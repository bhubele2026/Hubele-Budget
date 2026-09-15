// (PR-H round 2) TEST-ONLY: the classifier's view of household spend for a date
// range, prepared exactly the way `buildSpendingFacts` prepares its rows — the
// range's rows (start clamped to TRACKING_START), replaced pending rows left
// out, each posted row in effective-filing form — and classified against
// `loadMoneyContext`'s context.
//
// Production wiring waits for PR8r/PR10, when a displayed figure switches (see
// docs/reviews/2026-09-14-household-money-core.md). Until then the parity tests
// (`spendingFactsClassifierParity`, `spineParity`) use this to hold
// `classifierHouseholdSpend` to the figures the app shows.

import { and, eq, gte, lte } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import { classifierHouseholdSpend, TRACKING_START } from "../../lib/spendingFacts";
import { effectiveFiling } from "../../lib/pendingFiling";
import {
  loadMoneyContext,
  type MoneyContext,
  type MoneyContextSupersede,
} from "../../lib/moneyContext";
import type { MovementRow } from "../../lib/spendingFilter";

/** The range's rows as `classifyMovement` must see them: replaced pending rows out, the rest effectively filed. */
export async function loadClassifierRows(
  householdId: string,
  start: string,
  end: string,
  money: Pick<MoneyContext, "supersede" | "filingCtx">,
): Promise<MovementRow[]> {
  const txns = await db
    .select({
      id: transactionsTable.id,
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
      source: transactionsTable.source,
      reimbursable: transactionsTable.reimbursable,
      debtId: transactionsTable.debtId,
      isExternalCardPayment: transactionsTable.isExternalCardPayment,
      pfcDetailed: transactionsTable.pfcDetailed,
      weeklyAllowance: transactionsTable.weeklyAllowance,
      monthlyAllowance: transactionsTable.monthlyAllowance,
      unplannedAllowance: transactionsTable.unplannedAllowance,
      weeklyBucket: transactionsTable.weeklyBucket,
      isTransferUserOverridden: transactionsTable.isTransferUserOverridden,
      plaidAccountId: transactionsTable.plaidAccountId,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, start),
        lte(transactionsTable.occurredOn, end),
      ),
    );
  const rows: MovementRow[] = [];
  for (const row of txns) {
    if (money.supersede.replacedIds.has(row.id)) continue;
    rows.push(effectiveFiling(row, money.supersede.replacedBy.get(row.id), money.filingCtx));
  }
  return rows;
}

/**
 * `classifierHouseholdSpend` for `[start, end]`, through `loadMoneyContext`.
 * `supersede` is the caller's pre-read pairs (the spine's shape); omitted, the
 * loader reads them for the range.
 */
export async function classifierSpendForRange(
  householdId: string,
  start: string,
  end: string,
  opts: { mode?: "today" | "forward"; supersede?: MoneyContextSupersede } = {},
): Promise<{
  spend: { total: number; transactionCount: number };
  money: MoneyContext;
  rows: MovementRow[];
}> {
  const from = start < TRACKING_START ? TRACKING_START : start;
  const money = await loadMoneyContext(householdId, { start: from, end: end }, { supersede: opts.supersede });
  const rows = await loadClassifierRows(householdId, from, end, money);
  return { spend: classifierHouseholdSpend(rows, money, { mode: opts.mode }), money, rows };
}
