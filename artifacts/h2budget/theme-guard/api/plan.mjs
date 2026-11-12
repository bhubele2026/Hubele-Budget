// Bills, budget, debts and the report facts of the invented household — all
// worked out from the one transaction list (ledger.mjs) and the one recurring
// plan (fixture.mjs), so the pages agree with each other.
import * as fx from "./fixture.mjs";
import * as L from "./ledger.mjs";

const { TODAY, money, r2, sum, addDays, addMonths, monthStart, monthEnd } = L;

// ── debts ───────────────────────────────────────────────────────────────────
/** A card that was paid off in August: the "paid off" look. */
const PAID_OFF = {
  ...fx.debts[0],
  id: "debt-willow",
  name: "Willow Store Card",
  balance: "0.00",
  originalBalance: "1800.00",
  apr: "0.2290",
  minPayment: "0.00",
  payment: "0.00",
  type: "credit_card",
  status: "archived",
  sortOrder: 5,
  dueDay: 7,
  statementDay: 12,
  lastBalanceUpdate: "2026-08-14",
};
/** One that is closed and archived. */
const ARCHIVED = {
  ...fx.debts[0],
  id: "debt-fernbank",
  name: "Fernbank Personal Loan",
  balance: "0.00",
  originalBalance: "5000.00",
  apr: "0.0990",
  minPayment: "0.00",
  payment: "0.00",
  type: "personal_loan",
  status: "archived",
  sortOrder: 6,
  dueDay: null,
  statementDay: null,
  lastBalanceUpdate: "2026-03-02",
};
export const debts = [...fx.debts, PAID_OFF, ARCHIVED];
const ACTIVE = fx.debts;

/** Month-end balances for every debt, Nov 2025 → today: each falls steadily to today's figure. */
export function debtBalanceHistory() {
  const out = [];
  const months = [];
  for (let m = "2025-11-01"; m <= monthStart(TODAY); m = addMonths(m, 1)) months.push(m);
  // What each debt fell by per month (principal part of the minimum, plus the extra on the top card).
  const fall = { "debt-maple": 235, "debt-northwind": 48, "debt-harbor": 312, "debt-summit": 142 };
  // Months the top card went UP (new charges), so the line is not a ruler.
  const bump = { "2026-02-01": 310, "2026-07-01": 180 };
  for (const d of ACTIVE) {
    let bal = Number(d.balance);
    const series = [];
    for (let i = months.length - 1; i >= 0; i--) {
      const m = months[i];
      const day = i === months.length - 1 ? "2026-11-09" : monthEnd(m);
      series.push({ debtId: d.id, recordedOn: day, balance: money(bal) });
      bal = r2(bal + fall[d.id] - (d.id === "debt-maple" ? (bump[m] ?? 0) : 0));
    }
    out.push(...series.reverse());
  }
  // The paid-off card: $1,800 down to nothing by August.
  const willow = [1800, 1650, 1480, 1310, 1100, 860, 610, 340, 120, 0, 0, 0, 0];
  months.forEach((m, i) => out.push({ debtId: PAID_OFF.id, recordedOn: i === months.length - 1 ? "2026-11-09" : monthEnd(m), balance: money(willow[i] ?? 0) }));
  out.sort((a, b) => (a.recordedOn < b.recordedOn ? -1 : a.recordedOn > b.recordedOn ? 1 : 0));
  return out;
}

