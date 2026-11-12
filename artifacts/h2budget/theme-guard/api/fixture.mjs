// ⭐ ONE INVENTED HOUSEHOLD for the Forecast screenshot harness.
//
// Every name, bank, card and amount here is made up. Nothing is read from a
// database or the network. Every endpoint the page asks for is answered from the
// SAME list of plan occurrences and bank rows (below), so the bundle's `events`,
// the cash signal's `events` / `dayItems` / `daily`, the spine and the avalanche
// schedule all agree with each other.
//
// "Today" is fixed: 2026-11-10 (household time zone America/Chicago). The
// browser clock is pinned to the same day by shoot.mjs.

export const TODAY = "2026-11-10";
export const CASH_BUFFER = 500;
// The bank's last reading: Mon 2026-11-09 21:05 CST (= 03:05 UTC on the 10th).
export const SNAPSHOT_AT = "2026-11-10T03:05:00.000Z";
export const COMPUTED_AT = "2026-11-10T16:00:00.000Z";
// The bank's reading itself (the balance at SNAPSHOT_AT).
export const READING = 2482.4;

const CHECKING = {
  rowId: "pa-checking-4821",
  externalId: "acc-ext-checking-4821",
  name: "Everyday Checking",
  mask: "4821",
  subtype: "checking",
  institution: "Cedar Hollow Bank",
};

