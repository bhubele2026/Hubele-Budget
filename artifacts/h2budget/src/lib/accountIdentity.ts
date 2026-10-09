/**
 * Account identity — one pure answer to "what is this account, and what colour
 * is it?" shared by chips, panel edges, transaction rows and chart legends.
 *
 * Colour reinforces identity; the LABEL always says it too. Amex gets the
 * teal-green accent, checking the navy, the other cards the violet (`card2`),
 * everything else steel grey. Only two card accents exist besides Amex's, so
 * a third non-Amex card shares `other` with the non-cards — the label + mask
 * still tell them apart, which is why `label` and `mask4` are never optional.
 */
export type AccountKind = "checking" | "savings" | "amex" | "card" | "loan" | "other";
export type AccountAccentName = "checking" | "amex" | "card2" | "other";

export interface IdentityInput {
  id: string;
  name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  institutionName?: string | null;
  institutionSlug?: string | null;
  liabilityKind?: string | null;
}

export interface AccountIdentity {
  id: string;
  kind: AccountKind;
  /** Institution + name, de-duplicated ("Chase Total Checking"). Never empty. */
  label: string;
  /** The name alone (or the institution), for tight spaces. Never empty. */
  shortLabel: string;
  /** Last four digits of the mask, or "" when there is none. */
  mask4: string;
  accent: AccountAccentName;
  isCard: boolean;
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

function isAmex(a: IdentityInput): boolean {
  const hay = `${norm(a.institutionSlug)} ${norm(a.institutionName)}`;
  return hay.includes("amex") || hay.includes("american express") || hay.includes("american_express");
}

function kindOf(a: IdentityInput): AccountKind {
  const type = norm(a.type);
  const sub = norm(a.subtype);
  const liab = norm(a.liabilityKind);
  if (type === "credit" || sub.includes("credit card") || liab === "credit") {
    return isAmex(a) ? "amex" : "card";
  }
  if (type === "loan" || liab === "mortgage" || liab === "student" || liab === "loan" ||
      sub === "mortgage" || sub === "student" || sub === "auto") return "loan";
  if (sub === "savings" || sub === "money market" || sub === "cd") return "savings";
  if (sub === "checking" || (type === "depository" && sub === "")) return "checking";
  if (isAmex(a)) return "amex";
  return "other";
}

/**
 * Ids of the non-Amex cards in order of first appearance. Pass the result to
 * `identityOf` so each card keeps one accent no matter how the list is
 * filtered or re-sorted later. Pure: same accounts in, same order out.
 */
export function cardOrderOf(accounts: readonly IdentityInput[]): string[] {
  const seen: string[] = [];
  for (const a of accounts) {
    if (kindOf(a) === "card" && !seen.includes(a.id)) seen.push(a.id);
  }
  return seen;
}

export function identityOf(
  a: IdentityInput,
  opts: { cardOrder?: readonly string[] } = {},
): AccountIdentity {
  const kind = kindOf(a);
  const inst = (a.institutionName ?? "").trim();
  const name = (a.name ?? "").trim();
  const fallback =
    kind === "checking" ? "Checking" : kind === "savings" ? "Savings" :
    kind === "amex" ? "American Express" : kind === "card" ? "Card" :
    kind === "loan" ? "Loan" : "Account";
  let label: string;
  if (inst && name) {
    label = name.toLowerCase().startsWith(inst.toLowerCase()) ? name : `${inst} ${name}`;
  } else {
    label = name || inst || fallback;
  }
  const digits = (a.mask ?? "").replace(/\D/g, "");
  let accent: AccountAccentName = "other";
  if (kind === "checking") accent = "checking";
  else if (kind === "amex") accent = "amex";
  else if (kind === "card") {
    const i = (opts.cardOrder ?? []).indexOf(a.id);
    accent = i <= 0 ? "card2" : "other";
  }
  return {
    id: a.id,
    kind,
    label,
    shortLabel: name || inst || fallback,
    mask4: digits.slice(-4),
    accent,
    isCard: kind === "amex" || kind === "card",
  };
}

// ── Which account a TRANSACTION belongs to ──────────────────────────────────
//
// ⚠️ TWO IDS, ONE NAME. `transactions.plaidAccountId` holds Plaid's EXTERNAL
// `account_id` (plaidSync writes `t.account_id`). The items response gives each
// account both: `accountId` (that external id) and `id` (the internal
// `plaid_accounts` row id, which debts and settings key on). A lookup built on
// `id` and asked with a transaction's `plaidAccountId` never matches, so every
// row fell through to a nameless "Account" (the dashboard's Recent activity,
// 2026-10-09). Resolve a transaction through entries keyed by the EXTERNAL id
// (`buildEntries` in pages/next/accounts/entries.ts), and when there is no
// match say honestly where the row came from instead of guessing.

/** What `resolveTxnAccount` reads from a transaction (a generated `Transaction` fits). */
export interface TxnAccountRef {
  plaidAccountId?: string | null;
  source?: string | null;
  /** Free text on manual/imported rows. Never trusted as an identity. */
  account?: string | null;
}

/** One linked account, keyed by Plaid's external `account_id` (an `AccountEntry` fits). */
export interface TxnAccountEntry {
  plaidAccountId: string;
  identity: AccountIdentity;
  institutionName?: string | null;
  institutionSlug?: string | null;
}

/** The account a transaction belongs to; `known` is false for every fallback. */
export type ResolvedTxnAccount = AccountIdentity & { known: boolean };

/** A linked item's name for the slug, else the slug title-cased ("wells-fargo" → "Wells Fargo"). */
function institutionFromSlug(slug: string, entries: readonly TxnAccountEntry[]): string {
  const hit = entries.find((e) => norm(e.institutionSlug) === slug && norm(e.institutionName));
  if (hit) return hit.institutionName!.trim();
  if (slug === "amex") return "American Express";
  return slug.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || "Bank";
}

/**
 * ⭐ The identity of the account a transaction belongs to. Pure.
 *
 * 1. Its `plaidAccountId` matches a linked account → that account's identity
 *    (`known: true`).
 * 2. Otherwise, by `source` (`known: false`):
 *    - `amex` (the Amex workbook import) → "Amex (imported)", Amex accent;
 *    - `manual` → "Manual entry";
 *    - `plaid:<slug>` → "<institution> (no longer linked)": a bank row whose
 *      account is not in the items list any more (unlinked or re-linked);
 *    - anything else → "Unknown account".
 */
export function resolveTxnAccount(
  txn: TxnAccountRef,
  entries: readonly TxnAccountEntry[] | ReadonlyMap<string, TxnAccountEntry>,
): ResolvedTxnAccount {
  const list: readonly TxnAccountEntry[] = Array.isArray(entries)
    ? entries
    : [...(entries as ReadonlyMap<string, TxnAccountEntry>).values()];
  const ext = (txn.plaidAccountId ?? "").trim();
  const hit = ext ? list.find((e) => e.plaidAccountId === ext) : undefined;
  if (hit) return { ...hit.identity, known: true };
  const source = norm(txn.source);
  const id = `${source}:${ext}`;
  let input: IdentityInput;
  if (source === "amex") {
    input = { id, name: "Amex (imported)", type: "credit", institutionSlug: "amex" };
  } else if (source === "manual") {
    input = { id, name: "Manual entry" };
  } else if (source.startsWith("plaid:")) {
    const slug = source.slice(6);
    const amex = /amex|american/.test(slug);
    input = {
      id,
      name: `${institutionFromSlug(slug, list)} (no longer linked)`,
      type: amex ? "credit" : null,
      institutionSlug: amex ? "amex" : null,
    };
  } else {
    input = { id, name: "Unknown account" };
  }
  return { ...identityOf(input), known: false };
}
