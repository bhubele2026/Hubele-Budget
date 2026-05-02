import { Router, type IRouter } from "express";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  forecastClosedMonthsTable,
  forecastSettingsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

type Cadence =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "onetime";

type RecurringRow = typeof recurringItemsTable.$inferSelect;

type CashEvent = {
  date: string;
  itemId: string;
  label: string;
  kind: "income" | "expense";
  amount: number;
};

function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
}

function setSafeDay(year: number, monthIdx: number, day: number): Date {
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return new Date(year, monthIdx, Math.min(day, lastDay));
}

function expandItem(item: RecurringRow, from: Date, to: Date): CashEvent[] {
  if (item.active !== "true") return [];
  const out: CashEvent[] = [];
  const kind: "income" | "expense" = item.kind === "income" ? "income" : "expense";
  const sign = kind === "income" ? 1 : -1;
  const amt = Math.abs(Number(item.amount) || 0);
  const anchor = item.anchorDate ? parseISO(item.anchorDate) : from;

  const push = (d: Date) => {
    if (d < from || d > to) return;
    out.push({ date: fmtISO(d), itemId: item.id, label: item.name, kind, amount: sign * amt });
  };

  switch (item.frequency as Cadence) {
    case "onetime":
      push(anchor);
      break;
    case "weekly": {
      let cur = anchor;
      while (cur > from) cur = addDays(cur, -7);
      while (cur < from) cur = addDays(cur, 7);
      while (cur <= to) {
        push(cur);
        cur = addDays(cur, 7);
      }
      break;
    }
    case "biweekly": {
      let cur = anchor;
      while (cur > from) cur = addDays(cur, -14);
      while (cur < from) cur = addDays(cur, 14);
      while (cur <= to) {
        push(cur);
        cur = addDays(cur, 14);
      }
      break;
    }
    case "monthly": {
      const day = item.dayOfMonth ?? anchor.getDate();
      let y = from.getFullYear(),
        m = from.getMonth();
      const anchorFirst = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const fromFirst = new Date(from.getFullYear(), from.getMonth(), 1);
      if (anchorFirst > fromFirst) {
        y = anchor.getFullYear();
        m = anchor.getMonth();
      }
      let cur = setSafeDay(y, m, day);
      while (cur < from) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cur = setSafeDay(y, m, day);
      }
      while (cur <= to) {
        push(cur);
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cur = setSafeDay(y, m, day);
      }
      break;
    }
    case "semimonthly": {
      const d1 = item.dayOfMonth ?? anchor.getDate();
      const d2 = ((d1 + 14 - 1) % 30) + 1;
      let y = from.getFullYear(),
        m = from.getMonth();
      const days = [Math.min(d1, d2), Math.max(d1, d2)];
      while (true) {
        const a = setSafeDay(y, m, days[0]);
        const b = setSafeDay(y, m, days[1]);
        if (a > to && b > to) break;
        push(a);
        push(b);
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
      }
      break;
    }
    case "quarterly": {
      let cur = anchor;
      while (cur > from) cur = addMonths(cur, -3);
      while (cur < from) cur = addMonths(cur, 3);
      while (cur <= to) {
        push(cur);
        cur = addMonths(cur, 3);
      }
      break;
    }
    case "annual": {
      let cur = anchor;
      while (cur > from) cur = addMonths(cur, -12);
      while (cur < from) cur = addMonths(cur, 12);
      while (cur <= to) {
        push(cur);
        cur = addMonths(cur, 12);
      }
      break;
    }
  }
  return out;
}

async function ensureSettings(userId: string) {
  const [row] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, userId));
  if (row) return row;
  const [created] = await db
    .insert(forecastSettingsTable)
    .values({ userId })
    .returning();
  return created;
}

