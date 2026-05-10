import { Router, type IRouter } from "express";
import { and, desc, eq, asc, gt, gte, sql, inArray, isNull, isNotNull } from "drizzle-orm";
import {
  db,
  debtsTable,
  debtBalanceHistoryTable,
  transactionsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateDebtBody,
  UpdateDebtBody,
  UpdateDebtParams,
  DeleteDebtParams,
  CreateDebtPaymentBody,
  CreateDebtPaymentParams,
} from "@workspace/api-zod";
import { fetchLiabilitiesForItem } from "../lib/plaidLiabilities";

const router: IRouter = Router();

const REFRESH_STALE_MS = 60 * 60 * 1000; // 1 hour

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function recordBalanceSnapshot(
  userId: string,
  householdId: string,
  debtId: string,
  balance: string | number,
): Promise<void> {
  const balStr =
    typeof balance === "number" ? balance.toFixed(2) : String(balance);
  await db
    .insert(debtBalanceHistoryTable)
    .values({
      userId,
      householdId,
      debtId,
      recordedOn: todayISO(),
      balance: balStr,
    })
    .onConflictDoNothing({
      target: [
        debtBalanceHistoryTable.householdId,
        debtBalanceHistoryTable.debtId,
        debtBalanceHistoryTable.recordedOn,
      ],
    });
}

export class AprValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AprValidationError";
  }
}

// APR is stored and consumed as a *decimal* (e.g. 0.2499 for 24.99%). A user
// sending the percentage form (e.g. 24.99) would be interpreted as 2,499%
// APR by the simulator, breaking the whole avalanche page. Reject anything
// outside [0, 1) with a clear message so the bad value never reaches the DB.
export function validateAprDecimal(apr: unknown): void {
  if (apr === undefined || apr === null) return;
  const n = typeof apr === "number" ? apr : Number(apr);
  if (!Number.isFinite(n)) {
    throw new AprValidationError("APR must be a number");
  }
  if (n < 0) {
    throw new AprValidationError("APR must be ≥ 0");
  }
  if (n >= 1) {
    throw new AprValidationError(
      `APR must be a decimal — e.g. 0.2499 for 24.99% (got ${n})`,
    );
  }
}

function normalize<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (typeof out.lastBalanceUpdate === "string") {
    out.lastBalanceUpdate = new Date(out.lastBalanceUpdate as string);
  }
  if ("apr" in out) {
    validateAprDecimal(out.apr);
  }
  return out;
}

type DebtRow = typeof debtsTable.$inferSelect;
type AccountRow = typeof plaidAccountsTable.$inferSelect;
type ItemRow = typeof plaidItemsTable.$inferSelect;

async function loadAccountContext(
  householdId: string,
  accountIds: string[],
): Promise<{ accountById: Map<string, AccountRow>; itemById: Map<string, ItemRow> }> {
  if (accountIds.length === 0) {
    return { accountById: new Map(), itemById: new Map() };
  }
  const accounts = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.householdId, householdId),
        inArray(plaidAccountsTable.id, accountIds),
      ),
    );
  const itemIds = Array.from(new Set(accounts.map((a) => a.itemId)));
  const items =
    itemIds.length > 0
      ? await db
          .select()
          .from(plaidItemsTable)
          .where(
            and(
              eq(plaidItemsTable.householdId, householdId),
              inArray(plaidItemsTable.id, itemIds),
            ),
          )
      : [];
  return {
    accountById: new Map(accounts.map((a) => [a.id, a])),
    itemById: new Map(items.map((i) => [i.id, i])),
  };
}

// (#421) Pending-payment decrement: payments tagged to a debt that the
// creditor hasn't yet reflected in `balance`. The cutoff is the debt's last
// creditor-reported balance timestamp — `plaidLastSyncedAt` for Plaid-sourced
// debts, `lastBalanceUpdate` for manual ones. Anything tagged after that
// counts as pending; once Plaid (or a manual edit) reports a fresher balance
// the cutoff advances and the same payments fall out of the window
// automatically. No write-time bookkeeping required.
type PendingEntry = { total: number; count: number };

function pendingCutoffForDebt(d: DebtRow): Date | null {
  if (d.balanceSource === "plaid" && d.plaidAccountId) {
    return d.plaidLastSyncedAt ?? null;
  }
  return d.lastBalanceUpdate ?? null;
}

