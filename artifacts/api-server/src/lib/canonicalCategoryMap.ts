/**
 * Canonical merchant→category map used by the re-run categorization tool
 * (`scripts/src/recategorize.ts`). Lives next to `mappingSeed.ts` so future
 * seed changes update both pathways.
 *
 * Each entry's `category` is the literal name of a row in `budget_categories`
 * for the user. Patterns are matched case-insensitively. Transfers don't get
 * a category — they only get `is_transfer=true`.
 *
 * Originally extracted from the one-shot Chase-April-2026 backfill script;
 * kept conservative and easy to extend so future months / sources can re-use
 * it without forking.
 */
export type MatchType = "contains" | "starts_with";

export type CanonicalMapEntry = {
  /** Case-insensitive needle matched against the transaction description. */
  pattern: string;
  matchType: MatchType;
  /** Literal `budget_categories.name`, or "TRANSFER" for internal transfers. */
  category: string | "TRANSFER";
};

export type AmbiguousPattern = {
  pattern: string;
  reason: string;
};

/**
 * Merchant-by-merchant resolution map. Patterns are uppercase by convention;
 * matching is case-insensitive. Transfers between the user's own accounts
 * use the `TRANSFER` sentinel category.
 */
export const CANONICAL_CATEGORY_MAP: CanonicalMapEntry[] = [
  // ---- True transfers between the user's own accounts ----
  { pattern: "ONLINE TRANSFER TO",                matchType: "contains",    category: "TRANSFER" },
  { pattern: "ONLINE TRANSFER FROM",              matchType: "contains",    category: "TRANSFER" },
  { pattern: "ODP TRANSFER FROM SAVINGS",         matchType: "contains",    category: "TRANSFER" },
  { pattern: "APPLE GS SAVINGS TRANSFER",         matchType: "contains",    category: "TRANSFER" },
  { pattern: "Venmo",                             matchType: "starts_with", category: "TRANSFER" },
  { pattern: "PAYPAL TRANSFER",                   matchType: "starts_with", category: "TRANSFER" },
  { pattern: "PAYPAL INST XFER 1049422616723",    matchType: "contains",    category: "TRANSFER" },
  { pattern: "FID BKG SVC LLC MONEYLINE",         matchType: "contains",    category: "TRANSFER" },
  { pattern: "ATM WITHDRAWAL",                    matchType: "starts_with", category: "TRANSFER" },
  { pattern: "REMOTE ONLINE DEPOSIT",             matchType: "starts_with", category: "TRANSFER" },

  // ---- Loan / credit-card payments → debt-linked budget category ----
  { pattern: "APPLECARD GSBANK",                  matchType: "contains",    category: "Apple Card (Goldman Sachs)" },
  { pattern: "CAPITAL ONE CRCARDPMT",             matchType: "contains",    category: "Capital One Platinum" },
  { pattern: "CAPITAL ONE MOBILE PMT",            matchType: "contains",    category: "Capital One Platinum" },
  { pattern: "UPSTART NETWORK",                   matchType: "contains",    category: "Upstart Loan" },
  { pattern: "DISCOVER E-PAYMENT",                matchType: "contains",    category: "Discover" },
  { pattern: "CHASE CREDIT CRD AUTOPAY",          matchType: "contains",    category: "Chase Amazon Prime Visa" },
  { pattern: "PAYPAL INST XFER PYPL PAYMTHLY",    matchType: "contains",    category: "PayPal Credit (Brad) / Synchrony" },

  // ---- Mortgage / car / housing loans ----
  { pattern: "LAKEVIEW LN SRV",                   matchType: "contains",    category: "Mortgage (Lakeview)" },
  { pattern: "FIGURE LENDING",                    matchType: "contains",    category: "HELOC (Figure)" },
  { pattern: "TOYOTA ACH LEASE",                  matchType: "contains",    category: "Car Payments" },
  { pattern: "UW CREDIT UNION",                   matchType: "contains",    category: "Car Payments" },

  // ---- Recurring bills ----
  { pattern: "VERIZON",                           matchType: "contains",    category: "Utilities" },
  { pattern: "MADISON GAS",                       matchType: "contains",    category: "Utilities" },
  { pattern: "CITY OF MADISON",                   matchType: "contains",    category: "Utilities" },
  { pattern: "STATE FARM",                        matchType: "contains",    category: "Insurance" },
  { pattern: "TRUSTAGE",                          matchType: "contains",    category: "Insurance" },

  // ---- Income ----
  { pattern: "KFI STAFFING",                      matchType: "contains",    category: "Brad's paycheck (KFI)" },
  { pattern: "EXACT SCIENCES",                    matchType: "contains",    category: "Hannah's paycheck (Exact)" },

  // ---- Dining & coffee ----
  { pattern: "STARBUCKS",                         matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DUNKIN",                            matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DOORDASH MOOYAH",                   matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DOORDASH PHILZ",                    matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DOORDASH BIRDS",                    matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DOORDASH ORSOSR",                   matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "MOOYAH",                            matchType: "contains",    category: "Dining & Coffee" },

  // ---- Groceries / general merch ----
  { pattern: "METRO MARKET",                      matchType: "contains",    category: "Groceries" },
  { pattern: "COSTCO",                            matchType: "contains",    category: "Groceries" },
  { pattern: "WALMART",                           matchType: "contains",    category: "Shopping" },
  { pattern: "ALDO",                              matchType: "contains",    category: "Shopping" },
  { pattern: "BRGHTWHL",                          matchType: "contains",    category: "Shopping" },
  { pattern: "SHEN ZHEN SHI",                     matchType: "contains",    category: "Shopping" },
  { pattern: "STITCHFIXIN",                       matchType: "contains",    category: "Shopping" },

  // ---- Gas & transportation ----
  { pattern: "KWIK TRIP",                         matchType: "contains",    category: "Gas, Maintenance & Parking" },

  // ---- Subscriptions / entertainment ----
  { pattern: "PLAYSTATION",                       matchType: "contains",    category: "Subscriptions" },
  { pattern: "NINTENDOAME",                       matchType: "contains",    category: "Subscriptions" },
  { pattern: "PARAMNTPLUS",                       matchType: "contains",    category: "Subscriptions" },
  { pattern: "ADOBE",                             matchType: "contains",    category: "Subscriptions" },
  { pattern: "ANCESTRYCOM",                       matchType: "contains",    category: "Subscriptions" },

  // ---- Misc / Buffer (catch-alls) ----
  // NOTE: DEPT EDUCATION (federal student loan ACH) and INTUIT FINANCING (QBC
  // line of credit) are intentionally NOT auto-mapped here — neither has a
  // dedicated debt-linked budget category for this user. They are surfaced
  // under the "ambiguous" section so a human can either add a category or
  // keep routing them to Misc / Buffer manually. Persisting a high-priority
  // Misc/Buffer rule for these would silently misroute future syncs.
];

/**
 * Patterns intentionally NOT auto-applied because the right target is
 * ambiguous (multiple debts of the same family) or has no matching budget
 * category. Surfaced in the run summary so the user can disambiguate.
 */
export const AMBIGUOUS_PATTERNS: AmbiguousPattern[] = [
  { pattern: "AMERICAN EXPRESS ACH PMT", reason: "no Amex budget category for this user" },
  { pattern: "AFFIRM.COM PAYME",         reason: "5 Affirm debts; cannot disambiguate by description" },
  { pattern: "SYNCHRONY BANK PAYMENT",   reason: "4 Synchrony debts; cannot disambiguate by description" },
  { pattern: "Credit One Bank Payment",  reason: "no Credit One budget category for this user" },
  { pattern: "Best Buy",                 reason: "Best Buy is a Plaid LOAN_PAYMENTS row but no Best Buy / Citi debt category exists for this user (only Affirm — Best Buy)" },
  { pattern: "DEPT EDUCATION",           reason: "no Student Loan budget category for this user (currently routed to Misc / Buffer by a stale low-priority rule)" },
  { pattern: "INTUIT FINANCING",         reason: "no Intuit / QBC line-of-credit budget category for this user (currently routed to Misc / Buffer by a stale low-priority rule)" },
];

/** Case-insensitive `contains` / `starts_with` match against `desc`. */
export function matchesEntry(desc: string, e: CanonicalMapEntry): boolean {
  const hay = desc.toLowerCase();
  const needle = e.pattern.toLowerCase();
  return e.matchType === "starts_with" ? hay.startsWith(needle) : hay.includes(needle);
}

export function findAmbiguous(desc: string): AmbiguousPattern | null {
  const hay = desc.toLowerCase();
  for (const a of AMBIGUOUS_PATTERNS) {
    if (hay.includes(a.pattern.toLowerCase())) return a;
  }
  return null;
}