export function debtPlan() {
  const detail = ACTIVE.map((d) => ({ debtId: d.id, name: d.name, apr: Number(d.apr), balance: Number(d.balance), minPayment: Number(d.minPayment), minPaymentSource: "manual" }));
  const planned60d = [];
  for (const it of fx.ITEMS.filter((i) => i.debtId)) {
    for (const occ of fx.expandItem(it, TODAY, addDays(TODAY, 60)))
      planned60d.push({ date: occ.date, itemId: it.id, debtId: it.debtId, label: it.name, amount: -occ.amount });
  }
  for (const p of fx.avalancheSchedule().proposedPayments)
    planned60d.push({ date: p.date, itemId: "avalanche:extra", debtId: "debt-maple", label: "Extra payment → Maple Rewards Card", amount: p.amount });
  planned60d.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const assumptions = [
    { key: "extra", text: "The extra payment stays at $2,600 a month." },
    { key: "apr", text: "Each debt keeps today's rate." },
    { key: "no_new", text: "No new charges are added to the cards on the plan." },
  ];
  const upcoming = [
    { key: "paid:debt-maple", kind: "debt_paid_off", label: "Maple Rewards Card paid off", debtId: "debt-maple", monthIndex: 5, estimatedMonth: "2027-04" },
    { key: "pct:50", kind: "percent_paid", label: "Half of the debt paid", debtId: null, monthIndex: 7, estimatedMonth: "2027-06" },
    { key: "paid:debt-northwind", kind: "debt_paid_off", label: "Northwind Card paid off", debtId: "debt-northwind", monthIndex: 6, estimatedMonth: "2027-05" },
    { key: "paid:debt-harbor", kind: "debt_paid_off", label: "Harbor Auto Loan paid off", debtId: "debt-harbor", monthIndex: 11, estimatedMonth: "2027-10" },
    { key: "paid:debt-summit", kind: "debt_paid_off", label: "Summit Student Loan paid off", debtId: "debt-summit", monthIndex: 19, estimatedMonth: "2028-06" },
  ];
  return {
    asOf: fx.COMPUTED_AT,
    strategy: "avalanche",
    extraMonthly: 2600,
    comparison: {
      avalanche: { monthsToFreedom: 19, debtFreeMonth: "2028-06", totalInterest: 3412.18, firstKill: { debtId: "debt-maple", month: "2027-04" } },
      snowball: { monthsToFreedom: 19, debtFreeMonth: "2028-06", totalInterest: 3987.55, firstKill: { debtId: "debt-northwind", month: "2026-12" } },
      delta: { months: 0, interest: 575.37 },
      killMonths: [
        { debtId: "debt-maple", avalanche: "2027-04", snowball: "2027-05" },
        { debtId: "debt-northwind", avalanche: "2027-05", snowball: "2026-12" },
        { debtId: "debt-harbor", avalanche: "2027-10", snowball: "2027-10" },
        { debtId: "debt-summit", avalanche: "2028-06", snowball: "2028-06" },
      ],
      detail: { debts: detail },
    },
    range: {
      earliestMonth: "2028-06",
      latestMonth: "2029-09",
      interestLow: 3412.18,
      interestHigh: 5120.4,
      newChargesPerMonth: 150,
      runs: [
        { key: "base", debtFreeMonth: "2028-06", totalInterest: 3412.18 },
        { key: "half_extra", debtFreeMonth: "2029-09", totalInterest: 5120.4 },
        { key: "new_charges", debtFreeMonth: "2028-08", totalInterest: 3790.02 },
      ],
      assumptions,
    },
    milestones: {
      achieved: [
        { key: "paid:debt-willow", label: "Willow Store Card paid off", debtId: "debt-willow", achievedOn: "2026-08-14" },
        { key: "pct:25", label: "A quarter of the debt paid", debtId: null, achievedOn: "2026-06-30" },
      ],
      next: { key: upcoming[0].key, label: upcoming[0].label, estimatedMonth: upcoming[0].estimatedMonth },
      upcoming,
    },
    planned60d,
    confirmedMtd: 400,
    paidDownGenuineMtd: 400,
    newChargesMtd: 0,
    assumptions,
  };
}

// ── bills ───────────────────────────────────────────────────────────────────
const perMonth = (it) => (it.frequency === "weekly" ? (it.amount * 52) / 12 : it.frequency === "biweekly" ? (it.amount * 26) / 12 : it.frequency === "onetime" ? 0 : it.amount);
const pubItem = (it) => fx.recurringItems.find((r) => r.id === it.id);

/** GET /api/bills/summary?month= */
export function billsSummary(q) {
  const ms = monthStart(q.get("month") || TODAY);
  const me = monthEnd(ms);
  const rowsOfMonth = L.ALL.filter((t) => t.occurredOn >= ms && t.occurredOn <= me && t.plaidAccountId === L.CHECKING.externalId);
  // A bill's own rows: their ids carry the item ("txn-rent-1101"); the one the forecast takes as paid is named apart.
  const paidBy = (it, t) => t.id.startsWith(`txn-${it.id.slice(3)}-`) || [...fx.SPECIAL.assumedPaid].some(([k, v]) => k.startsWith(`${it.id}|`) && v.txnId === t.id);
  const actualOf = (it) => r2(Math.abs(sum(rowsOfMonth.filter((t) => paidBy(it, t)))));
  const next = (it) => {
    const from = ms === monthStart(TODAY) ? TODAY : ms;
    return fx.expandItem(it, from, addDays(from, 62))[0]?.date ?? null;
  };
  const row = (it) => {
    const inMonth = fx.expandItem(it, ms, me);
    const monthly = it.frequency === "onetime" ? inMonth.length * it.amount : perMonth(it);
    return { item: pubItem(it), nextOccurrence: next(it), monthlyAmount: money(monthly), actualAmount: money(actualOf(it)) };
  };
  const live = fx.ITEMS.filter((it) => it.frequency !== "onetime" || (it.anchorDate >= ms && it.anchorDate <= me));
  const income = live.filter((it) => it.kind === "income").map(row);
  const bills = live.filter((it) => it.kind !== "income" && !it.debtId).map(row);
  const debtMins = ACTIVE.map((d) => {
    const it = fx.ITEMS.find((i) => i.debtId === d.id);
    return {
      debtId: d.id,
      debtName: d.name,
      amount: d.minPayment,
      minPayment: d.minPayment,
      nextOccurrence: it ? next(it) : null,
      source: "manual",
      locked: false,
      linkedRecurringId: it?.id ?? null,
      dueDay: d.dueDay,
      endsThisCycle: false,
    };
  });
  const tIncome = sum(income, (r) => Number(r.monthlyAmount));
  const tBills = sum(bills, (r) => Number(r.monthlyAmount));
  const tDebt = sum(debtMins, (r) => Number(r.amount));
  return {
    income,
    bills,
    debtMins,
    monthly: {
      income: money(tIncome),
      bills: money(tBills),
      debtMin: money(tDebt),
      totalOutflow: money(tBills + tDebt),
      net: money(tIncome - tBills - tDebt),
      active: income.length + bills.length + debtMins.length,
      monthStart: ms,
      monthEnd: me,
    },
  };
}

