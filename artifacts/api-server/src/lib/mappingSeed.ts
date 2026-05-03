/**
 * Seed mapping rules: out-of-the-box patterns that translate the most common
 * bank/Amex transaction descriptions into the canonical budget categories
 * defined in `budgetSeed.ts`. Each entry references a seed category by name;
 * during seeding we resolve the name → categoryId for the current user.
 *
 * Patterns are matched case-insensitively as `contains`. Priority is set high
 * (50) so seed rules out-rank user-created defaults but can still be
 * over-ridden by adding a higher-priority rule.
 */
export type SeedMappingRule = {
  pattern: string;
  categoryName: string;
};

export const SEED_MAPPING_RULES: SeedMappingRule[] = [
  // ---------- Income ----------
  { pattern: "KFI STAFFING", categoryName: "Brad's paycheck (KFI)" },
  { pattern: "EXACT SCIENCES", categoryName: "Hannah's paycheck (Exact)" },

  // ---------- Credit-card payments → Debt minimums ----------
  // Amex
  { pattern: "AMERICAN EXPRESS ACH", categoryName: "Amex Delta SkyMiles Gold (28.49%)" },
  { pattern: "AMEX ACH PMT", categoryName: "Amex Delta SkyMiles Gold (28.49%)" },
  { pattern: "AMEX EPAYMENT", categoryName: "Amex Delta SkyMiles Gold (28.49%)" },

  // Capital One
  { pattern: "CAPITAL ONE CRCARDPMT", categoryName: "Capital One Platinum (28.74%)" },
  { pattern: "CAPITAL ONE MOBILE PYMT", categoryName: "Capital One Platinum (28.74%)" },

  // Apple Card / Goldman Sachs
  { pattern: "APPLECARD GSBANK", categoryName: "Apple Card (Goldman Sachs)" },
  { pattern: "GOLDMAN SACHS APPLE", categoryName: "Apple Card (Goldman Sachs)" },

  // PayPal credit lines
  { pattern: "PAYPAL PAYMTHLY", categoryName: "PayPal Credit — Brad / Synchrony (27.49%)" },
  { pattern: "SYNCHRONY PAYPAL", categoryName: "PayPal Credit — Brad / Synchrony (27.49%)" },

  // Discover / Citi / Credit One
  { pattern: "DISCOVER E-PAYMENT", categoryName: "Discover (27.99%)" },
  { pattern: "CITI CARD ONLINE", categoryName: "Best Buy / Citi (29.99%)" },
  { pattern: "CREDIT ONE BANK", categoryName: "Credit One Bank (27.99%)" },
  { pattern: "SYNCHRONY ASHLEY", categoryName: "Ashley Furniture / Synchrony (34.99%)" },
  { pattern: "MATTRESS FIRM", categoryName: "Mattress Firm / Synchrony Home (34.99%)" },
  { pattern: "MENARDS BIG CARD", categoryName: "Menards Big Card (28.49%)" },
  { pattern: "AFFIRM", categoryName: "Affirm — Best Buy Dec (28.32%)" },

  // ---------- Recurring bills (Essentials) ----------
  { pattern: "MGE", categoryName: "Electric & Gas (MGE)" },
  { pattern: "CITY OF MADISON", categoryName: "Water/Sewer (City of Madison)" },
  { pattern: "AT&T UVERSE", categoryName: "Internet/Cable (AT&T Uverse)" },
  { pattern: "ATT*BILL PAYMENT", categoryName: "Internet/Cable (AT&T Uverse)" },
  { pattern: "VERIZON", categoryName: "Phone (Verizon)" },
  { pattern: "STATE FARM", categoryName: "Auto Insurance (State Farm)" },
  { pattern: "TRUSTAGE", categoryName: "Life Insurance (Trustage)" },

  // ---------- Mortgage / housing-loan ----------
  { pattern: "LAKEVIEW", categoryName: "Mortgage (Lakeview)" },
  { pattern: "FIGURE", categoryName: "HELOC (Figure)" },
  { pattern: "NELNET", categoryName: "Student Loan (Nelnet / Dept of Ed)" },
  { pattern: "DEPT OF ED", categoryName: "Student Loan (Nelnet / Dept of Ed)" },

  // ---------- Transportation ----------
  { pattern: "TOYOTA FINANCIAL", categoryName: "Toyota Lease" },
  { pattern: "UW CREDIT UNION", categoryName: "Hannah's Car Payment (UW Credit Union)" },
  { pattern: "KWIK TRIP", categoryName: "Gasoline (Kwik Trip / Woodmans)" },
  { pattern: "WOODMANS", categoryName: "Gasoline (Kwik Trip / Woodmans)" },

  // ---------- Food & Groceries ----------
  { pattern: "TRADER JOE", categoryName: "Groceries ($425/wk × 4.33 wks)" },
  { pattern: "WHOLE FOODS", categoryName: "Groceries ($425/wk × 4.33 wks)" },
  { pattern: "HY-VEE", categoryName: "Groceries ($425/wk × 4.33 wks)" },
  { pattern: "COSTCO", categoryName: "Costco (warehouse stock-up)" },

  // ---------- Dining & Entertainment ----------
  { pattern: "DOORDASH", categoryName: "DoorDash & Delivery" },
  { pattern: "UBER EATS", categoryName: "DoorDash & Delivery" },
  { pattern: "GRUBHUB", categoryName: "DoorDash & Delivery" },
  { pattern: "STARBUCKS", categoryName: "Coffee (Starbucks, Dunkin)" },
  { pattern: "DUNKIN", categoryName: "Coffee (Starbucks, Dunkin)" },

  // ---------- Streaming & Tech ----------
  { pattern: "NETFLIX", categoryName: "Streaming (Netflix, Hulu, Spotify, Peacock)" },
  { pattern: "HULU", categoryName: "Streaming (Netflix, Hulu, Spotify, Peacock)" },
  { pattern: "SPOTIFY", categoryName: "Streaming (Netflix, Hulu, Spotify, Peacock)" },
  { pattern: "PEACOCK", categoryName: "Streaming (Netflix, Hulu, Spotify, Peacock)" },
  { pattern: "RING.COM", categoryName: "Tech Subscriptions (Boost, Ring, Tonal)" },

  // ---------- Shopping ----------
  { pattern: "AMAZON", categoryName: "Amazon (Non-essentials)" },
  { pattern: "WALMART", categoryName: "Walmart / Target" },
  { pattern: "TARGET", categoryName: "Walmart / Target" },
  { pattern: "BEST BUY", categoryName: "Best Buy / Electronics" },
  { pattern: "MENARDS", categoryName: "Home & Menards" },
];

export const SEED_MAPPING_PRIORITY = 50;
