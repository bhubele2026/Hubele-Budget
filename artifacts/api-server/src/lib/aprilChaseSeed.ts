import { and, eq, isNull, like } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  mappingRulesTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
  forecastSettingsTable,
} from "@workspace/db";
import { categorize, loadUserRules } from "./autoCategorize";

type SeedRow = {
  idx: number;
  date: string;
  description: string;
  type: "expense" | "income";
  pfc: string;
  amount: number;
};

// 95 transactions for April 2026 — Chase checking activity supplied by the
// user. Running balance reconciles from $4,944.06 (3/31 carryover) to
// $5,554.45 (4/30). Embedded so we don't depend on attached_assets at runtime.
export const APRIL_2026_CHASE_ROWS: readonly SeedRow[] = [
  { idx: 1, date: "2026-04-01", description: "CAPITAL ONE CRCARDPMT CA0CBEAA436C428 WEB ID: 9541719318", type: "expense", pfc: "LOAN_PAYMENTS", amount: 500.00 },
  { idx: 2, date: "2026-04-01", description: "Venmo", type: "expense", pfc: "TRANSFER_OUT", amount: 16.25 },
  { idx: 3, date: "2026-04-01", description: "PAYPAL INST XFER DOORDASH MOOYAH WEB ID: PAYPALSI77 Merchant: Mooyah", type: "expense", pfc: "FOOD_AND_DRINK", amount: 42.53 },
  { idx: 4, date: "2026-04-01", description: "APPLECARD GSBANK PAYMENT 2228596 WEB ID: 9999999999 Merchant: Apple Card", type: "expense", pfc: "LOAN_PAYMENTS", amount: 227.50 },
  { idx: 5, date: "2026-04-02", description: "AMERICAN EXPRESS ACH PMT W3556 WEB ID: 2005032111", type: "expense", pfc: "LOAN_PAYMENTS", amount: 600.00 },
  { idx: 6, date: "2026-04-02", description: "UPSTART NETWORK CORNING / 1028845 WEB ID: 45466061FN Merchant: Upstart", type: "expense", pfc: "LOAN_PAYMENTS", amount: 1309.17 },
  { idx: 7, date: "2026-04-03", description: "PAYPAL PURCHASE STITCHFIXIN WEB ID: PAYPALSI77", type: "expense", pfc: "GENERAL_MERCHANDISE", amount: 42.77 },
  { idx: 8, date: "2026-04-03", description: "FIGURE LENDING L FIGUREPAYM PPD ID: 1191069000 Merchant: Figure Lending", type: "expense", pfc: "LOAN_PAYMENTS", amount: 677.40 },
  { idx: 9, date: "2026-04-03", description: "CAPITAL ONE CRCARDPMT CA040925E95DF6A WEB ID: 9541719318", type: "expense", pfc: "LOAN_PAYMENTS", amount: 91.00 },
  { idx: 10, date: "2026-04-03", description: "PAYPAL PURCHASE PLAYSTATION WEB ID: PAYPALSI77 Merchant: Sony Playstation", type: "expense", pfc: "ENTERTAINMENT", amount: 18.98 },
  { idx: 11, date: "2026-04-03", description: "State Farm Merchant: State Farm", type: "expense", pfc: "GENERAL_SERVICES", amount: 128.59 },
  { idx: 12, date: "2026-04-03", description: "KFI STAFFING, LL PAYROLL PPD ID: 874304726", type: "income", pfc: "INCOME", amount: 3909.80 },
  { idx: 13, date: "2026-04-06", description: "PAYPAL TRANSFER PPD ID: PAYPALSD11", type: "income", pfc: "TRANSFER_IN", amount: 9.02 },
  { idx: 14, date: "2026-04-06", description: "AMERICAN EXPRESS ACH PMT M9212 WEB ID: 2005032111", type: "expense", pfc: "LOAN_PAYMENTS", amount: 85.01 },
  { idx: 15, date: "2026-04-06", description: "AMERICAN EXPRESS ACH PMT M9698 WEB ID: 2005032111", type: "expense", pfc: "LOAN_PAYMENTS", amount: 402.82 },
  { idx: 16, date: "2026-04-06", description: "PAYPAL PURCHASE NINTENDOAME WEB ID: PAYPALSI77", type: "expense", pfc: "ENTERTAINMENT", amount: 4.21 },
  { idx: 17, date: "2026-04-06", description: "Starbucks Merchant: Starbucks", type: "expense", pfc: "FOOD_AND_DRINK", amount: 15.00 },
  { idx: 18, date: "2026-04-06", description: "Best Buy Merchant: Best Buy", type: "expense", pfc: "LOAN_PAYMENTS", amount: 29.00 },
  { idx: 19, date: "2026-04-06", description: "CHASE CREDIT CRD AUTOPAY PPD ID: 4760039224", type: "expense", pfc: "LOAN_PAYMENTS", amount: 434.31 },
  { idx: 20, date: "2026-04-06", description: "UW Credit Union Loan Pay 000001836855588 WEB ID: 1222528268", type: "expense", pfc: "LOAN_PAYMENTS", amount: 651.55 },
  { idx: 21, date: "2026-04-06", description: "Online Transfer to SAV ...9037 transaction#: 28716437177 04/06", type: "expense", pfc: "TRANSFER_OUT", amount: 20.00 },
  { idx: 22, date: "2026-04-06", description: "Online Transfer to GMR ...0324 transaction#: 28716411133 04/06", type: "expense", pfc: "TRANSFER_OUT", amount: 10.00 },
  { idx: 23, date: "2026-04-06", description: "Online Transfer to GMR ...0324 transaction#: 28716405797 04/06", type: "expense", pfc: "TRANSFER_OUT", amount: 80.00 },
  { idx: 24, date: "2026-04-06", description: "State Farm Merchant: State Farm", type: "expense", pfc: "GENERAL_SERVICES", amount: 121.54 },
  { idx: 25, date: "2026-04-06", description: "PAYPAL TRANSFER PPD ID: PAYPALSD11", type: "income", pfc: "TRANSFER_IN", amount: 0.54 },
  { idx: 26, date: "2026-04-06", description: "PAYPAL TRANSFER PPD ID: PAYPALSD11", type: "income", pfc: "TRANSFER_IN", amount: 2.85 },
  { idx: 27, date: "2026-04-06", description: "PAYPAL TRANSFER PPD ID: PAYPALSD11", type: "income", pfc: "TRANSFER_IN", amount: 3.65 },
  { idx: 28, date: "2026-04-06", description: "PAYPAL TRANSFER PPD ID: PAYPALSD11", type: "income", pfc: "TRANSFER_IN", amount: 3.92 },
  { idx: 29, date: "2026-04-06", description: "PAYPAL TRANSFER PPD ID: PAYPALSD11", type: "income", pfc: "TRANSFER_IN", amount: 69.29 },
  { idx: 30, date: "2026-04-06", description: "PAYPAL TRANSFER PPD ID: PAYPALSD11", type: "income", pfc: "TRANSFER_IN", amount: 87.48 },
  { idx: 31, date: "2026-04-07", description: "PAYPAL INST XFER 1049422616723 WEB ID: PAYPALSI77", type: "expense", pfc: "TRANSFER_OUT", amount: 105.00 },
  { idx: 32, date: "2026-04-07", description: "TOYOTA ACH LEASE WEB 3L0Y0OBJS80I9FC WEB ID: 3953775816 Merchant: Toyota Ach Lease", type: "expense", pfc: "LOAN_PAYMENTS", amount: 672.80 },
  { idx: 33, date: "2026-04-08", description: "DISCOVER E-PAYMENT 2877 WEB ID: 2510020270", type: "expense", pfc: "LOAN_PAYMENTS", amount: 184.70 },
  { idx: 34, date: "2026-04-08", description: "BRGHTWHL* Aldo.. PURCHASE B ST-U6B8C1H0S5E2 WEB ID: 1800948598 Merchant: ALDO", type: "expense", pfc: "GENERAL_MERCHANDISE", amount: 200.00 },
  { idx: 35, date: "2026-04-09", description: "SYNCHRONY BANK PAYMENT 601918212201035 WEB ID: 1061537262 Merchant: Synchrony", type: "expense", pfc: "LOAN_PAYMENTS", amount: 200.00 },
  { idx: 36, date: "2026-04-09", description: "FID BKG SVC LLC MONEYLINE PPD ID: 0368004600 Merchant: Fidelity", type: "expense", pfc: "TRANSFER_OUT", amount: 50.00 },
  { idx: 37, date: "2026-04-09", description: "Kwik Trip Merchant: Kwik Trip", type: "expense", pfc: "TRANSPORTATION", amount: 200.00 },
  { idx: 38, date: "2026-04-09", description: "EXACT SCIENCES PAYROLL PPD ID: 9111111103", type: "income", pfc: "INCOME", amount: 2274.43 },
  { idx: 39, date: "2026-04-10", description: "AFFIRM.COM PAYME AFFIRM.COM ST-B4Q8V6T6D5K5 WEB ID: 4270465600 Merchant: Affirm", type: "expense", pfc: "LOAN_PAYMENTS", amount: 72.54 },
  { idx: 40, date: "2026-04-13", description: "AMERICAN EXPRESS ACH PMT W7814 WEB ID: 2005032111", type: "expense", pfc: "LOAN_PAYMENTS", amount: 150.00 },
  { idx: 41, date: "2026-04-13", description: "AMERICAN EXPRESS ACH PMT W8248 WEB ID: 2005032111", type: "expense", pfc: "LOAN_PAYMENTS", amount: 300.00 },
  { idx: 42, date: "2026-04-13", description: "Dunkin' Donuts Merchant: Dunkin'", type: "expense", pfc: "FOOD_AND_DRINK", amount: 30.04 },
  { idx: 43, date: "2026-04-13", description: "SYNCHRONY BANK PAYMENT 650172445143046 WEB ID: 1061537262 Merchant: Synchrony", type: "expense", pfc: "LOAN_PAYMENTS", amount: 129.00 },
  { idx: 44, date: "2026-04-13", description: "PAYPAL PURCHASE ADOBE INC ADOBE WEB ID: PAYPALSI77 Merchant: Adobe", type: "expense", pfc: "GENERAL_SERVICES", amount: 13.70 },
  { idx: 45, date: "2026-04-13", description: "PAYPAL PURCHASE DOORDASH ORSOSR WEB ID: PAYPALSI77 Merchant: Orsosr", type: "expense", pfc: "FOOD_AND_DRINK", amount: 32.54 },
  { idx: 46, date: "2026-04-13", description: "PAYPAL PURCHASE DOORDASH PHILZC WEB ID: PAYPALSI77 Merchant: Philzc", type: "expense", pfc: "FOOD_AND_DRINK", amount: 40.34 },
  { idx: 47, date: "2026-04-13", description: "PAYPAL PURCHASE DOORDASH BIRDSN WEB ID: PAYPALSI77 Merchant: Birdsn", type: "expense", pfc: "FOOD_AND_DRINK", amount: 70.70 },
  { idx: 48, date: "2026-04-13", description: "Online Transfer to GMR ...0324 transaction#: 28803014520 04/13", type: "expense", pfc: "TRANSFER_OUT", amount: 50.00 },
  { idx: 49, date: "2026-04-13", description: "PAYPAL PURCHASE PARAMNTPLUS WEB ID: PAYPALSI77", type: "expense", pfc: "ENTERTAINMENT", amount: 14.76 },
  { idx: 50, date: "2026-04-13", description: "APPLE GS SAVINGS TRANSFER 910121286352 WEB ID: 2222229999", type: "income", pfc: "TRANSFER_IN", amount: 600.00 },
  { idx: 51, date: "2026-04-14", description: "TruStage LIFE INSUR PPD ID: 007CMMLIPY Merchant: TruStage Insurance", type: "expense", pfc: "GENERAL_SERVICES", amount: 95.00 },
  { idx: 52, date: "2026-04-14", description: "PAYPAL PURCHASE PLAYSTATION WEB ID: PAYPALSI77 Merchant: Sony Playstation", type: "expense", pfc: "ENTERTAINMENT", amount: 6.32 },
  { idx: 53, date: "2026-04-14", description: "Credit One Bank Payment 48220862 WEB ID: WEB000004", type: "expense", pfc: "LOAN_PAYMENTS", amount: 8.25 },
  { idx: 54, date: "2026-04-14", description: "AFFIRM.COM PAYME AFFIRM.COM ST-X0K4X4G0X4O8 WEB ID: 4270465600 Merchant: Affirm", type: "expense", pfc: "LOAN_PAYMENTS", amount: 20.38 },
  { idx: 55, date: "2026-04-15", description: "AFFIRM.COM PAYME AFFIRM.COM ST-Z6V3X0F4U6T7 WEB ID: 1800948598 Merchant: Affirm", type: "expense", pfc: "LOAN_PAYMENTS", amount: 107.75 },
  { idx: 56, date: "2026-04-15", description: "LAKEVIEW LN SRV MTG PYMT 0061850673 WEB ID: 1541322890 Merchant: Lakeview Loan Servicing", type: "expense", pfc: "LOAN_PAYMENTS", amount: 1989.81 },
  { idx: 57, date: "2026-04-15", description: "ODP TRANSFER FROM SAVINGS ...9128", type: "income", pfc: "TRANSFER_IN", amount: 335.58 },
  { idx: 58, date: "2026-04-16", description: "Verizon Wireless Merchant: Verizon", type: "expense", pfc: "RENT_AND_UTILITIES", amount: 425.65 },
  { idx: 59, date: "2026-04-16", description: "PAYPAL PURCHASE ANCESTRYCOM WEB ID: PAYPALSI77", type: "expense", pfc: "GENERAL_SERVICES", amount: 26.36 },
  { idx: 60, date: "2026-04-16", description: "ODP TRANSFER FROM SAVINGS ...9128", type: "income", pfc: "TRANSFER_IN", amount: 452.01 },
  { idx: 61, date: "2026-04-17", description: "PAYPAL INST XFER PYPL PAYMTHLY WEB ID: PAYPALSI77 Merchant: Paymthly", type: "expense", pfc: "LOAN_PAYMENTS", amount: 59.06 },
  { idx: 62, date: "2026-04-17", description: "KFI STAFFING, LL PAYROLL PPD ID: 874304726", type: "income", pfc: "INCOME", amount: 3819.79 },
  { idx: 63, date: "2026-04-20", description: "AMERICAN EXPRESS ACH PMT M1684 WEB ID: 2005032111", type: "expense", pfc: "LOAN_PAYMENTS", amount: 162.41 },
  { idx: 64, date: "2026-04-20", description: "AMERICAN EXPRESS ACH PMT M1016 WEB ID: 2005032111", type: "expense", pfc: "LOAN_PAYMENTS", amount: 410.32 },
  { idx: 65, date: "2026-04-20", description: "Online Transfer to GMR ...0324 transaction#: 28905723669 04/20", type: "expense", pfc: "TRANSFER_OUT", amount: 30.00 },
  { idx: 66, date: "2026-04-20", description: "Online Transfer to GMR ...0324 transaction#: 28905703675 04/20", type: "expense", pfc: "TRANSFER_OUT", amount: 10.00 },
  { idx: 67, date: "2026-04-20", description: "CAPITAL ONE CRCARDPMT CA00822C50CA9D3 WEB ID: 9541719318", type: "expense", pfc: "LOAN_PAYMENTS", amount: 34.00 },
  { idx: 68, date: "2026-04-20", description: "AFFIRM.COM PAYME AFFIRM.COM ST-P2Y2J7K9D2C3 WEB ID: 1800948598 Merchant: Affirm", type: "expense", pfc: "LOAN_PAYMENTS", amount: 18.22 },
  { idx: 69, date: "2026-04-20", description: "Dunkin' Donuts Merchant: Dunkin'", type: "expense", pfc: "FOOD_AND_DRINK", amount: 30.04 },
  { idx: 70, date: "2026-04-20", description: "AFFIRM.COM PAYME AFFIRM.COM ST-S5P7M8K7A2N6 WEB ID: 4270465600 Merchant: Affirm", type: "expense", pfc: "LOAN_PAYMENTS", amount: 151.01 },
  { idx: 71, date: "2026-04-20", description: "ATM WITHDRAWAL 008272 04/182251 W BR", type: "expense", pfc: "TRANSFER_OUT", amount: 60.00 },
  { idx: 72, date: "2026-04-20", description: "Venmo", type: "income", pfc: "TRANSFER_IN", amount: 85.00 },
  { idx: 73, date: "2026-04-21", description: "MADISON GAS EL BILLPAY PPD ID: 0000000160 Merchant: Madison Gas El", type: "expense", pfc: "RENT_AND_UTILITIES", amount: 241.00 },
  { idx: 74, date: "2026-04-21", description: "Starbucks Merchant: Starbucks", type: "expense", pfc: "FOOD_AND_DRINK", amount: 10.00 },
  { idx: 75, date: "2026-04-21", description: "DISCOVER E-PAYMENT 2877 WEB ID: 2510020270", type: "expense", pfc: "LOAN_PAYMENTS", amount: 185.30 },
  { idx: 76, date: "2026-04-22", description: "METRO MARKET #434 MADISON WI 04/22 Merchant: Metro Market", type: "expense", pfc: "FOOD_AND_DRINK", amount: 58.84 },
  { idx: 77, date: "2026-04-22", description: "SYNCHRONY BANK PAYMENT 601919305959779 WEB ID: 1061537262 Merchant: Synchrony", type: "expense", pfc: "LOAN_PAYMENTS", amount: 34.00 },
  { idx: 78, date: "2026-04-23", description: "FID BKG SVC LLC MONEYLINE PPD ID: 0368004600 Merchant: Fidelity", type: "expense", pfc: "TRANSFER_OUT", amount: 50.00 },
  { idx: 79, date: "2026-04-23", description: "INTUIT FINANCING QBC_PMTS PPD ID: 5463467445 Merchant: Intuit Financing Qbc", type: "expense", pfc: "LOAN_PAYMENTS", amount: 176.06 },
  { idx: 80, date: "2026-04-23", description: "EXACT SCIENCES PAYROLL PPD ID: 9111111103", type: "income", pfc: "INCOME", amount: 2274.42 },
  { idx: 81, date: "2026-04-24", description: "Costco Merchant: Costco", type: "expense", pfc: "GENERAL_MERCHANDISE", amount: 62.45 },
  { idx: 82, date: "2026-04-24", description: "CITY OF MADISON MADISON WI 9306199 WEB ID: 0000070577 Merchant: City Of", type: "expense", pfc: "RENT_AND_UTILITIES", amount: 89.48 },
  { idx: 83, date: "2026-04-24", description: "Kwik Trip Merchant: Kwik Trip", type: "expense", pfc: "TRANSPORTATION", amount: 200.00 },
  { idx: 84, date: "2026-04-27", description: "Walmart Merchant: Walmart", type: "expense", pfc: "GENERAL_MERCHANDISE", amount: 47.05 },
  { idx: 85, date: "2026-04-27", description: "Online Transfer to GMR ...0324 transaction#: 28983515805 04/27", type: "expense", pfc: "TRANSFER_OUT", amount: 50.00 },
  { idx: 86, date: "2026-04-27", description: "SHEN ZHEN SHI SH PURCHASE 1049879865343 WEB ID: 770510487C Merchant: Shen Zhen Shi Sh", type: "expense", pfc: "GENERAL_MERCHANDISE", amount: 58.90 },
  { idx: 87, date: "2026-04-27", description: "Dunkin' Donuts Merchant: Dunkin'", type: "expense", pfc: "FOOD_AND_DRINK", amount: 30.43 },
  { idx: 88, date: "2026-04-27", description: "Dunkin' Donuts Merchant: Dunkin'", type: "expense", pfc: "FOOD_AND_DRINK", amount: 29.54 },
  { idx: 89, date: "2026-04-27", description: "DISCOVER E-PAYMENT 2877 WEB ID: 2510020270", type: "expense", pfc: "LOAN_PAYMENTS", amount: 39.00 },
  { idx: 90, date: "2026-04-29", description: "AFFIRM.COM PAYME AFFIRM.COM ST-J6L0K3Z3X2C4 WEB ID: 1800948598 Merchant: Affirm", type: "expense", pfc: "LOAN_PAYMENTS", amount: 66.93 },
  { idx: 91, date: "2026-04-29", description: "AFFIRM.COM PAYME AFFIRM.COM ST-L4R3X2J2U2C3 WEB ID: 1800948598 Merchant: Affirm", type: "expense", pfc: "LOAN_PAYMENTS", amount: 139.50 },
  { idx: 92, date: "2026-04-29", description: "DEPT EDUCATION STUDENT LN PPD ID: 9102001001 Merchant: Dept Education Student Ln", type: "expense", pfc: "LOAN_PAYMENTS", amount: 237.58 },
  { idx: 93, date: "2026-04-30", description: "CAPITAL ONE MOBILE PMT CA0855757503E1D WEB ID: 9279744380", type: "expense", pfc: "LOAN_PAYMENTS", amount: 100.00 },
  { idx: 94, date: "2026-04-30", description: "Online Transfer to GMR ...0324 transaction#: 29024305475 04/30", type: "expense", pfc: "TRANSFER_OUT", amount: 15.00 },
  { idx: 95, date: "2026-04-30", description: "REMOTE ONLINE DEPOSIT # 1", type: "income", pfc: "TRANSFER_IN", amount: 272.00 },
];

