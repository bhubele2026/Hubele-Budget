// Pure one-off / non-recurring spend computation for the Bills overview.
//
// Kept in its own module (no DB imports) so it unit-tests without a database.
// "One-off" = real spend (isRealSpend — excludes transfers, uncategorized,
// Ignore/Reimbursement, debt, income, card payments) that does NOT match any
// active recurring bill name.

import {
  isRealSpend,
  spendAmount,
  type SpendContext,
} from "./spendingFilter";
import { cleanMerchant } from "./merchantNameExtract";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Significant words from a recurring bill name, used to detect whether a
// transaction belongs to a tracked recurring bill (so one-off excludes it).
export function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
}

export interface OneOffTxn {
  description: string | null;
  amount: string | number;
  source: string | null;
  categoryId: string | null;
  isTransfer: boolean;
}

export interface OneOffResult {
  total: number;
  count: number;
  top: { name: string; amount: number }[];
}

export function computeOneOff(
  txns: OneOffTxn[],
  ctx: SpendContext,
  activeBillNames: string[],
): OneOffResult {
  const nameWordSets = activeBillNames
    .map(significantWords)
    .filter((w) => w.length > 0);
  const matchesRecurring = (desc: string): boolean => {
    const d = desc.toLowerCase();
    return nameWordSets.some((words) => words.some((w) => d.includes(w)));
  };
  let total = 0;
  let count = 0;
  const byMerchant = new Map<string, number>();
  for (const t of txns) {
    const tx = {
      amount: t.amount,
      source: t.source ?? "",
      isTransfer: t.isTransfer,
      categoryId: t.categoryId,
      description: t.description ?? "",
    };
    if (!isRealSpend(tx, ctx)) continue;
    if (matchesRecurring(tx.description)) continue; // tracked recurring, not one-off
    const spend = spendAmount(tx);
    if (spend <= 0) continue;
    total += spend;
    count++;
    const name = cleanMerchant(tx.description) || tx.description.trim() || "Other";
    byMerchant.set(name, (byMerchant.get(name) ?? 0) + spend);
  }
  const top = [...byMerchant.entries()]
    .map(([name, amount]) => ({ name, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);
  return { total: round2(total), count, top };
}