async function loadPendingPayments(
  householdId: string,
  debts: DebtRow[],
): Promise<Map<string, PendingEntry>> {
  const out = new Map<string, PendingEntry>();
  if (debts.length === 0) return out;
  const ids = debts.map((d) => d.id);
  const rows = await db
    .select({
      debtId: transactionsTable.debtId,
      amount: transactionsTable.amount,
      occurredOn: transactionsTable.occurredOn,
      occurredAt: transactionsTable.occurredAt,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        isNotNull(transactionsTable.debtId),
        inArray(transactionsTable.debtId, ids),
        // payment-direction (positive amount): pays down the debt
        gt(transactionsTable.amount, "0"),
      ),
    );
  const cutoffByDebt = new Map<string, Date | null>();
  for (const d of debts) cutoffByDebt.set(d.id, pendingCutoffForDebt(d));
  for (const r of rows) {
    if (!r.debtId) continue;
    const cutoff = cutoffByDebt.get(r.debtId) ?? null;
    // Use the timestamp when present so a same-day Plaid refresh dated
    // earlier in the day correctly clears earlier payments. Fall back to
    // end-of-day for the date-only column so a tagged payment dated the
    // same day as the cutoff still counts as "after".
    const txnTs = r.occurredAt
      ? new Date(r.occurredAt)
      : new Date(`${r.occurredOn}T23:59:59.999Z`);
    if (cutoff && txnTs.getTime() <= cutoff.getTime()) continue;
    const amt = Number(r.amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const cur = out.get(r.debtId) ?? { total: 0, count: 0 };
    cur.total += amt;
    cur.count += 1;
    out.set(r.debtId, cur);
  }
  return out;
}

function shapeDebt(
  d: DebtRow,
  accountById: Map<string, AccountRow>,
  itemById: Map<string, ItemRow>,
  pendingByDebt: Map<string, PendingEntry> = new Map(),
) {
  const acct = d.plaidAccountId ? accountById.get(d.plaidAccountId) : null;
  const item = acct ? itemById.get(acct.itemId) : null;
  const pending = pendingByDebt.get(d.id) ?? null;
  return {
    ...d,
    pendingPaymentTotal: pending && pending.total > 0 ? pending.total.toFixed(2) : null,
    pendingPaymentCount: pending && pending.count > 0 ? pending.count : null,
    lastBalanceUpdate: d.lastBalanceUpdate
      ? d.lastBalanceUpdate.toISOString()
      : null,
    plaidLastSyncedAt: d.plaidLastSyncedAt
      ? d.plaidLastSyncedAt.toISOString()
      : null,
    // (#43) Surface the parent Plaid item's last sync error on the debt so
    // the debts/avalanche UI can warn that balance/APR/min-payment values
    // may be stale (e.g. ITEM_LOGIN_REQUIRED). null when healthy or
    // when the debt isn't Plaid-linked.
    plaidLastSyncError:
      d.plaidAccountId && item?.lastSyncError ? item.lastSyncError : null,
    // (#198) Mirror the parent item's structured `error_code` so the Debts /
    // Avalanche rows can decide whether to render an inline Reconnect
    // affordance. The string `lastSyncError` above is for the human-readable
    // chip; this code is what drives the re-auth UI gate (matches the set
    // in PLAID_REAUTH_ERROR_CODES on both client and server).
    plaidLastSyncErrorCode:
      d.plaidAccountId && item?.lastSyncErrorCode
        ? item.lastSyncErrorCode
        : null,
    // (#238) Mirror the parent Plaid item's `consent_expiration_time` so
    // the inline DebtReauthBanner can show the dated PENDING_EXPIRATION /
    // PENDING_DISCONNECT subline ("Chase will disconnect on May 21 —
    // reconnect now to keep it linked.") instead of the date-less
    // fallback. Null when the debt isn't Plaid-linked or Plaid never
    // reported a cutoff for this item.
    plaidConsentExpirationAt:
      d.plaidAccountId && item?.consentExpirationAt
        ? item.consentExpirationAt.toISOString()
        : null,
    // (#320) Mirror the parent item's consent-refresh failure so the
    // inline DebtReauthBanner can warn that the disconnect-date check
    // itself has been failing — not just /transactions/sync. Surfaced
    // alongside `plaidLastSyncError` (separate field so a healthy sync
    // doesn't erase a stale consent-refresh failure and vice versa).
    plaidConsentExpirationLastRefreshError:
      d.plaidAccountId && item?.consentExpirationLastRefreshError
        ? item.consentExpirationLastRefreshError
        : null,
    plaidAccount: acct
      ? {
          id: acct.id,
          // (#198) Surface parent Plaid item row id so <PlaidReconnectButton>
          // can mint an update-mode link token without an extra round trip.
          itemId: acct.itemId,
          name: acct.name,
          mask: acct.mask,
          type: acct.type,
          subtype: acct.subtype,
          liabilityKind: acct.liabilityKind,
          institutionName: item?.institutionName ?? null,
          institutionSlug: item?.institutionSlug ?? null,
        }
      : null,
  };
}

/**
 * Apply cached Plaid liability values to a debt.
 * - On `mode='adopt'` (initial link): claim every field Plaid actually
 *   returned, marking that field's source as 'plaid'. Fields Plaid did not
 *   return stay manual.
 * - On `mode='refresh'` (subsequent syncs): only overwrite fields whose
 *   current source is already 'plaid'. Manual overrides are preserved.
 */
async function applyLiabilityToDebt(
  userId: string,
  householdId: string,
  debt: DebtRow,
  mode: "adopt" | "refresh" = "refresh",
  stampSync: boolean = true,
): Promise<DebtRow> {
  if (!debt.plaidAccountId) return debt;
  const [acct] = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.id, debt.plaidAccountId),
        eq(plaidAccountsTable.householdId, householdId),
      ),
    );
  if (!acct) return debt;
  const patch: Partial<typeof debtsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (stampSync) patch.plaidLastSyncedAt = new Date();
  const allowBalance = mode === "adopt" || debt.balanceSource === "plaid";
  const allowApr = mode === "adopt" || debt.aprSource === "plaid";
  const allowMin = mode === "adopt" || debt.minPaymentSource === "plaid";
  if (allowBalance && acct.liabilityBalance != null) {
    patch.balance = acct.liabilityBalance;
    patch.balanceSource = "plaid";
    patch.lastBalanceUpdate = new Date();
    // Anchor the original balance the first time we ever see one for this
    // debt so the avalanche progress bar has a stable denominator. We never
    // overwrite an existing anchor — the original is by definition the
    // highest known balance at adoption time.
    if (debt.originalBalance == null) {
      patch.originalBalance = acct.liabilityBalance;
    }
    // (#292) Auto-archive when Plaid reports the balance hit zero so the
    // Bills "Stops at payoff" celebratory row fires automatically. Without
    // this the user has to manually flip status='archived' for the row to
    // appear, and most paid-off debts would silently slip past it.
    if (
      debt.status === "active" &&
      Number(acct.liabilityBalance) <= 0.005
    ) {
      patch.status = "archived";
    }
  }
  if (allowApr && acct.liabilityApr != null) {
    validateAprDecimal(acct.liabilityApr);
    patch.apr = acct.liabilityApr;
    patch.aprSource = "plaid";
  }
  if (allowMin && acct.liabilityMinPayment != null) {
    patch.minPayment = acct.liabilityMinPayment;
    patch.minPaymentSource = "plaid";
  }
  const [updated] = await db
    .update(debtsTable)
    .set(patch)
    .where(and(eq(debtsTable.id, debt.id), eq(debtsTable.householdId, householdId)))
    .returning();
  if (updated && patch.balance != null) {
    await recordBalanceSnapshot(userId, householdId, updated.id, updated.balance);
  }
  return updated ?? debt;
}

