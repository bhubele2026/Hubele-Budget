import { Router, type IRouter } from "express";
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
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  computeCashSignal,
  expandItem,
  fmtISO,
  addDays,
  type CashEvent,
} from "../lib/cashSignal";
import {
  buildDebtMinSchedule,
  expandDebtMin,
  expandAvalancheExtra,
} from "../lib/debtMinSchedule";
import { plaid } from "../lib/plaid";
import { archiveExpiredOneTime } from "./bills";
import {
  dedupePlaidAccountsForUser,
  runAutoDedupeIfNeeded,
} from "../lib/dedupePlaidAccounts";
import {
  dedupeTransactionsForUser,
  dedupeTransactionsAcrossAccountsForUser,
} from "../lib/dedupeTransactions";

const router: IRouter = Router();

async function ensureSettings(userId: string) {
  const [row] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, userId));
  if (row) return row;
  // Upsert to avoid PK collisions when parallel requests for the same fresh
  // user race past the SELECT (mirrors the fix in avalanche.ts).
  const [created] = await db
    .insert(forecastSettingsTable)
    .values({ userId })
    .onConflictDoUpdate({
      target: forecastSettingsTable.userId,
      set: { userId },
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

export async function listCheckingAccounts(userId: string) {
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
    .where(eq(forecastSettingsTable.userId, userId));
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
    .where(eq(plaidAccountsTable.userId, userId));
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

router.get("/forecast", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  await archiveExpiredOneTime(userId);
  let settings = await ensureSettings(userId);
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
    settings = await ensureSettings(userId);
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
              eq(forecastSettingsTable.userId, userId),
              eq(
                forecastSettingsTable.bankSnapshotAccountId,
                settings.bankSnapshotAccountId,
              ),
            ),
          );
        settings = await ensureSettings(userId);
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
  const days = Number(req.query.days) || settings.daysAhead || 90;

  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const to = addDays(today, days);
  const fromISO = fmtISO(from);
  const toISO = fmtISO(to);

  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, userId));

  const debtsList = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId));

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
    .where(eq(avalancheSettingsTable.userId, userId));
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
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.forecastFlag, true),
        gte(transactionsTable.occurredOn, fromISO),
        lte(transactionsTable.occurredOn, toISO),
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
    .where(eq(forecastResolutionsTable.userId, userId));

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
    .where(eq(forecastClosedMonthsTable.userId, userId));

  const cashSignal = await computeCashSignal(userId);
  const plaidCheckingAccounts = await listCheckingAccounts(userId);

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
  });
});

router.get("/forecast/settings", requireAuth, async (req, res): Promise<void> => {
  const s = await ensureSettings(req.userId!);
  res.json(presentSettings(s));
});

router.put("/forecast/settings", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureSettings(userId);
  const body = req.body ?? {};
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.daysAhead === "number") update.daysAhead = body.daysAhead;
  if (typeof body.startingBalance === "string")
    update.startingBalance = body.startingBalance;
  if (typeof body.cashBuffer === "string") update.cashBuffer = body.cashBuffer;
  const [row] = await db
    .update(forecastSettingsTable)
    .set(update)
    .where(eq(forecastSettingsTable.userId, userId))
    .returning();
  res.json(presentSettings(row));
});

const ALLOWED_HORIZON_DAYS = new Set([30, 90, 120, 183, 365]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/forecast/cash-signal", requireAuth, async (req, res): Promise<void> => {
  let horizonDays: number | undefined;
  if (req.query.horizonDays != null) {
    const n = Number(req.query.horizonDays);
    if (!Number.isFinite(n) || !ALLOWED_HORIZON_DAYS.has(n)) {
      res.status(400).json({
        error: "invalid horizonDays (allowed: 30, 90, 120, 183, 365)",
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
  const signal = await computeCashSignal(req.userId!, { horizonDays, fromDate });
  res.json(signal);
});

router.post("/forecast/bank-snapshot", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureSettings(userId);
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
          eq(plaidAccountsTable.userId, userId),
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
    try {
      const resp = await plaid().accountsBalanceGet({
        access_token: item.accessToken,
        options: { account_ids: [acct.accountId] },
      });
      const a = resp.data.accounts.find((x) => x.account_id === acct.accountId);
      const live = a?.balances.available ?? a?.balances.current;
      if (live == null) {
        res.status(502).json({ error: "Plaid did not return a balance" });
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
          .where(eq(forecastSettingsTable.userId, userId))
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
        .where(eq(forecastSettingsTable.userId, userId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Plaid balance fetch failed";
      req.log.error({ err: e }, "accountsBalanceGet failed");
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
    .where(eq(forecastSettingsTable.userId, userId))
    .returning();
  res.json(presentSnapshot(row));
});

router.post("/forecast/refresh-bank", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const settings = await ensureSettings(userId);
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
        eq(plaidAccountsTable.userId, userId),
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
      .where(eq(forecastSettingsTable.userId, userId))
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
    const msg = e instanceof Error ? e.message : "Plaid balance fetch failed";
    req.log.error({ err: e }, "refresh-bank failed");
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

router.post("/forecast/resolutions", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
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
    if (rescheduledTo <= occurrenceDate) {
      res
        .status(400)
        .json({ error: "rescheduledTo must be after occurrenceDate" });
      return;
    }
  }

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
    const body = req.body ?? {};
    const monthKey = body.monthKey;
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

    // Freeze the current snapshot into monthSnapshots[monthKey], including the
    // reconcile state at close time so prior months can be displayed with a
    // ✓/gap badge later.
    const settings = await ensureSettings(userId);
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
        .where(eq(forecastSettingsTable.userId, userId));
    }

    res.json(row);
  },
);

router.delete(
  "/forecast/closed-months/:monthKey",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const monthKey = String(req.params.monthKey);
    await db
      .delete(forecastClosedMonthsTable)
      .where(
        and(
          eq(forecastClosedMonthsTable.userId, userId),
          eq(forecastClosedMonthsTable.monthKey, monthKey),
        ),
      );
    // Drop the frozen snapshot for this month, if any
    const settings = await ensureSettings(userId);
    if (settings.monthSnapshots && monthKey in settings.monthSnapshots) {
      const monthSnapshots = { ...settings.monthSnapshots };
      delete monthSnapshots[monthKey];
      await db
        .update(forecastSettingsTable)
        .set({ monthSnapshots, updatedAt: new Date() })
        .where(eq(forecastSettingsTable.userId, userId));
    }
    res.sendStatus(204);
  },
);

void sql;

export default router;
