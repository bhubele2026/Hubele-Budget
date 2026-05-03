export type SeedCategory = {
  name: string;
  groupName: string;
  kind: "income" | "expense";
  sourceKind: "manual" | "auto_bills" | "auto_debts";
  planned: string;
  note: string | null;
};

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
export const SEED_RECURRING_ITEMS: SeedRecurringItem[] = [
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
  { groupName: "Avalanche — Extra to Highest APR", kind: "expense", sourceKind: "manual", name: "Avalanche extra", planned: "2225.00", note: "Tag transactions with category 'Avalanche extra' to feed Actual" },

  // 7. Lifestyle & Shopping
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Subscriptions", planned: "315.62", note: "Streaming, tech, software, gaming" },
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Shopping", planned: "0", note: "Amazon, Walmart/Target, clothing, electronics, home" },
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Entertainment", planned: "0", note: "Movies, concerts, fun" },
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Charitable Giving & Education", planned: "0", note: "Athenaeum + Becker/Eastern Univ" },
  { groupName: "Lifestyle & Shopping", kind: "expense", sourceKind: "manual", name: "Misc / Buffer", planned: "0", note: "Catch-all small items" },

  // 8. Savings & Debt Payoff
  { groupName: "Savings & Debt Payoff", kind: "expense", sourceKind: "manual", name: "Emergency Fund", planned: "0", note: "Build $1,000 starter first" },
  { groupName: "Savings & Debt Payoff", kind: "expense", sourceKind: "manual", name: "Investments & Retirement", planned: "0", note: "Investments + extra retirement contributions" },
  { groupName: "Savings & Debt Payoff", kind: "expense", sourceKind: "manual", name: "Kids' Savings / 529", planned: "0", note: "Resume after high-APR debt is gone" },
  { groupName: "Savings & Debt Payoff", kind: "expense", sourceKind: "manual", name: "Tax Sinking Fund", planned: "0", note: "Save for next April taxes (~$1,500/yr)" },
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