async function refreshLinkedDebt(
  userId: string,
  householdId: string,
  debt: DebtRow,
): Promise<{ debt: DebtRow; fetchOk: boolean; error?: unknown }> {
  if (!debt.plaidAccountId) return { debt, fetchOk: true };
  const [acct] = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.id, debt.plaidAccountId),
        eq(plaidAccountsTable.householdId, householdId),
      ),
    );
  if (!acct) return { debt, fetchOk: true };
  let fetchOk = true;
  let error: unknown = undefined;
  try {
    await fetchLiabilitiesForItem(userId, acct.itemId);
  } catch (e) {
    fetchOk = false;
    error = e;
  }
  // Only stamp plaidLastSyncedAt when the Plaid fetch actually succeeded —
  // otherwise the UI should keep showing the previous sync time and the
  // 1-hour staleness window remains open for retry.
  const updated = await applyLiabilityToDebt(userId, householdId, debt, "refresh", fetchOk);
  return { debt: updated, fetchOk, error };
}

router.get(
  "/debts/balance-history",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const rows = await db
      .select({
        debtId: debtBalanceHistoryTable.debtId,
        recordedOn: debtBalanceHistoryTable.recordedOn,
        balance: debtBalanceHistoryTable.balance,
      })
      .from(debtBalanceHistoryTable)
      .where(eq(debtBalanceHistoryTable.householdId, householdId))
      .orderBy(asc(debtBalanceHistoryTable.recordedOn));
    res.json(rows);
  },
);

