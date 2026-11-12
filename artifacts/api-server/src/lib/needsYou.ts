import { and, countDistinct, desc, eq, inArray, notInArray } from "drizzle-orm";
import { db, budgetCategoriesTable, categoryDecisionsTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import { addDaysISO } from "@workspace/avalanche-core";
import { loadAnnotatedRows } from "./bankLedger";
import { OPEN_DECISION } from "./categorizer/review";
import { readUnresolvedBankRows } from "./unresolvedBankRows";
import { planBankMatches, listAutoDone, type MatchSuggestion } from "./bankAutoSort";

/**
 * ⭐ (BANK-AUTO) ONE LIST, ONE COUNT — `GET /banking/needs-you`.
 *
 * Everything H2 still needs a person for, after the auto-sort
 * (lib/bankAutoSort.ts) did what it was sure of:
 *
 *   match     the bank rows still waiting for a match — EXACTLY the rows the
 *             Review badge has always counted (`readUnresolvedBankRows`: this
 *             household month, the forecast's account, in the forecast, no
 *             deciding answer);
 *   category  the categorization review queue (open decisions: provisional or
 *             queued, unresolved, not undone), ONE item per charge. A charge on
 *             both lists is one item, kind "match", whose reason mentions the
 *             category.
 *
 * `count` is the number of charges on the list — the figure every badge shows:
 * `computeReviewCount` (the spine's `reviewCount`, GET /forecast/review-count,
 * the banking review's `badgeCount`) is `countNeedsYou`, this same reading.
 * `items` is capped (`limit`, at most NEEDS_YOU_MAX_LIMIT), newest first;
 * `truncated` says when the cap cut it, so `count === items.length` whenever
 * `truncated` is false.
 */

export const NEEDS_YOU_DEFAULT_LIMIT = 200;
export const NEEDS_YOU_MAX_LIMIT = 500;

export type NeedsYouKind = "match" | "category";
export type NeedsYouConfidence = "high" | "medium" | "low";

export interface NeedsYouSuggestion {
  label: string;
  planOccurrenceId?: string;
  categoryId?: string;
  reviewItemId?: string;
  confidence: NeedsYouConfidence;
}

export interface NeedsYouItem {
  id: string;
  txId: string;
  accountName: string;
  mask: string | null;
  date: string;
  name: string;
  amount: string;
  /** The row's current category (a provisional one included), or null when it has none. */
  categoryName: string | null;
  pending: boolean;
  kind: NeedsYouKind;
  suggestion: NeedsYouSuggestion | null;
  reason: string;
}

export interface NeedsYou {
  throughDate: string;
  count: number;
  truncated: boolean;
  items: NeedsYouItem[];
  autoDone: { matched: number; categorized: number; since: string };
}

/** The ids behind the count: the match rows, and the charges only the queue holds. */
async function readNeedsYouIds(householdId: string, ownerUserId: string) {
  const waiting = await readUnresolvedBankRows(householdId, ownerUserId);
  const matchIds = waiting.rows.map((r) => r.id);
  const [row] = await db
    .select({ n: countDistinct(categoryDecisionsTable.transactionId) })
    .from(categoryDecisionsTable)
    .where(
      and(
        eq(categoryDecisionsTable.householdId, householdId),
        OPEN_DECISION,
        matchIds.length > 0 ? notInArray(categoryDecisionsTable.transactionId, matchIds) : undefined,
      ),
    );
  return { waiting, matchIds, categoryOnly: Number(row?.n ?? 0) };
}

/**
 * ⭐ THE COUNT every badge shows: charges waiting for a match, plus charges only
 * the categorization queue holds (a charge on both counts once). Cheap: no
 * forecast ledger, no item detail.
 */
export async function countNeedsYou(householdId: string, ownerUserId: string): Promise<number> {
  const { matchIds, categoryOnly } = await readNeedsYouIds(householdId, ownerUserId);
  return matchIds.length + categoryOnly;
}

/** Why the queue proposed a category, in plain words (the web's `reviewWhy`). */
function categoryWhy(source: string, explanation: string, suggested: string | null): string {
  if (!suggested) return explanation || "H2 needs a look at this one.";
  switch (source) {
    case "rule":
      return "Matches a rule. Confirm the category.";
    case "memory":
      return "Learned from a correction. Confirm the category.";
    case "recurring":
      return "Looks like a recurring bill. Confirm the category.";
    case "inherited":
      return "Same as a related charge. Confirm the category.";
    case "refund":
      return "Looks like a refund. Confirm the category.";
    default:
      return "H2's best guess. Confirm the category.";
  }
}

function matchWhy(pending: boolean, s: MatchSuggestion | undefined, alsoCategory: boolean): string {
  const base = pending
    ? s
      ? `Pending at the bank. Looks like ${matchLabelOf(s)}.`
      : "Pending at the bank. Match it to a plan or mark it not in the plan."
    : s
      ? `Looks like ${matchLabelOf(s)}. Confirm the match or pick another.`
      : "Not matched to the plan yet. Match it or mark it not in the plan.";
  return alsoCategory ? `${base} Its category needs a look too.` : base;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 3" from "2026-11-03" (a calendar day; no time zone involved). */
const shortDay = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
/** "$1,112.00" from a signed amount: its size, to the cent, as code formats it. */
const dollars = (n: number): string => {
  const cents = Math.abs(Math.round(n * 100));
  return `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
};

/**
 * A match suggestion's label, written to follow "Looks like ": "the Car
 * insurance payment, planned $112.00 on Nov 3" (money in: "deposit").
 */
export function matchLabelOf(s: Pick<MatchSuggestion, "label" | "amount" | "dueDate">): string {
  const what = s.amount != null && s.amount > 0 ? "deposit" : "payment";
  const planned =
    s.amount != null && s.amount !== 0 ? `planned ${dollars(s.amount)} on ${shortDay(s.dueDate)}` : `planned on ${shortDay(s.dueDate)}`;
  return `the ${s.label} ${what}, ${planned}`;
}

const bandConfidence = (band: string): NeedsYouConfidence => (band === "provisional" ? "medium" : band === "auto" ? "high" : "low");

/** ⭐ The one list (see the file header). `since` (YYYY-MM-DD) dates `autoDone`; default a week back. */
export async function computeNeedsYou(
  householdId: string,
  ownerUserId: string,
  opts: { limit?: number; since?: string } = {},
): Promise<NeedsYou> {
  const limit = Math.min(Math.max(1, opts.limit ?? NEEDS_YOU_DEFAULT_LIMIT), NEEDS_YOU_MAX_LIMIT);
  const { waiting, matchIds, categoryOnly } = await readNeedsYouIds(householdId, ownerUserId);
  const throughDate = waiting.today;
  const since = opts.since ?? addDaysISO(throughDate, -7);
  const count = matchIds.length + categoryOnly;

  const cd = categoryDecisionsTable;
  const decisionCols = {
    decisionId: cd.id,
    transactionId: cd.transactionId,
    suggestedCategoryId: cd.categoryId,
    band: cd.band,
    source: cd.source,
    explanation: cd.explanation,
    occurredOn: transactionsTable.occurredOn,
  };
  const [planning, onMatchRows, queueRows, autoDone] = await Promise.all([
    matchIds.length > 0 ? planBankMatches(householdId, ownerUserId) : Promise.resolve(null),
    matchIds.length > 0
      ? db
          .select(decisionCols)
          .from(cd)
          .innerJoin(transactionsTable, eq(transactionsTable.id, cd.transactionId))
          .where(and(eq(cd.householdId, householdId), OPEN_DECISION, inArray(cd.transactionId, matchIds)))
      : Promise.resolve([]),
    // Newest charges first; one charge may hold more than one open decision, so read twice the page.
    db
      .select(decisionCols)
      .from(cd)
      .innerJoin(transactionsTable, eq(transactionsTable.id, cd.transactionId))
      .where(
        and(
          eq(cd.householdId, householdId),
          eq(transactionsTable.householdId, householdId),
          OPEN_DECISION,
          matchIds.length > 0 ? notInArray(cd.transactionId, matchIds) : undefined,
        ),
      )
      .orderBy(desc(transactionsTable.occurredOn), desc(cd.createdAt), desc(cd.id))
      .limit(limit * 2),
    listAutoDone(householdId, since),
  ]);

  // One open decision per charge: the newest that proposes a category, else the newest.
  const pickDecision = <T extends { transactionId: string; suggestedCategoryId: string | null }>(rows: readonly T[]) => {
    const out = new Map<string, T>();
    for (const r of rows) {
      const cur = out.get(r.transactionId);
      if (!cur || (!cur.suggestedCategoryId && r.suggestedCategoryId)) out.set(r.transactionId, r);
    }
    return out;
  };
  const matchDecisions = pickDecision(onMatchRows);
  const queueByTxn = pickDecision(queueRows);

  type Draft = Omit<NeedsYouItem, "accountName" | "mask" | "name" | "amount" | "categoryName" | "pending"> & { txId: string };
  const drafts: Draft[] = [];
  for (const r of waiting.rows) {
    const s = planning?.suggestionByTxn.get(r.id);
    drafts.push({
      id: `match:${r.id}`,
      txId: r.id,
      date: r.occurredOn,
      kind: "match",
      suggestion: s
        ? { label: matchLabelOf(s), planOccurrenceId: s.planKey, confidence: s.confidence }
        : null,
      reason: matchWhy(r.pending, s, matchDecisions.has(r.id)),
    });
  }
  // The household's categories (a short list): the suggestions' names and each row's current one.
  const catNames = new Map<string, string>(
    (
      await db
        .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
        .from(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.householdId, householdId))
    ).map((c) => [c.id, c.name] as const),
  );
  for (const d of queueByTxn.values()) {
    const name = d.suggestedCategoryId ? catNames.get(d.suggestedCategoryId) : undefined;
    drafts.push({
      id: `category:${d.transactionId}`,
      txId: d.transactionId,
      date: d.occurredOn,
      kind: "category",
      suggestion:
        d.suggestedCategoryId && name
          ? { label: name, categoryId: d.suggestedCategoryId, reviewItemId: d.decisionId, confidence: bandConfidence(d.band) }
          : null,
      reason: categoryWhy(d.source, d.explanation, d.suggestedCategoryId),
    });
  }
  drafts.sort(
    (a, b) =>
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      (a.kind === b.kind ? 0 : a.kind === "match" ? -1 : 1) ||
      (a.txId < b.txId ? 1 : a.txId > b.txId ? -1 : 0),
  );
  const page = drafts.slice(0, limit);

  // The charges' own words and accounts: the rows as GET /transactions annotates them.
  const annotated = await loadAnnotatedRows(householdId, page.map((d) => d.txId));
  const accounts = await db
    .select({ accountId: plaidAccountsTable.accountId, name: plaidAccountsTable.name, mask: plaidAccountsTable.mask, institution: plaidItemsTable.institutionName })
    .from(plaidAccountsTable)
    .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
    .where(eq(plaidAccountsTable.householdId, householdId));
  const accountOf = new Map(accounts.map((a) => [a.accountId, a] as const));
  const items: NeedsYouItem[] = [];
  for (const d of page) {
    const t = annotated.get(d.txId) as
      | {
          description: string;
          displayName?: unknown;
          amount: string;
          pending: boolean;
          plaidAccountId: string | null;
          account: string | null;
          categoryId: string | null;
        }
      | undefined;
    if (!t) continue;
    const a = t.plaidAccountId ? accountOf.get(t.plaidAccountId) : undefined;
    items.push({
      ...d,
      accountName: a?.name ?? a?.institution ?? t.account ?? "Manual entry",
      mask: a?.mask ?? null,
      name: String(t.displayName ?? t.description),
      amount: t.amount,
      categoryName: t.categoryId ? (catNames.get(t.categoryId) ?? null) : null,
      pending: t.pending === true,
    });
  }
  return {
    throughDate,
    count,
    truncated: count > items.length,
    items,
    autoDone: { matched: autoDone.matched, categorized: autoDone.categorized, since },
  };
}