// Stable carryover starting balance: end-of-day 3/31/2026, derived from
// $4,444.06 (running after tx#1) + the $500 expense in tx#1.
export const APRIL_2026_OPENING_BALANCE = 4944.06;
export const APRIL_2026_ENDING_BALANCE = 5554.45;

const SOURCE = "plaid:chase";
const SYNTHETIC_ITEM_ID = "seed-april-2026-chase";
const SYNTHETIC_ACCOUNT_ID = "seed-april-2026-chase-checking";

// New mapping rules to add (only if not already present). Each entry has a
// fixed pattern plus an ordered list of candidate target category names —
// the first one that exists for the user wins. Lets us cover both v1 and v2
// (post-consolidation) category sets without overwriting user customizations.
type RuleSeed = {
  pattern: string;
  candidates: string[];
  // When true and no candidate matches a user category (even by substring),
  // fall back to the user's "Misc / Buffer" catch-all so the row still
  // categorizes and the budget Actual reflects it. Used for debt-bearing
  // rows where the user's debt category names are unpredictable.
  fallbackMiscBuffer?: boolean;
};

const NEW_MAPPING_RULES: RuleSeed[] = [
  // Toyota lease appears as "TOYOTA ACH LEASE" in the Chase wire — existing
  // "TOYOTA FINANCIAL" rule wouldn't match.
  { pattern: "TOYOTA ACH LEASE", candidates: ["Car Payments", "Toyota Lease"] },
  // Utilities — existing rules use "MGE"; the actual Chase wire reads
  // "MADISON GAS EL", and the city water bill arrives as "CITY OF MADISON".
  { pattern: "MADISON GAS", candidates: ["Utilities", "Electric & Gas (MGE)"] },
  // Groceries
  { pattern: "METRO MARKET", candidates: ["Groceries", "Groceries ($425/wk × 4.33 wks)"] },
  // Shopping
  { pattern: "STITCHFIXIN", candidates: ["Shopping", "Clothing (Threadbeast/Stitch/Lulu)"] },
  { pattern: "SHEN ZHEN SHI", candidates: ["Shopping"] },
  { pattern: "BRGHTWHL", candidates: ["Shopping"] },
  { pattern: "ALDO", candidates: ["Shopping", "Clothing (Threadbeast/Stitch/Lulu)"] },
  // Subscriptions
  { pattern: "PARAMNTPLUS", candidates: ["Subscriptions", "Streaming (Netflix, Hulu, Spotify, Peacock)"] },
  { pattern: "ADOBE", candidates: ["Subscriptions", "Other Tech / Software"] },
  { pattern: "ANCESTRYCOM", candidates: ["Subscriptions", "Other Tech / Software"] },
  { pattern: "PLAYSTATION", candidates: ["Subscriptions", "Gaming subs"] },
  { pattern: "NINTENDOAME", candidates: ["Subscriptions", "Gaming subs"] },
  // Dining
  { pattern: "MOOYAH", candidates: ["Dining & Coffee", "Restaurants & Bars"] },
  // Debt-bearing patterns: fuzzy candidate list, with a final Misc / Buffer
  // fallback (see fallbackMiscBuffer) so the row always categorizes even when
  // the user's debt category names don't match any candidate.
  { pattern: "SYNCHRONY BANK PAYMENT", candidates: [
    "Synchrony", "Synchrony Bank",
    "Ashley Furniture / Synchrony (34.99%)",
    "Mattress Firm / Synchrony Home (34.99%)",
    "PayPal Credit — Brad / Synchrony (27.49%)",
  ], fallbackMiscBuffer: true },
  { pattern: "DEPT EDUCATION", candidates: [
    "Student Loan (Nelnet / Dept of Ed)",
    "Student Loan (Nelnet)",
    "Nelnet",
    "Dept of Ed",
    "Student Loan",
  ], fallbackMiscBuffer: true },
  { pattern: "INTUIT FINANCING", candidates: ["Intuit Financing", "Intuit"], fallbackMiscBuffer: true },
  { pattern: "CHASE CREDIT CRD AUTOPAY", candidates: [
    "Chase Sapphire", "Chase Freedom", "Chase",
  ], fallbackMiscBuffer: true },
  { pattern: "UPSTART NETWORK", candidates: ["Upstart", "Upstart Personal Loan"], fallbackMiscBuffer: true },
  // Chase wire uses "MOBILE PMT" (no Y) — existing seed only covers "MOBILE PYMT".
  { pattern: "CAPITAL ONE MOBILE PMT", candidates: [
    "Capital One Platinum (28.74%)", "Capital One",
  ], fallbackMiscBuffer: true },
  // PayPal Pay Monthly arrives as "PYPL PAYMTHLY" — existing seed only covers
  // "PAYPAL PAYMTHLY".
  { pattern: "PYPL PAYMTHLY", candidates: [
    "PayPal Credit — Brad / Synchrony (27.49%)",
    "PayPal Credit",
    "PayPal",
  ], fallbackMiscBuffer: true },
];

