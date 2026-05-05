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
} from "../lib/debtMinSchedule";
import { plaid } from "../lib/plaid";
import { archiveExpiredOneTime } from "./bills";

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

async function listCheckingAccounts(userId: string) {
  const rows = await db
    .select({
      id: plaidAccountsTable.id,
      accountId: plaidAccountsTable.accountId,
      name: plaidAccountsTable.name,
      mask: plaidAccountsTable.mask,
      subtype: plaidAccountsTable.subtype,
      type: plaidAccountsTable.type,
      institutionName: plaidItemsTable.institutionName,
    })
    .from(plaidAccountsTable)
    .leftJoin(plaidItemsTable, eq(plaidAccountsTable.itemId, plaidItemsTable.id))
    .where(eq(plaidAccountsTable.userId, userId));
  return rows
    .filter(
      (a) =>
        a.subtype === "checking" ||
        a.type === "depository" ||
        a.subtype === "savings",
    )
    .map((a) => ({
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
  const settings = await ensureSettings(userId);
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
      res.status(502).json({ error: "Plaid did not return a balance" });
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
