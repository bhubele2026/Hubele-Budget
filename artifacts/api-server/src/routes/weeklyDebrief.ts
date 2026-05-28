// (#766 — Phase D1) Weekly Debrief HTTP API.
//
// Four endpoints that power the Sun–Sat week-walk:
//   GET  /debrief/weeks            list + status + brief summary
//   GET  /debrief/weeks/:weekStart full snapshot (live or stored)
//   POST /debrief/weeks/:weekStart/lock
//   POST /debrief/weeks/:weekStart/unlock
//
// All four scope by req.householdId. Cross-household reads/writes
// 404. The unlock endpoint requires `{ confirm: true }` in the body
// before it clears `varianceSnapshot` / `actionsSummary` — Phase E
// will depend on that historical data so a stray POST must not be
// enough to silently wipe it.

import { Router, type IRouter } from "express";
import { and, eq, gte, lte, or, isNull, sql, asc } from "drizzle-orm";
import {
  db,
  weeklyDebriefsTable,
  transactionsTable,
  recurringItemsTable,
  type DebriefVarianceSnapshot,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  computeWeekVariance,
  loadConfiguredCheckingExternalId,
  makeIsBankRow,
  summarizeActions,
  weekEndFor,
  weekStartFor,
} from "../lib/weeklyDebrief";
import { addDays, fmtISO, parseISO } from "../lib/cashSignal";

const router: IRouter = Router();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isSunday(dateStr: string): boolean {
  return parseISO(dateStr).getDay() === 0;
}

function currentWeekStart(now: Date = new Date()): string {
  return weekStartFor(now);
}

type WeekStatus = "in_progress" | "awaiting_review" | "locked";

function deriveStatus(
  weekStart: string,
  row: typeof weeklyDebriefsTable.$inferSelect | null,
  now: Date,
): WeekStatus {
  if (row?.status === "locked") return "locked";
  const curr = currentWeekStart(now);
  if (weekStart === curr) return "in_progress";
  if (weekStart > curr) return "in_progress"; // future = treat as in_progress
  return "awaiting_review";
}

router.get("/debrief/weeks", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const now = new Date();
  let from = typeof req.query.from === "string" ? req.query.from : undefined;
  let to = typeof req.query.to === "string" ? req.query.to : undefined;
  if (from && !ISO_DATE.test(from)) {
    res.status(400).json({ error: "from must be YYYY-MM-DD" });
    return;
  }
  if (to && !ISO_DATE.test(to)) {
    res.status(400).json({ error: "to must be YYYY-MM-DD" });
    return;
  }
  if (!from) {
    // Default: 12 weeks back from the current Sun.
    from = fmtISO(addDays(parseISO(currentWeekStart(now)), -7 * 12));
  } else {
    from = weekStartFor(from);
  }
  if (!to) {
    to = currentWeekStart(now);
  } else {
    to = weekStartFor(to);
  }

  // Pull all stored debrief rows in range.
  const stored = await db
    .select()
    .from(weeklyDebriefsTable)
    .where(
      and(
        eq(weeklyDebriefsTable.householdId, householdId),
        gte(weeklyDebriefsTable.weekStart, from),
        lte(weeklyDebriefsTable.weekStart, to),
      ),
    )
    .orderBy(asc(weeklyDebriefsTable.weekStart));
  const byWeek = new Map(stored.map((r) => [r.weekStart, r]));

  // Enumerate every Sun–Sat week in the range, oldest first.
  const out: Array<{
    weekStart: string;
    weekEnd: string;
    status: WeekStatus;
    openItemsCount: number;
    netSummary: { plannedNet: string; actualNet: string; varianceNet: string };
    lockedAt: string | null;
  }> = [];
  let cur = parseISO(from);
  const end = parseISO(to);
  while (cur <= end) {
    const ws = fmtISO(cur);
    const we = weekEndFor(ws);
    const row = byWeek.get(ws) ?? null;
    const status = deriveStatus(ws, row, now);
    let openItemsCount = 0;
    let netSummary = {
      plannedNet: "0.00",
      actualNet: "0.00",
      varianceNet: "0.00",
    };
    if (status === "locked" && row?.varianceSnapshot) {
      openItemsCount = 0;
      netSummary = {
        plannedNet: row.varianceSnapshot.totals.plannedNet,
        actualNet: row.varianceSnapshot.totals.actualNet,
        varianceNet: row.varianceSnapshot.totals.varianceNet,
      };
    } else {
      const snap = await computeWeekVariance(householdId, ws, { now });
      openItemsCount = snap.openItemsCount;
      netSummary = {
        plannedNet: snap.totals.plannedNet,
        actualNet: snap.totals.actualNet,
        varianceNet: snap.totals.varianceNet,
      };
    }
    out.push({
      weekStart: ws,
      weekEnd: we,
      status,
      openItemsCount,
      netSummary,
      lockedAt: row?.lockedAt ? row.lockedAt.toISOString() : null,
    });
    cur = addDays(cur, 7);
  }

  res.json({ weeks: out });
});