// Description fragments that flag transfers between the user's own accounts.
// Mostly already covered by autoCategorize.ts's TRANSFER_DESC_PATTERNS plus
// the TRANSFER_IN/TRANSFER_OUT PFC primary, but we list them here as a
// belt-and-suspenders to be sure every row in the seed is correctly tagged.
const TRANSFER_HINTS = [
  "online transfer to",
  "online transfer from",
  "odp transfer",
  "venmo",
  "paypal transfer",
  "fid bkg svc",
  "apple gs savings transfer",
  "atm withdrawal",
  "remote online deposit",
  "paypal inst xfer 1049422616723",
];

function isTransferRow(r: SeedRow): boolean {
  if (r.pfc === "TRANSFER_IN" || r.pfc === "TRANSFER_OUT") return true;
  const hay = r.description.toLowerCase();
  return TRANSFER_HINTS.some((p) => hay.includes(p));
}

async function ensureChaseAccount(userId: string): Promise<{
  itemRowId: string;
  accountIdText: string;
  accountRowId: string;
  isSynthetic: boolean;
}> {
  // Prefer the account the user has already linked as their bank snapshot
  // (the Chase checking they connected on the Forecast page). If none, fall
  // back to any depository/checking account on file. If still none, create a
  // synthetic plaid_item + plaid_account so transactions have a stable home.
  const [settings] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, userId));

  let accountRowId: string | null = settings?.bankSnapshotAccountId ?? null;

  if (!accountRowId) {
    const accounts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, userId));
    const checking = accounts.find(
      (a) => a.subtype === "checking" || a.type === "depository",
    );
    if (checking) accountRowId = checking.id;
  }

  if (accountRowId) {
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.id, accountRowId),
          eq(plaidAccountsTable.userId, userId),
        ),
      );
    if (acct) {
      return {
        itemRowId: acct.itemId,
        accountIdText: acct.accountId,
        accountRowId: acct.id,
        isSynthetic: false,
      };
    }
  }

  // Synthetic Chase fallback so the page has data even before the user has
  // completed Plaid OAuth. Idempotent on plaid_items.itemId / plaid_accounts.accountId.
  let [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.itemId, SYNTHETIC_ITEM_ID));
  if (!item) {
    [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        itemId: SYNTHETIC_ITEM_ID,
        accessToken: "synthetic-no-access",
        institutionId: null,
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .onConflictDoNothing()
      .returning();
    if (!item) {
      [item] = await db
        .select()
        .from(plaidItemsTable)
        .where(eq(plaidItemsTable.itemId, SYNTHETIC_ITEM_ID));
    }
  }
  if (!item) throw new Error("Failed to materialize synthetic Chase plaid_item");

  let [acct] = await db
    .select()
    .from(plaidAccountsTable)
    .where(eq(plaidAccountsTable.accountId, SYNTHETIC_ACCOUNT_ID));
  if (!acct) {
    [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        itemId: item.id,
        accountId: SYNTHETIC_ACCOUNT_ID,
        name: "Chase Checking",
        officialName: "Chase Total Checking",
        mask: "0000",
        type: "depository",
        subtype: "checking",
      })
      .onConflictDoNothing()
      .returning();
    if (!acct) {
      [acct] = await db
        .select()
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.accountId, SYNTHETIC_ACCOUNT_ID));
    }
  }
  if (!acct) throw new Error("Failed to materialize synthetic Chase plaid_account");

  // Wire up the bank snapshot so the Chase page picks up this account too.
  if (!settings?.bankSnapshotAccountId) {
    await db
      .insert(forecastSettingsTable)
      .values({
        userId,
        bankSnapshotBalance: APRIL_2026_ENDING_BALANCE.toFixed(2),
        bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
        bankSnapshotSource: "manual",
        bankSnapshotAccountId: acct.id,
        bankSnapshotName: acct.name,
        bankSnapshotMask: acct.mask,
      })
      .onConflictDoUpdate({
        target: forecastSettingsTable.userId,
        set: {
          bankSnapshotBalance: APRIL_2026_ENDING_BALANCE.toFixed(2),
          bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
          bankSnapshotSource: "manual",
          bankSnapshotAccountId: acct.id,
          bankSnapshotName: acct.name,
          bankSnapshotMask: acct.mask,
        },
      });
  }

  return {
    itemRowId: item.id,
    accountIdText: acct.accountId,
    accountRowId: acct.id,
    isSynthetic: true,
  };
}