router.get("/debts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const householdId = req.householdId!;
  let rows = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId))
    .orderBy(asc(debtsTable.sortOrder), desc(debtsTable.apr), asc(debtsTable.name));

  // Opportunistic refresh of stale linked debts
  const now = Date.now();
  const stale = rows.filter(
    (d) =>
      d.plaidAccountId &&
      (!d.plaidLastSyncedAt ||
        now - d.plaidLastSyncedAt.getTime() > REFRESH_STALE_MS),
  );
  if (stale.length > 0) {
    // Group by item so we only call /liabilities/get once per item
    const accountIds = stale
      .map((d) => d.plaidAccountId!)
      .filter((v, i, a) => a.indexOf(v) === i);
    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.householdId, householdId),
          inArray(plaidAccountsTable.id, accountIds),
        ),
      );
    const itemIds = Array.from(new Set(accts.map((a) => a.itemId)));
    const itemFetchOk = new Map<string, boolean>();
    for (const itemId of itemIds) {
      try {
        await fetchLiabilitiesForItem(userId, itemId);
        itemFetchOk.set(itemId, true);
      } catch {
        itemFetchOk.set(itemId, false);
      }
    }
    const itemByAccount = new Map(accts.map((a) => [a.id, a.itemId]));
    for (const d of stale) {
      const ok = itemFetchOk.get(itemByAccount.get(d.plaidAccountId!) ?? "") ?? false;
      // Don't break GET /debts if a single Plaid value is malformed — the
      // explicit /refresh endpoint surfaces that as a 400.
      try {
        await applyLiabilityToDebt(userId, householdId, d, "refresh", ok);
      } catch (e) {
        if (!(e instanceof AprValidationError)) throw e;
      }
    }
    rows = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.householdId, householdId))
      .orderBy(asc(debtsTable.sortOrder), desc(debtsTable.apr), asc(debtsTable.name));
  }

  // Ensure every active debt has at least one balance snapshot so the
  // reports thermometer and per-debt rings have a starting reference.
  for (const d of rows) {
    if (d.status !== "active") continue;
    await recordBalanceSnapshot(userId, householdId, d.id, d.balance);
  }

  // Backfill `originalBalance` for any debts that pre-date the column.
  // The original is the highest balance we've ever seen for the debt —
  // falling back to the current balance if no history exists. This makes
  // the avalanche progress bar show real paid-down progress immediately
  // for users who created their debts before this anchor existed.
  const needsBackfill = rows.filter((d) => d.originalBalance == null);
  if (needsBackfill.length > 0) {
    const ids = needsBackfill.map((d) => d.id);
    const peakRows = await db
      .select({
        debtId: debtBalanceHistoryTable.debtId,
        peak: sql<string>`max(${debtBalanceHistoryTable.balance})`,
      })
      .from(debtBalanceHistoryTable)
      .where(
        and(
          eq(debtBalanceHistoryTable.householdId, householdId),
          inArray(debtBalanceHistoryTable.debtId, ids),
        ),
      )
      .groupBy(debtBalanceHistoryTable.debtId);
    const peakById = new Map(peakRows.map((r) => [r.debtId, r.peak]));
    for (const d of needsBackfill) {
      const peak = Number(peakById.get(d.id) ?? 0);
      const cur = Number(d.balance);
      const original = Math.max(peak, cur).toFixed(2);
      await db
        .update(debtsTable)
        .set({ originalBalance: original })
        .where(
          and(
            eq(debtsTable.id, d.id),
            eq(debtsTable.householdId, householdId),
            isNull(debtsTable.originalBalance),
          ),
        );
      d.originalBalance = original;
    }
  }

  const accountIds = rows
    .map((r) => r.plaidAccountId)
    .filter((v): v is string => !!v);
  const { accountById, itemById } = await loadAccountContext(householdId, accountIds);
  const pendingByDebt = await loadPendingPayments(householdId, rows);
  res.json(
    rows.map((r) => shapeDebt(r, accountById, itemById, pendingByDebt)),
  );
});