// ── budget ──────────────────────────────────────────────────────────────────
/** What the household set aside for the categories no bill plans (per month). */
const MANUAL_PLAN = { "cat-dining": 420, "cat-health": 120, "cat-pets": 90, "cat-travel": 300, "cat-home-repair": 150, "cat-subs": 60, "cat-fuel": 300, "cat-groceries": 1250 };

/** Money in / out of a category in [from, to], every account, payments and transfers left out. */
function categoryActuals(from, to) {
  const m = new Map();
  for (const t of L.ALL) {
    if (t.occurredOn < from || t.occurredOn > to) continue;
    if (L.isPayment(t)) continue;
    const key = t.categoryId ?? "cat-uncat";
    const e = m.get(key) ?? { posted: 0, pending: 0, bank: 0, card: 0, nBank: 0, nCard: 0 };
    const amt = Number(t.amount);
    if (t.pending) e.pending += amt;
    else e.posted += amt;
    if (L.isCardRow(t)) (e.card += amt), e.nCard++;
    else (e.bank += amt), e.nBank++;
    m.set(key, e);
  }
  return m;
}

/** GET /api/budget/months/:month */
export function budgetMonth(month) {
  const ms = monthStart(month);
  const me = monthEnd(ms);
  const actuals = categoryActuals(ms, me > TODAY ? TODAY : me);
  const lines = fx.categories
    .filter((c) => c.id !== "cat-uncat" || actuals.has("cat-uncat"))
    .map((c) => {
      const items = fx.ITEMS.filter((it) => it.categoryId === c.id && (it.frequency !== "onetime" || (it.anchorDate >= ms && it.anchorDate <= me)));
      const billRows = items.map((it) => {
        const n = fx.expandItem(it, ms, me).length;
        return { id: it.id, name: it.name, amount: money(it.amount), frequency: it.frequency, eventCount: n, _total: n * it.amount };
      });
      const fromBills = sum(billRows, (b) => b._total);
      const manual = MANUAL_PLAN[c.id];
      const planned = c.id === "cat-uncat" ? 0 : manual != null ? Math.max(manual, fromBills) : fromBills;
      const a = actuals.get(c.id) ?? { posted: 0, pending: 0, bank: 0, card: 0, nBank: 0, nCard: 0 };
      const sign = c.kind === "income" ? 1 : -1;
      const posted = r2(sign * a.posted);
      const pending = r2(sign * a.pending);
      const planSource = c.kind === "income" ? "income" : c.id === "cat-debt" ? "debts" : fromBills > 0 ? "bills" : "unbacked";
      const sourceBreakdown = [];
      if (a.nBank) sourceBreakdown.push({ source: "Bank", count: a.nBank, amount: money(sign * a.bank) });
      if (a.nCard) sourceBreakdown.push({ source: "Amex", count: a.nCard, amount: money(sign * a.card) });
      return {
        id: `bl-${ms.slice(0, 7)}-${c.id}`,
        categoryId: c.id,
        categoryName: c.name,
        plannedAmount: money(planned),
        actualAmount: money(posted + pending),
        postedAmount: money(posted),
        pendingAmount: money(pending),
        combinedAmount: money(posted + pending),
        note: c.id === "cat-travel" && ms === "2026-11-01" ? "Holiday flights on the 24th" : null,
        groupName: c.groupName,
        sourceKind: c.id === "cat-debt" ? "auto_debts" : fromBills > 0 && manual == null ? "auto_bills" : "manual",
        planSource,
        sortOrder: c.sortOrder,
        kind: c.kind,
        pinned: manual != null,
        sourceBreakdown,
        plannedSource: { kind: manual != null ? "pinned" : fromBills > 0 ? "bills" : "manual", bills: billRows.map(({ _total, ...b }) => b) },
      };
    });
  const groupNames = [...new Set(lines.map((l) => l.groupName))];
  const groups = groupNames.map((groupName) => {
    const ls = lines.filter((l) => l.groupName === groupName);
    return { groupName, plannedTotal: money(sum(ls, (l) => Number(l.plannedAmount))), actualTotal: money(sum(ls, (l) => Number(l.actualAmount))), lines: ls };
  });
  const inc = lines.filter((l) => l.kind === "income");
  const exp = lines.filter((l) => l.kind !== "income");
  const tot = (ls, f) => sum(ls, (l) => Number(l[f]));
  const iB = tot(inc, "plannedAmount");
  const iA = tot(inc, "actualAmount");
  const eB = tot(exp, "plannedAmount");
  const eA = tot(exp, "actualAmount");
  const bucket = (src) => {
    const ls = lines.filter((l) => l.planSource === src);
    return { planned: money(tot(ls, "plannedAmount")), actual: money(tot(ls, "actualAmount")), lineCount: ls.length };
  };
  // Allowances: the cards' flagged purchases this month.
  const inMonth = L.ALL.filter((t) => t.occurredOn >= ms && t.occurredOn <= me && t.occurredOn <= TODAY && !L.isPayment(t));
  const allowLine = (bucketName, pick, planned) => {
    const rows = inMonth.filter(pick);
    const posted = r2(-sum(rows.filter((t) => !t.pending)));
    const pending = r2(-sum(rows.filter((t) => t.pending)));
    const subs = ["groceries", "dining", "alcohol", "entertainment", "misc"].map((b) => {
      const rs = rows.filter((t) => t.weeklyBucket === b);
      return { bucket: b, actual: money(-sum(rs)), count: rs.length };
    });
    return {
      bucket: bucketName,
      planned: money(planned),
      actual: money(posted + pending),
      posted: money(posted),
      pending: money(pending),
      combined: money(posted + pending),
      count: rows.length,
      subBuckets: bucketName === "weekly" ? subs.filter((s) => s.count > 0) : [],
    };
  };
  const weeks = 4.43;
  const aLines = [
    allowLine("weekly", (t) => t.weeklyAllowance, 325 * weeks),
    allowLine("monthly", (t) => t.monthlyAllowance, 400),
    allowLine("unplanned", (t) => t.unplannedAllowance, 0),
  ];
  const aTot = (f) => money(sum(aLines, (l) => Number(l[f])));
  const uncat = actuals.get("cat-uncat");
  return {
    monthStart: ms,
    note: ms === "2026-11-01" ? "Three paychecks land in October; November is the tight one." : null,
    monthPinned: false,
    lines,
    groups,
    summary: {
      income: { budget: money(iB), actual: money(iA) },
      expenses: { budget: money(eB), actual: money(eA) },
      net: { budget: money(iB - eB), actual: money(iA - eA) },
      percentSpent: { budget: "100", actual: eB > 0 ? String(Math.round((eA / eB) * 100)) : "0" },
    },
    planBySource: {
      income: bucket("income"),
      bills: bucket("bills"),
      debts: bucket("debts"),
      unbacked: bucket("unbacked"),
      plannedTotal: money(eB),
      actualTotal: money(eA),
      net: money(iB - eB),
    },
    allowance: { lines: aLines, planned: aTot("planned"), actual: aTot("actual"), posted: aTot("posted"), pending: aTot("pending"), combined: aTot("combined"), weeksInMonth: String(weeks) },
    replacedPendingIds: [],
    inheritedCategories: [],
    spendingReconciliation: {
      budgetActual: money(eA),
      householdSpendToDate: money(eA - (uncat ? -(uncat.posted + uncat.pending) : 0)),
      through: me > TODAY ? TODAY : me,
      difference: money(uncat ? -(uncat.posted + uncat.pending) : 0),
      terms: {
        futureDated: "0.00",
        cardPayments: "0.00",
        debtPayments: "0.00",
        excludedNames: "0.00",
        reimbursable: "0.00",
        bankNoise: "0.00",
        splitsOutsideLines: "0.00",
        uncategorized: money(uncat ? -(uncat.posted + uncat.pending) : 0),
        parkedUncategorized: "0.00",
        refundsNetted: "0.00",
      },
      unexplained: "0.00",
    },
  };
}