// ── dates (pure ISO arithmetic, UTC-based so the host TZ never matters) ─────
const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => {
  const d = D(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const dow = (s) => D(s).getUTCDay();
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 86_400_000);
const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const r2 = (n) => Math.round(n * 100) / 100;
const money = (n) => r2(n).toFixed(2);
const nextBusinessDay = (s) => {
  let c = addDays(s, 1);
  while (dow(c) === 0 || dow(c) === 6) c = addDays(c, 1);
  return c;
};
const weekdayOnOrAfter = (s) => {
  let c = s;
  while (dow(c) === 0 || dow(c) === 6) c = addDays(c, 1);
  return c;
};
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const firstOfLastMonth = (s) => {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
};

// ── categories ──────────────────────────────────────────────────────────────
const CATS = [
  ["cat-income", "Paychecks", "income", "Income"],
  ["cat-housing", "Rent", "expense", "Home"],
  ["cat-utilities", "Utilities", "expense", "Home"],
  ["cat-phone", "Phone & internet", "expense", "Home"],
  ["cat-insurance", "Insurance", "expense", "Protection"],
  ["cat-groceries", "Groceries", "expense", "Everyday"],
  ["cat-childcare", "Childcare", "expense", "Family"],
  ["cat-fuel", "Fuel", "expense", "Transport"],
  ["cat-dining", "Dining & fun", "expense", "Everyday"],
  ["cat-subs", "Subscriptions", "expense", "Everyday"],
  ["cat-health", "Health & fitness", "expense", "Family"],
  ["cat-pets", "Pets", "expense", "Family"],
  ["cat-travel", "Travel", "expense", "Family"],
  ["cat-debt", "Debt payments", "expense", "Debt"],
  ["cat-home-repair", "Home & garden", "expense", "Home"],
  ["cat-uncat", "Uncategorized", "expense", "Other"],
];
export const categories = CATS.map(([id, name, kind, groupName], i) => ({
  id,
  name,
  kind,
  groupName,
  sourceKind: "manual",
  sortOrder: i + 1,
  excludeFromBudget: id === "cat-uncat",
}));

// ── debts ───────────────────────────────────────────────────────────────────
const DEBTS = [
  { id: "debt-maple", name: "Maple Rewards Card", balance: 9850, original: 12400, apr: "0.2499", min: 145, dueDay: 11, statementDay: 16, type: "credit_card" },
  { id: "debt-northwind", name: "Northwind Card", balance: 2310, original: 3800, apr: "0.1949", min: 65, dueDay: 21, statementDay: 26, type: "credit_card" },
  { id: "debt-harbor", name: "Harbor Auto Loan", balance: 13400, original: 24500, apr: "0.0690", min: 389, dueDay: 16, statementDay: null, type: "auto_loan" },
  { id: "debt-summit", name: "Summit Student Loan", balance: 21750, original: 30200, apr: "0.0550", min: 242, dueDay: 28, statementDay: null, type: "student_loan" },
];
export const debts = DEBTS.map((d, i) => ({
  id: d.id,
  name: d.name,
  balance: money(d.balance),
  originalBalance: money(d.original),
  apr: d.apr,
  minPayment: money(d.min),
  payment: money(d.min),
  type: d.type,
  status: "active",
  sortOrder: i + 1,
  dueDay: d.dueDay,
  statementDay: d.statementDay,
  notes: null,
  lastBalanceUpdate: "2026-11-09",
  plaidAccountId: null,
  plaidLastSyncedAt: null,
  plaidLastSyncError: null,
  plaidLastSyncErrorCode: null,
  plaidConsentExpirationAt: null,
  plaidConsentExpirationLastRefreshError: null,
  balanceSource: "manual",
  aprSource: "manual",
  minPaymentSource: "manual",
  pendingPaymentTotal: null,
  pendingPaymentCount: 0,
  liabilityAsOf: null,
  statement: null,
  plaidAccount: null,
  paidAs: null,
}));

// ── recurring items (the plan) ──────────────────────────────────────────────
// `bank`: the description its checking row carries once it posts.
export const ITEMS = [
  { id: "ri-pay-jordan", name: "Paycheck · Jordan", kind: "income", amount: 2450, frequency: "biweekly", anchorDate: "2026-10-16", categoryId: "cat-income", bank: "LARKFIELD LOGISTICS PAYROLL" },
  { id: "ri-pay-sam", name: "Paycheck · Sam", kind: "income", amount: 1880, frequency: "biweekly", anchorDate: "2026-10-09", categoryId: "cat-income", bank: "BRIGHTWATER CLINIC DIR DEP" },
  { id: "ri-reimb", name: "Expense reimbursement · Jordan", kind: "income", amount: 240, frequency: "onetime", anchorDate: "2026-11-06", categoryId: "cat-income", bank: "LARKFIELD LOGISTICS EXP REIMB" },
  { id: "ri-rent", name: "Rent · Birchwood Apartments", kind: "bill", amount: 2450, frequency: "monthly", dayOfMonth: 1, categoryId: "cat-housing", bank: "BIRCHWOOD APTS RENT" },
  { id: "ri-water", name: "Water & Sewer", kind: "bill", amount: 64, frequency: "monthly", dayOfMonth: 1, categoryId: "cat-utilities", bank: "TOWN UTILITIES WATER" },
  { id: "ri-gym", name: "Gym · Peak Fitness", kind: "bill", amount: 45, frequency: "monthly", dayOfMonth: 30, categoryId: "cat-health", bank: "PEAK FITNESS DUES" },
  { id: "ri-car-ins", name: "Car insurance · Oakmont Mutual", kind: "bill", amount: 186, frequency: "monthly", dayOfMonth: 5, categoryId: "cat-insurance", bank: "OAKMONT MUTUAL AUTO" },
  { id: "ri-renters", name: "Renters insurance · Oakmont Mutual", kind: "bill", amount: 18, frequency: "monthly", dayOfMonth: 1, categoryId: "cat-insurance", bank: "OAKMONT MUTUAL HOME" },
  { id: "ri-pet-ins", name: "Pet insurance · Paws & Co", kind: "bill", amount: 38, frequency: "monthly", dayOfMonth: 8, categoryId: "cat-pets", bank: "PAWS AND CO INSURANCE" },
  { id: "ri-internet", name: "Internet · Ridgeway Fiber", kind: "bill", amount: 70, frequency: "monthly", dayOfMonth: 9, categoryId: "cat-phone", bank: "RIDGEWAY FIBER" },
  { id: "ri-maple-min", name: "Maple Rewards card payment", kind: "bill", amount: 145, frequency: "monthly", dayOfMonth: 11, categoryId: "cat-debt", debtId: "debt-maple", bank: "MAPLE REWARDS ONLINE PMT" },
  { id: "ri-gas", name: "Gas · Lakeside Energy", kind: "bill", amount: 88, frequency: "monthly", dayOfMonth: 12, categoryId: "cat-utilities", bank: "LAKESIDE ENERGY", amountKind: "estimate" },
  { id: "ri-phone", name: "Phone · Brightline Mobile", kind: "bill", amount: 115, frequency: "monthly", dayOfMonth: 15, categoryId: "cat-phone", bank: "BRIGHTLINE MOBILE" },
  { id: "ri-harbor", name: "Harbor Auto Loan", kind: "bill", amount: 389, frequency: "monthly", dayOfMonth: 16, categoryId: "cat-debt", debtId: "debt-harbor", bank: "HARBOR AUTO FINANCE" },
  { id: "ri-electric", name: "Electric · Prairie Power", kind: "bill", amount: 142, frequency: "monthly", dayOfMonth: 18, categoryId: "cat-utilities", bank: "PRAIRIE POWER CO", amountKind: "estimate" },
  { id: "ri-streaming", name: "Streaming bundle", kind: "bill", amount: 23, frequency: "monthly", dayOfMonth: 20, categoryId: "cat-subs", bank: "STREAMBOX BUNDLE" },
  { id: "ri-northwind-min", name: "Northwind Card minimum", kind: "bill", amount: 65, frequency: "monthly", dayOfMonth: 21, categoryId: "cat-debt", debtId: "debt-northwind", bank: "NORTHWIND CARD PAYMENT" },
  { id: "ri-music", name: "Music subscription", kind: "bill", amount: 11, frequency: "monthly", dayOfMonth: 25, categoryId: "cat-subs", bank: "TUNEWAVE MUSIC" },
  { id: "ri-summit", name: "Summit Student Loan", kind: "bill", amount: 242, frequency: "monthly", dayOfMonth: 28, categoryId: "cat-debt", debtId: "debt-summit", bank: "SUMMIT LOAN SERVICING" },
  { id: "ri-groceries", name: "Groceries", kind: "bill", amount: 235, frequency: "weekly", anchorDate: "2026-10-03", categoryId: "cat-groceries", bank: "FRESHFIELD MARKET", amountKind: "estimate" },
  { id: "ri-childcare", name: "Childcare · Little Sprouts", kind: "bill", amount: 330, frequency: "weekly", anchorDate: "2026-10-05", categoryId: "cat-childcare", bank: "LITTLE SPROUTS LEARNING" },
  { id: "ri-fuel", name: "Fuel", kind: "bill", amount: 60, frequency: "weekly", anchorDate: "2026-10-02", categoryId: "cat-fuel", bank: "QUICKFILL FUEL", amountKind: "estimate" },
  { id: "ri-dining", name: "Dining & fun", kind: "bill", amount: 90, frequency: "weekly", anchorDate: "2026-10-04", categoryId: "cat-dining", bank: "CORNER BISTRO", amountKind: "estimate" },
  { id: "ri-vet", name: "Vet visit · Paws Clinic", kind: "bill", amount: 135, frequency: "onetime", anchorDate: "2026-10-20", categoryId: "cat-pets", bank: "PAWS CLINIC" },
  { id: "ri-flights", name: "Holiday flights", kind: "bill", amount: 640, frequency: "onetime", anchorDate: "2026-11-24", categoryId: "cat-travel", bank: "SKYLARK AIR" },
  { id: "ri-thanksgiving", name: "Thanksgiving groceries", kind: "bill", amount: 180, frequency: "onetime", anchorDate: "2026-11-25", categoryId: "cat-groceries", bank: "FRESHFIELD MARKET" },
];
export const recurringItems = ITEMS.map((it) => ({
  id: it.id,
  name: it.name,
  kind: it.kind,
  amount: money(it.amount),
  frequency: it.frequency,
  dayOfMonth: it.dayOfMonth ?? null,
  anchorDate: it.anchorDate ?? null,
  active: "true",
  categoryId: it.categoryId ?? null,
  debtId: it.debtId ?? null,
  amountKind: it.amountKind ?? "fixed",
}));

/** Every occurrence of `item` in [from, to] (inclusive). */
export function expandItem(item, from, to) {
  const out = [];
  const sign = item.kind === "income" ? 1 : -1;
  const push = (date) => {
    if (date >= from && date <= to)
      out.push({ date, itemId: item.id, label: item.name, kind: item.kind === "income" ? "income" : "expense", amount: sign * item.amount });
  };
  if (item.frequency === "onetime") push(item.anchorDate);
  else if (item.frequency === "weekly" || item.frequency === "biweekly") {
    const step = item.frequency === "weekly" ? 7 : 14;
    let d = item.anchorDate;
    while (d > from) d = addDays(d, -step);
    for (; d <= to; d = addDays(d, step)) push(d);
  } else if (item.frequency === "monthly") {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    for (;;) {
      const day = Math.min(item.dayOfMonth, lastDom(y, m));
      const d = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (d > to) break;
      push(d);
      m += 1;
      if (m === 13) { m = 1; y += 1; }
    }
  }
  return out;
}

// ── the weekly avalanche: one payment every Friday from the 13th ────────────
// "Pays the most that is safe each week": each Friday pays the most that keeps
// the rest of the walk above a floor (computed once, below, from the walk with
// no avalanche at all). The weeks leading into the Dec 1 rent run closest to the
// $500 buffer, which is what puts the low point there.
const AVALANCHE_FIRST = "2026-11-13";
const AVALANCHE_CAP = 620;
const AVALANCHE_MIN = 100;
const AVALANCHE_FLOOR_EARLY = 535; // Fridays before AVALANCHE_EARLY_UNTIL
const AVALANCHE_EARLY_UNTIL = "2026-12-04";
const AVALANCHE_FLOOR = 735;
const AVALANCHE_THROUGH = addDays(TODAY, 400);
// Highest APR first; the label names the debt the week's money goes to.
const AVALANCHE_ORDER = [
  ["Maple Rewards Card", 9850],
  ["Northwind Card", 2310],
  ["Harbor Auto Loan", 13400],
  ["Summit Student Loan", 21750],
];
let AVALANCHE = null; // [{date, amount, target}]
function avalancheEvents(from, to) {
  return (AVALANCHE ?? [])
    .filter((a) => a.date >= from && a.date <= to)
    .map((a) => ({ date: a.date, itemId: "avalanche:extra", label: `Avalanche payment → ${a.target}`, kind: "expense", amount: -a.amount }));
}

// ── answers (resolutions) and the special past-due cases ────────────────────
const SPECIAL = {
  // Past due, no bank row, inside 14 days → carried onto the next business day.
  carried: new Set(["ri-water|2026-11-01", "ri-internet|2026-11-09"]),
  // Past due, a bank row the forecast takes as payment (still unmatched).
  assumedPaid: new Map([["ri-car-ins|2026-11-05", { txnId: "txn-oakmont-auto-1105", confidence: "high" }]]),
  // Income that never landed.
  incomeNotArrived: new Set(["ri-reimb|2026-11-06"]),
  // Older than 14 days, no bank row: off the curve.
  older: new Set(["ri-vet|2026-10-20"]),
  missed: new Map([["ri-streaming|2026-11-20", "res-missed-streaming-1120"]]),
  rescheduled: new Map([["ri-electric|2026-11-18", { id: "res-moved-electric-1118", to: "2026-11-24" }]]),
};
const BUNDLE_FROM = firstOfLastMonth(TODAY); // 2026-10-01
const PAST_THROUGH = addDays(TODAY, -1); // 2026-11-09

/** Every past occurrence (bundle window up to yesterday) of the plan. */
function pastOccurrences() {
  const out = [];
  for (const it of ITEMS) out.push(...expandItem(it, BUNDLE_FROM, PAST_THROUGH).map((e) => ({ ...e, item: it })));
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label < b.label ? -1 : 1));
  return out;
}