router.post("/debts", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateDebtBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [{ maxOrder }] = await db
    .select({ maxOrder: sql<number>`coalesce(max(${debtsTable.sortOrder}), 0)` })
    .from(debtsTable)
    .where(eq(debtsTable.householdId, req.householdId!));
  let values: Record<string, unknown>;
  try {
    values = normalize({ ...parsed.data, userId: req.userId!, householdId: req.householdId! });
  } catch (e) {
    if (e instanceof AprValidationError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
  if (values.sortOrder == null) values.sortOrder = (maxOrder ?? 0) + 1;
  // Anchor original balance at create so /avalanche can show real
  // paid-down progress from day one.
  if (values.originalBalance == null && values.balance != null) {
    values.originalBalance = values.balance;
  }
  const [row] = await db
    .insert(debtsTable)
    .values(values as typeof debtsTable.$inferInsert)
    .returning();
  await recordBalanceSnapshot(req.userId!, req.householdId!, row.id, row.balance);
  const pendingByDebt = await loadPendingPayments(req.householdId!, [row]);
  res.status(201).json(shapeDebt(row, new Map(), new Map(), pendingByDebt));
});

router.post("/debts/sync-minimums", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const debts = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceISO = since.toISOString().slice(0, 10);
  const txns = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, sinceISO),
      ),
    );
  const updated: { id: string; name: string; oldMin: string; newMin: string }[] = [];
  for (const d of debts) {
    if (d.status !== "active") continue;
    if (d.minPaymentSource === "plaid") continue;
    const needle = d.name.toLowerCase();
    const matches = txns.filter((t) => {
      const desc = (t.description ?? "").toLowerCase();
      const amt = Number(t.amount);
      return amt < 0 && desc.includes(needle);
    });
    if (matches.length === 0) continue;
    matches.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
    const recent = Math.abs(Number(matches[0].amount));
    const oldMin = Number(d.minPayment);
    if (Math.abs(recent - oldMin) < 0.01) continue;
    const newMinStr = recent.toFixed(2);
    await db
      .update(debtsTable)
      .set({ minPayment: newMinStr, updatedAt: new Date() })
      .where(and(eq(debtsTable.id, d.id), eq(debtsTable.householdId, householdId)));
    updated.push({
      id: d.id,
      name: d.name,
      oldMin: oldMin.toFixed(2),
      newMin: newMinStr,
    });
  }
  res.json({ updated });
});

