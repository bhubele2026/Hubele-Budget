// (PR-A) Loads what the stages read, once per batch.
import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  merchantMemoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO } from "@workspace/avalanche-core";
import { loadUserRules } from "../autoCategorize";
import { spendContextOf } from "../spendContext";
import { refundSignature } from "../merchantNameExtract";
import { uncategorizedCategoryIds } from "../pendingFiling";
import { findSupersededPending } from "../supersededPending";
import { isOutflow, REFUND_WINDOW_DAYS } from "./stages/heuristic";
import type { AccountFacts, EngineContext, EngineRow, MemoryRow, OutflowRef, RecurringRow } from "./types";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const ENGINE_ROW_COLUMNS = {
  id: transactionsTable.id,
  description: transactionsTable.description,
  amount: transactionsTable.amount,
  source: transactionsTable.source,
  plaidAccountId: transactionsTable.plaidAccountId,
  pfcPrimary: transactionsTable.pfcPrimary,
  pfcDetailed: transactionsTable.pfcDetailed,
  pending: transactionsTable.pending,
  occurredOn: transactionsTable.occurredOn,
  createdAt: transactionsTable.createdAt,
  categoryId: transactionsTable.categoryId,
  categoryLockedByUser: transactionsTable.categoryLockedByUser,
  categoryProvisional: transactionsTable.categoryProvisional,
  isTransfer: transactionsTable.isTransfer,
  isTransferUserOverridden: transactionsTable.isTransferUserOverridden,
  isExternalCardPayment: transactionsTable.isExternalCardPayment,
  debtId: transactionsTable.debtId,
  reimbursable: transactionsTable.reimbursable,
  weeklyAllowance: transactionsTable.weeklyAllowance,
  monthlyAllowance: transactionsTable.monthlyAllowance,
  unplannedAllowance: transactionsTable.unplannedAllowance,
  weeklyBucket: transactionsTable.weeklyBucket,
  refundOfTxnId: transactionsTable.refundOfTxnId,
};

export async function loadEngineRows(householdId: string, where: SQL): Promise<EngineRow[]> {
  return db
    .select(ENGINE_ROW_COLUMNS)
    .from(transactionsTable)
    .where(and(eq(transactionsTable.householdId, householdId), where))
    .orderBy(transactionsTable.occurredOn, transactionsTable.createdAt, transactionsTable.id);
}

export function toMemoryRow(m: typeof merchantMemoryTable.$inferSelect): MemoryRow {
  return {
    id: m.id,
    signature: m.signature,
    scope: m.scope as MemoryRow["scope"],
    plaidAccountId: m.plaidAccountId,
    amountBandLo: m.amountBandLo == null ? null : Number(m.amountBandLo),
    amountBandHi: m.amountBandHi == null ? null : Number(m.amountBandHi),
    categoryId: m.categoryId,
    count: m.count,
    createdAt: m.createdAt,
  };
}

/** Content versions: an in-place rule edit changes the hash (a count + max(created_at) would miss it). */
export function contentVersions(
  rules: { id: string; pattern: string; matchType: string; categoryId: string | null; priority: number }[],
  memory: MemoryRow[],
  recurring: RecurringRow[],
): EngineContext["versions"] {
  return {
    rules: sha256(rules.map((r) => `${r.id}:${r.pattern}:${r.matchType}:${r.categoryId}:${r.priority}`).join("\n")),
    memory: sha256(
      [...memory]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => `${m.id}:${m.scope}:${m.categoryId}:${m.count}:${m.plaidAccountId}:${m.amountBandLo}:${m.amountBandHi}`)
        .join("\n"),
    ),
    recurring: sha256(
      [...recurring]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => `${r.id}:${r.name}:${r.amount}:${r.categoryId}`)
        .join("\n"),
    ),
  };
}

/**
 * sha256(description|amount|plaid_account_id|pfc_primary|pfc_detailed|pending
 * |locked|rulesVersion|memoryVersion|recurringVersion|replaced pending filing).
 * Same inputs → same hash → the unique (transaction_id, input_hash) makes a
 * second run a no-op.
 */
export function inputHash(row: EngineRow, ctx: EngineContext): string {
  const replaced = ctx.replacedBy.get(row.id);
  return sha256(
    [
      row.description,
      row.amount,
      row.plaidAccountId ?? "",
      row.pfcPrimary ?? "",
      row.pfcDetailed ?? "",
      String(row.pending),
      String(row.categoryLockedByUser),
      ctx.versions.rules,
      ctx.versions.memory,
      ctx.versions.recurring,
      replaced ? JSON.stringify([replaced.id, replaced.filing]) : "",
    ].join("|"),
  );
}

// (WP5d) Moved to ../spendContext.ts (shared with the insert-time rule fill);
// re-exported so existing importers keep working.
export { spendContextOf };

