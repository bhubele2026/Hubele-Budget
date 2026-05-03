import { Router, type IRouter } from "express";
import { and, desc, eq, asc, gte, sql, inArray } from "drizzle-orm";
import {
  db,
  debtsTable,
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

function normalize<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (typeof out.lastBalanceUpdate === "string") {
    out.lastBalanceUpdate = new Date(out.lastBalanceUpdate as string);
  }
  return out;
}

type DebtRow = typeof debtsTable.$inferSelect;
type AccountRow = typeof plaidAccountsTable.$inferSelect;
type ItemRow = typeof plaidItemsTable.$inferSelect;

async function loadAccountContext(
  userId: string,
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
        eq(plaidAccountsTable.userId, userId),
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
              eq(plaidItemsTable.userId, userId),
              inArray(plaidItemsTable.id, itemIds),
            ),
          )
      : [];
  return {
    accountById: new Map(accounts.map((a) => [a.id, a])),
    itemById: new Map(items.map((i) => [i.id, i])),
  };
}

function shapeDebt(
  d: DebtRow,
  accountById: Map<string, AccountRow>,
  itemById: Map<string, ItemRow>,
) {
  const acct = d.plaidAccountId ? accountById.get(d.plaidAccountId) : null;
  const item = acct ? itemById.get(acct.itemId) : null;
  return {
    ...d,
    lastBalanceUpdate: d.lastBalanceUpdate
      ? d.lastBalanceUpdate.toISOString()
      : null,
    plaidLastSyncedAt: d.plaidLastSyncedAt
      ? d.plaidLastSyncedAt.toISOString()
      : null,
    plaidAccount: acct
      ? {
          id: acct.id,
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
        eq(plaidAccountsTable.userId, userId),
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
  }
  if (allowApr && acct.liabilityApr != null) {
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
    .where(and(eq(debtsTable.id, debt.id), eq(debtsTable.userId, userId)))
    .returning();
  return updated ?? debt;
}

async function refreshLinkedDebt(
  userId: string,
  debt: DebtRow,
): Promise<{ debt: DebtRow; fetchOk: boolean; error?: unknown }> {
  if (!debt.plaidAccountId) return { debt, fetchOk: true };
  const [acct] = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.id, debt.plaidAccountId),
        eq(plaidAccountsTable.userId, userId),
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
  const updated = await applyLiabilityToDebt(userId, debt, "refresh", fetchOk);
  return { debt: updated, fetchOk, error };
}

router.get("/debts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  let rows = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId))
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
          eq(plaidAccountsTable.userId, userId),
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
      // Only stamp the sync timestamp on accounts whose Plaid fetch succeeded.
      await applyLiabilityToDebt(userId, d, "refresh", ok);
    }
    rows = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.userId, userId))
      .orderBy(asc(debtsTable.sortOrder), desc(debtsTable.apr), asc(debtsTable.name));
  }

  const accountIds = rows
    .map((r) => r.plaidAccountId)
    .filter((v): v is string => !!v);
  const { accountById, itemById } = await loadAccountContext(userId, accountIds);
  res.json(rows.map((r) => shapeDebt(r, accountById, itemById)));
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
    .where(eq(debtsTable.userId, req.userId!));
  const values = normalize({ ...parsed.data, userId: req.userId! });
  if (values.sortOrder == null) values.sortOrder = (maxOrder ?? 0) + 1;
  const [row] = await db
    .insert(debtsTable)
    .values(values as typeof debtsTable.$inferInsert)
    .returning();
  res.status(201).json(shapeDebt(row, new Map(), new Map()));
});

router.post("/debts/sync-minimums", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const debts = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId));
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceISO = since.toISOString().slice(0, 10);
  const txns = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
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
      .where(and(eq(debtsTable.id, d.id), eq(debtsTable.userId, userId)));
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
      and(eq(debtsTable.id, String(params.data.id)), eq(debtsTable.userId, req.userId!)),
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
  if (changed(parsed.data.apr, current.apr))
    overrides.aprSource = "manual";
  if (changed(parsed.data.minPayment, current.minPayment))
    overrides.minPaymentSource = "manual";
  const [row] = await db
    .update(debtsTable)
    .set({ ...normalize(parsed.data), ...overrides, updatedAt: new Date() })
    .where(
      and(eq(debtsTable.id, String(params.data.id)), eq(debtsTable.userId, req.userId!)),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const accountIds = row.plaidAccountId ? [row.plaidAccountId] : [];
  const { accountById, itemById } = await loadAccountContext(req.userId!, accountIds);
  res.json(shapeDebt(row, accountById, itemById));
});

router.post(
  "/debts/:id/link",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const debtId = String(req.params.id);
    const plaidAccountId = String(req.body?.plaidAccountId ?? "");
    if (!plaidAccountId) {
      res.status(400).json({ error: "plaidAccountId is required" });
      return;
    }
    const [debt] = await db
      .select()
      .from(debtsTable)
      .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)));
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
          eq(plaidAccountsTable.userId, userId),
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
          eq(debtsTable.userId, userId),
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
      .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)))
      .returning();
    const refreshed = await applyLiabilityToDebt(userId, linked, "adopt", fetchOk);
    const { accountById, itemById } = await loadAccountContext(userId, [plaidAccountId]);
    res.json(shapeDebt(refreshed, accountById, itemById));
  },
);

router.post(
  "/debts/:id/unlink",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
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
      .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(shapeDebt(row, new Map(), new Map()));
  },
);

router.post(
  "/debts/:id/refresh",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const debtId = String(req.params.id);
    const [debt] = await db
      .select()
      .from(debtsTable)
      .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)));
    if (!debt) {
      res.status(404).json({ error: "Debt not found" });
      return;
    }
    if (!debt.plaidAccountId) {
      res.status(400).json({ error: "Debt is not linked to Plaid" });
      return;
    }
    const result = await refreshLinkedDebt(userId, debt);
    if (!result.fetchOk) {
      res.status(502).json({
        error: "Failed to refresh from Plaid",
        detail: String(result.error ?? "unknown"),
      });
      return;
    }
    const { accountById, itemById } = await loadAccountContext(userId, [
      result.debt.plaidAccountId!,
    ]);
    res.json(shapeDebt(result.debt, accountById, itemById));
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
    const amount = Number(parsed.data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be > 0" });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [debt] = await tx
        .select()
        .from(debtsTable)
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)));
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
          occurredOn,
          description: killed
            ? `Payment — ${debt.name} (PAID OFF)`
            : `Payment — ${debt.name}`,
          amount: (-Math.abs(amount)).toFixed(2),
          account: parsed.data.account ?? null,
          notes: mergedNotes,
          source: "manual",
          member: null,
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
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)))
        .returning();
      return { debt: updated, transaction: txn, killed };
    });
    if (!result) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const accountIds = result.debt.plaidAccountId ? [result.debt.plaidAccountId] : [];
    const { accountById, itemById } = await loadAccountContext(req.userId!, accountIds);
    res.status(201).json({
      debt: shapeDebt(result.debt, accountById, itemById),
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
      and(eq(debtsTable.id, String(params.data.id)), eq(debtsTable.userId, req.userId!)),
    );
  res.sendStatus(204);
});

export default router;