// ── the old dashboard summary (the reports hub still reads it) ──────────────
export function dashboard() {
  const ms = monthStart(TODAY);
  const month = L.ALL.filter((t) => t.occurredOn >= ms && t.occurredOn <= TODAY);
  const income = sum(month.filter(L.isIncome));
  const spendRows = month.filter(L.isSpend);
  const spend = -sum(spendRows);
  const byCat = new Map();
  for (const t of spendRows) byCat.set(t.categoryId ?? "cat-uncat", r2((byCat.get(t.categoryId ?? "cat-uncat") ?? 0) - Number(t.amount)));
  const paid = -sum(month.filter((t) => t.debtId));
  return {
    totalDebt: money(sum(ACTIVE, (d) => Number(d.balance))),
    monthlyIncome: money(income),
    monthlySpend: money(spend),
    netCashflow: money(income - spend),
    debtCount: debts.length,
    activeDebtCount: ACTIVE.length,
    paidThisMonth: money(paid),
    paidLifetime: money(sum(ACTIVE, (d) => Number(d.originalBalance) - Number(d.balance)) + 1800),
    transactionCount: L.ALL.length,
    recentTransactions: L.ALL.filter((t) => t.occurredOn <= TODAY).slice(0, 8).map(L.pub),
    topCategories: [...byCat].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, total]) => ({ categoryName: L.categoryName(id) ?? "Uncategorized", total: money(total) })),
    upcomingBills: fx.recurringItems.filter((r) => r.kind !== "income").slice(0, 6),
  };
}