router.patch("/debts/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateDebtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateDebtBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Only flip the source flag to 'manual' when the user actually CHANGED a
  // synced field. Submitting the edit dialog unchanged should not turn a
  // Plaid-managed value into a manual override.
  const [current] = await db
    .select()
    .from(debtsTable)
    .where(
      and(eq(debtsTable.id, String(params.data.id)), eq(debtsTable.householdId, req.householdId!)),
    );
  if (!current) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const overrides: Record<string, unknown> = {};
  const changed = (a: unknown, b: unknown) =>
    a !== undefined && String(a) !== String(b);
  if (changed(parsed.data.balance, current.balance))
    overrides.balanceSource = "manual";
  // (#292) Auto-archive when a manual balance edit zeroes out an active
  // debt so the Bills "Stops at payoff" celebratory row fires without
  // requiring the user to also flip the status by hand. We only do this
  // when the user didn't already specify a status in the same patch, so
  // an explicit status='active' (e.g. un-archive) still wins.
  if (
    parsed.data.balance !== undefined &&
    Number(parsed.data.balance) <= 0.005 &&
    current.status === "active" &&
    parsed.data.status === undefined
  ) {
    overrides.status = "archived";
  }
  if (changed(parsed.data.apr, current.apr))
    overrides.aprSource = "manual";
  if (changed(parsed.data.minPayment, current.minPayment))
    overrides.minPaymentSource = "manual";
  let normalizedPatch: Record<string, unknown>;
  try {
    normalizedPatch = normalize(parsed.data);
  } catch (e) {
    if (e instanceof AprValidationError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
  const [row] = await db
    .update(debtsTable)
    .set({ ...normalizedPatch, ...overrides, updatedAt: new Date() })
    .where(
      and(eq(debtsTable.id, String(params.data.id)), eq(debtsTable.householdId, req.householdId!)),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (changed(parsed.data.balance, current.balance)) {
    await recordBalanceSnapshot(req.userId!, req.householdId!, row.id, row.balance);
    // If a manual edit pushes the balance above the recorded original
    // (or no original anchor exists yet), bump the anchor so progress
    // never goes negative.
    const newBal = Number(row.balance);
    const orig = row.originalBalance == null ? null : Number(row.originalBalance);
    if (orig == null || newBal > orig) {
      const next = newBal.toFixed(2);
      await db
        .update(debtsTable)
        .set({ originalBalance: next })
        .where(
          and(
            eq(debtsTable.id, row.id),
            eq(debtsTable.householdId, req.householdId!),
          ),
        );
      row.originalBalance = next;
    }
  }
  const accountIds = row.plaidAccountId ? [row.plaidAccountId] : [];
  const { accountById, itemById } = await loadAccountContext(req.householdId!, accountIds);
  const pendingByDebt = await loadPendingPayments(req.householdId!, [row]);
  res.json(shapeDebt(row, accountById, itemById, pendingByDebt));
});

router.post(
  "/debts/:id/link",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const householdId = req.householdId!;
    const debtId = String(req.params.id);
    const plaidAccountId = String(req.body?.plaidAccountId ?? "");
    if (!plaidAccountId) {
      res.status(400).json({ error: "plaidAccountId is required" });
      return;
    }
    const [debt] = await db
      .select()
      .from(debtsTable)
      .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)));
    if (!debt) {
      res.status(404).json({ error: "Debt not found" });
      return;
    }
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.id, plaidAccountId),
          eq(plaidAccountsTable.householdId, householdId),
        ),
      );
    if (!acct) {
      res.status(404).json({ error: "Plaid account not found" });
      return;
    }
    // Server-side debt-like guard.
    const debtSubtypes = new Set([
      "credit card", "paypal", "line of credit", "student", "mortgage",
      "home equity", "auto", "loan", "commercial", "construction",
      "consumer", "overdraft",
    ]);
    const sub = (acct.subtype ?? "").toLowerCase();
    const isDebtLike =
      !!acct.liabilityKind ||
      acct.type === "credit" ||
      acct.type === "loan" ||
      debtSubtypes.has(sub);
    if (!isDebtLike) {
      res.status(400).json({
        error: "Selected Plaid account does not look like a debt account",
      });
      return;
    }
    // Enforce one debt per Plaid account.
    const [taken] = await db
      .select({ id: debtsTable.id })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.householdId, householdId),
          eq(debtsTable.plaidAccountId, plaidAccountId),
        ),
      );
    if (taken && taken.id !== debtId) {
      res.status(409).json({
        error: "This Plaid account is already linked to another debt",
      });
      return;
    }
    // Refresh liabilities for the parent item so the cache is fresh.
    let fetchOk = true;
    try {
      await fetchLiabilitiesForItem(userId, acct.itemId);
    } catch {
      // Keep going with whatever cached values exist, but don't claim the
      // sync timestamp is fresh.
      fetchOk = false;
    }
    const [linked] = await db
      .update(debtsTable)
      .set({ plaidAccountId, updatedAt: new Date() })
      .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)))
      .returning();
    let refreshed;
    try {
      refreshed = await applyLiabilityToDebt(userId, householdId, linked, "adopt", fetchOk);
    } catch (e) {
      if (e instanceof AprValidationError) {
        // Roll back the link write so the debt isn't left half-attached
        // to a Plaid account whose APR we couldn't accept.
        await db
          .update(debtsTable)
          .set({
            plaidAccountId: debt.plaidAccountId,
            updatedAt: new Date(),
          })
          .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)));
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
    const { accountById, itemById } = await loadAccountContext(householdId, [plaidAccountId]);
    const pendingByDebt = await loadPendingPayments(householdId, [refreshed]);
    res.json(shapeDebt(refreshed, accountById, itemById, pendingByDebt));
  },
);

