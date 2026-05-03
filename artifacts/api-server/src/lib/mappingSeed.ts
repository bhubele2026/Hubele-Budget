export type SeedMappingRule = {
  pattern: string;
  categoryName: string;
};

export const SEED_MAPPING_RULES: SeedMappingRule[] = [
  { pattern: "KFI STAFFING", categoryName: "Brad's paycheck (KFI)" },
  { pattern: "EXACT SCIENCES", categoryName: "Hannah's paycheck (Exact)" },

  { pattern: "AMERICAN EXPRESS ACH", categoryName: "Amex Delta SkyMiles Gold (28.49%)" },
  { pattern: "AMEX ACH PMT", categoryName: "Amex Delta SkyMiles Gold (28.49%)" },
  { pattern: "AMEX EPAYMENT", categoryName: "Amex Delta SkyMiles Gold (28.49%)" },

  { pattern: "CAPITAL ONE CRCARDPMT", categoryName: "Capital One Platinum (28.74%)" },
  { pattern: "CAPITAL ONE MOBILE PYMT", categoryName: "Capital One Platinum (28.74%)" },

  { pattern: "APPLECARD GSBANK", categoryName: "Apple Card (Goldman Sachs)" },
  { pattern: "GOLDMAN SACHS APPLE", categoryName: "Apple Card (Goldman Sachs)" },

  { pattern: "PAYPAL PAYMTHLY", categoryName: "PayPal Credit — Brad / Synchrony (27.49%)" },
  { pattern: "SYNCHRONY PAYPAL", categoryName: "PayPal Credit — Brad / Synchrony (27.49%)" },

  { pattern: "DISCOVER E-PAYMENT", categoryName: "Discover (27.99%)" },
  { pattern: "CITI CARD ONLINE", categoryName: "Best Buy / Citi (29.99%)" },
  { pattern: "CREDIT ONE BANK", categoryName: "Credit One Bank (27.99%)" },
  { pattern: "SYNCHRONY ASHLEY", categoryName: "Ashley Furniture / Synchrony (34.99%)" },
  { pattern: "MATTRESS FIRM", categoryName: "Mattress Firm / Synchrony (34.99%)" },
  { pattern: "MENARDS BIG CARD", categoryName: "Menards Big Card (28.49%)" },
  { pattern: "AFFIRM", categoryName: "Affirm — Best Buy Dec (28.32%)" },

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