// ── report facts ────────────────────────────────────────────────────────────
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** GET /api/reports/spending-facts?from&to */
export function spendingFacts(q) {
  const end = q.get("to") && q.get("to") < TODAY ? q.get("to") : TODAY;
  const wanted = q.get("from") || addDays(end, -30);
  const start = wanted < L.HISTORY_FROM ? L.HISTORY_FROM : wanted;
  const rows = L.ALL.filter((t) => t.occurredOn >= start && t.occurredOn <= end);
  const spendRows = rows.filter((t) => L.isSpend(t) && !t.reimbursable);
  const real = -sum(spendRows);
  const refunds = rows.filter((t) => Number(t.amount) > 0 && !L.isIncome(t) && !L.isPayment(t));
  const incomeRows = rows.filter(L.isIncome);
  const unplanned = rows.filter((t) => t.unplannedAllowance);
  const uncat = spendRows.filter((t) => !t.categoryId);
  const group = (list, keyOf) => {
    const m = new Map();
    for (const t of list) {
      const k = keyOf(t);
      const e = m.get(k) ?? { total: 0, count: 0, sample: t };
      e.total = r2(e.total - Number(t.amount));
      e.count++;
      m.set(k, e);
    }
    return [...m].sort((a, b) => b[1].total - a[1].total);
  };
  const byCategory = group(spendRows.filter((t) => t.categoryId), (t) => t.categoryId).map(([categoryId, e]) => ({
    categoryId,
    name: L.categoryName(categoryId),
    total: e.total,
    txnCount: e.count,
    pctOfRealSpend: real > 0 ? Math.round((e.total / real) * 1000) / 10 : 0,
  }));
  const byMerchant = group(spendRows, (t) => t.displayName).slice(0, 25).map(([name, e]) => ({
    name,
    total: e.total,
    count: e.count,
    sampleCategoryName: L.categoryName(e.sample.categoryId),
    sampleCategoryId: e.sample.categoryId ?? null,
  }));
  const dailyBuckets = [];
  const dailyNet = [];
  const days = L.daysBetween(start, end) + 1;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const dayRows = spendRows.filter((t) => t.occurredOn === d);
    dailyBuckets.push({ date: d, total: r2(-sum(dayRows)), count: dayRows.length });
    dailyNet.push({ date: d, net: r2(sum(rows.filter((t) => t.occurredOn === d && !L.isPayment(t)))) });
  }
  const dayOfWeek = DOW.map((label, i) => {
    const rs = spendRows.filter((t) => L.dow(t.occurredOn) === i);
    const total = r2(-sum(rs));
    let n = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) if (L.dow(d) === i) n++;
    return { dow: i, label, avgPerDay: n ? r2(total / n) : 0, total, topMerchants: group(rs, (t) => t.displayName).slice(0, 3).map(([name, e]) => ({ name, total: e.total })) };
  });
  // The months: always the six up to `end`, so the trend has a line to draw.
  const monthlyTrends = [];
  for (let m = addMonths(monthStart(end), -5); m <= monthStart(end); m = addMonths(m, 1)) {
    const hi = monthEnd(m) > TODAY ? TODAY : monthEnd(m);
    const rs = L.ALL.filter((t) => t.occurredOn >= m && t.occurredOn <= hi && L.isSpend(t) && !t.reimbursable);
    monthlyTrends.push({
      month: m.slice(0, 7),
      total: r2(-sum(rs)),
      byTopCategory: group(rs.filter((t) => t.categoryId), (t) => t.categoryId).slice(0, 5).map(([id, e]) => ({ name: L.categoryName(id), total: e.total })),
    });
  }
  const reimb = rows.filter((t) => t.reimbursable && !t.reimbursed);
  return {
    range: { start, end, daysCovered: days, trackingStart: L.HISTORY_FROM, floorApplied: wanted < L.HISTORY_FROM },
    householdSpend: { total: real, transactionCount: spendRows.length },
    unplanned: {
      total: r2(-sum(unplanned)),
      transactionCount: unplanned.length,
      transactions: unplanned.map((t) => ({ id: t.id, date: t.occurredOn, description: t.displayName, amount: -Number(t.amount) })),
    },
    realSpend: { total: real, transactionCount: spendRows.length },
    refunds: { total: sum(refunds), transactionCount: refunds.length, fromCategories: new Set(refunds.map((t) => t.categoryId)).size },
    realIncome: { total: sum(incomeRows), transactionCount: incomeRows.length },
    uncategorized: {
      total: r2(-sum(uncat)),
      transactionCount: uncat.length,
      sampleMerchants: group(uncat, (t) => t.displayName).slice(0, 5).map(([name, e]) => ({ name, total: e.total, count: e.count })),
    },
    excluded: {
      transfersTotal: r2(Math.abs(sum(rows.filter((t) => t.isTransfer && !t.isExternalCardPayment && Number(t.amount) < 0)))),
      debtPaymentsTotal: r2(-sum(rows.filter((t) => t.debtId))),
      reimbursementTotal: 0,
      ignoreTotal: 0,
      cardPayments: r2(-sum(rows.filter((t) => t.isExternalCardPayment && Number(t.amount) < 0))),
      reimbursable: r2(-sum(reimb)),
      replacedPending: 0,
      expiredHolds: 0,
    },
    byCategory,
    byMerchant,
    dailyBuckets,
    dailyNet,
    dayOfWeek,
    monthlyTrends,
    reimbursable: { personalTotal: real, outstandingReimbursableTotal: r2(-sum(reimb)) },
  };
}