// Bank rows on the checking account (the bundle's `transactions`) and the
// resolutions that tie them to the plan.
function buildBankAndResolutions() {
  const txns = [];
  const resolutions = [];
  const row = (id, date, description, amount, extra = {}) => ({
    id,
    occurredOn: date,
    occurredAt: null,
    description,
    amount: money(amount),
    account: "Everyday Checking",
    categoryId: extra.categoryId ?? null,
    forecastFlag: true,
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    reimbursable: false,
    reimbursed: false,
    reviewed: false,
    isTransfer: false,
    isTransferUserOverridden: false,
    isExternalCardPayment: false,
    sentToReviewAt: null,
    notes: null,
    source: "plaid",
    member: null,
    owedBy: null,
    plaidTransactionId: `ptx-${id}`,
    plaidAccountId: CHECKING.externalId,
    debtId: extra.debtId ?? null,
    pfcDetailed: null,
    pending: extra.pending ?? false,
    expiredHold: false,
    expiredPair: false,
  });
  for (const occ of pastOccurrences()) {
    const key = `${occ.itemId}|${occ.date}`;
    if (SPECIAL.carried.has(key) || SPECIAL.incomeNotArrived.has(key) || SPECIAL.older.has(key)) continue;
    if (SPECIAL.missed.has(key)) continue;
    const posted = Math.min(Number(D(weekdayOnOrAfter(occ.date))), Number(D(PAST_THROUGH)));
    const postedOn = iso(new Date(posted));
    if (SPECIAL.assumedPaid.has(key)) {
      txns.push(row(SPECIAL.assumedPaid.get(key).txnId, postedOn, `${occ.item.bank} PMT`, occ.amount, { categoryId: occ.item.categoryId }));
      continue;
    }
    const id = `txn-${occ.itemId.slice(3)}-${occ.date.slice(5).replace("-", "")}`;
    txns.push(row(id, postedOn, occ.item.bank, occ.amount, { categoryId: occ.item.categoryId, debtId: occ.item.debtId }));
    resolutions.push({
      id: `res-${occ.itemId.slice(3)}-${occ.date.slice(5).replace("-", "")}`,
      recurringItemId: occ.itemId,
      occurrenceDate: occ.date,
      status: "matched",
      matchedTxnId: id,
      rescheduledTo: null,
      txnDate: postedOn,
      txnDescription: occ.item.bank,
      txnAmount: money(occ.amount),
      txnForecastFlag: true,
    });
  }
  // Rows with no plan behind them.
  txns.push(row("txn-hardware-1107", "2026-11-07", "CORNER HARDWARE #18", -42.18, { categoryId: "cat-home-repair" }));
  resolutions.push({ id: "res-unplanned-hardware-1107", recurringItemId: null, occurrenceDate: null, status: "ignored_unforecasted", matchedTxnId: "txn-hardware-1107", rescheduledTo: null, txnDate: "2026-11-07", txnDescription: "CORNER HARDWARE #18", txnAmount: "-42.18", txnForecastFlag: true });
  txns.push(row("txn-pharmacy-1108", "2026-11-08", "PHARMACY PLUS #212", -23.4, { categoryId: "cat-health" }));
  txns.push(row("txn-coffee-1110", "2026-11-10", "COFFEE CORNER", -6.5, { categoryId: "cat-dining", pending: true }));
  // Answered missed (past or future).
  for (const [key, id] of SPECIAL.missed) {
    const [itemId, occurrenceDate] = key.split("|");
    resolutions.push({ id, recurringItemId: itemId, occurrenceDate, status: "missed", matchedTxnId: null, rescheduledTo: null, txnDate: null, txnDescription: null, txnAmount: null, txnForecastFlag: null });
  }
  // Moves.
  for (const [key, mv] of SPECIAL.rescheduled) {
    const [itemId, occurrenceDate] = key.split("|");
    resolutions.push({ id: mv.id, recurringItemId: itemId, occurrenceDate, status: "rescheduled", matchedTxnId: null, rescheduledTo: mv.to, txnDate: null, txnDescription: null, txnAmount: null, txnForecastFlag: null });
  }
  txns.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0));
  return { txns, resolutions };
}
const { txns: BANK_ROWS, resolutions: RESOLUTIONS } = buildBankAndResolutions();
const MATCHED_TXN_IDS = new Set(RESOLUTIONS.filter((r) => r.status === "matched" && r.matchedTxnId).map((r) => r.matchedTxnId));
// Rows after the reading (dated after its household day, 11/09) roll the balance forward.
const READING_DAY = "2026-11-09";
const ROWS_SINCE = BANK_ROWS.filter((t) => t.occurredOn > READING_DAY && t.occurredOn <= TODAY);
const SINCE_NET = r2(ROWS_SINCE.reduce((s, t) => s + Number(t.amount), 0));
export const BANK_TODAY = r2(READING + SINCE_NET);

