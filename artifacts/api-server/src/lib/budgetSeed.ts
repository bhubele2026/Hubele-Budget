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
  "Essential — Housing",
  "Essential — Insurance",
  "Food & Groceries",
  "Transportation",
  "Kids & Pets",
  "Debt — Minimum Payments",
  "Avalanche — Extra to Highest APR",
  "Streaming & Tech",
  "Dining & Entertainment",
  "Shopping",
  "Other",
  "Savings & Sinking Funds",
];

export const SEED_CATEGORIES: SeedCategory[] = [
  // Income
  { groupName: "Income", kind: "income", sourceKind: "auto_bills", name: "Mom — Verizon reimbursement", planned: "88.00", note: "Auto-pulled from Bills · monthly" },
  { groupName: "Income", kind: "income", sourceKind: "auto_bills", name: "Hannah's paycheck (Exact)", planned: "4499.99", note: "Auto-pulled from Bills · biweekly" },
  { groupName: "Income", kind: "income", sourceKind: "auto_bills", name: "Brad's paycheck (KFI)", planned: "8100.00", note: "Auto-pulled from Bills · biweekly" },

  // Essential — Housing
  { groupName: "Essential — Housing", kind: "expense", sourceKind: "manual", name: "Mortgage (Lakeview)", planned: "1989.81", note: "Recurring — kept here, not in Debt Tracker" },
  { groupName: "Essential — Housing", kind: "expense", sourceKind: "manual", name: "HELOC (Figure)", planned: "677.40", note: "Recurring — kept here, not in Debt Tracker" },
  { groupName: "Essential — Housing", kind: "expense", sourceKind: "manual", name: "Electric & Gas (MGE)", planned: "241.00", note: null },
  { groupName: "Essential — Housing", kind: "expense", sourceKind: "manual", name: "Water/Sewer (City of Madison)", planned: "101.02", note: null },
  { groupName: "Essential — Housing", kind: "expense", sourceKind: "manual", name: "Internet/Cable (AT&T Uverse)", planned: "90.22", note: null },
  { groupName: "Essential — Housing", kind: "expense", sourceKind: "manual", name: "Phone (Verizon)", planned: "342.00", note: "⚠ HIGH — review plan" },
  { groupName: "Essential — Housing", kind: "expense", sourceKind: "manual", name: "Home Maintenance / Repairs", planned: "0", note: "Buffer" },

  // Essential — Insurance
  { groupName: "Essential — Insurance", kind: "expense", sourceKind: "manual", name: "Health/Medical Out-of-Pocket", planned: "0", note: null },
  { groupName: "Essential — Insurance", kind: "expense", sourceKind: "manual", name: "Auto Insurance (State Farm)", planned: "128.59", note: null },
  { groupName: "Essential — Insurance", kind: "expense", sourceKind: "manual", name: "Other Insurance (State Farm 2nd)", planned: "121.54", note: null },
  { groupName: "Essential — Insurance", kind: "expense", sourceKind: "manual", name: "Life Insurance (Trustage)", planned: "95.00", note: null },
  { groupName: "Essential — Insurance", kind: "expense", sourceKind: "manual", name: "Home Warranty (UHP)", planned: "53.85", note: null },
  { groupName: "Essential — Insurance", kind: "expense", sourceKind: "manual", name: "Health Insurance Premium", planned: "0", note: "Fill in if not pre-tax via paycheck" },

  // Food & Groceries
  { groupName: "Food & Groceries", kind: "expense", sourceKind: "manual", name: "Groceries ($425/wk × 4.33 wks)", planned: "460.00", note: null },
  { groupName: "Food & Groceries", kind: "expense", sourceKind: "manual", name: "Costco (warehouse stock-up)", planned: "0", note: "Periodic large hauls" },

  // Transportation
  { groupName: "Transportation", kind: "expense", sourceKind: "manual", name: "Toyota Lease", planned: "672.80", note: "Lease — kept here, not in Debt Tracker" },
  { groupName: "Transportation", kind: "expense", sourceKind: "manual", name: "Hannah's Car Payment (UW Credit Union)", planned: "651.55", note: "Auto loan — kept here, not in Debt Tracker" },
  { groupName: "Transportation", kind: "expense", sourceKind: "manual", name: "Gasoline (Kwik Trip / Woodmans)", planned: "250.00", note: null },
  { groupName: "Transportation", kind: "expense", sourceKind: "manual", name: "Auto Maintenance / Wash", planned: "0", note: null },
  { groupName: "Transportation", kind: "expense", sourceKind: "manual", name: "Parking (Madison)", planned: "0", note: null },

  // Kids & Pets
  { groupName: "Kids & Pets", kind: "expense", sourceKind: "manual", name: "Childcare / School Costs", planned: "0", note: "Madison Metro $60 + Monona Grove $50" },
  { groupName: "Kids & Pets", kind: "expense", sourceKind: "manual", name: "Kids' Activities", planned: "0", note: null },
  { groupName: "Kids & Pets", kind: "expense", sourceKind: "manual", name: "Camp K9 (Pet Boarding)", planned: "0", note: "Use only when traveling" },
  { groupName: "Kids & Pets", kind: "expense", sourceKind: "manual", name: "Vet / Pet Other", planned: "0", note: "Buffer" },

  // Debt — Minimum Payments (top 16 active debts by APR, seeded as auto_debts placeholders;
  // a later task will replace this seed with a live pull from the Debts module).
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Ashley Furniture / Synchrony (34.99%)", planned: "33.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Mattress Firm / Synchrony Home (34.99%)", planned: "129.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Best Buy / Citi (29.99%)", planned: "29.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Capital One Platinum (28.74%)", planned: "200.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Amex Delta SkyMiles Gold (28.49%)", planned: "205.87", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Menards Big Card (28.49%)", planned: "92.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Amex Platinum POT (28.49%)", planned: "40.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Affirm — Best Buy Dec (28.32%)", planned: "151.01", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Affirm — Best Buy Feb (28.17%)", planned: "72.54", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Capital One Quicksilver (28.24%)", planned: "38.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Discover (27.99%)", planned: "80.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Credit One Bank (27.99%)", planned: "8.25", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "PayPal Credit — Brad / Synchrony (27.49%)", planned: "44.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "PayPal Credit — Hannah / Synchrony (27.49%)", planned: "99.00", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Affirm — Shady Rays (26.97%)", planned: "19.11", note: "Live from Debt Tracker" },
  { groupName: "Debt — Minimum Payments", kind: "expense", sourceKind: "auto_debts", name: "Amex Blue Cash Preferred (26.49%)", planned: "40.00", note: "Live from Debt Tracker" },

  // Avalanche — Extra to Highest APR
  { groupName: "Avalanche — Extra to Highest APR", kind: "expense", sourceKind: "manual", name: "Avalanche extra", planned: "2225.00", note: "Tag transactions with category 'Avalanche extra' to feed Actual" },

  // Streaming & Tech
  { groupName: "Streaming & Tech", kind: "expense", sourceKind: "manual", name: "Tech Subscriptions (Boost, Ring, Tonal)", planned: "86.78", note: null },
  { groupName: "Streaming & Tech", kind: "expense", sourceKind: "manual", name: "Streaming (Netflix, Hulu, Spotify, Peacock)", planned: "167.68", note: null },
  { groupName: "Streaming & Tech", kind: "expense", sourceKind: "manual", name: "Brewers F&B / Streaming Sports", planned: "0", note: "MLB Brewers tickets/food avg" },
  { groupName: "Streaming & Tech", kind: "expense", sourceKind: "manual", name: "Other Tech / Software", planned: "0", note: "Buffer for variable subs" },

  // Dining & Entertainment
  { groupName: "Dining & Entertainment", kind: "expense", sourceKind: "manual", name: "Restaurants & Bars", planned: "460.00", note: null },
  { groupName: "Dining & Entertainment", kind: "expense", sourceKind: "manual", name: "DoorDash & Delivery", planned: "0", note: "⚠ HIGH — discipline target" },
  { groupName: "Dining & Entertainment", kind: "expense", sourceKind: "manual", name: "Coffee (Starbucks, Dunkin)", planned: "0", note: null },
  { groupName: "Dining & Entertainment", kind: "expense", sourceKind: "manual", name: "Movies / Concerts / Other Fun", planned: "0", note: null },

  // Shopping
  { groupName: "Shopping", kind: "expense", sourceKind: "manual", name: "Clothing (Threadbeast/Stitch/Lulu)", planned: "0", note: "⚠ Cancel these subs" },
  { groupName: "Shopping", kind: "expense", sourceKind: "manual", name: "Amazon (Non-essentials)", planned: "0", note: null },
  { groupName: "Shopping", kind: "expense", sourceKind: "manual", name: "Walmart / Target", planned: "0", note: null },
  { groupName: "Shopping", kind: "expense", sourceKind: "manual", name: "Best Buy / Electronics", planned: "0", note: null },
  { groupName: "Shopping", kind: "expense", sourceKind: "manual", name: "Home & Menards", planned: "0", note: null },

  // Other
  { groupName: "Other", kind: "expense", sourceKind: "manual", name: "Charitable Giving (Athenaeum)", planned: "0", note: null },
  { groupName: "Other", kind: "expense", sourceKind: "manual", name: "Education (Becker, Eastern Univ)", planned: "0", note: null },
  { groupName: "Other", kind: "expense", sourceKind: "manual", name: "Intuit Financing", planned: "0", note: null },
  { groupName: "Other", kind: "expense", sourceKind: "manual", name: "Student Loan (Nelnet / Dept of Ed)", planned: "237.58", note: "Federal loan — kept here, not in Debt Tracker" },
  { groupName: "Other", kind: "expense", sourceKind: "manual", name: "Gaming subs", planned: "61.16", note: null },
  { groupName: "Other", kind: "expense", sourceKind: "manual", name: "Misc / Buffer", planned: "0", note: "Catch-all small items" },

  // Savings & Sinking Funds
  { groupName: "Savings & Sinking Funds", kind: "expense", sourceKind: "manual", name: "Investments", planned: "0", note: null },
  { groupName: "Savings & Sinking Funds", kind: "expense", sourceKind: "manual", name: "Emergency Fund Contribution", planned: "0", note: "Build $1,000 starter first" },
  { groupName: "Savings & Sinking Funds", kind: "expense", sourceKind: "manual", name: "Tax Sinking Fund", planned: "0", note: "Save for next April taxes (~$1,500/yr)" },
  { groupName: "Savings & Sinking Funds", kind: "expense", sourceKind: "manual", name: "Kids' Savings / 529", planned: "0", note: "Resume after high-APR debt is gone" },
  { groupName: "Savings & Sinking Funds", kind: "expense", sourceKind: "manual", name: "Retirement (extra contributions)", planned: "0", note: "Don't reduce employer match contributions" },
];
