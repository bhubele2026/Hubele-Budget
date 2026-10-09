import type { AgentProposal, MemoryItem } from "@workspace/api-client-react/features";
import { fmtMoney, toAmount } from "@/lib/money";

/**
 * (F8) The words the Ask screens use, ported from the frozen h2 app
 * (`artifacts/h2/src/screens/ask/askWords.ts`) with its tests; never imported
 * from it. Nothing here works out a figure: a proposal's before and after are
 * read off the payload as the server's code wrote them, and printed the way
 * classic prints money (dollars and cents). The AI-cost words (`taskWord`,
 * `usd`, `percent`, `RUN_STATUS_WORD`) live in `aiCostWords.ts`.
 */

export const KIND_WORD: Record<AgentProposal["kind"], string> = {
  set_category: "Change a category",
  weekly_limit: "Change the weekly limit",
  budget_line: "Change a budget line",
  extra_debt_payment: "Change the extra debt payment",
  bill_amount: "Change a bill's amount",
};

export const PROPOSAL_STATUS_WORD: Record<AgentProposal["status"], string> = {
  proposed: "Waiting for you",
  approved: "Approved",
  applied: "Applied",
  rejected: "Rejected",
  expired: "Expired",
};

export const SCOPE_WORD: Record<MemoryItem["scope"], string> = {
  categorization: "Filing",
  spending: "Spending",
  debt: "Debt",
  general: "General",
};
export const SCOPE_ORDER: ReadonlyArray<MemoryItem["scope"]> = ["categorization", "spending", "debt", "general"];

export const SOURCE_WORD: Record<MemoryItem["source"], string> = {
  user_stated: "You said",
  inferred: "H2 inferred",
  agent_proposed: "H2 proposed",
};

/** The quiet line shown while Ask reads something. */
export const TOOL_LINE: Record<string, string> = {
  get_position: "Checking what is safe to spend…",
  get_spending_summary: "Looking at spending…",
  list_transactions: "Looking through charges…",
  explain_transaction: "Reading one charge…",
  get_bills_and_income: "Checking bills and income…",
  get_debt_plan: "Checking the debt plan…",
  get_recap_facts: "Reading the recap…",
  list_memory: "Reading what H2 remembers…",
  list_findings: "Checking what H2 flagged…",
  set_category: "Preparing a filing…",
  remember_preference: "Making a note…",
  propose_plan_change: "Preparing a proposal…",
  add_wishlist_item: "Adding to the wish list…",
};
export const toolLine = (name: string): string => TOOL_LINE[name] ?? "Working on it…";

/** A memory key as words: "dining_out-limit" → "Dining out limit". */
export function keyWords(key: string): string {
  const s = key.replace(/[_.-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

export const REF = /ref:([A-Za-z0-9_-]{6,64})/g;

export type Piece = { kind: "text"; text: string } | { kind: "ref"; id: string };

/** A line split into plain text and `ref:<id>` pieces. */
export function splitRefs(line: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of line.matchAll(REF)) {
    if (m.index > at) out.push({ kind: "text", text: line.slice(at, m.index) });
    out.push({ kind: "ref", id: m[1]! });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ kind: "text", text: line.slice(at) });
  return out;
}

/** An answer as paragraphs: blank lines split them, a single newline stays inside one. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export const BASED_ON = /^based on:?\s*/i;

/**
 * Where a `ref` id leads. h2 opened `/activity?txn=`; classic has no all-account
 * ledger, so a ref opens the Chase ledger on that charge (`?tx=`, CH-09), which
 * scrolls to the row when it is in the month on screen.
 */
export const refHref = (id: string): string => `/transactions?tx=${encodeURIComponent(id)}`;

const money = (v: unknown): string => {
  const n = toAmount(typeof v === "string" || typeof v === "number" ? v : null);
  return n == null ? "—" : fmtMoney(n);
};

export interface Change {
  what: string;
  before: string;
  after: string;
  /** Machine values for the <data> elements; null for words. */
  beforeValue: string | null;
  afterValue: string | null;
  txnId: string | null;
}

/** What a proposal changes, before → after, from the payload the server wrote. */
export function describeChange(p: Pick<AgentProposal, "kind" | "payload">, categories: ReadonlyMap<string, string>): Change {
  const pl = p.payload as Record<string, unknown>;
  const label = typeof pl.label === "string" && pl.label.trim() ? pl.label : KIND_WORD[p.kind];
  if (p.kind === "set_category") {
    const name = (id: unknown) => (typeof id === "string" ? categories.get(id) : undefined);
    return {
      what: label,
      before: name(pl.before) ?? "Not filed",
      after: name(pl.after) ?? "Another category",
      beforeValue: null,
      afterValue: null,
      txnId: typeof pl.txnId === "string" ? pl.txnId : null,
    };
  }
  const val = (v: unknown) => (typeof v === "number" || typeof v === "string" ? String(v) : null);
  return { what: label, before: money(pl.before), after: money(pl.after), beforeValue: val(pl.before), afterValue: val(pl.after), txnId: null };
}