router.post(
  "/debts/:id/unlink",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const debtId = String(req.params.id);
    const [row] = await db
      .update(debtsTable)
      .set({
        plaidAccountId: null,
        plaidLastSyncedAt: null,
        balanceSource: "manual",
        aprSource: "manual",
        minPaymentSource: "manual",
        updatedAt: new Date(),
      })
      .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const pendingByDebt = await loadPendingPayments(householdId, [row]);
    res.json(shapeDebt(row, new Map(), new Map(), pendingByDebt));
  },
);

router.post(
  "/debts/:id/refresh",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const householdId = req.householdId!;
    const debtId = String(req.params.id);
    const [debt] = await db
      .select()
      .from(debtsTable)
      .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)));
    if (!debt) {
      res.status(404).json({ error: "Debt not found" });
      return;
    }
    if (!debt.plaidAccountId) {
      res.status(400).json({ error: "Debt is not linked to Plaid" });
      return;
    }
    let result;
    try {
      result = await refreshLinkedDebt(userId, householdId, debt);
    } catch (e) {
      if (e instanceof AprValidationError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
    if (!result.fetchOk) {
      res.status(502).json({
        error: "Failed to refresh from Plaid",
        detail: String(result.error ?? "unknown"),
      });
      return;
    }
    const { accountById, itemById } = await loadAccountContext(householdId, [
      result.debt.plaidAccountId!,
    ]);
    const pendingByDebt = await loadPendingPayments(householdId, [result.debt]);
    res.json(shapeDebt(result.debt, accountById, itemById, pendingByDebt));
  },
);

router.post(
  "/debts/:id/payments",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateDebtPaymentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateDebtPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const debtId = String(params.data.id);
    const userId = req.userId!;
    const householdId = req.householdId!;
    const amount = Number(parsed.data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be > 0" });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [debt] = await tx
        .select()
        .from(debtsTable)
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)));
      if (!debt) return null;
      const oldBal = Number(debt.balance);
      const newBal = Math.max(0, oldBal - amount);
      const killed = oldBal > 0 && newBal === 0 && debt.status === "active";
      const occurredOn = parsed.data.occurredOn;
      const userNotes = parsed.data.notes ?? null;
      const finalNote = killed ? "Final payment — debt paid in full 🎉" : null;
      const mergedNotes = killed
        ? userNotes
          ? `${userNotes}\n${finalNote}`
          : finalNote
        : userNotes;
      const [txn] = await tx
        .insert(transactionsTable)
        .values({
          userId,
          householdId,
          occurredOn,
          description: killed
            ? `Payment — ${debt.name} (PAID OFF)`
            : `Payment — ${debt.name}`,
          amount: (-Math.abs(amount)).toFixed(2),
          account: parsed.data.account ?? null,
          notes: mergedNotes,
          source: "manual",
          member: null,
          debtId,
        })
        .returning();
      const [updated] = await tx
        .update(debtsTable)
        .set({
          balance: newBal.toFixed(2),
          lastBalanceUpdate: new Date(),
          updatedAt: new Date(),
          ...(killed ? { status: "archived" } : {}),
        })
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)))
        .returning();
      return { debt: updated, transaction: txn, killed };
    });
    if (!result) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await recordBalanceSnapshot(req.userId!, householdId, result.debt.id, result.debt.balance);
    const accountIds = result.debt.plaidAccountId ? [result.debt.plaidAccountId] : [];
    const { accountById, itemById } = await loadAccountContext(householdId, accountIds);
    const pendingByDebt = await loadPendingPayments(householdId, [result.debt]);
    res.status(201).json({
      debt: shapeDebt(result.debt, accountById, itemById, pendingByDebt),
      transaction: result.transaction,
      killed: result.killed,
    });
  },
);

router.delete("/debts/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteDebtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db
    .delete(debtsTable)
    .where(
      and(eq(debtsTable.id, String(params.data.id)), eq(debtsTable.householdId, req.householdId!)),
    );
  res.sendStatus(204);
});

export default router;
