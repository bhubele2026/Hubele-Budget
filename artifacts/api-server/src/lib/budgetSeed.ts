export type SeedCategory = {
  name: string;
  groupName: string;
  kind: "income" | "expense";
  sourceKind: "manual" | "auto_bills" | "auto_debts";
  planned: string;
  note: string | null;
  // (#474) When true, the category is created with `exclude_from_budget=true`
  // and is omitted from every Budget page roll-up (planned, actual, groups,
  // summary). Used for the system-managed "Uncategorized" category. No
  // budget_lines row is seeded for these categories.
  excludeFromBudget?: boolean;
};

// (#474) Canonical name for the system-managed Uncategorized category. Picked
// on Transactions/Chase/Amex to mark a row as triaged without contaminating
// budget math. Excluded from the Budget page entirely (treated like
// transfers in actuals roll-ups). Mapping rules cannot target it.
export const UNCATEGORIZED_CATEGORY_NAME = "Uncategorized";

// (#607) Canonical name for the system-managed Transfer category. Picked on
// a transaction's category picker to mark the row as an internal transfer
// without polluting budget actuals. Mirrors the Uncategorized pattern:
// `excludeFromBudget=true` filters it out of every Budget page roll-up,
// and mapping rules are forbidden from targeting it. Picking it on a row
// also flips `isTransfer=true` (with `isTransferUserOverridden=true`) so
// the row is excluded from actuals via the existing transfer filter and
// future Plaid syncs don't re-flip it from the description heuristic.
export const TRANSFER_CATEGORY_NAME = "Transfer";

export const SEED_MONTH = "2026-05-01";

export const SEED_GROUP_ORDER = [
  "Income",
  "Housing & Utilities",
  "Insurance & Health",
  "Food",
  "Transportation",
  "Kids & Pets",
  "Debt — Minimum Payments",
  "Avalanche — Extra to Highest APR",
  "Lifestyle & Shopping",
  "Savings & Debt Payoff",
];

export type SeedRecurringItem = {
  name: string;
  kind: "income" | "bill" | "subscription";
  amount: string;
  frequency: "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "annual" | "onetime";
  dayOfMonth: number | null;
  anchorDate: string | null;
  // Name of the budget category this recurring item should link to.
  // Defaults to `name` when not provided.
  categoryName?: string;
};