/** Earlier purchases by their refund-link signature (B6: `refundSignature`, the same key a credit looks up). */
export function groupOutflows(
  rows: {
    id: string;
    description: string;
    amount: string;
    source: string;
    occurredOn: string;
    categoryId: string | null;
    plaidAccountId?: string | null;
  }[],
): Map<string, OutflowRef[]> {
  const out = new Map<string, OutflowRef[]>();
  for (const r of rows) {
    if (!isOutflow(r)) continue;
    const sig = refundSignature(r.description);
    if (!sig) continue;
    const list = out.get(sig) ?? [];
    list.push({
      id: r.id,
      occurredOn: r.occurredOn,
      amountAbs: Math.abs(Number(r.amount) || 0),
      categoryId: r.categoryId,
      description: r.description,
      plaidAccountId: r.plaidAccountId ?? null,
    });
    out.set(sig, list);
  }
  return out;
}

/**
 * The Plaid accounts the rows sit on, by external account id (household-scoped).
 * (WP5c) Moved from modelStage.ts so the context loads it ONCE per batch: the
 * direction guard and the model stage both read it.
 */
export async function loadAccounts(
  householdId: string,
  rows: readonly Pick<EngineRow, "plaidAccountId">[],
): Promise<Map<string, AccountFacts>> {
  const ids = [...new Set(rows.map((r) => r.plaidAccountId).filter((x): x is string => !!x))];
  const out = new Map<string, AccountFacts>();
  if (ids.length === 0) return out;
  const found = await db
    .select({
      accountId: plaidAccountsTable.accountId,
      type: plaidAccountsTable.type,
      subtype: plaidAccountsTable.subtype,
      institutionSlug: plaidItemsTable.institutionSlug,
    })
    .from(plaidAccountsTable)
    .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
    .where(and(eq(plaidAccountsTable.householdId, householdId), inArray(plaidAccountsTable.accountId, ids)));
  for (const f of found) {
    out.set(f.accountId, { type: f.type, subtype: f.subtype, institutionSlug: f.institutionSlug });
  }
  return out;
}

export async function loadEngineContext(
  householdId: string,
  rows: readonly EngineRow[],
): Promise<EngineContext> {
  const [rules, memoryRaw, recurringRaw, cats, supersede, accounts] = await Promise.all([
    loadUserRules(householdId),
    db
      .select()
      .from(merchantMemoryTable)
      .where(and(eq(merchantMemoryTable.householdId, householdId), isNull(merchantMemoryTable.disabledAt))),
    db
      .select({
        id: recurringItemsTable.id,
        name: recurringItemsTable.name,
        amount: recurringItemsTable.amount,
        categoryId: recurringItemsTable.categoryId,
      })
      .from(recurringItemsTable)
      .where(
        and(
          eq(recurringItemsTable.householdId, householdId),
          eq(recurringItemsTable.active, "true"),
          isNotNull(recurringItemsTable.categoryId),
        ),
      ),
    db
      .select({
        id: budgetCategoriesTable.id,
        name: budgetCategoriesTable.name,
        debtId: budgetCategoriesTable.debtId,
        kind: budgetCategoriesTable.kind,
      })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, householdId)),
    findSupersededPending(householdId),
    loadAccounts(householdId, rows),
  ]);
  const memory = memoryRaw.map(toMemoryRow);
  const memoryBySignature = new Map<string, MemoryRow[]>();
  for (const m of memory) {
    const list = memoryBySignature.get(m.signature) ?? [];
    list.push(m);
    memoryBySignature.set(m.signature, list);
  }
  const recurring: RecurringRow[] = recurringRaw.map((r) => ({
    id: r.id,
    name: r.name,
    amount: Number(r.amount) || 0,
    categoryId: r.categoryId as string,
  }));

  // Outflows a refund in this batch could point back to.
  let outflowsBySignature = new Map<string, OutflowRef[]>();
  const inflowDates = rows.filter((r) => !isOutflow(r) && Number(r.amount) !== 0).map((r) => r.occurredOn).sort();
  if (inflowDates.length > 0) {
    const from = addDaysISO(inflowDates[0]!, -REFUND_WINDOW_DAYS);
    const to = inflowDates[inflowDates.length - 1]!;
    outflowsBySignature = groupOutflows(
      await db
        .select({
          id: transactionsTable.id,
          description: transactionsTable.description,
          amount: transactionsTable.amount,
          source: transactionsTable.source,
          occurredOn: transactionsTable.occurredOn,
          categoryId: transactionsTable.categoryId,
          plaidAccountId: transactionsTable.plaidAccountId,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, householdId),
            gte(transactionsTable.occurredOn, from),
            lte(transactionsTable.occurredOn, to),
          ),
        ),
    );
  }

  return {
    rules,
    memoryBySignature,
    recurring,
    replacedBy: supersede.replacedBy,
    uncategorizedIds: uncategorizedCategoryIds(cats),
    spendCtx: spendContextOf(cats),
    accounts,
    outflowsBySignature,
    versions: contentVersions(rules, memory, recurring),
  };
}