// ── the curve's plan occurrences from today on ──────────────────────────────
const CARRY_TO = nextBusinessDay(TODAY); // 2026-11-11
function curvePlans(to) {
  const out = [];
  // Carried past-due expenses.
  for (const occ of pastOccurrences()) {
    const key = `${occ.itemId}|${occ.date}`;
    if (!SPECIAL.carried.has(key)) continue;
    out.push({ date: CARRY_TO, itemId: occ.itemId, label: occ.label, amount: occ.amount, originalDate: occ.date, occurrenceDate: occ.date, assumption: "overdue_assumed_unpaid" });
  }
  const future = [];
  for (const it of ITEMS) future.push(...expandItem(it, TODAY, to));
  future.push(...avalancheEvents(TODAY, to));
  for (const ev of future) {
    const key = `${ev.itemId}|${ev.date}`;
    if (SPECIAL.missed.has(key)) continue;
    const mv = SPECIAL.rescheduled.get(key);
    const date = mv ? mv.to : ev.date;
    if (date > to) continue;
    out.push({ date, itemId: ev.itemId, label: ev.label, amount: ev.amount, originalDate: date, occurrenceDate: ev.date, assumption: null });
  }
  return out;
}

// The avalanche amounts, once: walk the plan with no avalanche, then let each
// Friday take what is safe given every earlier Friday's payment.
(function computeAvalanche() {
  AVALANCHE = [];
  const base = new Map();
  let bal = r2(READING + SINCE_NET - ROWS_SINCE.filter((t) => t.occurredOn === TODAY).reduce((s, t) => s + Number(t.amount), 0));
  const plans = curvePlans(AVALANCHE_THROUGH);
  const rows = BANK_ROWS.filter((t) => t.occurredOn === TODAY);
  for (let d = TODAY; d <= AVALANCHE_THROUGH; d = addDays(d, 1)) {
    for (const t of rows) if (t.occurredOn === d) bal = r2(bal + Number(t.amount));
    for (const p of plans) if (p.date === d) bal = r2(bal + p.amount);
    base.set(d, bal);
  }
  const days = [...base.keys()];
  let paid = 0;
  let target = 0;
  let paidToTarget = 0;
  for (let f = AVALANCHE_FIRST; f <= addDays(TODAY, 366); f = addDays(f, 7)) {
    let low = Infinity;
    for (const d of days) if (d >= f) low = Math.min(low, base.get(d) - paid);
    const floor = f < AVALANCHE_EARLY_UNTIL ? AVALANCHE_FLOOR_EARLY : AVALANCHE_FLOOR;
    const amount = Math.max(0, Math.min(AVALANCHE_CAP, Math.floor((low - floor) / 10) * 10));
    if (amount < AVALANCHE_MIN) continue; // a week with less room than this pays nothing
    while (target < AVALANCHE_ORDER.length - 1 && paidToTarget >= AVALANCHE_ORDER[target][1]) {
      paidToTarget -= AVALANCHE_ORDER[target][1];
      target += 1;
    }
    AVALANCHE.push({ date: f, amount, target: AVALANCHE_ORDER[target][0] });
    paid += amount;
    paidToTarget += amount;
  }
})();