// Recurring items that back the auto_bills budget categories.
// `categoryName` (or `name` if absent) must match a SEED_CATEGORIES entry.
// Income items are linked by name match; bills set `categoryName` explicitly
// to point at the consolidated category they roll up into.
export const SEED_RECURRING_ITEMS: SeedRecurringItem[] = [
  // --- Income (3) ---
  {
    name: "Mom — Verizon reimbursement",
    categoryName: "Other Income",
    kind: "income",
    amount: "88.00",
    frequency: "monthly",
    dayOfMonth: 15,
    anchorDate: null,
  },
  {
    name: "Hannah's paycheck (Exact)",
    kind: "income",
    amount: "4499.99",
    frequency: "biweekly",
    dayOfMonth: null,
    anchorDate: "2026-05-08",
  },
  {
    name: "Brad's paycheck (KFI)",
    kind: "income",
    amount: "8100.00",
    frequency: "biweekly",
    dayOfMonth: null,
    anchorDate: "2026-05-01",
  },

  // --- Bills (18) — totals exactly $8,466.70/mo for May 2026 ---
  // (5 weekly events × $450 = $2,250 + monthly sum $6,216.70).
  // Order roughly mirrors the user's Bills list so they read naturally.
  // categoryName values point at the consolidated SEED_CATEGORIES from
  // Task #65 (Subscriptions, Car Payments, Utilities, Insurance, etc).
  {
    name: "PlayStation Network",
    kind: "bill",
    amount: "18.98",
    frequency: "monthly",
    dayOfMonth: 5,
    anchorDate: null,
    categoryName: "Subscriptions",
  },
  {
    name: "PlayStation Network",
    kind: "bill",
    amount: "18.98",
    frequency: "monthly",
    dayOfMonth: 16,
    anchorDate: null,
    categoryName: "Subscriptions",
  },
  {
    name: "Hannah's Car (UW Credit Union)",
    kind: "bill",
    amount: "651.55",
    frequency: "monthly",
    dayOfMonth: 6,
    anchorDate: null,
    categoryName: "Car Payments",
  },
  {
    name: "Toyota Lease",
    kind: "bill",
    amount: "672.80",
    frequency: "monthly",
    dayOfMonth: 7,
    anchorDate: null,
    categoryName: "Car Payments",
  },
  {
    name: "Kwik Trip / gas",
    kind: "bill",
    amount: "200.00",
    frequency: "monthly",
    dayOfMonth: 9,
    anchorDate: null,
    categoryName: "Gas, Maintenance & Parking",
  },
  {
    name: "Kwik Trip / gas",
    kind: "bill",
    amount: "200.00",
    frequency: "monthly",
    dayOfMonth: 24,
    anchorDate: null,
    categoryName: "Gas, Maintenance & Parking",
  },
  {
    name: "Weekly Spend",
    kind: "bill",
    amount: "450.00",
    frequency: "weekly",
    dayOfMonth: null,
    anchorDate: "2026-05-02",
    categoryName: "Misc / Buffer",
  },
  {
    // Amount chosen so the May 2026 Bills "per month" total lands on
    // exactly $8,466.70 (5 weekly events × $450 + sum of monthly bills).
    name: "Monthly Spend",
    kind: "bill",
    amount: "440.45",
    frequency: "monthly",
    dayOfMonth: 1,
    anchorDate: null,
    categoryName: "Misc / Buffer",
  },
  {
    name: "TruStage / Ethos",
    kind: "bill",
    amount: "95.00",
    frequency: "monthly",
    dayOfMonth: 15,
    anchorDate: null,
    categoryName: "Insurance",
  },
  {
    name: "Mortgage (Lakeview)",
    kind: "bill",
    amount: "1989.81",
    frequency: "monthly",
    dayOfMonth: 14,
    anchorDate: null,
    categoryName: "Mortgage (Lakeview)",
  },
  {
    name: "Verizon Wireless",
    kind: "bill",
    amount: "342.00",
    frequency: "monthly",
    dayOfMonth: 16,
    anchorDate: null,
    categoryName: "Utilities",
  },
  {
    name: "MGE Electric & Gas",
    kind: "bill",
    amount: "241.00",
    frequency: "monthly",
    dayOfMonth: 20,
    anchorDate: null,
    categoryName: "Utilities",
  },
  {
    name: "Water/Sewer",
    kind: "bill",
    amount: "101.02",
    frequency: "monthly",
    dayOfMonth: 24,
    anchorDate: null,
    categoryName: "Utilities",
  },
  {
    name: "Student Loan (Nelnet)",
    kind: "bill",
    amount: "237.58",
    frequency: "monthly",
    dayOfMonth: 29,
    anchorDate: null,
    categoryName: "Misc / Buffer",
  },
  {
    name: "Dog Waste Removal",
    kind: "bill",
    amount: "80.00",
    frequency: "monthly",
    dayOfMonth: 1,
    anchorDate: null,
    categoryName: "Home Maintenance & Warranty",
  },
  {
    name: "State Farm",
    kind: "bill",
    amount: "121.54",
    frequency: "monthly",
    dayOfMonth: 3,
    anchorDate: null,
    categoryName: "Insurance",
  },
  {
    name: "State Farm Insurance",
    kind: "bill",
    amount: "128.59",
    frequency: "monthly",
    dayOfMonth: 3,
    anchorDate: null,
    categoryName: "Insurance",
  },
  {
    name: "HELOC (Figure)",
    kind: "bill",
    amount: "677.40",
    frequency: "monthly",
    dayOfMonth: 3,
    anchorDate: null,
    categoryName: "HELOC (Figure)",
  },
];

