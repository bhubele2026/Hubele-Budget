import type { CardRowKind } from "@workspace/avalanche-core";
import type { MappingRule, Transaction } from "@workspace/api-client-react";

/**
 * ⭐ (P1) WHAT AN AMEX ROW SAYS, IN WORDS. The calm row (Review mode) shows a
 * row's spending as a word instead of four marks, its statuses only when they
 * apply, and — in its details — where its category came from. Everything here
 * FORMATS what the row and the server already say (the row's own flags, the
 * server's "not filed yet" rows, the server's row kind); it adds up nothing
 * and decides nothing about money.
 */

type RowFlags = Pick<
  Transaction,
  | "weeklyAllowance"
  | "monthlyAllowance"
  | "unplannedAllowance"
  | "reimbursable"
  | "isTransfer"
  | "expiredHold"
>;

/** The words for each bucket flag, in the order the marks are drawn. */
const FLAG_WORDS: ReadonlyArray<[keyof RowFlags, string]> = [
  ["weeklyAllowance", "Weekly"],
  ["monthlyAllowance", "Monthly"],
  ["unplannedAllowance", "Unplanned"],
  ["reimbursable", "Reimbursable"],
];

/** A row's kind (`amexRowKind`, the server's rule) as a word, when no bucket says more. */
const KIND_WORDS: Record<CardRowKind, string> = {
  purchase: "No bucket",
  refund: "Refund",
  payment: "Payment",
  other_credit: "Credit",
  other_charge: "Other charge",
};

/**
 * The row's spending in words, first rule that applies:
 *   1. an expired hold says nothing here (its label already says "not counted");
 *   2. a transfer, or a row in the Ignore category → "Not counted";
 *   3. its bucket flags → "Weekly", "Unplanned · Reimbursable", …;
 *   4. no flag: one of the server's "not filed yet" rows → "Not filed yet";
 *      otherwise its kind → "No bucket" / "Refund" / "Payment" / "Credit";
 *      no kind → "—".
 */
export function spendingWords(
  t: RowFlags,
  opts: { ignored: boolean; unfiled: boolean; kind: CardRowKind | null },
): string {
  if (t.expiredHold) return "";
  if (t.isTransfer || opts.ignored) return "Not counted";
  const flags = FLAG_WORDS.filter(([k]) => t[k] === true).map(([, w]) => w);
  if (flags.length > 0) return flags.join(" · ");
  if (opts.unfiled) return "Not filed yet";
  return opts.kind ? KIND_WORDS[opts.kind] : "—";
}

export type RowStatus = {
  key: "pending" | "transfer" | "external" | "ignored";
  label: string;
  testId: string;
  /** A one-line meaning for the chip's tooltip. */
  title?: string;
};

/**
 * The status chips a row carries, only when they apply, in reading order:
 * Pending · Transfer · Not in avalanche · Ignored. (An expired hold carries its
 * own label, first; "Reviewed" is quiet text after the chips.)
 */
export function rowStatuses(
  t: Pick<Transaction, "id" | "pending" | "expiredHold" | "isTransfer" | "isTransferUserOverridden" | "isExternalCardPayment">,
  ignored: boolean,
): RowStatus[] {
  const out: RowStatus[] = [];
  if (t.pending && !t.expiredHold) out.push({ key: "pending", label: "Pending", testId: `chip-pending-${t.id}` });
  if (t.isTransfer) {
    out.push({
      key: "transfer",
      label: "Transfer",
      testId: `badge-transfer-${t.id}`,
      title: t.isTransferUserOverridden ? "Set by hand. The next sync keeps it." : "Not counted as spending.",
    });
  }
  if (t.isExternalCardPayment) {
    out.push({
      key: "external",
      label: "Not in avalanche",
      testId: `badge-external-card-${t.id}`,
      title: "Paid to a card outside the debt plan.",
    });
  }
  if (ignored) out.push({ key: "ignored", label: "Ignored", testId: `chip-ignored-${t.id}`, title: "Left out of budgets and reports." });
  return out;
}

export type CategoryProvenance =
  | { kind: "empty" }
  | { kind: "hand" }
  | { kind: "rule"; ruleId: string; pattern: string; matchWords: string }
  | { kind: "no_rule" };

const MATCH_WORDS: Record<string, string> = {
  contains: "contains",
  exact: "equals",
  starts_with: "starts with",
};

/**
 * Where a row's category came from — the real answer, never a "Manual" guess:
 *   no category (or the system Uncategorized) → empty;
 *   a person chose it (`categoryLockedByUser`) → by hand;
 *   the rule the server matched, still pointing at this category → that rule;
 *   anything else → no rule matches this category.
 */
export function categoryProvenance(
  t: Pick<Transaction, "categoryId" | "matchedRuleId" | "categoryLockedByUser">,
  rules: readonly Pick<MappingRule, "id" | "pattern" | "matchType" | "categoryId">[] | undefined,
  uncategorizedId: string | null,
): CategoryProvenance {
  if (!t.categoryId || t.categoryId === uncategorizedId) return { kind: "empty" };
  if (t.categoryLockedByUser) return { kind: "hand" };
  const rule = t.matchedRuleId ? (rules ?? []).find((r) => r.id === t.matchedRuleId) : undefined;
  if (rule && (rule.categoryId == null || rule.categoryId === t.categoryId)) {
    return {
      kind: "rule",
      ruleId: rule.id,
      pattern: rule.pattern,
      matchWords: MATCH_WORDS[rule.matchType] ?? rule.matchType.replace("_", " "),
    };
  }
  return { kind: "no_rule" };
}

/** The provenance as one short sentence (the rule's link is drawn beside it). */
export function provenanceWords(p: CategoryProvenance): string {
  switch (p.kind) {
    case "empty":
      return "No category yet.";
    case "hand":
      return "Chosen by hand.";
    case "rule":
      return `Set by rule "${p.pattern}" (${p.matchWords}).`;
    default:
      return "No rule matches this category.";
  }
}