// ── categories to confirm ───────────────────────────────────────────────────
export function categorizationReview() {
  const item = (n, id, suggested, confidence, band, explanation, flags = {}) => {
    const t = L.byId(id);
    return {
      decisionId: `dec-${n}`,
      transactionId: t.id,
      occurredOn: t.occurredOn,
      description: t.description,
      amount: t.amount,
      account: t.account,
      currentCategoryId: t.categoryId,
      suggestedCategoryId: suggested,
      confidence,
      band,
      source: "model",
      explanation,
      createdAt: `${t.occurredOn}T18:30:00.000Z`,
      flags: { novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false, ...flags },
    };
  };
  const items = [
    item(1, "txn-ca-1116", "cat-groceries", 0.58, "queue", "A market stall: most likely food, but this seller is new.", { novelMerchant: true }),
    item(2, "txn-cb-1106", null, 0.22, "queue", "The bank gave no merchant name. Nothing to go on.", { novelMerchant: true }),
    item(3, "txn-ca-1117", "cat-fuel", 0.71, "provisional", "Tow and tire shops have been filed under Fuel before; the amount is much larger than usual.", { amountAnomaly: true }),
    item(4, "txn-ca-1115", "cat-home-repair", 0.83, "provisional", "Sundial Hardware has been filed under Home & garden 6 times."),
  ];
  return { items, total: items.length };
}

export const mappingRules = [
  ["mr-1", "CORNER GROCER", "contains", "cat-groceries"],
  ["mr-2", "HILLTOP FUEL", "contains", "cat-fuel"],
  ["mr-3", "LANTERN THAI", "contains", "cat-dining"],
  ["mr-4", "MOSSY OAK COFFEE", "contains", "cat-dining"],
  ["mr-5", "BLUEBIRD PHARMACY", "contains", "cat-health"],
  ["mr-6", "TIDY PAWS", "contains", "cat-pets"],
  ["mr-7", "CLOUDNEST", "contains", "cat-subs"],
  ["mr-8", "PAPERTRAIL NEWS", "exact", "cat-subs"],
  ["mr-9", "SUNDIAL HARDWARE", "contains", "cat-home-repair"],
  ["mr-10", "PAYROLL", "contains", "cat-income"],
].map(([id, pattern, matchType, categoryId], i) => ({ id, pattern, matchType, categoryId, priority: 100 - i * 5, updatedAt: "2026-09-14T15:00:00.000Z" }));