export const SEED_CATEGORIES: SeedCategory[] = [
  // 1. Income
  { groupName: "Income", kind: "income", sourceKind: "auto_bills", name: "Hannah's paycheck (Exact)", planned: "4499.99", note: "Auto-pulled from Bills · biweekly" },
  { groupName: "Income", kind: "income", sourceKind: "auto_bills", name: "Brad's paycheck (KFI)", planned: "8100.00", note: "Auto-pulled from Bills · biweekly" },
  { groupName: "Income", kind: "income", sourceKind: "auto_bills", name: "Other Income", planned: "88.00", note: "Reimbursements, side income" },

  // 2. Housing & Utilities
  { groupName: "Housing & Utilities", kind: "expense", sourceKind: "manual", name: "Mortgage (Lakeview)", planned: "1989.81", note: "Recurring — kept here, not in Debt Tracker" },
  { groupName: "Housing & Utilities", kind: "expense", sourceKind: "manual", name: "HELOC (Figure)", planned: "677.40", note: "Recurring — kept here, not in Debt Tracker" },
  { groupName: "Housing & Utilities", kind: "expense", sourceKind: "manual", name: "Utilities", planned: "774.24", note: "Electric, gas, water, internet, phone" },
  { groupName: "Housing & Utilities", kind: "expense", sourceKind: "manual", name: "Home Maintenance & Warranty", planned: "53.85", note: "Repairs + UHP warranty" },

  // 3. Insurance & Health
  { groupName: "Insurance & Health", kind: "expense", sourceKind: "manual", name: "Health", planned: "0", note: "Premium + out-of-pocket" },
  { groupName: "Insurance & Health", kind: "expense", sourceKind: "manual", name: "Insurance", planned: "345.13", note: "Auto, home, life" },

  // 4. Food
  { groupName: "Food", kind: "expense", sourceKind: "manual", name: "Groceries", planned: "460.00", note: "Includes Costco" },
  { groupName: "Food", kind: "expense", sourceKind: "manual", name: "Dining & Coffee", planned: "460.00", note: "Restaurants, DoorDash, coffee" },

  // 5. Transportation
  { groupName: "Transportation", kind: "expense", sourceKind: "manual", name: "Car Payments", planned: "1324.35", note: "Toyota Lease + Hannah's car" },
  { groupName: "Transportation", kind: "expense", sourceKind: "manual", name: "Gas, Maintenance & Parking", planned: "250.00", note: null },

  // 6. Kids & Pets
  { groupName: "Kids & Pets", kind: "expense", sourceKind: "manual", name: "Childcare & Activities", planned: "0", note: null },
  { groupName: "Kids & Pets", kind: "expense", sourceKind: "manual", name: "Pets", planned: "0", note: "Camp K9 + vet" },

  // Debt — Minimum Payments: rows are generated live from the Debts tracker on
  // every GET /budget/months/:monthStart (see syncAutoDebtCategories). No seed
  // rows here — adding/removing/editing a debt updates this group automatically.

  // Avalanche — Extra to Highest APR
  // The "Avalanche payment" line is system-managed: it's created and kept in
  // sync by syncAvalanchePaymentCategory based on avalancheSettings.manualExtra.
  // No seed entry here on purpose.

  // 7. Lifestyle & Shopping
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Subscriptions", planned: "315.62", note: "Streaming, tech, software, gaming" },
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Shopping", planned: "0", note: "Amazon, Walmart/Target, clothing, electronics, home" },
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Entertainment", planned: "0", note: "Movies, concerts, fun" },
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Charitable Giving & Education", planned: "0", note: "Athenaeum + Becker/Eastern Univ" },
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Misc / Buffer", planned: "237.58", note: "Catch-all small items + Nelnet student loan rolled in" },

  // 8. Savings & Debt Payoff
  { groupName: "Savings & Debt Payoff", kind: "expense", sourceKind: "manual", name: "Emergency Fund", planned: "0", note: "Build $1,000 starter first" },
  { groupName: "Savings & Debt Payoff", kind: "expense", sourceKind: "manual", name: "Investments & Retirement", planned: "0", note: "Investments + extra retirement contributions" },
  { groupName: "Savings & Debt Payoff", kind: "expense", sourceKind: "manual", name: "Kids' Savings / 529", planned: "0", note: "Resume after high-APR debt is gone" },
  { groupName: "Savings & Debt Payoff", kind: "expense", sourceKind: "manual", name: "Tax Sinking Fund", planned: "0", note: "Save for next April taxes (~$1,500/yr)" },

  // (#474) System-managed Uncategorized category. Picked on a transaction
  // to mark it as triaged without contaminating budget math. Excluded from
  // the Budget page entirely (no group, no totals). `groupName` is set to
  // the same name so it never sneaks into a real group when filtering is
  // disabled. No budget_lines row is seeded for it.
  {
    groupName: UNCATEGORIZED_CATEGORY_NAME,
    kind: "expense",
    sourceKind: "manual",
    name: UNCATEGORIZED_CATEGORY_NAME,
    planned: "0",
    note: null,
    excludeFromBudget: true,
  },

  // (#607) System-managed Transfer category. Picked on a transaction to
  // classify it as an internal transfer (savings move, credit-card payment
  // between own accounts, etc.) without contaminating budget math. Same
  // `excludeFromBudget` treatment as Uncategorized — never appears as a
  // line, in a group, or in the month-summary totals. Picking it on a row
  // also flips `isTransfer=true` so the row is excluded from actuals by
  // the existing transfer filter, and `isTransferUserOverridden=true` so
  // future Plaid syncs don't re-flip it. Mapping rules cannot target it.
  {
    groupName: TRANSFER_CATEGORY_NAME,
    kind: "expense",
    sourceKind: "manual",
    name: TRANSFER_CATEGORY_NAME,
    planned: "0",
    note: null,
    excludeFromBudget: true,
  },
];

