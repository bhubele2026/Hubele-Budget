import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  forecastClosedMonthsTable,
  forecastSettingsTable,
  plaidItemsTable,
  plaidAccountsTable,
  avalancheSettingsTable,
  weeklyDebriefsTable,
  type AvalancheAdvisorSummary,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  computeCashSignal,
  expandItem,
  fmtISO,
  addDays,
  parseISO,
  type CashEvent,
} from "../lib/cashSignal";
import {
  buildDebtMinSchedule,
  expandDebtMin,
  expandAvalancheExtra,
} from "../lib/debtMinSchedule";
import { buildAvalancheSchedule } from "../lib/avalancheScheduler";
import { generateAvalancheSummary } from "../lib/avalancheAdvisorSummary";
import {
  plaid,
  isValidPlaidAccessToken,
  isAccessTokenForCurrentEnv,
  ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
  MALFORMED_PLAID_TOKEN_MESSAGE,
} from "../lib/plaid";
import { extractPlaidError, markItemMalformedToken } from "../lib/plaidSync";
import { PLAID_REAUTH_ERROR_CODES } from "../lib/plaidReauthCodes";
import { archiveExpiredOneTime } from "./bills";
import {
  dedupePlaidAccountsForUser,
  runAutoDedupeIfNeeded,
} from "../lib/dedupePlaidAccounts";
import {
  countDuplicateTransactionsForUser,
  dedupeTransactionsForUser,
  dedupeTransactionsAcrossAccountsForUser,
} from "../lib/dedupeTransactions";

const router: IRouter = Router();

async function ensureSettings(ownerUserId: string, householdId: string) {
  const [row] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  if (row) return row;
  // Upsert to avoid PK collisions when parallel requests for the same fresh
  // user race past the SELECT (mirrors the fix in avalanche.ts).
  const [created] = await db
    .insert(forecastSettingsTable)
    .values({ userId: ownerUserId, householdId })
    .onConflictDoUpdate({
      target: forecastSettingsTable.userId,
      set: { userId: ownerUserId },
    })
    .returning();
  return created;
}

function presentSettings(row: typeof forecastSettingsTable.$inferSelect) {
  return {
    daysAhead: row.daysAhead,
    startingBalance: row.startingBalance,
    cashBuffer: row.cashBuffer,
  };
}

function presentSnapshot(row: typeof forecastSettingsTable.$inferSelect) {
  if (row.bankSnapshotBalance == null || !row.bankSnapshotAt) return null;
  return {
    balance: row.bankSnapshotBalance,
    at: row.bankSnapshotAt.toISOString(),
    source: (row.bankSnapshotSource as "manual" | "plaid") ?? "manual",
    accountId: row.bankSnapshotAccountId ?? null,
    name: row.bankSnapshotName ?? null,
    mask: row.bankSnapshotMask ?? null,
  };
}