/** CashSignal for [from, from + horizonDays]. */
export function cashSignal({ horizonDays = 90, fromDate } = {}) {
  const from = fromDate && fromDate < TODAY ? fromDate : TODAY;
  const to = addDays(from, horizonDays);
  // Balance at the START of `from`: the reading, less the rows the bank had already counted on/after `from`.
  let start;
  if (from > READING_DAY) start = READING + r2(BANK_ROWS.filter((t) => t.occurredOn > READING_DAY && t.occurredOn < from).reduce((s, t) => s + Number(t.amount), 0));
  else start = READING - r2(BANK_ROWS.filter((t) => t.occurredOn >= from && t.occurredOn <= READING_DAY).reduce((s, t) => s + Number(t.amount), 0));
  start = r2(start);

  const items = [];
  for (const t of BANK_ROWS) {
    if (t.occurredOn < from || t.occurredOn > TODAY) continue;
    items.push({ date: t.occurredOn, kind: "bank_row", amount: Number(t.amount), txnId: t.id, matched: MATCHED_TXN_IDS.has(t.id), _label: t.description });
  }
  for (const p of curvePlans(to)) {
    if (p.date < from || p.date > to) continue;
    items.push({ ...p, kind: p.amount > 0 ? "income" : "expense" });
  }
  const KIND_ORDER = { income: 0, expense: 1, bank_row: 2 };
  items.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1)
      : a.kind !== b.kind ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
        : (a.label ?? a._label ?? "") !== (b.label ?? b._label ?? "") ? ((a.label ?? a._label ?? "") < (b.label ?? b._label ?? "") ? -1 : 1)
          : a.amount - b.amount,
  );

  const daily = [];
  let bal = start;
  let lowest = Infinity;
  let lowestDate = null;
  let income = 0;
  let expenses = 0;
  let accepted = 0;
  let idx = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    while (idx < items.length && items[idx].date === d) {
      const it = items[idx++];
      bal = r2(bal + it.amount);
      if (it.amount > 0) income += it.amount;
      else expenses += -it.amount;
      if (it.kind === "bank_row" && it.matched) accepted += it.amount;
    }
    daily.push({ date: d, balance: money(bal) });
    if (bal < lowest) { lowest = bal; lowestDate = d; }
  }
  const status = lowest >= CASH_BUFFER + 200 ? "ready" : lowest >= CASH_BUFFER ? "tight" : "not_yet";

  const plans = items.filter((it) => it.kind !== "bank_row");
  const events = plans
    .filter((p) => p.amount < 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((p) => ({
      date: p.date,
      label: p.label,
      amount: money(p.amount),
      itemId: p.itemId,
      originalDate: p.originalDate,
      assumption: p.assumption,
      occurrenceKey: `${p.itemId}|${p.occurrenceDate}`,
      occurrenceDate: p.occurrenceDate,
    }));
  const dayItems = items.map((it) =>
    it.kind === "bank_row"
      ? { date: it.date, kind: "bank_row", amount: money(it.amount), txnId: it.txnId, matched: it.matched }
      : {
          date: it.date,
          kind: it.kind,
          amount: money(it.amount),
          label: it.label,
          itemId: it.itemId,
          occurrenceKey: `${it.itemId}|${it.occurrenceDate}`,
          occurrenceDate: it.occurrenceDate,
          originalDate: it.originalDate,
          assumption: it.assumption,
        },
  );

  const occLabel = (key) => ITEMS.find((i) => i.id === key.split("|")[0]);
  const listed = (set) =>
    [...set].map((key) => {
      const [itemId, occurrenceDate] = key.split("|");
      const it = occLabel(key);
      return {
        planKey: key,
        itemId,
        occurrenceDate,
        dueDate: occurrenceDate,
        amount: money((it.kind === "income" ? 1 : -1) * it.amount),
        label: it.name,
        daysOverdue: daysBetween(occurrenceDate, TODAY),
      };
    });
  const assumedPaid = [...SPECIAL.assumedPaid].map(([key, v]) => {
    const [itemId, occurrenceDate] = key.split("|");
    const it = occLabel(key);
    const txn = BANK_ROWS.find((t) => t.id === v.txnId);
    return {
      planKey: key,
      itemId,
      occurrenceDate,
      dueDate: occurrenceDate,
      label: it.name,
      daysOverdue: daysBetween(occurrenceDate, TODAY),
      planAmount: money(-it.amount),
      txnId: v.txnId,
      txnAmount: txn.amount,
      confidence: v.confidence,
      unpaidRemainder: "0.00",
    };
  });

  const reading = { balance: money(READING), at: SNAPSHOT_AT, source: "plaid" };
  const since = { net: money(SINCE_NET), count: ROWS_SINCE.length, through: TODAY };
  return {
    bankToday: money(BANK_TODAY),
    lowestProjected: money(lowest),
    lowestDate,
    cashBuffer: money(CASH_BUFFER),
    status,
    maxSafeExtra: money(Math.max(0, lowest - CASH_BUFFER)),
    snapshotAt: SNAPSHOT_AT,
    snapshotSource: "plaid",
    dataAsOf: { snapshotAt: SNAPSHOT_AT, computedAt: COMPUTED_AT },
    account: { rowId: CHECKING.rowId, externalId: CHECKING.externalId, name: CHECKING.name, mask: CHECKING.mask, subtype: CHECKING.subtype, via: "pointer" },
    horizonDays,
    fromDate: from,
    toDate: to,
    startingBalance: money(start),
    opening: { date: from, balance: money(start), reading, since: from <= TODAY ? since : null },
    endingBalance: money(bal),
    endingDate: to,
    projectedIncome: money(income),
    projectedExpenses: money(expenses),
    acceptedImpact: money(accepted),
    daily,
    events,
    dayItems,
    overdueOutsideForecast: listed(SPECIAL.older),
    incomeNotArrived: listed(SPECIAL.incomeNotArrived),
    overdueAssumedPaid: assumedPaid,
    matches: [],
  };
}