// Maps every old (pre-consolidation) category name to its new consolidated
// target name. Used by the one-time per-user migration in /budget/months/...
// to merge planned/actual amounts and re-point transactions, recurring items,
// mapping rules, and avalanche settings onto the new category. Idempotent.
export const BUDGET_CATEGORY_MIGRATION_MAP: Record<string, string> = {
  // Income
  "Mom — Verizon reimbursement": "Other Income",

  // Housing & Utilities
  "Electric & Gas (MGE)": "Utilities",
  "Water/Sewer (City of Madison)": "Utilities",
  "Internet/Cable (AT&T Uverse)": "Utilities",
  "Phone (Verizon)": "Utilities",
  "Home Maintenance / Repairs": "Home Maintenance & Warranty",
  "Home Warranty (UHP)": "Home Maintenance & Warranty",

  // Insurance & Health
  "Health/Medical Out-of-Pocket": "Health",
  "Health Insurance Premium": "Health",
  "Auto Insurance (State Farm)": "Insurance",
  "Other Insurance (State Farm 2nd)": "Insurance",
  "Life Insurance (Trustage)": "Insurance",

  // Food
  "Groceries ($425/wk × 4.33 wks)": "Groceries",
  "Costco (warehouse stock-up)": "Groceries",
  "Restaurants & Bars": "Dining & Coffee",
  "DoorDash & Delivery": "Dining & Coffee",
  "Coffee (Starbucks, Dunkin)": "Dining & Coffee",

  // Transportation
  "Toyota Lease": "Car Payments",
  "Hannah's Car Payment (UW Credit Union)": "Car Payments",
  "Gasoline (Kwik Trip / Woodmans)": "Gas, Maintenance & Parking",
  "Auto Maintenance / Wash": "Gas, Maintenance & Parking",
  "Parking (Madison)": "Gas, Maintenance & Parking",

  // Kids & Pets
  "Childcare / School Costs": "Childcare & Activities",
  "Kids' Activities": "Childcare & Activities",
  "Camp K9 (Pet Boarding)": "Pets",
  "Vet / Pet Other": "Pets",

  // Lifestyle & Shopping
  "Tech Subscriptions (Boost, Ring, Tonal)": "Subscriptions",
  "Streaming (Netflix, Hulu, Spotify, Peacock)": "Subscriptions",
  "Brewers F&B / Streaming Sports": "Subscriptions",
  "Other Tech / Software": "Subscriptions",
  "Gaming subs": "Subscriptions",
  "Clothing (Threadbeast/Stitch/Lulu)": "Shopping",
  "Amazon (Non-essentials)": "Shopping",
  "Walmart / Target": "Shopping",
  "Best Buy / Electronics": "Shopping",
  "Home & Menards": "Shopping",
  "Movies / Concerts / Other Fun": "Entertainment",
  "Charitable Giving (Athenaeum)": "Charitable Giving & Education",
  "Education (Becker, Eastern Univ)": "Charitable Giving & Education",
  // Older "Other" group leftovers with no clear new home — roll into Misc / Buffer.
  "Intuit Financing": "Misc / Buffer",
  "Student Loan (Nelnet / Dept of Ed)": "Misc / Buffer",

  // Savings & Debt Payoff
  "Emergency Fund Contribution": "Emergency Fund",
  "Investments": "Investments & Retirement",
  "Retirement (extra contributions)": "Investments & Retirement",
};