// ── the two smaller reports (budget, habits) ────────────────────────────────
const statusOf = (pct, kind) => (kind === "income" ? (pct >= 95 ? "good" : pct >= 60 ? "watch" : "miss") : pct <= 100 ? "good" : pct <= 115 ? "watch" : "miss");

/** GET /api/reports/budget-facts?monthStart=&monthsBack= */
export function budgetFacts(q) {
  const ms = monthStart(q.get("monthStart") || TODAY);
  const me = monthEnd(ms);
  const back = Number(q.get("monthsBack") ?? 6) || 6;
  const passed = me < TODAY;
  const daysInMonth = Number(me.slice(8, 10));
  const daysElapsed = passed ? daysInMonth : Math.max(1, Number(TODAY.slice(8, 10)));
  const classOf = (l) => (l.kind === "income" ? "income" : l.categoryId === "cat-debt" ? "debt" : l.planSource === "bills" && !l.pinned ? "bill" : "flex");
  const factsOf = (month) =>
    budgetMonth(month)
      .lines.filter((l) => l.categoryId !== "cat-uncat")
      .map((l) => {
        const planned = Number(l.plannedAmount);
        const actual = Number(l.actualAmount);
        const pct = planned > 0 ? Math.round((actual / planned) * 100) : actual > 0 ? 999 : 0;
        return { categoryId: l.categoryId, name: l.categoryName, class: classOf(l), planned, actual, pct, status: statusOf(pct, l.kind) };
      });
  const lines = factsOf(ms);
  const section = (cls) => {
    const ls = lines.filter((l) => l.class === cls);
    return { paidCount: ls.filter((l) => l.actual >= l.planned && l.planned > 0).length, totalCount: ls.length, lines: ls };
  };
  const flex = lines.filter((l) => l.class === "flex").map((l) => ({ ...l, unbudgeted: l.planned === 0 }));
  const plannedTotal = sum(flex, (l) => l.planned);
  const actualTotal = sum(flex, (l) => l.actual);
  const flexIds = new Set(flex.map((l) => l.categoryId));
  const burndown = [];
  let cum = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${ms.slice(0, 8)}${String(day).padStart(2, "0")}`;
    if (date <= TODAY) cum = r2(cum - sum(L.ALL.filter((t) => t.occurredOn === date && flexIds.has(t.categoryId) && !L.isPayment(t))));
    burndown.push({ day, date, plannedCumulative: r2((plannedTotal * day) / daysInMonth), actualCumulative: date <= TODAY ? cum : null });
  }
  const paceToDate = r2((plannedTotal * daysElapsed) / daysInMonth);
  const projected = r2((actualTotal / daysElapsed) * daysInMonth);
  const monthKeys = [];
  for (let m = addMonths(ms, -(back - 1)); m <= ms; m = addMonths(m, 1)) monthKeys.push(m.slice(0, 7));
  const perMonth = monthKeys.map((k) => (`${k}-01` < L.HISTORY_FROM ? null : factsOf(`${k}-01`)));
  const rows = lines.map((l) => {
    const cells = perMonth.map((f) => {
      const hit = f?.find((x) => x.categoryId === l.categoryId);
      return hit ? { status: hit.status, pct: hit.pct } : null;
    });
    let current = 0;
    for (let i = cells.length - 1; i >= 0 && cells[i]?.status === "good"; i--) current++;
    let longest = 0;
    let runLen = 0;
    for (const c of cells) {
      runLen = c?.status === "good" ? runLen + 1 : 0;
      longest = Math.max(longest, runLen);
    }
    return { categoryId: l.categoryId, name: l.name, class: l.class, currentStreakGood: current, longestStreakGood: longest, cells };
  });
  return {
    range: { monthStart: ms, monthEnd: me, daysInMonth, daysElapsed, monthHasPassed: passed, monthLabel: L.monthLabel(ms), monthsBack: back },
    income: section("income"),
    bills: section("bill"),
    debts: section("debt"),
    flex: {
      paidCount: flex.filter((l) => l.status === "good").length,
      totalCount: flex.length,
      lines: flex,
      plannedTotal,
      actualTotal,
      pacePlanToDate: paceToDate,
      paceStatus: actualTotal > paceToDate * 1.05 ? "over" : actualTotal < paceToDate * 0.9 ? "under" : "on_track",
      projectedMonthEnd: projected,
      projectedVsPlan: r2(projected - plannedTotal),
      burndown,
    },
    streak: { monthKeys, rows },
  };
}

/** GET /api/reports/behavior-facts?from=&to= */
export function behaviorFacts(q) {
  const end = q.get("to") && q.get("to") < TODAY ? q.get("to") : TODAY;
  const wanted = q.get("from") || addDays(end, -30);
  const start = wanted < L.HISTORY_FROM ? L.HISTORY_FROM : wanted;
  const rows = L.ALL.filter((t) => t.occurredOn >= start && t.occurredOn <= end);
  const spend = rows.filter((t) => L.isSpend(t));
  const ref = (t) => (t ? { amount: Math.abs(Number(t.amount)), date: t.occurredOn, merchant: t.displayName, categoryName: L.categoryName(t.categoryId) } : null);
  const since = (pick) => {
    const t = L.ALL.find((x) => x.occurredOn <= end && L.isSpend(x) && pick(x));
    return t ? { days: L.daysBetween(t.occurredOn, end), lastDate: t.occurredOn, lastMerchant: t.displayName, lastAmount: Math.abs(Number(t.amount)) } : null;
  };
  const byDay = new Map();
  for (const t of spend) byDay.set(t.occurredOn, r2((byDay.get(t.occurredOn) ?? 0) - Number(t.amount)));
  const dayRef = (e) => (e ? { date: e[0], total: e[1], dayOfWeek: DOW[L.dow(e[0])] } : null);
  const days = [...byDay].sort((a, b) => a[1] - b[1]);
  const visits = new Map();
  for (const t of spend) {
    const e = visits.get(t.displayName) ?? { count: 0, total: 0, sample: t };
    e.count++;
    e.total = r2(e.total - Number(t.amount));
    visits.set(t.displayName, e);
  }
  const top = [...visits].sort((a, b) => b[1].count - a[1].count)[0];
  const biggest = [...spend].sort((a, b) => Number(a.amount) - Number(b.amount))[0];
  const biggestIn = [...rows.filter(L.isIncome)].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
  const impulse = spend.filter((t) => t.unplannedAllowance || !t.categoryId);
  // The bank gives no time of day: spread the day's purchases over shop hours by a fixed rule.
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, count: 0 }));
  spend.forEach((t, i) => {
    const h = hours[8 + ((i * 7 + t.description.length) % 13)];
    h.total = r2(h.total - Number(t.amount));
    h.count++;
  });
  const subs = fx.ITEMS.filter((i) => i.categoryId === "cat-subs" || i.id === "ri-gym");
  return {
    range: { start, end, daysCovered: L.daysBetween(start, end) + 1, trackingStart: L.HISTORY_FROM, floorApplied: wanted < L.HISTORY_FROM },
    daysSinceLast: {
      dining: since((t) => t.weeklyBucket === "dining" || /BISTRO/.test(t.description)),
      amazon: null,
      coffee: since((t) => /COFFEE/.test(t.description)),
      gasStation: since((t) => t.categoryId === "cat-fuel" && /FUEL/.test(t.description)),
      groceries: since((t) => t.categoryId === "cat-groceries"),
      onlineShopping: since((t) => /CLOUDNEST|THREADLINE/.test(t.description)),
    },
    streaks: {
      noDining: { currentDays: 1, longestDays: 6, longestEndDate: "2026-09-19" },
      coffeeFree: { currentDays: 0, longestDays: 11, longestEndDate: "2026-08-02" },
    },
    funFacts: {
      biggestSplurge: ref(biggest),
      mostVisitedMerchant: top ? { name: top[0], count: top[1].count, total: top[1].total, sampleCategoryName: L.categoryName(top[1].sample.categoryId) } : null,
      quietestDay: dayRef(days[0]),
      mostExpensiveDay: dayRef(days.at(-1)),
      impulseBuyCount: { count: impulse.length, total: r2(-sum(impulse)), exampleMerchants: [...new Set(impulse.map((t) => t.displayName))].slice(0, 3) },
      subscriptionsCount: { count: subs.length + 2, monthlyTotal: sum(subs, (s) => s.amount) + 21.99, topThree: subs.slice(0, 3).map((s) => ({ name: s.name, amount: s.amount, frequency: s.frequency })) },
      nextPaycheckCountdown: { days: 3, paycheckLabel: "Paycheck · Jordan", expectedAmount: 2450, expectedDate: "2026-11-13" },
    },
    hourlySpendingClock: hours,
    dayOfWeekSpend: DOW.map((label, i) => {
      const rs = spend.filter((t) => L.dow(t.occurredOn) === i);
      let n = 0;
      for (let d = start; d <= end; d = addDays(d, 1)) if (L.dow(d) === i) n++;
      const total = r2(-sum(rs));
      return { dow: i, label, total, count: rs.length, avgPerDay: n ? r2(total / n) : 0 };
    }),
    hallOfFame: { biggestExpense: ref(biggest), biggestIncome: ref(biggestIn) },
  };
}
