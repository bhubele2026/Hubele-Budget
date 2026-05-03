import { Router, type IRouter } from "express";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
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
import { plaid } from "../lib/plaid";
import { archiveExpiredOneTime } from "./bills";

const router: IRouter = Router();

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

  const resolutions = resolutionRows.filter(
    (r) => !r.matchedTxnId || r.txnForecastFlag !== false,
  );

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

const ALLOWED_HORIZON_DAYS = new Set([30, 60, 90, 183, 365]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/forecast/cash-signal", requireAuth, async (req, res): Promise<void> => {
  let horizonDays: number | undefined;
  if (req.query.horizonDays != null) {
    const n = Number(req.query.horizonDays);
    if (!Number.isFinite(n) || !ALLOWED_HORIZON_DAYS.has(n)) {
      res.status(400).json({
        error: "invalid horizonDays (allowed: 30, 60, 90, 183, 365)",
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
  if (!settings.bankSnapshotAccountId) {
    res.status(400).json({ error: "No checking account linked. Set one first." });
    return;
  }
  // Reuse the same flow as bank-snapshot
  req.body = { plaidAccountId: settings.bankSnapshotAccountId };
  // Forward
  const [acct] = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.id, settings.bankSnapshotAccountId),
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
    const [row] = await db
      .update(forecastSettingsTable)
      .set({
        bankSnapshotBalance: Number(live).toFixed(2),
        bankSnapshotAt: at,
        bankSnapshotSource: "plaid",
        bankSnapshotAccountId: acct.id,
        bankSnapshotName: acct.name,
        bankSnapshotMask: acct.mask,
        updatedAt: new Date(),
      })
      .where(eq(forecastSettingsTable.userId, userId))
      .returning();
    res.json(presentSnapshot(row));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Plaid balance fetch failed";
    req.log.error({ err: e }, "refresh-bank failed");
    res.status(502).json({ error: msg });
  }
});

router.post("/forecast/resolutions", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const { recurringItemId, occurrenceDate, status, matchedTxnId } = req.body ?? {};
  if (!status) {
    res.status(400).json({ error: "status required" });
    return;
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