const plaidChecking = {
  id: CHECKING.rowId,
  accountId: CHECKING.externalId,
  name: CHECKING.name,
  mask: CHECKING.mask,
  subtype: CHECKING.subtype,
  institutionName: CHECKING.institution,
};
const bankSnapshot = {
  balance: money(READING),
  at: SNAPSHOT_AT,
  source: "plaid",
  accountId: CHECKING.rowId,
  name: CHECKING.name,
  mask: CHECKING.mask,
};

/** ForecastBundle for `days` (events from the first of last month). */
export function forecastBundle({ days = 90 } = {}) {
  const to = addDays(TODAY, days);
  const events = [];
  for (const it of ITEMS) events.push(...expandItem(it, BUNDLE_FROM, to));
  events.push(...avalancheEvents(BUNDLE_FROM, to));
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    dataAsOf: { snapshotAt: SNAPSHOT_AT, computedAt: COMPUTED_AT },
    fromDate: BUNDLE_FROM,
    toDate: to,
    events,
    transactions: BANK_ROWS.filter((t) => t.occurredOn >= BUNDLE_FROM && t.occurredOn <= to),
    resolutions: RESOLUTIONS,
    closedMonths: [],
    settings: { daysAhead: 90, startingBalance: "0.00", cashBuffer: String(CASH_BUFFER) },
    bankSnapshot,
    cashSignal: cashSignal({ horizonDays: 90 }),
    plaidCheckingAccounts: [plaidChecking],
    checkingAccountExternalId: CHECKING.externalId,
    today: TODAY,
    monthSnapshots: {},
    accountSnapshots: {},
  };
}