async function ensureExtraMappingRules(userId: string): Promise<number> {
  const [cats, existingRules] = await Promise.all([
    db
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, userId)),
    db
      .select()
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, userId)),
  ]);
  const catByName = new Map(cats.map((c) => [c.name, c]));
  const havePattern = new Set(
    existingRules.map((r) => r.pattern.toLowerCase()),
  );
  const miscBuffer = catByName.get("Misc / Buffer");

  // Substring/contains match: returns the first user category whose name
  // contains any of the candidate strings (case-insensitive). Catches
  // auto-generated debt categories like "Upstart Personal Loan ($1,309/mo)"
  // when the candidate is "Upstart".
  const findByContains = (candidates: string[]) => {
    for (const cand of candidates) {
      const needle = cand.toLowerCase();
      if (!needle) continue;
      const hit = cats.find((c) => c.name.toLowerCase().includes(needle));
      if (hit) return hit;
    }
    return null;
  };

  let inserted = 0;
  for (const seed of NEW_MAPPING_RULES) {
    if (havePattern.has(seed.pattern.toLowerCase())) continue;
    const exact = seed.candidates
      .map((n) => catByName.get(n))
      .find((c): c is NonNullable<typeof c> => !!c);
    const contains = exact ? null : findByContains(seed.candidates);
    const target =
      exact ??
      contains ??
      (seed.fallbackMiscBuffer ? miscBuffer ?? null : null);
    if (!target) continue;
    // Lower priority for Misc / Buffer fallback rules so any future
    // user-defined rule cleanly wins. Direct matches keep the default 50.
    const isFallback = !exact && !contains;
    await db.insert(mappingRulesTable).values({
      userId,
      pattern: seed.pattern,
      matchType: "contains",
      categoryId: target.id,
      priority: isFallback ? 10 : 50,
    });
    inserted++;
  }
  return inserted;
}