router.get("/forecast", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const settings = await ensureSettings(userId);
  const days = Number(req.query.days) || settings.daysAhead || 90;

  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth() - 1, 1); // include prior month for context
  const to = addDays(today, days);
  const fromISO = fmtISO(from);
  const toISO = fmtISO(to);

  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, userId));

  const events: CashEvent[] = [];
  for (const item of recurring) events.push(...expandItem(item, from, to));
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const txns = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.forecastFlag, true),
        gte(transactionsTable.occurredOn, fromISO),
        lte(transactionsTable.occurredOn, toISO),
      ),
    );

  const resolutionRows = await db
    .select({
      id: forecastResolutionsTable.id,
      recurringItemId: forecastResolutionsTable.recurringItemId,
      occurrenceDate: forecastResolutionsTable.occurrenceDate,
      status: forecastResolutionsTable.status,
      matchedTxnId: forecastResolutionsTable.matchedTxnId,
      txnDate: transactionsTable.occurredOn,
      txnDescription: transactionsTable.description,
      txnAmount: transactionsTable.amount,
      txnForecastFlag: transactionsTable.forecastFlag,
    })
    .from(forecastResolutionsTable)
    .leftJoin(
      transactionsTable,
      eq(forecastResolutionsTable.matchedTxnId, transactionsTable.id),
    )
    .where(eq(forecastResolutionsTable.userId, userId));

  // Filter out resolutions tied to txns whose forecast_flag was turned off
  const resolutions = resolutionRows.filter(
    (r) => !r.matchedTxnId || r.txnForecastFlag !== false,
  );

  const closedRows = await db
    .select()
    .from(forecastClosedMonthsTable)
    .where(eq(forecastClosedMonthsTable.userId, userId));

  res.json({
    fromDate: fromISO,
    toDate: toISO,
    events,
    transactions: txns,
    resolutions,
    closedMonths: closedRows.map((c) => c.monthKey),
    settings: {
      daysAhead: settings.daysAhead,
      startingBalance: settings.startingBalance,
    },
  });
});

router.get("/forecast/settings", requireAuth, async (req, res): Promise<void> => {
  const s = await ensureSettings(req.userId!);
  res.json({ daysAhead: s.daysAhead, startingBalance: s.startingBalance });
});

router.put("/forecast/settings", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureSettings(userId);
  const body = req.body ?? {};
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.daysAhead === "number") update.daysAhead = body.daysAhead;
  if (typeof body.startingBalance === "string")
    update.startingBalance = body.startingBalance;
  const [row] = await db
    .update(forecastSettingsTable)
    .set(update)
    .where(eq(forecastSettingsTable.userId, userId))
    .returning();
  res.json({ daysAhead: row.daysAhead, startingBalance: row.startingBalance });
});

router.post("/forecast/resolutions", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const { recurringItemId, occurrenceDate, status, matchedTxnId } = req.body ?? {};
  if (!status) {
    res.status(400).json({ error: "status required" });
    return;
  }

  // Idempotency: replace any existing resolution for the same plan-event or same txn
  if (recurringItemId && occurrenceDate) {
    await db
      .delete(forecastResolutionsTable)
      .where(
        and(
          eq(forecastResolutionsTable.userId, userId),
          eq(forecastResolutionsTable.recurringItemId, recurringItemId),
          eq(forecastResolutionsTable.occurrenceDate, occurrenceDate),
        ),
      );
  }
  if (matchedTxnId) {
    await db
      .delete(forecastResolutionsTable)
      .where(
        and(
          eq(forecastResolutionsTable.userId, userId),
          eq(forecastResolutionsTable.matchedTxnId, matchedTxnId),
        ),
      );
  }

  const [row] = await db
    .insert(forecastResolutionsTable)
    .values({
      userId,
      recurringItemId: recurringItemId ?? null,
      occurrenceDate: occurrenceDate ?? null,
      status,
      matchedTxnId: matchedTxnId ?? null,
    })
    .returning();
  res.json(row);
});

router.delete(
  "/forecast/resolutions/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    await db
      .delete(forecastResolutionsTable)
      .where(
        and(
          eq(forecastResolutionsTable.id, String(req.params.id)),
          eq(forecastResolutionsTable.userId, req.userId!),
        ),
      );
    res.sendStatus(204);
  },
);

router.post(
  "/forecast/closed-months",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const monthKey = req.body?.monthKey;
    if (!monthKey) {
      res.status(400).json({ error: "monthKey required" });
      return;
    }
    const [row] = await db
      .insert(forecastClosedMonthsTable)
      .values({ userId, monthKey })
      .onConflictDoUpdate({
        target: [forecastClosedMonthsTable.userId, forecastClosedMonthsTable.monthKey],
        set: { monthKey },
      })
      .returning();
    res.json(row);
  },
);

router.delete(
  "/forecast/closed-months/:monthKey",
  requireAuth,
  async (req, res): Promise<void> => {
    await db
      .delete(forecastClosedMonthsTable)
      .where(
        and(
          eq(forecastClosedMonthsTable.userId, req.userId!),
          eq(forecastClosedMonthsTable.monthKey, String(req.params.monthKey)),
        ),
      );
    res.sendStatus(204);
  },
);

// Suppress unused import in some build configs
void sql;

export default router;