// ── what the shell and the side cards read ──────────────────────────────────
const INBOX_COUNT = BANK_ROWS.filter(
  (t) => t.occurredOn.slice(0, 7) === TODAY.slice(0, 7) && !RESOLUTIONS.some((r) => r.matchedTxnId === t.id),
).length;

export function spine() {
  const cs = cashSignal({ horizonDays: 90 });
  const weekStart = addDays(TODAY, -dow(TODAY));
  const spent = (fromD) =>
    r2(-BANK_ROWS.filter((t) => t.occurredOn >= fromD && t.occurredOn <= TODAY && Number(t.amount) < 0 && !t.debtId && !/RENT|INSURANCE|MUTUAL|LOAN|FINANCE|PMT|PAYMENT/.test(t.description)).reduce((s, t) => s + Number(t.amount), 0));
  const nextBill = cs.events.find((e) => e.date >= TODAY && e.assumption == null);
  const billsDue = cs.events.filter((e) => e.date >= TODAY && e.date.slice(0, 7) === TODAY.slice(0, 7)).length;
  return {
    asOf: COMPUTED_AT,
    dataAsOf: { snapshotAt: SNAPSHOT_AT, computedAt: COMPUTED_AT },
    bank: {
      balance: cs.bankToday,
      asOfDate: SNAPSHOT_AT,
      source: "plaid",
      lastContactAt: SNAPSHOT_AT,
      lastFailureAt: null,
      stale: false,
      staleReason: null,
      snapshot: cs.opening.reading,
      sinceSnapshot: cs.opening.since,
      account: cs.account,
    },
    spentMonth: spent(monthStart(TODAY)),
    spentWeek: spent(weekStart),
    nextBill: nextBill ? { name: nextBill.label, amount: money(-Number(nextBill.amount)), dueDate: nextBill.date } : null,
    billsDueCount: billsDue,
    forecast: { lowPoint: cs.lowestProjected, lowPointDate: cs.lowestDate, runwayDays: null, cashBuffer: cs.cashBuffer, status: cs.status },
    debt: { payoffPct: 31, nextMilestone: { label: "Maple Rewards Card paid off", estimatedMonth: "2027-04" }, paidDownMtd: 0, confirmedPaymentsMtd: 0, newChargesMtd: 0 },
    reviewCount: INBOX_COUNT,
    position: {
      safeToSpendNow: "212.00",
      remainingWeek: "212.00",
      knownWeek: "113.00",
      unresolvedWeek: "0.00",
      provisional: false,
      remainingWeekKnown: "212.00",
      availableUntilPayday: "1240.00",
      paydayDate: "2026-11-13",
      horizonKind: "payday",
      withinPlan: "yes",
      confidence: "firm",
      degraded: false,
      weekAdjustment: null,
    },
    monthAllowance: { plan: null, actual: "0.00", status: "not_set", remaining: null, over: null },
    bankConfidence: {
      fetchedAt: SNAPSHOT_AT,
      bankBalance: money(READING),
      bankAsOf: SNAPSHOT_AT,
      h2Balance: cs.bankToday,
      check: { status: "matches", reason: null, stale: false, staleReason: null, checkedAt: SNAPSHOT_AT, difference: "0.00", direction: null },
      pendingCount: BANK_ROWS.filter((t) => t.pending && t.occurredOn <= TODAY).length,
    },
  };
}