export type AprilChaseSeedResult = {
  alreadySeeded: boolean;
  inserted: number;
  skipped: number;
  categorized: number;
  transfers: number;
  rulesAdded: number;
  endingBalance: string;
  syntheticAccount: boolean;
  accountId: string;
};

export async function seedAprilChase(
  userId: string,
): Promise<AprilChaseSeedResult> {
  const rulesAdded = await ensureExtraMappingRules(userId);
  const acct = await ensureChaseAccount(userId);
  const rules = await loadUserRules(userId);

  // Backfill: re-categorize previously-seeded April Chase rows that landed
  // uncategorized (e.g. from an earlier seed run before the new mapping
  // rules were added). Only touches rows we own (plaid_transaction_id with
  // our seed prefix) that have no category and are not flagged as transfer.
  const backfillCandidates = await db
    .select({
      id: transactionsTable.id,
      description: transactionsTable.description,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        isNull(transactionsTable.categoryId),
        eq(transactionsTable.isTransfer, false),
        like(transactionsTable.plaidTransactionId, "seed-april-2026-chase:%"),
      ),
    );
  let backfilled = 0;
  for (const row of backfillCandidates) {
    const result = categorize(
      { description: row.description, pfcPrimary: null },
      rules,
    );
    if (result.categoryId) {
      await db
        .update(transactionsTable)
        .set({ categoryId: result.categoryId })
        .where(eq(transactionsTable.id, row.id));
      backfilled++;
    }
  }

  let inserted = 0;
  let skipped = 0;
  let categorized = backfilled;
  let transfers = 0;

  for (const r of APRIL_2026_CHASE_ROWS) {
    const plaidTxnId = `seed-april-2026-chase:${r.idx}`;
    // Idempotency: bail out if we've already seeded this row.
    const [existing] = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidTransactionId, plaidTxnId));
    if (existing) {
      skipped++;
      continue;
    }

    const isTransfer = isTransferRow(r);
    const result = isTransfer
      ? { categoryId: null, isTransfer: true }
      : categorize(
          { description: r.description, pfcPrimary: r.pfc },
          rules,
        );
    if (result.categoryId) categorized++;
    if (isTransfer) transfers++;

    const signed =
      r.type === "income" ? r.amount.toFixed(2) : (-r.amount).toFixed(2);

    await db.insert(transactionsTable).values({
      userId,
      occurredOn: r.date,
      occurredAt: new Date(`${r.date}T12:00:00Z`).toISOString(),
      description: r.description,
      amount: signed,
      account: "Chase Checking",
      categoryId: result.categoryId,
      isTransfer,
      source: SOURCE,
      plaidTransactionId: plaidTxnId,
      plaidAccountId: acct.accountIdText,
    });
    inserted++;
  }

  return {
    alreadySeeded: inserted === 0 && rulesAdded === 0,
    inserted,
    skipped,
    categorized,
    transfers,
    rulesAdded,
    endingBalance: APRIL_2026_ENDING_BALANCE.toFixed(2),
    syntheticAccount: acct.isSynthetic,
    accountId: acct.accountIdText,
  };
}
