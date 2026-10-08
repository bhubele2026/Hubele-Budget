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
