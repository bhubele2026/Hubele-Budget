export type SeedMappingRule = {
  pattern: string;
  categoryName: string;
};

export const SEED_MAPPING_RULES: SeedMappingRule[] = [
  { pattern: "KFI STAFFING", categoryName: "Brad's paycheck (KFI)" },
  { pattern: "EXACT SCIENCES", categoryName: "Hannah's paycheck (Exact)" },

  // Credit-card / installment debt payment patterns. Each one points at the
  // catch-all "Misc / Buffer" category so a fresh user gets every rule wired
  // up at seed time (the per-debt categories — e.g. "Amex Delta SkyMiles Gold
  // (28.49%)" — are created lazily by syncAutoDebtCategories only after the
  // user has actually added that debt to the Debts tracker, so we cannot
  // reference them by name from the static seed without silently skipping).
  // The auto-learn / inline categorize flow will repoint individual rules at
  // the real debt category the first time the user re-categorizes one of
  // these transactions.
  { pattern: "AMERICAN EXPRESS ACH", categoryName: "Misc / Buffer" },
  { pattern: "AMEX ACH PMT", categoryName: "Misc / Buffer" },
  { pattern: "AMEX EPAYMENT", categoryName: "Misc / Buffer" },

  { pattern: "CAPITAL ONE CRCARDPMT", categoryName: "Misc / Buffer" },
  { pattern: "CAPITAL ONE MOBILE PYMT", categoryName: "Misc / Buffer" },

  { pattern: "APPLECARD GSBANK", categoryName: "Misc / Buffer" },
  { pattern: "GOLDMAN SACHS APPLE", categoryName: "Misc / Buffer" },

  { pattern: "PAYPAL PAYMTHLY", categoryName: "Misc / Buffer" },
  { pattern: "SYNCHRONY PAYPAL", categoryName: "Misc / Buffer" },

  { pattern: "DISCOVER E-PAYMENT", categoryName: "Misc / Buffer" },
  { pattern: "CITI CARD ONLINE", categoryName: "Misc / Buffer" },
  { pattern: "CREDIT ONE BANK", categoryName: "Misc / Buffer" },
  { pattern: "SYNCHRONY ASHLEY", categoryName: "Misc / Buffer" },
  { pattern: "MATTRESS FIRM", categoryName: "Misc / Buffer" },
  { pattern: "MENARDS BIG CARD", categoryName: "Misc / Buffer" },
  { pattern: "AFFIRM", categoryName: "Misc / Buffer" },

  { pattern: "MGE", categoryName: "Utilities" },
  { pattern: "CITY OF MADISON", categoryName: "Utilities" },
  { pattern: "AT&T UVERSE", categoryName: "Utilities" },
  { pattern: "ATT*BILL PAYMENT", categoryName: "Utilities" },
  { pattern: "VERIZON", categoryName: "Utilities" },
  { pattern: "STATE FARM", categoryName: "Insurance" },
  { pattern: "TRUSTAGE", categoryName: "Insurance" },

  { pattern: "LAKEVIEW", categoryName: "Mortgage (Lakeview)" },
  { pattern: "FIGURE", categoryName: "HELOC (Figure)" },
  { pattern: "NELNET", categoryName: "Misc / Buffer" },
  { pattern: "DEPT OF ED", categoryName: "Misc / Buffer" },

  { pattern: "TOYOTA FINANCIAL", categoryName: "Car Payments" },
  { pattern: "UW CREDIT UNION", categoryName: "Car Payments" },
  { pattern: "KWIK TRIP", categoryName: "Gas, Maintenance & Parking" },
  { pattern: "WOODMANS", categoryName: "Gas, Maintenance & Parking" },

  { pattern: "TRADER JOE", categoryName: "Groceries" },
  { pattern: "WHOLE FOODS", categoryName: "Groceries" },
  { pattern: "HY-VEE", categoryName: "Groceries" },
  { pattern: "COSTCO", categoryName: "Groceries" },

  { pattern: "DOORDASH", categoryName: "Dining & Coffee" },
  { pattern: "UBER EATS", categoryName: "Dining & Coffee" },
  { pattern: "GRUBHUB", categoryName: "Dining & Coffee" },
  { pattern: "STARBUCKS", categoryName: "Dining & Coffee" },
  { pattern: "DUNKIN", categoryName: "Dining & Coffee" },

  { pattern: "NETFLIX", categoryName: "Subscriptions" },
  { pattern: "HULU", categoryName: "Subscriptions" },
  { pattern: "SPOTIFY", categoryName: "Subscriptions" },
  { pattern: "PEACOCK", categoryName: "Subscriptions" },
  { pattern: "RING.COM", categoryName: "Subscriptions" },

  { pattern: "AMAZON", categoryName: "Shopping" },
  { pattern: "WALMART", categoryName: "Shopping" },
  { pattern: "TARGET", categoryName: "Shopping" },
  { pattern: "BEST BUY", categoryName: "Shopping" },
  { pattern: "MENARDS", categoryName: "Shopping" },
];

export const SEED_MAPPING_PRIORITY = 50;