router.get(
  "/debrief/weeks/:weekStart",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const raw: string =
      typeof req.params.weekStart === "string" ? req.params.weekStart : "";
    if (!ISO_DATE.test(raw) || !isSunday(raw)) {
      res.status(400).json({ error: "weekStart must be a Sunday YYYY-MM-DD" });
      return;
    }
    const weekStart = raw;
    const weekEnd = weekEndFor(weekStart);
    const now = new Date();
    const [row] = await db
      .select()
      .from(weeklyDebriefsTable)
      .where(
        and(
          eq(weeklyDebriefsTable.householdId, householdId),
          eq(weeklyDebriefsTable.weekStart, weekStart),
        ),
      );
    const status = deriveStatus(weekStart, row ?? null, now);

    if (status === "locked" && row?.varianceSnapshot && row.lockedAt) {
      // Late-syncing rows that landed in this week AFTER lockedAt:
      // surface separately, do NOT mutate the stored snapshot.
      const lockedAtIso = row.lockedAt.toISOString();
      const ownerSettingsCheckingExternal =
        await loadConfiguredCheckingExternalId(householdId, req.householdOwnerId!);
      const isBankRow = makeIsBankRow(ownerSettingsCheckingExternal);
      const lateRows = await db
        .select()
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, householdId),
            gte(transactionsTable.createdAt, row.lockedAt),
            or(
              and(
                sql`${transactionsTable.occurredAt} IS NOT NULL`,
                gte(
                  sql`${transactionsTable.occurredAt}::date`,
                  sql`${weekStart}::date`,
                ),
                lte(
                  sql`${transactionsTable.occurredAt}::date`,
                  sql`${weekEnd}::date`,
                ),
              ),
              and(
                isNull(transactionsTable.occurredAt),
                gte(transactionsTable.occurredOn, weekStart),
                lte(transactionsTable.occurredOn, weekEnd),
              ),
            ),
          ),
        );
      const postLockAdditions = lateRows
        .filter((t) => isBankRow(t.source, t.plaidAccountId))
        .map((t) => ({
          txnId: t.id,
          date: t.occurredAt ? t.occurredAt.slice(0, 10) : t.occurredOn,
          description: t.description,
          amount: t.amount,
          categoryId: t.categoryId ?? null,
          source: t.source ?? null,
          syncedAt: t.createdAt.toISOString(),
        }));
      res.json({
        weekStart,
        weekEnd,
        status,
        lockedAt: lockedAtIso,
        lockedByUserId: row.lockedByUserId,
        varianceSnapshot: row.varianceSnapshot,
        actionsSummary: row.actionsSummary,
        postLockAdditions,
      });
      return;
    }

    const snapshot = await computeWeekVariance(householdId, weekStart, { now });
    res.json({
      weekStart,
      weekEnd,
      status,
      lockedAt: null,
      lockedByUserId: null,
      varianceSnapshot: snapshot,
      actionsSummary: null,
      postLockAdditions: [],
    });
  },
);