export function avalancheSchedule() {
  const cs = cashSignal({ horizonDays: 90 });
  const pays = avalancheEvents(TODAY, addDays(TODAY, 34));
  const paychecks = cs.dayItems.filter((d) => d.kind === "income").map((d) => d.date);
  const proposedPayments = pays.map((p, i) => {
    const next = pays[i + 1]?.date ?? addDays(p.date, 7);
    const window = cs.daily.filter((d) => d.date >= p.date && d.date < next).map((d) => Number(d.balance));
    const low = Math.min(...window);
    const anchor = [...paychecks].reverse().find((d) => d <= p.date) ?? p.date;
    return {
      date: p.date,
      amount: -p.amount,
      rationale: `Paid the Friday ${anchor === p.date ? "payday" : "after payday"}; keeps the week above the $500 buffer.`,
      confidence: low - CASH_BUFFER >= 150 ? "high" : low - CASH_BUFFER >= 50 ? "medium" : "low",
      paycheckAnchor: anchor,
      lowestBetweenThisAndNextPaycheck: r2(low),
      headroom: r2(low - CASH_BUFFER),
    };
  });
  return {
    proposedPayments,
    totalProposed: r2(proposedPayments.reduce((s, p) => s + p.amount, 0)),
    lowestPostScheduleBalance: Number(cs.lowestProjected),
    lowestPostScheduleDate: cs.lowestDate,
    currentAvalancheTarget: { debtName: "Maple Rewards Card", apr: 0.2499, balance: 9850 },
    cashBuffer: CASH_BUFFER,
    bankBalance: Number(cs.bankToday),
    scheduleThroughDate: pays.at(-1)?.date ?? null,
  };
}

export const avalancheSettings = {
  strategy: "avalanche",
  extraSource: "manual",
  extraBudgetCategoryId: null,
  manualExtra: "2600.00",
  budgetMode: "budgeted",
  extraCadence: "weekly",
  extraWeekday: 5,
};
export const avalancheExtra = {
  source: "manual",
  amount: "2600.00",
  monthStart: monthStart(TODAY),
  mode: "budgeted",
};

export const me = { userId: "user_fixture_alex", email: "alex@example.com", displayName: "Alex", isOwner: true };

export const plaidItems = [
  {
    id: "pi-cedar-hollow",
    itemId: "item-ext-cedar-hollow",
    institutionId: "ins_fixture_1",
    institutionName: CHECKING.institution,
    institutionSlug: "cedar-hollow-bank",
    lastSyncedAt: SNAPSHOT_AT,
    lastSyncError: null,
    lastSyncErrorCode: null,
    stillPreparing: false,
    stillPreparingSince: null,
    consentExpirationAt: null,
    consentExpirationLastRefreshedAt: null,
    consentExpirationLastRefreshError: null,
    consentExpirationLastRefreshErrorCode: null,
    consentWarningDismissedForCutoff: null,
    errorKind: null,
    lastBankTxOn: "2026-11-10",
    refreshProductDisabledAt: null,
    freshness: { state: "ok", stale: false, staleReason: null, fetchedAt: SNAPSHOT_AT, lastContactAt: SNAPSHOT_AT, lastFailureAt: null },
    autoUpdates: { on: false, reason: "ok", checkedAt: null, error: null },
    accounts: [
      {
        id: CHECKING.rowId,
        accountId: CHECKING.externalId,
        name: CHECKING.name,
        officialName: "Everyday Checking",
        mask: CHECKING.mask,
        type: "depository",
        subtype: "checking",
        importCutoffDate: null,
        firstSyncCompletedAt: "2026-05-02T14:00:00.000Z",
        snapshot: null,
      },
    ],
  },
];

export const forecastSettings = { daysAhead: 90, startingBalance: "0.00", cashBuffer: String(CASH_BUFFER) };

/** A short, human summary (printed by the dev server at start). */
export function summary() {
  const cs = cashSignal({ horizonDays: 90 });
  const busiest = Object.entries(
    cs.dayItems.reduce((m, d) => ((m[d.date] = (m[d.date] ?? 0) + 1), m), {}),
  ).sort((a, b) => b[1] - a[1])[0];
  return {
    today: TODAY,
    reading: money(READING),
    bankToday: cs.bankToday,
    startingBalance: cs.startingBalance,
    lowest: cs.lowestProjected,
    lowestDate: cs.lowestDate,
    status: cs.status,
    ending: `${cs.endingBalance} on ${cs.endingDate}`,
    avalancheDates: cs.events.filter((e) => e.itemId === "avalanche:extra").map((e) => `${e.date} $${-Number(e.amount)}`),
    carried: cs.events.filter((e) => e.assumption).map((e) => `${e.label} due ${e.originalDate} → ${e.date}`),
    busiestDay: busiest,
    inbox: INBOX_COUNT,
  };
}

// For the other page fixtures (ledger.mjs …): the same checking rows, answers and account.
export { BANK_ROWS, RESOLUTIONS, MATCHED_TXN_IDS, CHECKING, SPECIAL, READING_DAY };