export async function listCheckingAccounts(
  userId: string,
  householdId?: string,
  ownerUserId?: string,
) {
  const ownerId = ownerUserId ?? userId;
  const hhId = householdId ?? userId;
  // (#411) First time this user lands on the Chase / transactions page,
  // collapse any leftover duplicate `plaid_accounts` rows so the picker
  // and balances render against a single survivor row. Gated by
  // `forecast_settings.auto_dedupe_ran_at` so it runs at most once per
  // user; explicit hooks (Plaid (re)link, the maintenance endpoint)
  // bypass the gate. Best-effort — failures are logged but never block
  // the page load.
  await runAutoDedupeIfNeeded(userId, "listCheckingAccounts");

  // (#410) Read the bank-snapshot pointer first so dedupe can prefer the
  // snapshot row when collapsing duplicates by (institutionName, mask).
  const [settingsRow] = await db
    .select({ bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerId));
  const snapshotAccountId = settingsRow?.bankSnapshotAccountId ?? null;

  const rows = await db
    .select({
      id: plaidAccountsTable.id,
      accountId: plaidAccountsTable.accountId,
      name: plaidAccountsTable.name,
      mask: plaidAccountsTable.mask,
      subtype: plaidAccountsTable.subtype,
      type: plaidAccountsTable.type,
      createdAt: plaidAccountsTable.createdAt,
      institutionName: plaidItemsTable.institutionName,
    })
    .from(plaidAccountsTable)
    .leftJoin(plaidItemsTable, eq(plaidAccountsTable.itemId, plaidItemsTable.id))
    .where(eq(plaidAccountsTable.householdId, hhId));
  const checking = rows.filter(
    (a) =>
      a.subtype === "checking" ||
      a.type === "depository" ||
      a.subtype === "savings",
  );

  // (#410) Collapse duplicate `plaid_accounts` rows that point at the
  // same physical bank account. Picker / DB cleanup may lag behind, so
  // we de-dupe in the API response keyed by (institutionName, mask)
  // (case-insensitive). Survivor preference: snapshot pointer first,
  // then most recently created. Rows with no mask cannot be safely
  // collapsed (we can't tell them apart) and pass through unchanged.
  type Row = (typeof checking)[number];
  const groups = new Map<string, Row[]>();
  const passthrough: Row[] = [];
  for (const r of checking) {
    if (!r.mask) {
      passthrough.push(r);
      continue;
    }
    const key = `${(r.institutionName ?? "").toLowerCase()}|${r.mask.toLowerCase()}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  const survivors: Row[] = [...passthrough];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      survivors.push(arr[0]);
      continue;
    }
    arr.sort((a, b) => {
      const aSnap = a.id === snapshotAccountId ? 0 : 1;
      const bSnap = b.id === snapshotAccountId ? 0 : 1;
      if (aSnap !== bSnap) return aSnap - bSnap;
      const at = a.createdAt?.getTime() ?? 0;
      const bt = b.createdAt?.getTime() ?? 0;
      return bt - at;
    });
    survivors.push(arr[0]);
  }

  return survivors.map((a) => ({
    id: a.id,
    accountId: a.accountId,
    name: a.name,
    mask: a.mask,
    subtype: a.subtype,
    institutionName: a.institutionName,
  }));
}

// In-process per-user gate for the forecast safety-net dedupe passes.
// Each /forecast hit was paying ~600-900ms re-running both passes; once
// per process per user is sufficient (see commentary below).
const FORECAST_DEDUPE_DONE = new Set<string>();

router.get("/forecast", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId!;
  await archiveExpiredOneTime(householdId);
  let settings = await ensureSettings(ownerUserId, householdId);
  // (#411) Auto-dedupe / accountSnapshots auto-repair pass. Gated by
  // `forecast_settings.auto_dedupe_ran_at` so it runs at most once per
  // user from this code path instead of re-firing on every /forecast
  // request. Idempotent and best-effort — failures are logged but never
  // block the page load.
  const autoReport = await runAutoDedupeIfNeeded(userId, "/forecast");
  if (
    autoReport &&
    (autoReport.accountSnapshotsRepointed > 0 ||
      autoReport.accountSnapshotsPruned > 0 ||
      autoReport.duplicatesRemoved > 0)
  ) {
    // Re-read settings so the response below reflects the repaired
    // accountSnapshots map instead of the stale pre-dedupe copy.
    settings = await ensureSettings(ownerUserId, householdId);
  }
  // (#432-followup) Heal stale snapshot identity: when
  // `bank_snapshot_account_id` points at a real plaid_accounts row but
  // the stored `bank_snapshot_mask` / `bank_snapshot_name` are out of
  // sync (e.g. a synthetic ··0000 seed got linked to a real ··5526
  // account but the legacy columns were never updated), reconcile them
  // to the live plaid_account values. This is what makes the snapshot
  // header read "Chase ··5526" instead of "Chase ··0000" after the user
  // links the real bank, and stops the picker from emitting the stale
  // identity as a phantom second row.
  if (settings.bankSnapshotAccountId) {
    try {
      const [linked] = await db
        .select({
          name: plaidAccountsTable.name,
          mask: plaidAccountsTable.mask,
        })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.id, settings.bankSnapshotAccountId));
      if (
        linked &&
        ((linked.mask ?? null) !== (settings.bankSnapshotMask ?? null) ||
          (linked.name ?? null) !== (settings.bankSnapshotName ?? null))
      ) {
        await db
          .update(forecastSettingsTable)
          .set({
            bankSnapshotMask: linked.mask ?? null,
            bankSnapshotName: linked.name ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(forecastSettingsTable.userId, ownerUserId),
              eq(
                forecastSettingsTable.bankSnapshotAccountId,
                settings.bankSnapshotAccountId,
              ),
            ),
          );
        settings = await ensureSettings(ownerUserId, householdId);
      }
    } catch (err) {
      console.error(
        "[forecast] bankSnapshot identity heal failed",
        { userId, err: err instanceof Error ? err.message : String(err) },
      );
    }
  }
  // (#475-followup) Two-stage transaction dedupe heal:
  //   1. Per-account dedupe (#452): collapses duplicate rows that
  //      share (plaidAccountId, occurredOn, amount, normalizedDesc).
  //      This is the dominant case once `dedupePlaidAccountsForUser`
  //      has already collapsed duplicate plaid_accounts rows — every
  //      twin is now stacked on the same surviving account_id.
  //   2. Cross-account dedupe: collapses twins that still live under
  //      different `plaid_account_id` strings (an orphan + a live
  //      account from a relink that hasn't been collapsed yet).
  // Both passes are idempotent — clean data is a no-op. We run them
  // best-effort so the page never fails just because dedupe choked.
  //
  // Perf: gate to once per process per user. These are safety-net heals,
  // not a per-request responsibility — they re-scan every transaction for
  // the user on every call and were costing ~600-900ms per /forecast hit
  // (the page loads on every dashboard mount). The user-triggered cleanup
  // path (POST /forecast/dedupe-transactions, route below) is unaffected
  // and continues to run on demand. New duplicates introduced after the
  // first run are still caught by the next process boot or by the explicit
  // cleanup button on Settings.
  if (!FORECAST_DEDUPE_DONE.has(userId)) {
    try {
      await dedupeTransactionsForUser(userId);
    } catch (err) {
      console.error(
        "[forecast] per-account transaction dedupe failed",
        { userId, err: err instanceof Error ? err.message : String(err) },
      );
    }
    try {
      await dedupeTransactionsAcrossAccountsForUser(userId);
    } catch (err) {
      console.error(
        "[forecast] cross-account transaction dedupe failed",
        { userId, err: err instanceof Error ? err.message : String(err) },
      );
    }
    FORECAST_DEDUPE_DONE.add(userId);
  }
  const days = Number(req.query.days) || settings.daysAhead || 90;

  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const to = addDays(today, days);
  const fromISO = fmtISO(from);
  const toISO = fmtISO(to);

  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));

  const debtsList = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));

  // Same series as Bills: linked recurring items represent the debt's
  // minimum; for unlinked active debts we synthesize monthly events so the
  // forecast doesn't miss known obligations and never double-counts them.
  const linkedRecurringByDebt = new Map<string, typeof recurring[number]>();
  for (const r of recurring) {
    if (r.debtId && r.active === "true" && !linkedRecurringByDebt.has(r.debtId)) {
      linkedRecurringByDebt.set(r.debtId, r);
    }
  }

  const events: CashEvent[] = [];
  for (const item of recurring) events.push(...expandItem(item, from, to));
  for (const d of debtsList) {
    events.push(
      ...expandDebtMin(d, linkedRecurringByDebt.get(d.id) ?? null, from, to),
    );
  }
  // Inject the synthetic "Avalanche extra payment" events alongside the
  // debt-min series so the Forecast register shows the slider amount as a
  // committed end-of-month outflow until the avalanche pays everything off.
  const [avaSettingsRow] = await db
    .select()
    .from(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, ownerUserId));
  const manualExtra = Number(avaSettingsRow?.manualExtra ?? 0) || 0;
  events.push(...expandAvalancheExtra(debtsList, manualExtra, from, to, today));
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Forecast is Chase-checking-only. Resolve the configured checking
  // account's external Plaid account_id (if any) so we can filter out
  // any non-checking transactions/resolutions at read time — even if a
  // legacy row still has `forecastFlag = true`.
  let configuredCheckingExternalId: string | null = null;
  if (settings.bankSnapshotAccountId) {
    const [acct] = await db
      .select({ accountId: plaidAccountsTable.accountId })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, settings.bankSnapshotAccountId));
    configuredCheckingExternalId = acct?.accountId ?? null;
  }
  const isBankRow = (
    source: string | null | undefined,
    plaidAccountId: string | null | undefined,
  ): boolean => {
    if (plaidAccountId) {
      return (
        configuredCheckingExternalId !== null &&
        plaidAccountId === configuredCheckingExternalId
      );
    }
    const s = (source ?? "manual").toLowerCase();
    if (s === "amex" || s === "plaid:amex") return false;
    if (s.startsWith("plaid:")) return false;
    return true;
  };

  const txnsAll = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.forecastFlag, true),
        gte(transactionsTable.occurredOn, fromISO),
        lte(transactionsTable.occurredOn, toISO),
        // Original single-flow design (Task #6 Review inbox / Task #33
        // "Forecast mirrors checking" / Task #67 Forecast Inbox flow):
        // a checking row that's forecast-flagged IS in the Review
        // pipeline — full stop. The #762 "Phase B" manual
        // sent_to_review_at second gate is intentionally removed; it
        // split one action into two, hid forecast-flagged rows from
        // Review until a second click, and got repeatedly patched
        // around (#812 backlog clear, "Chase txns not appearing in
        // review queues"). Send to Forecast = in Review = on the curve.
      ),
    );
  const txns = txnsAll.filter((t) => isBankRow(t.source, t.plaidAccountId));

  const resolutionRows = await db
    .select({
      id: forecastResolutionsTable.id,
      recurringItemId: forecastResolutionsTable.recurringItemId,
      occurrenceDate: forecastResolutionsTable.occurrenceDate,
      status: forecastResolutionsTable.status,
      matchedTxnId: forecastResolutionsTable.matchedTxnId,
      rescheduledTo: forecastResolutionsTable.rescheduledTo,
      txnDate: transactionsTable.occurredOn,
      txnDescription: transactionsTable.description,
      txnAmount: transactionsTable.amount,
      txnForecastFlag: transactionsTable.forecastFlag,
      txnSource: transactionsTable.source,
      txnPlaidAccountId: transactionsTable.plaidAccountId,
    })
    .from(forecastResolutionsTable)
    .leftJoin(
      transactionsTable,
      eq(forecastResolutionsTable.matchedTxnId, transactionsTable.id),
    )
    .where(eq(forecastResolutionsTable.householdId, householdId));

  // Drop resolutions whose matched transaction isn't bank-checking, so
  // legacy Amex matches no longer mark planned items as `matched` on
  // the Forecast page.
  const resolutions = resolutionRows
    .filter((r) => !r.matchedTxnId || r.txnForecastFlag !== false)
    .filter(
      (r) =>
        !r.matchedTxnId || isBankRow(r.txnSource, r.txnPlaidAccountId),
    )
    .map(({ txnSource: _s, txnPlaidAccountId: _p, ...rest }) => rest);

  const closedRows = await db
    .select()
    .from(forecastClosedMonthsTable)
    .where(eq(forecastClosedMonthsTable.householdId, householdId));

  // (#804 — Phase F) Load locked weekly_debriefs once so we can both
  // (a) hand them to computeCashSignal to freeze the forecast curve
  // over locked dates, and (b) emit a `lockedWeeks[]` array with each
  // locked week's daily ACTUAL checking balance for the chart overlay.
  const lockedDebriefRows = await db
    .select({
      weekStart: weeklyDebriefsTable.weekStart,
      weekEnd: weeklyDebriefsTable.weekEnd,
      varianceSnapshot: weeklyDebriefsTable.varianceSnapshot,
    })
    .from(weeklyDebriefsTable)
    .where(
      and(
        eq(weeklyDebriefsTable.householdId, householdId),
        eq(weeklyDebriefsTable.status, "locked"),
      ),
    );
  const lockedWeekInputs = lockedDebriefRows.flatMap((r) =>
    r.varianceSnapshot
      ? [{
          weekStart: r.weekStart,
          weekEnd: r.weekEnd,
          varianceSnapshot: r.varianceSnapshot,
        }]
      : [],
  );

  const cashSignal = await computeCashSignal(householdId, ownerUserId, {
    lockedWeeks: lockedWeekInputs,
  });
  const plaidCheckingAccounts = await listCheckingAccounts(
    userId,
    householdId,
    ownerUserId,
  );

  // Build daily actual checking balance for each locked week. We walk
  // the bank snapshot forward/backward using bank-row checking txns so
  // each day's point reflects the real end-of-day balance the user
  // would have seen. No snapshot ⇒ empty actualPoints (chart simply
  // doesn't render the overlay for that week).
  const lockedWeeks: Array<{
    weekStart: string;
    weekEnd: string;
    actualPoints: Array<{ date: string; balance: string }>;
  }> = [];
  if (lockedWeekInputs.length > 0) {
    const snapshotBalance =
      settings.bankSnapshotBalance != null
        ? Number(settings.bankSnapshotBalance)
        : null;
    const snapshotAt = settings.bankSnapshotAt
      ? fmtISO(settings.bankSnapshotAt)
      : null;
    // Resolve the configured checking account's external Plaid id so
    // we can scope txns the same way cashSignal does (isBankRow).
    let configuredCheckingExternalId: string | null = null;
    if (settings.bankSnapshotAccountId) {
      const [acct] = await db
        .select({ accountId: plaidAccountsTable.accountId })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.id, settings.bankSnapshotAccountId));
      configuredCheckingExternalId = acct?.accountId ?? null;
    }
    const isBankRow = (source: string | null, plaidAccountId: string | null) => {
      if (plaidAccountId) {
        return (
          configuredCheckingExternalId !== null &&
          plaidAccountId === configuredCheckingExternalId
        );
      }
      const s = (source ?? "").toLowerCase();
      if (s === "amex" || s.startsWith("plaid:")) return false;
      return true;
    };

    // Determine the txn date range we need: from earliest locked-week
    // start to latest locked-week end, plus the snapshot date (since
    // pre-snapshot dates require subtracting txns that fall between
    // them and the snapshot).
    let minISO: string | null = null;
    let maxISO: string | null = null;
    for (const lw of lockedWeekInputs) {
      if (!minISO || lw.weekStart < minISO) minISO = lw.weekStart;
      if (!maxISO || lw.weekEnd > maxISO) maxISO = lw.weekEnd;
    }
    if (snapshotAt) {
      if (!minISO || snapshotAt < minISO) minISO = snapshotAt;
      if (!maxISO || snapshotAt > maxISO) maxISO = snapshotAt;
    }
    let actualTxns: Array<{
      occurredOn: string;
      amount: string;
      source: string | null;
      plaidAccountId: string | null;
    }> = [];
    if (snapshotBalance != null && snapshotAt && minISO && maxISO) {
      const rows = await db
        .select({
          occurredOn: transactionsTable.occurredOn,
          amount: transactionsTable.amount,
          source: transactionsTable.source,
          plaidAccountId: transactionsTable.plaidAccountId,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, householdId),
            gte(transactionsTable.occurredOn, minISO),
            lte(transactionsTable.occurredOn, maxISO),
          ),
        );
      actualTxns = rows.filter((r) => isBankRow(r.source, r.plaidAccountId));
    }

    for (const lw of lockedWeekInputs) {
      const actualPoints: Array<{ date: string; balance: string }> = [];
      if (snapshotBalance != null && snapshotAt) {
        // Use the cashSignal date helpers (local-date based) so
        // fmtISO/addDays don't drift the day in non-UTC server TZs.
        let cur = parseISO(lw.weekStart);
        const end = parseISO(lw.weekEnd);
        while (cur <= end) {
          const dISO = fmtISO(cur);
          // balance(d) = snapshot + Σ(txn.occurredOn > snapshot AND <= d)
          //                       − Σ(txn.occurredOn > d AND <= snapshot)
          let delta = 0;
          for (const t of actualTxns) {
            const on = t.occurredOn;
            if (on > snapshotAt && on <= dISO) {
              delta += Number(t.amount) || 0;
            } else if (on > dISO && on <= snapshotAt) {
              delta -= Number(t.amount) || 0;
            }
          }
          const bal = snapshotBalance + delta;
          actualPoints.push({
            date: dISO,
            balance: (Math.round(bal * 100) / 100).toFixed(2),
          });
          cur = addDays(cur, 1);
        }
      }
      lockedWeeks.push({
        weekStart: lw.weekStart,
        weekEnd: lw.weekEnd,
        actualPoints,
      });
    }
  }

  res.json({
    fromDate: fromISO,
    toDate: toISO,
    events,
    transactions: txns,
    resolutions,
    closedMonths: closedRows.map((c) => c.monthKey),
    settings: presentSettings(settings),
    bankSnapshot: presentSnapshot(settings),
    cashSignal,
    plaidCheckingAccounts,
    monthSnapshots: settings.monthSnapshots ?? {},
    accountSnapshots: settings.accountSnapshots ?? {},
    lockedWeeks,
  });
});

router.get("/forecast/settings", requireAuth, async (req, res): Promise<void> => {
  const s = await ensureSettings(req.householdOwnerId!, req.householdId!);
  res.json(presentSettings(s));
});

router.put("/forecast/settings", requireAuth, async (req, res): Promise<void> => {
  const ownerUserId = req.householdOwnerId!;
  const householdId = req.householdId!;
  await ensureSettings(ownerUserId, householdId);
  const body = req.body ?? {};
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.daysAhead === "number") update.daysAhead = body.daysAhead;
  if (typeof body.startingBalance === "string")
    update.startingBalance = body.startingBalance;
  if (typeof body.cashBuffer === "string") update.cashBuffer = body.cashBuffer;
  const [row] = await db
    .update(forecastSettingsTable)
    .set(update)
    .where(eq(forecastSettingsTable.userId, ownerUserId))
    .returning();
  res.json(presentSettings(row));
});

// 7 is the "THIS WEEK" horizon the Forecast page defaults to; it was missing
// here, so the page's default request 400'd and every projection tile fell back
// to $0. computeCashSignal handles a 7-day window fine (the main /forecast route
// already accepts days=7) — this is a validation whitelist fix, not a math change.
const ALLOWED_HORIZON_DAYS = new Set([7, 30, 90, 120, 183, 365]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/forecast/cash-signal", requireAuth, async (req, res): Promise<void> => {
  let horizonDays: number | undefined;
  if (req.query.horizonDays != null) {
    const n = Number(req.query.horizonDays);
    if (!Number.isFinite(n) || !ALLOWED_HORIZON_DAYS.has(n)) {
      res.status(400).json({
        error: "invalid horizonDays (allowed: 7, 30, 90, 120, 183, 365)",
      });
      return;
    }
    horizonDays = n;
  }
  let fromDate: string | undefined;
  if (typeof req.query.fromDate === "string" && req.query.fromDate) {
    if (!ISO_DATE_RE.test(req.query.fromDate)) {
      res.status(400).json({ error: "invalid fromDate (expected YYYY-MM-DD)" });
      return;
    }
    fromDate = req.query.fromDate;
  }
  const signal = await computeCashSignal(req.householdId!, req.householdOwnerId!, { horizonDays, fromDate });
  res.json(signal);
});

// (#826) Avalanche extra-payment schedule. Always recomputes the
// DETERMINISTIC schedule (cheap), then returns the cached Claude
// narrative when the facts hash is unchanged — otherwise regenerates it,
// caches the result + hash, and returns "fresh". `?refresh=true` forces
// regeneration (a new Anthropic call) for the Refresh button.
router.get(
  "/forecast/avalanche-schedule",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const ownerUserId = req.householdOwnerId!;
    const forceRefresh =
      req.query.refresh === "true" || req.query.refresh === "1";

    await ensureSettings(ownerUserId, householdId);

    // Deterministic schedule — ground truth for the numbers + narrative.
    const facts = await buildAvalancheSchedule(householdId, ownerUserId);

    // Hash only the inputs that determine the narrative. generatedAt and
    // free-form rationale strings are excluded so identical schedules
    // produce identical hashes across requests.
    const factsHash = createHash("sha256")
      .update(
        JSON.stringify({
          payments: facts.proposedPayments.map((p) => [
            p.date,
            p.amount,
            p.confidence,
            p.paycheckAnchor,
            p.lowestBetweenThisAndNextPaycheck,
            p.headroom,
          ]),
          total: facts.totalProposed,
          target: facts.currentAvalancheTarget,
          cashBuffer: facts.cashBuffer,
          // bankBalance is narrated in the prompt, so it must invalidate
          // the cached summary when it changes.
          bankBalance: facts.bankBalance,
          lowestPost: facts.lowestPostScheduleBalance,
          lowestPostDate: facts.lowestPostScheduleDate,
        }),
      )
      .digest("hex");

    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId));
    const cached = settings?.avalancheAdvisorSummary ?? null;
    const cachedHash = settings?.avalancheAdvisorFactsHash ?? null;

    let summaryRow: AvalancheAdvisorSummary;
    let source: "cache" | "fresh";
    if (!forceRefresh && cached && cachedHash === factsHash) {
      summaryRow = cached;
      source = "cache";
    } else {
      summaryRow = await generateAvalancheSummary(facts);
      await db
        .update(forecastSettingsTable)
        .set({
          avalancheAdvisorSummary: summaryRow,
          avalancheAdvisorFactsHash: factsHash,
          updatedAt: new Date(),
        })
        .where(eq(forecastSettingsTable.userId, ownerUserId));
      source = "fresh";
    }

    res.json({
      proposedPayments: facts.proposedPayments,
      totalProposed: facts.totalProposed,
      lowestPostScheduleBalance: facts.lowestPostScheduleBalance,
      lowestPostScheduleDate: facts.lowestPostScheduleDate,
      currentAvalancheTarget: facts.currentAvalancheTarget,
      cashBuffer: facts.cashBuffer,
      bankBalance: facts.bankBalance,
      scheduleThroughDate: facts.scheduleThroughDate,
      summary: summaryRow.summary,
      paymentsText: summaryRow.paymentsText,
      summarySource: summaryRow.source,
      generatedAt: summaryRow.generatedAt,
      source,
    });
  },
);

router.post("/forecast/bank-snapshot", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId!;
  await ensureSettings(ownerUserId, householdId);
  const { balance, plaidAccountId } = req.body ?? {};

  let snapshotBalance: string | null = null;
  let source: "manual" | "plaid" = "manual";
  let accountId: string | null = null;
  let accountName: string | null = null;
  let accountMask: string | null = null;

  if (plaidAccountId) {
    // Plaid refresh: look up account, fetch live balance
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.id, String(plaidAccountId)),
          eq(plaidAccountsTable.householdId, householdId),
        ),
      );
    if (!acct) {
      res.status(404).json({ error: "Plaid account not found" });
      return;
    }
    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, acct.itemId));
    if (!item) {
      res.status(404).json({ error: "Plaid item not found" });
      return;
    }
    // (#654) Preflight token guards — mirror the same {409, action:"relink",
    // code} contract /plaid/link-token/update returns so the Reconnect button
    // and the manual snapshot/refresh flows recover identically. Without
    // these, a sandbox-prefixed token on a production server would call
    // Plaid, get INVALID_ACCESS_TOKEN, surface as a generic 502, and never
    // stamp the per-item reauth state.
    if (!isValidPlaidAccessToken(item.accessToken)) {
      await markItemMalformedToken(item.id);
      res.status(409).json({
        error: MALFORMED_PLAID_TOKEN_MESSAGE,
        code: "ITEM_LOGIN_REQUIRED",
        action: "relink",
        account: { name: acct.name ?? null, mask: acct.mask ?? null },
      });
      return;
    }
    if (!isAccessTokenForCurrentEnv(item.accessToken)) {
      await markItemMalformedToken(item.id, {
        code: "INVALID_ACCESS_TOKEN",
        message: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
      });
      res.status(409).json({
        error: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
        code: "INVALID_ACCESS_TOKEN",
        action: "relink",
        account: { name: acct.name ?? null, mask: acct.mask ?? null },
      });
      return;
    }
    try {
      const resp = await plaid().accountsBalanceGet({
        access_token: item.accessToken,
        options: { account_ids: [acct.accountId] },
      });
      const a = resp.data.accounts.find((x) => x.account_id === acct.accountId);
      const live = a?.balances.available ?? a?.balances.current;
      if (live == null) {
        // Task #546 — mirror the structured `no_balance` body that
        // /forecast/refresh-bank returns (Task #385) so the Forecast
        // page's link-checking / manual-set flows can surface the
        // same account-aware "doesn't have a refreshable balance"
        // toast instead of the dead-end raw error string.
        res.status(502).json({
          error: "Plaid did not return a balance",
          code: "no_balance",
          account: { name: acct.name ?? null, mask: acct.mask ?? null },
        });
        return;
      }
      snapshotBalance = Number(live).toFixed(2);
      source = "plaid";
      accountId = acct.id;
      accountName = acct.name;
      accountMask = acct.mask;
      // Mirror into per-account snapshot map (#296) so the Chase
      // page can anchor balance math for this account too.
      const prevMap = (
        await db
          .select({ accountSnapshots: forecastSettingsTable.accountSnapshots })
          .from(forecastSettingsTable)
          .where(eq(forecastSettingsTable.userId, ownerUserId))
      )[0]?.accountSnapshots ?? {};
      const nextMap = {
        ...prevMap,
        [acct.id]: {
          balance: snapshotBalance,
          at: new Date().toISOString(),
          source: "plaid" as const,
          name: acct.name,
          mask: acct.mask,
        },
      };
      await db
        .update(forecastSettingsTable)
        .set({ accountSnapshots: nextMap })
        .where(eq(forecastSettingsTable.userId, ownerUserId));
    } catch (e) {
      const { code: plaidCode, message: plaidMsg } = extractPlaidError(e);
      req.log.error({ err: e, code: plaidCode }, "accountsBalanceGet failed");
      // (#655) Mirror the /plaid/link-token/update catch (#654): if Plaid
      // rejects the stored access_token at runtime (e.g. after a server
      // credential rotation), surface the same 409 + relink shape the
      // preflight guards above produce so the Reconnect button's recovery
      // path is consistent everywhere — not a dead-end 502.
      if (plaidCode && PLAID_REAUTH_ERROR_CODES.has(plaidCode)) {
        await markItemMalformedToken(item.id, {
          code: plaidCode,
          message: plaidMsg,
        });
        res.status(409).json({
          error: plaidMsg,
          code: plaidCode,
          action: "relink",
          account: { name: acct.name ?? null, mask: acct.mask ?? null },
        });
        return;
      }
      const msg = e instanceof Error ? e.message : "Plaid balance fetch failed";
      res.status(502).json({ error: msg });
      return;
    }
  } else if (typeof balance === "string" && balance.length > 0) {
    const n = Number(balance);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "Invalid balance" });
      return;
    }
    snapshotBalance = n.toFixed(2);
    source = "manual";
  } else {
    res.status(400).json({ error: "balance or plaidAccountId required" });
    return;
  }

  const at = new Date();
  const [row] = await db
    .update(forecastSettingsTable)
    .set({
      bankSnapshotBalance: snapshotBalance,
      bankSnapshotAt: at,
      bankSnapshotSource: source,
      bankSnapshotAccountId: accountId,
      bankSnapshotName: accountName,
      bankSnapshotMask: accountMask,
      updatedAt: new Date(),
    })
    .where(eq(forecastSettingsTable.userId, ownerUserId))
    .returning();
  res.json(presentSnapshot(row));
});

router.post("/forecast/refresh-bank", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId!;
  const settings = await ensureSettings(ownerUserId, householdId);
  // #296 — accept an optional `plaidAccountId` so the Chase page can
  // refresh whichever account the user is currently viewing, not just
  // the primary snapshot account. Falls back to the primary account
  // when the body is absent (legacy Forecast-page behavior).
  const requestedId =
    typeof req.body?.plaidAccountId === "string" && req.body.plaidAccountId
      ? String(req.body.plaidAccountId)
      : settings.bankSnapshotAccountId;
  if (!requestedId) {
    res.status(400).json({ error: "No checking account linked. Set one first." });
    return;
  }
  const [acct] = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.id, requestedId),
        eq(plaidAccountsTable.householdId, householdId),
      ),
    );
  if (!acct) {
    res.status(404).json({ error: "Linked checking account no longer exists" });
    return;
  }
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.id, acct.itemId));
  if (!item) {
    res.status(404).json({ error: "Plaid item not found" });
    return;
  }
  // (#654) Same preflight token guards as the snapshot-set endpoint
  // above. /forecast/refresh-bank is the most common manual recovery
  // path users tap when their Plaid balance is stale, so a stuck
  // env-mismatched item must surface as a Reconnect-actionable 409
  // here too — not a generic 502 that the user has nowhere to go from.
  if (!isValidPlaidAccessToken(item.accessToken)) {
    await markItemMalformedToken(item.id);
    res.status(409).json({
      error: MALFORMED_PLAID_TOKEN_MESSAGE,
      code: "ITEM_LOGIN_REQUIRED",
      action: "relink",
      account: { name: acct.name ?? null, mask: acct.mask ?? null },
    });
    return;
  }
  if (!isAccessTokenForCurrentEnv(item.accessToken)) {
    await markItemMalformedToken(item.id, {
      code: "INVALID_ACCESS_TOKEN",
      message: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
    });
    res.status(409).json({
      error: ENV_MISMATCH_PLAID_TOKEN_MESSAGE,
      code: "INVALID_ACCESS_TOKEN",
      action: "relink",
      account: { name: acct.name ?? null, mask: acct.mask ?? null },
    });
    return;
  }
  try {
    const resp = await plaid().accountsBalanceGet({
      access_token: item.accessToken,
      options: { account_ids: [acct.accountId] },
    });
    const a = resp.data.accounts.find((x) => x.account_id === acct.accountId);
    const live = a?.balances.available ?? a?.balances.current;
    if (live == null) {
      // Task #385 — distinguish the "this Plaid account doesn't expose
      // a refreshable balance" case (e.g. brokerage sub-accounts) from
      // a generic Plaid outage so the client can show an account-aware
      // toast naming the row that failed and offering a manual fallback.
      res.status(502).json({
        error: "Plaid did not return a balance",
        code: "no_balance",
        account: { name: acct.name ?? null, mask: acct.mask ?? null },
      });
      return;
    }
    const at = new Date();
    const balanceStr = Number(live).toFixed(2);
    // Always upsert the per-account snapshot (#296) so the Chase page
    // anchor for this account picks up the fresh value.
    const accountSnapshots = {
      ...(settings.accountSnapshots ?? {}),
      [acct.id]: {
        balance: balanceStr,
        at: at.toISOString(),
        source: "plaid" as const,
        name: acct.name,
        mask: acct.mask,
      },
    };
    // If this is the primary snapshot account (or no primary is set
    // yet), also update the legacy bankSnapshot* columns so the
    // Forecast page / cash-signal anchor advances too.
    const isPrimary =
      !settings.bankSnapshotAccountId ||
      settings.bankSnapshotAccountId === acct.id;
    const update: Record<string, unknown> = {
      accountSnapshots,
      updatedAt: new Date(),
    };
    if (isPrimary) {
      update.bankSnapshotBalance = balanceStr;
      update.bankSnapshotAt = at;
      update.bankSnapshotSource = "plaid";
      update.bankSnapshotAccountId = acct.id;
      update.bankSnapshotName = acct.name;
      update.bankSnapshotMask = acct.mask;
    }
    const [row] = await db
      .update(forecastSettingsTable)
      .set(update)
      .where(eq(forecastSettingsTable.userId, ownerUserId))
      .returning();
    // Keep the response shape backward-compatible (BankSnapshot). When
    // refreshing a non-primary account, synthesize the snapshot
    // payload from the per-account map entry rather than the legacy
    // primary columns so the client sees the freshly-refreshed value.
    if (isPrimary) {
      res.json(presentSnapshot(row));
    } else {
      res.json({
        balance: balanceStr,
        at: at.toISOString(),
        source: "plaid",
        accountId: acct.id,
        name: acct.name,
        mask: acct.mask,
      });
    }
  } catch (e) {
    const { code: plaidCode, message: plaidMsg } = extractPlaidError(e);
    req.log.error({ err: e, code: plaidCode }, "refresh-bank failed");
    // (#655) See the matching catch in /forecast/bank-snapshot above.
    // Translate runtime Plaid reauth errors (INVALID_ACCESS_TOKEN /
    // ITEM_LOGIN_REQUIRED / PENDING_*) into the same 409 + relink shape
    // the preflight guards produce so the Reconnect button always has a
    // recovery path here too.
    if (plaidCode && PLAID_REAUTH_ERROR_CODES.has(plaidCode)) {
      await markItemMalformedToken(item.id, {
        code: plaidCode,
        message: plaidMsg,
      });
      res.status(409).json({
        error: plaidMsg,
        code: plaidCode,
        action: "relink",
        account: { name: acct.name ?? null, mask: acct.mask ?? null },
      });
      return;
    }
    const msg = e instanceof Error ? e.message : "Plaid balance fetch failed";
    res.status(502).json({ error: msg });
  }
});

// (#410) Maintenance endpoint: collapse duplicate `plaid_accounts`
// rows for the calling user. User-scoped so the affected user can hit
// it without admin tooling. Idempotent — running it on a clean account
// reports zero changes.
router.post(
  "/forecast/dedupe-plaid-accounts",
  requireAuth,
  async (req, res): Promise<void> => {
    const report = await dedupePlaidAccountsForUser(req.userId!);
    res.json(report);
  },
);

// (#452) Maintenance endpoint: collapse duplicate `transactions` rows
// across every Plaid account belonging to the calling user. Same key
// as the /transactions/sync post-upsert pass — `(userId, plaidAccountId,
// occurredOn, amount, normalizedDescription)` — so it's safe to run
// at any time. Idempotent: a clean ledger reports zero duplicates.
router.post(
  "/forecast/dedupe-transactions",
  requireAuth,
  async (req, res): Promise<void> => {
    const report = await dedupeTransactionsForUser(req.userId!);
    res.json(report);
  },
);

// (#470) Read-only twin of the dedupe-transactions endpoint: returns
// how many duplicate rows the cleanup would remove if it ran right
// now, without mutating anything. Used by the Settings badge so the
// "Clean up duplicate transactions" row can show "12 duplicates
// found" / hide the button when there's nothing to clean.
router.get(
  "/forecast/duplicate-transaction-count",
  requireAuth,
  async (req, res): Promise<void> => {
    const result = await countDuplicateTransactionsForUser(req.userId!);
    res.json(result);
  },
);

router.post("/forecast/resolutions", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const householdId = req.householdId!;
  const { recurringItemId, occurrenceDate, status, matchedTxnId, rescheduledTo } =
    req.body ?? {};
  if (!status) {
    res.status(400).json({ error: "status required" });
    return;
  }
  if (rescheduledTo != null) {
    if (typeof rescheduledTo !== "string" || !ISO_DATE_RE.test(rescheduledTo)) {
      res.status(400).json({ error: "invalid rescheduledTo (YYYY-MM-DD)" });
      return;
    }
  }
  if (status === "rescheduled") {
    if (!recurringItemId || !occurrenceDate || !rescheduledTo) {
      res.status(400).json({
        error: "rescheduled requires recurringItemId, occurrenceDate, rescheduledTo",
      });
      return;
    }
    // (#888) Allow moving an occurrence EARLIER or later than its original
    // date — Brad wants to freely reschedule within the forecast window.
    // We no longer require rescheduledTo > occurrenceDate. We do bound it to
    // a sane window (today-1d .. today+60d) so it can't be set to an
    // arbitrary far-off date; earlier-than-original is allowed inside it.
    const isoOf = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const lower = new Date();
    lower.setDate(lower.getDate() - 1);
    const upper = new Date();
    upper.setDate(upper.getDate() + 60);
    if (rescheduledTo < isoOf(lower) || rescheduledTo > isoOf(upper)) {
      res
        .status(400)
        .json({ error: "rescheduledTo out of allowed window" });
      return;
    }
  }

  if (recurringItemId && occurrenceDate) {
    await db
      .delete(forecastResolutionsTable)
      .where(
        and(
          eq(forecastResolutionsTable.householdId, householdId),
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
          eq(forecastResolutionsTable.householdId, householdId),
          eq(forecastResolutionsTable.matchedTxnId, matchedTxnId),
        ),
      );
  }

  const [row] = await db
    .insert(forecastResolutionsTable)
    .values({
      userId,
      householdId,
      recurringItemId: recurringItemId ?? null,
      occurrenceDate: occurrenceDate ?? null,
      status,
      matchedTxnId: matchedTxnId ?? null,
      rescheduledTo: rescheduledTo ?? null,
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
          eq(forecastResolutionsTable.householdId, req.householdId!),
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
    const householdId = req.householdId!;
    const ownerUserId = req.householdOwnerId!;
    const body = req.body ?? {};
    const monthKey = body.monthKey;
    if (!monthKey) {
      res.status(400).json({ error: "monthKey required" });
      return;
    }
    const [row] = await db
      .insert(forecastClosedMonthsTable)
      .values({ userId, householdId, monthKey })
      .onConflictDoUpdate({
        target: [
          forecastClosedMonthsTable.householdId,
          forecastClosedMonthsTable.monthKey,
        ],
        set: { monthKey },
      })
      .returning();

    // Freeze the current snapshot into monthSnapshots[monthKey], including the
    // reconcile state at close time so prior months can be displayed with a
    // ✓/gap badge later.
    const settings = await ensureSettings(ownerUserId, householdId);
    if (settings.bankSnapshotBalance != null && settings.bankSnapshotAt) {
      const closedAt = new Date().toISOString();
      const entry: {
        balance: string;
        at: string;
        gap?: string;
        forecastEnd?: string;
        bankEnd?: string;
        pending?: number;
        reconciled?: boolean;
        closedAt?: string;
      } = {
        balance: settings.bankSnapshotBalance,
        at: settings.bankSnapshotAt.toISOString(),
        closedAt,
      };
      const normNum = (v: unknown): string | undefined => {
        if (typeof v !== "string") return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) return undefined;
        return n.toFixed(2);
      };
      const g = normNum(body.gap);
      const fe = normNum(body.forecastEnd);
      const be = normNum(body.bankEnd);
      if (g !== undefined) entry.gap = g;
      if (fe !== undefined) entry.forecastEnd = fe;
      if (be !== undefined) entry.bankEnd = be;
      if (typeof body.pending === "number" && Number.isInteger(body.pending) && body.pending >= 0)
        entry.pending = body.pending;
      if (typeof body.reconciled === "boolean") entry.reconciled = body.reconciled;
      const monthSnapshots = {
        ...(settings.monthSnapshots ?? {}),
        [String(monthKey)]: entry,
      };
      await db
        .update(forecastSettingsTable)
        .set({ monthSnapshots, updatedAt: new Date() })
        .where(eq(forecastSettingsTable.userId, ownerUserId));
    }

    res.json(row);
  },
);

router.delete(
  "/forecast/closed-months/:monthKey",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const ownerUserId = req.householdOwnerId!;
    const monthKey = String(req.params.monthKey);
    await db
      .delete(forecastClosedMonthsTable)
      .where(
        and(
          eq(forecastClosedMonthsTable.householdId, householdId),
          eq(forecastClosedMonthsTable.monthKey, monthKey),
        ),
      );
    // Drop the frozen snapshot for this month, if any
    const settings = await ensureSettings(ownerUserId, householdId);
    if (settings.monthSnapshots && monthKey in settings.monthSnapshots) {
      const monthSnapshots = { ...settings.monthSnapshots };
      delete monthSnapshots[monthKey];
      await db
        .update(forecastSettingsTable)
        .set({ monthSnapshots, updatedAt: new Date() })
        .where(eq(forecastSettingsTable.userId, ownerUserId));
    }
    res.sendStatus(204);
  },
);

void sql;

export default router;