router.post(
  "/debrief/weeks/:weekStart/lock",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const actor = req.userId!;
    const raw: string =
      typeof req.params.weekStart === "string" ? req.params.weekStart : "";
    if (!ISO_DATE.test(raw) || !isSunday(raw)) {
      res.status(400).json({ error: "weekStart must be a Sunday YYYY-MM-DD" });
      return;
    }
    const weekStart = raw;
    const weekEnd = weekEndFor(weekStart);
    const now = new Date();
    // Cannot lock the current or future week.
    if (weekStart >= currentWeekStart(now)) {
      res
        .status(400)
        .json({ error: "Cannot lock the current or a future week" });
      return;
    }

    const snapshot = await computeWeekVariance(householdId, weekStart, { now });
    if (snapshot.openItemsCount > 0) {
      res.status(400).json({
        error: "Week has unresolved items",
        openItems: {
          unmatchedPlans: snapshot.unmatchedPlans,
          unplannedTxns: snapshot.unplannedTxns.filter((t) => {
            // Mirror computeWeekVariance — open txns are unplanned + !reviewed.
            return true;
          }),
        },
      });
      return;
    }

    const actions = summarizeActions(snapshot);
    const lockedAt = new Date();
    const [row] = await db
      .insert(weeklyDebriefsTable)
      .values({
        householdId,
        weekStart,
        weekEnd,
        status: "locked",
        lockedAt,
        lockedByUserId: actor,
        varianceSnapshot: snapshot,
        actionsSummary: actions,
        updatedAt: lockedAt,
      })
      .onConflictDoUpdate({
        target: [weeklyDebriefsTable.householdId, weeklyDebriefsTable.weekStart],
        set: {
          status: "locked",
          lockedAt,
          lockedByUserId: actor,
          varianceSnapshot: snapshot,
          actionsSummary: actions,
          updatedAt: lockedAt,
        },
      })
      .returning();
    res.json({
      weekStart: row.weekStart,
      weekEnd: row.weekEnd,
      status: row.status as WeekStatus,
      lockedAt: row.lockedAt?.toISOString() ?? null,
      lockedByUserId: row.lockedByUserId,
      varianceSnapshot: row.varianceSnapshot,
      actionsSummary: row.actionsSummary,
    });
  },
);

router.post(
  "/debrief/weeks/:weekStart/unlock",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const raw: string =
      typeof req.params.weekStart === "string" ? req.params.weekStart : "";
    if (!ISO_DATE.test(raw) || !isSunday(raw)) {
      res.status(400).json({ error: "weekStart must be a Sunday YYYY-MM-DD" });
      return;
    }
    const weekStart = raw;
    const confirm = (req.body ?? {}).confirm === true;
    if (!confirm) {
      // Mirror destructive-confirm contracts elsewhere in the
      // codebase: 400 + `requiresConfirmation` so the UI can prompt
      // and re-POST with `{ confirm: true }`. Phase E depends on
      // varianceSnapshot history; a stray POST must not silently
      // wipe it.
      res.status(400).json({
        error: "Unlocking clears the saved variance snapshot. Confirm to proceed.",
        requiresConfirmation: true,
      });
      return;
    }
    const [existing] = await db
      .select()
      .from(weeklyDebriefsTable)
      .where(
        and(
          eq(weeklyDebriefsTable.householdId, householdId),
          eq(weeklyDebriefsTable.weekStart, weekStart),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Debrief not found" });
      return;
    }
    if (existing.status !== "locked") {
      res.status(400).json({ error: "Week is not locked" });
      return;
    }
    const [row] = await db
      .update(weeklyDebriefsTable)
      .set({
        status: "awaiting_review",
        lockedAt: null,
        lockedByUserId: null,
        varianceSnapshot: null,
        actionsSummary: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(weeklyDebriefsTable.householdId, householdId),
          eq(weeklyDebriefsTable.weekStart, weekStart),
        ),
      )
      .returning();
    res.json({
      weekStart: row.weekStart,
      weekEnd: row.weekEnd,
      status: row.status as WeekStatus,
      lockedAt: null,
      lockedByUserId: null,
    });
  },
);

export default router;

// Re-export for tests / other modules.
export { weekStartFor, weekEndFor, currentWeekStart };
