// ⭐ EVERY TRANSACTION OF THE INVENTED HOUSEHOLD, in one list.
//
// The checking rows of October–November are `fixture.mjs`'s own (the forecast
// page's balance depends on them, so they are taken as they are). This file adds
// the months before (May–September 2026, from the same recurring plan) and two
// invented credit cards, "Card A" and "Card B", so the ledgers, the spending
// pages and the report charts have several months to draw.
//
// Nothing is random at run time: the history comes from a seeded generator, and
// the current month's card rows are written out by hand so the week's and the
// month's totals are known figures. Every name is made up.
import * as fx from "./fixture.mjs";

export const TODAY = fx.TODAY;
export const HISTORY_FROM = "2026-05-01";
/** The last day of the invented history; from the next day the checking rows are the forecast fixture's. */
export const HISTORY_TO = "2026-09-30";
export const TZ = "America/Chicago";

// ── small helpers ───────────────────────────────────────────────────────────
export const r2 = (n) => Math.round(n * 100) / 100;
export const money = (n) => r2(n).toFixed(2);
export const addDays = fx.addDays;
const D = (s) => new Date(`${s}T00:00:00Z`);
export const dow = (s) => D(s).getUTCDay();
export const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86_400_000);
export const monthStart = (s) => `${s.slice(0, 7)}-01`;
export const addMonths = (s, n) => {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
  return d.toISOString().slice(0, 10);
};
export const monthEnd = (s) => addDays(addMonths(monthStart(s), 1), -1);
export const weekStartOf = (s) => addDays(s, -dow(s)); // Sunday
const weekdayOnOrAfter = (s) => {
  let d = s;
  while (dow(d) === 0 || dow(d) === 6) d = addDays(d, 1);
  return d;
};
const lastWeekdayOf = (s) => {
  let d = monthEnd(s);
  while (dow(d) === 0 || dow(d) === 6) d = addDays(d, -1);
  return d;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
export const shortDay = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}`;
export const sum = (rows, f = (t) => Number(t.amount)) => r2(rows.reduce((s, t) => s + f(t), 0));

/** A seeded generator (mulberry32): the same list on every start. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── accounts ────────────────────────────────────────────────────────────────
export const CHECKING = fx.CHECKING;
export const CARD_ISSUER = "Juniper Card Services";
export const CARD_A = { rowId: "pa-card-a-1007", externalId: "acc-ext-card-a-1007", name: "Card A", mask: "1007", subtype: "credit card", institution: CARD_ISSUER, cadence: "weekly", brand: "blue" };
export const CARD_B = { rowId: "pa-card-b-2044", externalId: "acc-ext-card-b-2044", name: "Card B", mask: "2044", subtype: "credit card", institution: CARD_ISSUER, cadence: "monthly", brand: "silver" };
export const CARDS = [CARD_A, CARD_B];
export const ACCOUNTS = [CHECKING, CARD_A, CARD_B];
/** The app's own source key for a card row (its list of card sources is fixed in the app). */
export const CARD_SOURCE = "plaid:amex";
export const accountOf = (t) => ACCOUNTS.find((a) => a.externalId === t.plaidAccountId) ?? null;
export const isCardRow = (t) => t.plaidAccountId === CARD_A.externalId || t.plaidAccountId === CARD_B.externalId;

export const categoryName = (id) => fx.categories.find((c) => c.id === id)?.name ?? null;

// ── rows ────────────────────────────────────────────────────────────────────
const base = (id, date, description, amount, acct, x = {}) => ({
  id,
  occurredOn: date,
  occurredAt: null,
  description,
  amount: money(amount),
  account: acct.name,
  categoryId: x.categoryId ?? null,
  forecastFlag: acct === CHECKING,
  weeklyAllowance: x.weekly ?? false,
  weeklyBucket: x.bucket ?? null,
  monthlyAllowance: x.monthly ?? false,
  unplannedAllowance: x.unplanned ?? false,
  reimbursable: x.reimbursable ?? false,
  reimbursed: x.reimbursed ?? false,
  reviewed: x.reviewed ?? true,
  isTransfer: x.transfer ?? false,
  isTransferUserOverridden: false,
  categoryLockedByUser: false,
  splits: [],
  isExternalCardPayment: x.cardPayment ?? false,
  sentToReviewAt: null,
  notes: x.notes ?? null,
  source: acct === CHECKING ? "plaid" : CARD_SOURCE,
  member: x.member ?? null,
  owedBy: x.owedBy ?? null,
  plaidTransactionId: `ptx-${id}`,
  plaidAccountId: acct.externalId,
  debtId: x.debtId ?? null,
  pfcDetailed: x.pfc ?? null,
  pending: x.pending ?? false,
  matchedRuleId: x.ruleId ?? null,
  displayName: x.displayName ?? titleCase(description),
  merchantSignature: description.toLowerCase().replace(/[^a-z]+/g, " ").trim(),
  paymentState: null,
  confirmedByTxnId: null,
  expiredHold: false,
  expiredPair: false,
});
function titleCase(s) {
  return s
    .replace(/\s+#\d+$/, "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bPmt\b/g, "payment")
    .replace(/\bDir Dep\b/g, "direct deposit")
    .replace(/\bExp Reimb\b/g, "expense reimbursement");
}

// The merchants the cards are used at. [description, displayName, category, weekly bucket | "monthly" | null, low, high]
const SHOPS_A = [
  ["CORNER GROCER #114", "Corner Grocer", "cat-groceries", "groceries", 28, 96],
  ["CORNER GROCER #114", "Corner Grocer", "cat-groceries", "groceries", 12, 44],
  ["HILLTOP FUEL 0221", "Hilltop Fuel", "cat-fuel", "misc", 31, 58],
  ["LANTERN THAI KITCHEN", "Lantern Thai Kitchen", "cat-dining", "dining", 24, 62],
  ["MOSSY OAK COFFEE", "Mossy Oak Coffee", "cat-dining", "dining", 5, 14],
  ["NORTHGATE CINEMA", "Northgate Cinema", "cat-dining", "entertainment", 18, 36],
  ["BLUEBIRD PHARMACY", "Bluebird Pharmacy", "cat-health", "misc", 9, 41],
  ["PINE AND PAGE BOOKS", "Pine & Page Books", "cat-dining", "entertainment", 11, 34],
  ["GREENLEAF GARDEN CTR", "Greenleaf Garden Center", "cat-home-repair", "monthly", 22, 88],
  ["TIDY PAWS GROOMING", "Tidy Paws Grooming", "cat-pets", "monthly", 45, 65],
];
const SHOPS_B = [
  ["ORCHARD HOME GOODS", "Orchard Home Goods", "cat-home-repair", "monthly", 35, 140],
  ["THREADLINE CLOTHING", "Threadline Clothing", "cat-dining", "monthly", 28, 95],
  ["CLOUDNEST STORAGE", "Cloudnest Storage", "cat-subs", null, 9.99, 9.99],
  ["PAPERTRAIL NEWS", "Papertrail News", "cat-subs", null, 12, 12],
  ["WILLOW CREEK DENTAL", "Willow Creek Dental", "cat-health", "monthly", 40, 160],
  ["SUNDIAL HARDWARE", "Sundial Hardware", "cat-home-repair", "monthly", 14, 72],
];

function buildHistory() {
  const out = [];
  const from = HISTORY_FROM;
  const to = "2026-09-30";
  const jitter = rng(4821);
  // Checking: the same plan, the months before the forecast's window.
  for (const it of fx.ITEMS) {
    if (it.frequency === "onetime") continue;
    for (const occ of fx.expandItem(it, from, to)) {
      let d = occ.date;
      while (dow(d) === 0 || dow(d) === 6) d = addDays(d, 1);
      if (d > to) continue;
      const wobble = it.amountKind === "estimate" ? 0.8 + jitter() * 0.45 : 1;
      const amount = r2(occ.amount * wobble);
      out.push(
        base(`txn-${it.id.slice(3)}-${occ.date.slice(2).replace(/-/g, "")}`, d, it.bank, amount, CHECKING, {
          categoryId: it.categoryId,
          debtId: it.debtId,
        }),
      );
    }
  }
  // A few checking rows with no plan behind them, so the months are not identical.
  const extras = [
    ["2026-05-14", "COUNTY CLERK VEHICLE REG", -86, "cat-insurance"],
    ["2026-06-09", "PAWS CLINIC", -210.5, "cat-pets"],
    ["2026-06-22", "STATE TAX REFUND", 412, "cat-income"],
    ["2026-07-03", "LAKEVIEW CABIN RENTAL", -540, "cat-travel"],
    ["2026-07-18", "SUNDIAL HARDWARE #7", -64.32, "cat-home-repair"],
    ["2026-08-11", "MAPLEWOOD SCHOOL SUPPLIES", -118.4, "cat-childcare"],
    ["2026-08-27", "WILLOW CREEK DENTAL", -175, "cat-health"],
    ["2026-09-12", "TIRE BARN", -389.9, "cat-fuel"],
    ["2026-09-25", "BRIGHTWATER CLINIC BONUS", 600, "cat-income"],
  ];
  for (const [date, description, amount, categoryId] of extras)
    out.push(base(`txn-x-${date.slice(5).replace("-", "")}`, date, description, amount, CHECKING, { categoryId }));

  // The cards, May 1 → Oct 31. Card A is the everyday card; Card B the occasional one.
  const pick = rng(1007);
  let n = 0;
  for (let d = from; d <= "2026-10-31"; d = addDays(d, 1)) {
    const count = pick() < 0.62 ? (pick() < 0.3 ? 2 : 1) : 0;
    for (let i = 0; i < count; i++) {
      const s = SHOPS_A[Math.floor(pick() * SHOPS_A.length)];
      const amt = r2(s[4] + pick() * (s[5] - s[4]));
      out.push(
        base(`txn-ca-${String(++n).padStart(4, "0")}`, d, s[0], -amt, CARD_A, {
          categoryId: s[2],
          displayName: s[1],
          weekly: s[3] !== "monthly",
          bucket: s[3] !== "monthly" ? s[3] : null,
          monthly: s[3] === "monthly",
        }),
      );
    }
    if (pick() < 0.16) {
      const s = SHOPS_B[Math.floor(pick() * SHOPS_B.length)];
      const amt = r2(s[4] + pick() * (s[5] - s[4]));
      out.push(
        base(`txn-cb-${String(++n).padStart(4, "0")}`, d, s[0], -amt, CARD_B, {
          categoryId: s[2],
          displayName: s[1],
          monthly: s[3] === "monthly",
        }),
      );
    }
  }
  return out;
}

/** November's card rows, by hand: the figures the week and month pages show. */
function buildNovemberCards() {
  const A = (id, date, description, displayName, amount, x) => base(id, date, description, amount, CARD_A, { displayName, ...x });
  const B = (id, date, description, displayName, amount, x) => base(id, date, description, amount, CARD_B, { displayName, ...x });
  const wk = (categoryId, bucket) => ({ categoryId, weekly: true, bucket });
  const mo = (categoryId) => ({ categoryId, monthly: true });
  return [
    // week of Nov 1–7
    A("txn-ca-1101", "2026-11-01", "CORNER GROCER #114", "Corner Grocer", -82.14, wk("cat-groceries", "groceries")),
    A("txn-ca-1102", "2026-11-02", "HILLTOP FUEL 0221", "Hilltop Fuel", -46.3, wk("cat-fuel", "misc")),
    A("txn-ca-1103", "2026-11-03", "LANTERN THAI KITCHEN", "Lantern Thai Kitchen", -57.6, wk("cat-dining", "dining")),
    A("txn-ca-1104", "2026-11-04", "MOSSY OAK COFFEE", "Mossy Oak Coffee", -8.75, wk("cat-dining", "dining")),
    A("txn-ca-1105", "2026-11-05", "CORNER GROCER #114", "Corner Grocer", -64.92, wk("cat-groceries", "groceries")),
    A("txn-ca-1106", "2026-11-05", "GREENLEAF GARDEN CTR", "Greenleaf Garden Center", -73.4, mo("cat-home-repair")),
    A("txn-ca-1107", "2026-11-06", "NORTHGATE CINEMA", "Northgate Cinema", -31.5, wk("cat-dining", "entertainment")),
    A("txn-ca-1108", "2026-11-06", "CORNER GROCER #114", "Corner Grocer", 12.4, { categoryId: "cat-groceries", weekly: true, bucket: "groceries", notes: "Returned item" }),
    A("txn-ca-1109", "2026-11-07", "RIVERBEND CONFERENCE HOTEL", "Riverbend Conference Hotel", -214.0, { categoryId: "cat-travel", reimbursable: true, owedBy: "Larkfield Logistics", notes: "Work trip: to be paid back" }),
    A("txn-ca-1110", "2026-11-07", "TIDY PAWS GROOMING", "Tidy Paws Grooming", -58.0, mo("cat-pets")),
    // this week (Sun Nov 8 → today): the weekly plan's $113.00
    A("txn-ca-1112", "2026-11-08", "CORNER GROCER #114", "Corner Grocer", -54.2, { ...wk("cat-groceries", "groceries"), reviewed: false }),
    A("txn-ca-1113", "2026-11-09", "LANTERN THAI KITCHEN", "Lantern Thai Kitchen", -38.8, { ...wk("cat-dining", "dining"), reviewed: false }),
    A("txn-ca-1114", "2026-11-10", "NORTHGATE CINEMA", "Northgate Cinema", -20.0, { ...wk("cat-dining", "entertainment"), reviewed: false, pending: true }),
    A("txn-ca-1115", "2026-11-09", "SUNDIAL HARDWARE #7", "Sundial Hardware", -86.45, { ...mo("cat-home-repair"), reviewed: false }),
    A("txn-ca-1116", "2026-11-09", "SQ *MARKET STALL 44", "Market Stall 44", -27.0, { reviewed: false }), // not filed, no category
    A("txn-ca-1117", "2026-11-10", "ROADSIDE TOW AND TIRE", "Roadside Tow & Tire", -189.0, { categoryId: "cat-fuel", unplanned: true, reviewed: false, notes: "Flat tire" }),
    // Card B
    B("txn-cb-1101", "2026-11-01", "CLOUDNEST STORAGE", "Cloudnest Storage", -9.99, { categoryId: "cat-subs" }),
    B("txn-cb-1102", "2026-11-03", "PAPERTRAIL NEWS", "Papertrail News", -12.0, { categoryId: "cat-subs" }),
    B("txn-cb-1103", "2026-11-04", "ORCHARD HOME GOODS", "Orchard Home Goods", -128.75, mo("cat-home-repair")),
    B("txn-cb-1104", "2026-11-06", "THREADLINE CLOTHING", "Threadline Clothing", -64.0, mo("cat-dining")),
    B("txn-cb-1105", "2026-11-08", "WILLOW CREEK DENTAL", "Willow Creek Dental", -95.0, { ...mo("cat-health"), reviewed: false }),
    B("txn-cb-1106", "2026-11-09", "UNKNOWN MERCHANT 5521", "Unknown merchant 5521", -41.17, { reviewed: false }), // not filed, no category
  ];
}

/**
 * Card payments: each card is paid in full from checking (Card A every Monday for
 * the week before, Card B on the 1st for the month before). The checking side is
 * written only for the history months: October and November's checking rows are
 * the forecast fixture's own and are left exactly as they are.
 */
function buildCardPayments(rows) {
  const out = [];
  for (const card of CARDS) {
    const mine = rows.filter((t) => t.plaidAccountId === card.externalId && Number(t.amount) < 0);
    const key = (t) => (card.cadence === "weekly" ? addDays(weekStartOf(t.occurredOn), 7) : addMonths(t.occurredOn, 1));
    const byPeriod = new Map();
    for (const t of mine) byPeriod.set(key(t), r2((byPeriod.get(key(t)) ?? 0) - Number(t.amount)));
    for (const [day, amount] of byPeriod) {
      let d = day;
      while (dow(d) === 0 || dow(d) === 6) d = addDays(d, 1);
      if (d > TODAY) continue;
      const tag = `${card.mask}-${d.slice(2).replace(/-/g, "")}`;
      out.push(base(`txn-rcv-${tag}`, d, "PAYMENT RECEIVED - THANK YOU", amount, card, { cardPayment: true, transfer: true, displayName: "Payment received" }));
      if (d <= HISTORY_TO)
        out.push(
          base(`txn-pay-${tag}`, d, `${card.name.toUpperCase()} AUTOPAY`, -amount, CHECKING, {
            categoryId: "cat-debt",
            cardPayment: true,
            displayName: `${card.name} payment`,
          }),
        );
    }
  }
  return out;
}

/**
 * Savings transfers in the history months, sized so checking ends each month
 * near where September really ended (the forecast fixture fixes that figure).
 */
function buildSavingsTransfers(rows) {
  const out = [];
  const drift = { "2026-05": 350, "2026-06": -200, "2026-07": 250, "2026-08": -550, "2026-09": 150 }; // sums to 0
  for (const [ym, keep] of Object.entries(drift)) {
    const net = sum(rows.filter((t) => t.plaidAccountId === CHECKING.externalId && t.occurredOn.slice(0, 7) === ym));
    // Rent leaves on the 1st, before the month's paychecks: savings covers it, and gets it back late in the month.
    const FLOAT = 2400;
    const first = weekdayOnOrAfter(`${ym}-01`);
    out.push(base(`txn-savin-${ym.replace("-", "")}`, first, "TRANSFER FROM SAVINGS 7730", FLOAT, CHECKING, { transfer: true, displayName: "Transfer from savings" }));
    const move = r2(Math.round((net - keep) / 5) * 5) + FLOAT;
    out.push(base(`txn-sav-${ym.replace("-", "")}`, lastWeekdayOf(`${ym}-01`), "TRANSFER TO SAVINGS 7730", -move, CHECKING, { transfer: true, displayName: "Transfer to savings" }));
  }
  return out;
}

function decorateCurrent(rows) {
  // The forecast's own checking rows, with the labels the other pages show.
  return rows.map((t) => {
    const item = fx.ITEMS.find((i) => i.bank === t.description || `${i.bank} PMT` === t.description);
    const matched = fx.MATCHED_TXN_IDS.has(t.id);
    return {
      weeklyBucket: null,
      categoryLockedByUser: false,
      splits: [],
      matchedRuleId: null,
      displayName: titleCase(t.description),
      merchantSignature: t.description.toLowerCase().replace(/[^a-z]+/g, " ").trim(),
      paymentState: null,
      confirmedByTxnId: null,
      ...t,
      reviewed: matched,
      // The pharmacy row is waiting to be paid back; the hardware row was marked unplanned.
      reimbursable: t.id === "txn-pharmacy-1108",
      owedBy: t.id === "txn-pharmacy-1108" ? "Brightwater Clinic" : null,
      unplannedAllowance: t.id === "txn-hardware-1107",
      weeklyAllowance: t.id === "txn-coffee-1110" ? false : t.weeklyAllowance,
      _itemId: item?.id ?? null,
    };
  });
}

function build() {
  const hist = buildHistory();
  const nov = buildNovemberCards();
  const pays = buildCardPayments([...hist, ...nov]);
  const savings = buildSavingsTransfers([...hist, ...pays]);
  const now = decorateCurrent(fx.BANK_ROWS);
  const all = [...hist, ...pays, ...savings, ...now, ...nov];
  // newest first; within a day by id so the order never moves
  all.sort((a, b) => (a.occurredOn !== b.occurredOn ? (a.occurredOn < b.occurredOn ? 1 : -1) : a.id < b.id ? 1 : -1));
  return all;
}

/** Every transaction, newest first. */
export const ALL = build();
const BY_ID = new Map(ALL.map((t) => [t.id, t]));
export const byId = (id) => BY_ID.get(id) ?? null;
/** The public Transaction (no private `_` fields). */
export const pub = (t) => {
  const { _itemId, ...rest } = t;
  return rest;
};

// ── what a row is (one rule, used by every page fixture) ────────────────────
export const isIncome = (t) => t.categoryId === "cat-income" && Number(t.amount) > 0;
export const isPayment = (t) => t.isExternalCardPayment || t.isTransfer;
export const isDebtPayment = (t) => !!t.debtId || t.categoryId === "cat-debt";
export const isBill = (t) => !!t._itemId || (t.plaidAccountId === CHECKING.externalId && t.occurredOn < "2026-10-01" && !/^txn-x-/.test(t.id));
/** A purchase: money out that is not a payment, a debt payment or a transfer. */
export const isSpend = (t) => Number(t.amount) < 0 && !isPayment(t) && !isDebtPayment(t);
export const isUnfiled = (t) =>
  isCardRow(t) && Number(t.amount) < 0 && !isPayment(t) && !t.weeklyAllowance && !t.monthlyAllowance && !t.unplannedAllowance && !t.reimbursable && t.categoryId !== "cat-subs";

// ── balances ────────────────────────────────────────────────────────────────
/** What each card owes today (positive = owed). */
export const CARD_OWED = Object.fromEntries(
  CARDS.map((c) => [c.externalId, r2(-sum(ALL.filter((t) => t.plaidAccountId === c.externalId && t.occurredOn <= TODAY)))]),
);
/** An account's balance at the end of `day` (checking: the bank's; a card: −owed). */
export function balanceAtEndOf(acct, day) {
  const todayBal = acct === CHECKING ? fx.BANK_TODAY : -CARD_OWED[acct.externalId];
  const later = ALL.filter((t) => t.plaidAccountId === acct.externalId && t.occurredOn > day && t.occurredOn <= TODAY);
  return r2(todayBal - sum(later));
}

/** GET /api/transactions */
export function listTransactions(q) {
  const from = q.get("from");
  const to = q.get("to");
  const limit = Number(q.get("limit") ?? 500) || 500;
  const sources = q.get("source") ? new Set(q.get("source").split(",")) : null;
  const search = (q.get("search") ?? "").toLowerCase();
  const minA = q.get("minAmount");
  const maxA = q.get("maxAmount");
  let rows = ALL.filter((t) => {
    if (from && t.occurredOn < from) return false;
    if (to && t.occurredOn > to) return false;
    if (sources && !sources.has(t.source)) return false;
    if (q.get("uncategorized") === "true" && t.categoryId) return false;
    if (q.get("excludeTransfers") === "true" && t.isTransfer) return false;
    if (q.get("reimbursable") === "true" && !t.reimbursable) return false;
    if (q.get("categoryId") && t.categoryId !== q.get("categoryId")) return false;
    if (q.get("plaidAccountId") && t.plaidAccountId !== q.get("plaidAccountId")) return false;
    if (search && !`${t.description} ${t.displayName}`.toLowerCase().includes(search)) return false;
    if (minA && Math.abs(Number(t.amount)) < Number(minA)) return false;
    if (maxA && Math.abs(Number(t.amount)) > Number(maxA)) return false;
    return true;
  });
  return rows.slice(0, limit).map(pub);
}

/** Which account a ledger `account=` names (a row id or an external id); none → the planned account, checking. */
export function scopeOf(account) {
  const hit = account ? ACCOUNTS.find((a) => a.rowId === account || a.externalId === account) : null;
  return hit ? { via: "account", accounts: [hit] } : { via: "pointer", accounts: [CHECKING] };
}

/** GET /api/transactions/balances?account=&dates=a,b,c */
export function ledgerBalances(q) {
  const scope = scopeOf(q.get("account"));
  const acct = scope.accounts[0];
  const dates = (q.get("dates") ?? "").split(",").filter(Boolean);
  return {
    balances: dates.map((date) => ({ date, balance: money(balanceAtEndOf(acct, date > TODAY ? TODAY : date)) })),
    balanceUnavailableReason: null,
    anchor: anchorOf(acct),
    account: { via: scope.via, plaidAccountIds: [acct.externalId] },
    dataAsOf: { snapshotAt: fx.SNAPSHOT_AT, computedAt: fx.COMPUTED_AT },
  };
}
const anchorOf = (acct) => ({
  today: TODAY,
  todayBalance: money(balanceAtEndOf(acct, TODAY)),
  snapshotBalance: acct === CHECKING ? money(fx.READING) : money(-CARD_OWED[acct.externalId]),
  snapshotAt: fx.SNAPSHOT_AT,
  snapshotDay: fx.READING_DAY,
});

/** GET /api/transactions/ledger */
export function ledgerPage(q) {
  const scope = scopeOf(q.get("account"));
  const one = scope.accounts.length === 1 ? scope.accounts[0] : null;
  const ids = new Set(scope.accounts.map((a) => a.externalId));
  const from = q.get("from");
  const to = q.get("to");
  const search = (q.get("search") ?? "").toLowerCase();
  const limit = Math.min(Number(q.get("limit") ?? 50) || 50, 200);
  const sources = q.get("source") ? new Set(q.get("source").split(",")) : null;
  const want = (k) => (q.get(k) === "true" ? true : q.get(k) === "false" ? false : null);
  const reviewed = want("reviewed");
  const pending = want("pending");
  const inScope = ALL.filter((t) => ids.has(t.plaidAccountId));
  const match = inScope.filter((t) => {
    if (from && t.occurredOn < from) return false;
    if (to && t.occurredOn > to) return false;
    if (sources && !sources.has(t.source)) return false;
    if (reviewed != null && t.reviewed !== reviewed) return false;
    if (pending != null && t.pending !== pending) return false;
    if (q.get("uncategorized") === "true" && t.categoryId) return false;
    if (q.get("categoryId") && t.categoryId !== q.get("categoryId")) return false;
    if (q.get("member") && t.member !== q.get("member")) return false;
    if (search && !`${t.description} ${t.displayName}`.toLowerCase().includes(search)) return false;
    return true;
  });
  // The running balance, one account at a time, walked back from today's.
  const running = new Map();
  if (one) {
    let bal = balanceAtEndOf(one, TODAY);
    for (const t of inScope) {
      if (t.occurredOn > TODAY) continue;
      running.set(t.id, bal);
      bal = r2(bal - Number(t.amount));
    }
  }
  const start = Number(q.get("cursor") ?? 0) || 0;
  const page = match.slice(start, start + limit);
  const rows = page.map((t) => ({
    ...pub(t),
    splitCount: 0,
    categoryProvisional: false,
    runningBalance: running.has(t.id) ? money(running.get(t.id)) : null,
    balanceAmount: t.amount,
    countsInBalance: true,
    balanceReason: "counted",
    replacedPendingId: null,
    heldAhead: false,
    afterToday: t.occurredOn > TODAY,
    stalePending: false,
    expiredHold: false,
  }));
  const moneyIn = sum(match.filter((t) => Number(t.amount) > 0));
  const moneyOut = sum(match.filter((t) => Number(t.amount) < 0));
  const lo = from ?? HISTORY_FROM;
  const hi = to && to < TODAY ? to : TODAY;
  return {
    rows,
    nextCursor: start + limit < match.length ? String(start + limit) : null,
    limit,
    matchingCount: match.length,
    totals: { count: match.length, moneyIn: money(moneyIn), moneyOut: money(-moneyOut), net: money(moneyIn + moneyOut) },
    review: { reviewed: match.filter((t) => t.reviewed).length, unreviewed: match.filter((t) => !t.reviewed).length },
    balanceStart: one ? money(balanceAtEndOf(one, addDays(lo, -1))) : null,
    balanceEnd: one ? money(balanceAtEndOf(one, hi)) : null,
    balanceToday: one ? money(balanceAtEndOf(one, TODAY)) : null,
    balanceUnavailableReason: null,
    anchor: anchorOf(one),
    account: { via: scope.via, plaidAccountIds: scope.accounts.map((a) => a.externalId) },
    dataAsOf: { snapshotAt: fx.SNAPSHOT_AT, computedAt: fx.COMPUTED_AT },
  };
}

/** The two card accounts, as Plaid items list them. */
export const cardPlaidItem = {
  ...fx.plaidItems[0],
  id: "pi-juniper-cards",
  itemId: "item-ext-juniper-cards",
  institutionId: "ins_fixture_2",
  institutionName: CARD_ISSUER,
  // The app's own key for "a card that belongs on its card page" (it tints and lists those cards); the name shown is the invented one.
  institutionSlug: "amex",
  accounts: CARDS.map((c) => ({
    id: c.rowId,
    accountId: c.externalId,
    name: c.name,
    officialName: c.name,
    mask: c.mask,
    type: "credit",
    subtype: "credit card",
    importCutoffDate: null,
    firstSyncCompletedAt: "2026-05-02T14:00:00.000Z",
    snapshot: { balance: money(CARD_OWED[c.externalId]), at: fx.SNAPSHOT_AT, source: "plaid" },
  })),
};
export const plaidItems = [
  { ...fx.plaidItems[0], accounts: fx.plaidItems[0].accounts.map((a) => ({ ...a, snapshot: { balance: money(fx.READING), at: fx.SNAPSHOT_AT, source: "plaid" } })) },
  cardPlaidItem,
];

/** GET /api/plaid/liability-accounts: what each card owes, as the issuer reports it (neither is on the payoff plan). */
export const liabilityAccounts = CARDS.map((c) => ({
  id: c.rowId,
  accountId: c.externalId,
  itemId: cardPlaidItem.id,
  name: c.name,
  officialName: c.name,
  mask: c.mask,
  type: "credit",
  subtype: "credit card",
  liabilityKind: "credit",
  balance: money(CARD_OWED[c.externalId]),
  apr: null,
  minPayment: "35.00",
  lastFetchedAt: fx.SNAPSHOT_AT,
  institutionId: cardPlaidItem.institutionId,
  institutionName: CARD_ISSUER,
  institutionSlug: cardPlaidItem.institutionSlug,
  linkedDebt: null,
  suggestedDebt: null,
}));
