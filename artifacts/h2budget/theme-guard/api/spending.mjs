// The week / month spending pages, the card page and the banking review of the
// invented household — all read from the one transaction list (ledger.mjs).
import * as fx from "./fixture.mjs";
import * as home from "./home.mjs";
import * as L from "./ledger.mjs";

const { TODAY, TZ, money, r2, sum, addDays, addMonths, monthStart, monthEnd, weekStartOf } = L;

export const WEEK_PLAN = 325;
export const MONTH_PLAN = 400;

const acctRef = (t) => {
  const a = L.accountOf(t);
  return { id: a?.rowId ?? null, institution: a?.institution ?? null, name: a?.name ?? null, mask: a?.mask ?? null };
};
const catRef = (t) => (t.categoryId ? { id: t.categoryId, name: L.categoryName(t.categoryId) } : null);

/** What a row counts as, the same words on every page. */
function coverageOf(t) {
  const amt = Number(t.amount);
  if (t.isExternalCardPayment) return ["card_payment", "card_payment"];
  if (t.isTransfer) return ["transfer", "transfer"];
  if (t.debtId || t.categoryId === "cat-debt") return ["debt_payment", "debt_payment"];
  if (L.isIncome(t)) return ["income", "income_category"];
  if (amt > 0) return ["refund", "inflow_other"];
  if (t.reimbursable) return ["reimbursable", "reimbursable"];
  if (t.unplannedAllowance) return ["unplanned", "unplanned_flag"];
  if (t.monthlyAllowance) return ["allowance_monthly", "monthly_flag"];
  if (t.weeklyAllowance) return ["allowance_weekly", "weekly_flag"];
  if (L.isBill(t) || fx.MATCHED_TXN_IDS.has(t.id)) return ["bill_matched", "bill_match_confirmed"];
  if (t.categoryId === "cat-subs") return ["bill_matched", "bill_match_tier2"];
  return ["needs_classification", "unfiled"];
}
const rowEvidence = (t, coverage) =>
  coverage === "needs_classification"
    ? { class: "unresolved", reason: "no_contrary_evidence", items: t.pfcDetailed ? [{ field: "pfc_detailed", value: t.pfcDetailed }] : [], suggestion: null }
    : null;
function pbRow(t) {
  const [coverage, rule] = coverageOf(t);
  return {
    id: t.id,
    date: t.occurredOn,
    displayName: t.displayName,
    amount: money(-Number(t.amount)),
    account: acctRef(t),
    pending: t.pending,
    category: catRef(t),
    reason: { coverage, nets: null, rule },
    splitPart: null,
    evidence: rowEvidence(t, coverage),
  };
}

/** GET /api/money/period-breakdown?period=week|month&start=&account=&rowsPerGroup= */
export function periodBreakdown(q) {
  const period = q.get("period") === "month" ? "month" : "week";
  const start = q.get("start") || (period === "week" ? weekStartOf(TODAY) : monthStart(TODAY));
  const end = period === "week" ? addDays(start, 6) : monthEnd(start);
  const cap = Number(q.get("rowsPerGroup") ?? 50) || 50;
  const scope = q.get("account") ? L.scopeOf(q.get("account")) : null;
  const one = scope && scope.accounts.length === 1 ? scope.accounts[0] : null;
  const isCurrent = start <= TODAY && TODAY <= end;
  const through = end > TODAY ? TODAY : end;
  const inPeriod = (from, to) => L.ALL.filter((t) => t.occurredOn >= from && t.occurredOn <= to && (!one || t.plaidAccountId === one.externalId));
  const rows = inPeriod(start, through);
  const mine = period === "week" ? "allowance_weekly" : "allowance_monthly";
  const cov = new Map(rows.map((t) => [t.id, coverageOf(t)[0]]));
  const counted = rows.filter((t) => cov.get(t.id) === mine || (cov.get(t.id) === "refund" && (period === "week" ? t.weeklyAllowance : t.monthlyAllowance)));
  const known = r2(-sum(counted));
  const open = rows.filter((t) => cov.get(t.id) === "needs_classification");
  const unresolved = r2(-sum(open));
  const plan = period === "week" ? WEEK_PLAN : MONTH_PLAN;

  // "Usual": the same category over the six periods before, to the same day of the period.
  const step = (s, n) => (period === "week" ? addDays(s, 7 * n) : addMonths(s, n));
  const offset = L.daysBetween(start, through);
  const usualOf = (categoryId, full) => {
    let total = 0;
    let n = 0;
    for (let i = 1; i <= 6; i++) {
      const s = step(start, -i);
      if (s < L.HISTORY_FROM) break;
      const e = full ? (period === "week" ? addDays(s, 6) : monthEnd(s)) : addDays(s, offset);
      total += -sum(L.ALL.filter((t) => t.occurredOn >= s && t.occurredOn <= e && (t.categoryId ?? null) === categoryId && (period === "week" ? t.weeklyAllowance : t.monthlyAllowance)));
      n++;
    }
    return n ? [r2(total / n), n] : [null, 0];
  };
  const byCat = new Map();
  for (const t of counted) {
    const k = t.categoryId ?? null;
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(t);
  }
  const categories = [...byCat]
    .map(([categoryId, list]) => {
      const amount = r2(-sum(list));
      const [usual, n] = usualOf(categoryId, false);
      const [usualFull] = usualOf(categoryId, true);
      return {
        categoryId,
        name: categoryId ? L.categoryName(categoryId) : null,
        amount: money(amount),
        shareBp: known > 0 ? Math.round((amount / known) * 10000) : null,
        count: list.length,
        usual: usual == null ? null : money(usual),
        usualFullPeriod: usualFull == null ? null : money(usualFull),
        aboveUsual: usual != null && amount > usual ? money(amount - usual) : null,
        historyPeriods: n,
        rows: list.slice(0, cap).map(pbRow),
        truncated: list.length > cap,
      };
    })
    .sort((a, b) => Number(b.amount) - Number(a.amount));
  const pays = rows.filter((t) => ["card_payment", "debt_payment", "transfer"].includes(cov.get(t.id)) && Number(t.amount) < 0);
  const of = (c) => r2(-sum(rows.filter((t) => cov.get(t.id) === c)));
  const remaining = r2(plan - known);
  return {
    period,
    basis: period === "week" ? "weekly_allowance" : "monthly_allowance",
    start,
    end,
    isCurrent,
    timezone: TZ,
    scope: one
      ? { kind: "account", id: one.rowId, institution: one.institution, name: one.name, mask: one.mask }
      : { kind: "household", id: null, institution: null, name: null, mask: null },
    planScope: "household",
    plan: { status: "set", amount: money(plan), source: "plan", planId: `plan-${period}`, effectiveFrom: "2026-09-06" },
    carryOver: null,
    actual: money(known),
    known: money(known),
    remaining: remaining >= 0 ? money(remaining) : null,
    over: remaining < 0 ? money(-remaining) : null,
    withinPlan: remaining >= 0,
    provisional: unresolved > 0,
    categories,
    needsClassification: { amount: money(unresolved), count: open.length, rows: open.slice(0, cap).map(pbRow), truncated: open.length > cap, countsAgainstPlan: false },
    unresolved: { amount: money(unresolved), nettedByRefunds: "0.00", count: open.length, rows: open.slice(0, cap).map(pbRow), truncated: open.length > cap },
    excludedPayments: { amount: money(-sum(pays)), count: pays.length, rows: pays.slice(0, cap).map(pbRow), truncated: pays.length > cap },
    refundFloorAdjustment: "0.00",
    usualBasis: isCurrent ? "same_days" : "full_period",
    usualThrough: isCurrent ? through : null,
    beside: {
      unplanned: money(of("unplanned")),
      weekly: period === "week" ? null : money(of("allowance_weekly")),
      monthly: period === "month" ? null : money(of("allowance_monthly")),
      billMatched: money(of("bill_matched")),
      reimbursable: money(of("reimbursable")),
      householdSpend: money(-sum(rows.filter((t) => L.isSpend(t) && !t.reimbursable))),
    },
    limitations: [],
  };
}

// ── the card page ───────────────────────────────────────────────────────────
const paidAsOf = (c) => ({ effectiveMode: c.cadence === "weekly" ? "in_full_weekly" : "in_full_monthly", source: "default_no_debt" });
const payDown = { available: false, reason: "no_debt" };
const defaultMode = { mode: "in_full", reason: "no_debt" };
const cardRows = (card, from, to) => L.ALL.filter((t) => t.plaidAccountId === card.externalId && t.occurredOn >= from && t.occurredOn <= to);
const isPurchase = (t) => Number(t.amount) < 0 && !L.isPayment(t);
const isRefund = (t) => Number(t.amount) > 0 && !L.isPayment(t);
const total = (rows) => ({ amount: money(Math.abs(sum(rows))), count: rows.length });

/** GET /api/amex/weekly-payoff?weekStart= */
export function amexWeeklyPayoff(q) {
  const ws = q.get("weekStart") || weekStartOf(TODAY);
  const we = addDays(ws, 6);
  const cards = L.CARDS.map((c) => {
    const from = c.cadence === "weekly" ? ws : monthStart(ws > TODAY ? TODAY : we < TODAY ? we : TODAY);
    const to = c.cadence === "weekly" ? we : monthEnd(from);
    const rows = cardRows(c, from, to > TODAY ? TODAY : to);
    const buys = rows.filter(isPurchase);
    const charges = r2(-sum(buys) - sum(rows.filter(isRefund)));
    const owed = L.CARD_OWED[c.externalId];
    const top = [...buys].sort((a, b) => Number(a.amount) - Number(b.amount))[0];
    return {
      paidAs: paidAsOf(c),
      accountId: c.externalId,
      plaidAccountId: c.rowId,
      debtId: null,
      name: c.name,
      brand: c.brand,
      cadence: c.cadence,
      periodLabel: c.cadence === "weekly" ? `${L.shortDay(ws)} – ${L.shortDay(we)}` : L.monthLabel(from),
      displayName: c.name,
      weekCharges: charges,
      chargeCount: buys.length,
      statementBalance: owed,
      pctOfStatementThisWeek: owed > 0 ? Math.round((charges / owed) * 100) : 0,
      topMerchant: top ? { name: top.displayName, amount: -Number(top.amount) } : null,
    };
  });
  const weekly = cards.filter((c) => c.cadence === "weekly");
  return {
    weekStart: ws,
    weekEnd: we,
    cards,
    combinedWeekCharges: sum(weekly, (c) => c.weekCharges),
    combinedStatementBalance: sum(cards, (c) => c.statementBalance),
    debtLinkedCards: [],
    payoffModes: L.CARDS.map((c) => ({
      accountId: c.externalId,
      name: c.name,
      mask: c.mask,
      cadence: c.cadence,
      mode: "in_full",
      source: "default",
      reason: "no_debt",
      debtId: null,
      paidAs: paidAsOf(c),
      payDown,
      defaultMode,
    })),
  };
}

const cardRef = (t) => {
  const c = L.accountOf(t);
  return { accountId: c.externalId, name: c.name, mask: c.mask };
};
function flagsOf(t) {
  const f = [];
  if (t.reimbursable) f.push("reimbursable");
  if (t.unplannedAllowance) f.push("unplanned");
  if (L.isUnfiled(t)) f.push("unfiled");
  if (!t.categoryId) f.push("uncategorized");
  if (t.weeklyAllowance) f.push("weekly");
  if (t.monthlyAllowance) f.push("monthly");
  if (t.categoryId === "cat-subs") f.push("bill_matched");
  return f;
}
const sumRow = (t) => ({ id: t.id, date: t.occurredOn, displayName: t.displayName, amount: money(-Number(t.amount)), pending: t.pending, category: catRef(t), flags: flagsOf(t), card: cardRef(t) });

/** GET /api/amex/summary?accountId=&from=&to= */
export function amexSummary(q) {
  const accountId = q.get("accountId") || "all";
  const from = q.get("from") || weekStartOf(TODAY);
  const to = q.get("to") || TODAY;
  const cap = Number(q.get("rowsPerGroup") ?? 50) || 50;
  const one = L.CARDS.find((c) => c.externalId === accountId || c.rowId === accountId) ?? null;
  const cards = one ? [one] : L.CARDS;
  const through = to > TODAY ? TODAY : to;
  const rows = cards.flatMap((c) => cardRows(c, from, through)).sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0));
  const buys = rows.filter(isPurchase);
  const refunds = rows.filter(isRefund);
  const payments = rows.filter((t) => L.isPayment(t));
  const group = (list) => ({ ...total(list), rows: list.slice(0, cap).map(sumRow), truncated: list.length > cap });
  const unplanned = buys.filter((t) => t.unplannedAllowance);
  const unfiled = buys.filter((t) => !t.unplannedAllowance && L.isUnfiled(t));
  const uncategorized = buys.filter((t) => !t.unplannedAllowance && !L.isUnfiled(t) && !t.categoryId);
  const owed = sum(cards, (c) => L.CARD_OWED[c.externalId]);
  const keyOf = (t) =>
    t.reimbursable ? "reimbursable" : t.unplannedAllowance ? "unplanned" : t.weeklyAllowance ? "weekly_known" : t.monthlyAllowance ? "monthly_known" : t.categoryId === "cat-subs" ? "bills" : "no_bucket";
  const LABELS = {
    weekly_known: "In the weekly plan",
    weekly_unresolved: "Weekly plan · unconfirmed",
    monthly_known: "In the monthly allowance",
    monthly_unresolved: "Monthly allowance · unconfirmed",
    bills: "Bills",
    unplanned: "Unplanned",
    reimbursable: "To be paid back",
    not_counted: "Not counted",
    no_bucket: "Not placed yet",
  };
  const groups = Object.keys(LABELS)
    .map((key) => {
      const list = buys.filter((t) => keyOf(t) === key);
      return {
        key,
        label: LABELS[key],
        ...total(list),
        rows: list.slice(0, cap).map((t) => ({
          id: t.id,
          date: t.occurredOn,
          displayName: t.displayName,
          amount: money(-Number(t.amount)),
          pending: t.pending,
          card: cardRef(t),
          notes: [...(L.isUnfiled(t) ? ["not_filed"] : []), ...(!t.categoryId ? ["no_category"] : []), ...(t.pending ? ["pending"] : [])],
        })),
        truncated: list.length > cap,
      };
    })
    .filter((g) => g.count > 0);
  const weeklyRows = buys.filter((t) => t.weeklyAllowance);
  const monthlyRows = buys.filter((t) => t.monthlyAllowance);
  const open = buys.filter((t) => keyOf(t) === "no_bucket");
  const summaryCard = (c) => ({
    accountId: c.externalId,
    name: c.name,
    mask: c.mask,
    institution: c.institution,
    brand: c.brand,
    cadence: c.cadence,
    debtLinked: false,
    debtId: null,
    owed: money(L.CARD_OWED[c.externalId]),
    payoffMode: { mode: "in_full", source: "default", reason: "no_debt" },
    paidAs: paidAsOf(c),
    payDown,
    defaultMode,
    purchases: total(cardRows(c, from, through).filter(isPurchase)),
  });
  const hook = one ?? L.CARD_A;
  return {
    scope: {
      kind: one ? "card" : "all",
      accountId: one ? one.externalId : null,
      name: one ? one.name : null,
      mask: one ? one.mask : null,
      institution: one ? one.institution : null,
      cards: L.CARDS.map(summaryCard),
    },
    period: { from, to, timezone: TZ },
    owed: { tracked: null, current: money(owed), statement: money(owed), asOf: fx.SNAPSHOT_AT, source: "plaid" },
    purchases: { ...total(buys), reimbursable: total(buys.filter((t) => t.reimbursable)) },
    refunds: total(refunds),
    payments: total(payments),
    otherCredits: { amount: "0.00", count: 0 },
    otherCharges: { amount: "0.00", count: 0 },
    notMine: { amount: "0.00", count: 0 },
    householdContribution: {
      weeklyPlan: money(-sum(weeklyRows) - sum(refunds.filter((t) => t.weeklyAllowance))),
      weeklyKnown: money(-sum(weeklyRows) - sum(refunds.filter((t) => t.weeklyAllowance))),
      weeklyUnresolved: "0.00",
      monthlyPlan: money(-sum(monthlyRows)),
      monthlyKnown: money(-sum(monthlyRows)),
      monthlyUnresolved: "0.00",
      unfiled: money(-sum(open)),
      link: "/spending/week",
    },
    planLink: {
      kind: hook.cadence === "weekly" ? "weekly_hook" : "monthly_hook",
      payoff: money(L.CARD_OWED[hook.externalId]),
      payoffDate: hook.cadence === "weekly" ? "2026-11-16" : "2026-12-01",
      basis: "plan",
      debtId: null,
      name: `${hook.name} payoff`,
      minimum: null,
      avalancheRank: null,
      status: null,
    },
    needsAttention: { unplanned: group(unplanned), unfiled: group(unfiled), uncategorized: group(uncategorized), truncated: false },
    reconciliation: {
      purchases: total(buys),
      refunds: total(refunds),
      net: money(-sum(buys) - sum(refunds)),
      unresolved: total(open),
      ties: true,
      groups,
    },
    limitations: [],
  };
}

// ── the banking review ──────────────────────────────────────────────────────
const ZERO = { count: 0, moneyIn: "0.00", moneyOut: "0.00", net: "0.00", pendingNet: "0.00" };
const totals = (rows) => {
  const inn = sum(rows.filter((t) => Number(t.amount) > 0));
  const out = -sum(rows.filter((t) => Number(t.amount) < 0));
  return { count: rows.length, moneyIn: money(inn), moneyOut: money(out), net: money(inn - out), pendingNet: money(sum(rows.filter((t) => t.pending))) };
};
function kindOf(t) {
  if (t.isExternalCardPayment) return "card_payment";
  if (t.debtId || t.categoryId === "cat-debt") return "debt_payment";
  if (t.isTransfer) return "transfer";
  if (L.isIncome(t)) return "income";
  if (Number(t.amount) > 0) return "refund";
  return "spending";
}

/** GET /api/banking/review?account=&from=&to=&rowsPerBucket=&bucket=&kind=&cursor=&limit= */
export function bankingReview(q) {
  const from = q.get("from") || monthStart(TODAY);
  const to = q.get("to") || TODAY;
  const cap = Number(q.get("rowsPerBucket") ?? 25) || 25;
  const scope = L.scopeOf(q.get("account") || L.CHECKING.rowId);
  const acct = scope.accounts.length === 1 ? scope.accounts[0] : L.CHECKING;
  const planned = acct === L.CHECKING;
  const through = to > TODAY ? TODAY : to;
  const rows = L.ALL.filter((t) => t.plaidAccountId === acct.externalId && t.occurredOn >= from && t.occurredOn <= through);

  // The plan's occurrences in the range, each with what became of it.
  const plannedList = [];
  const place = new Map(); // txn id → { bucket, reason, plan }
  if (planned) {
    const occs = [];
    // A few days before the range too: a weekend's bill posts on the Monday inside it.
    for (const it of fx.ITEMS) for (const o of fx.expandItem(it, addDays(from, -6), to)) occs.push({ ...o, item: it });
    occs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label < b.label ? -1 : 1));
    for (const o of occs) {
      const key = `${o.itemId}|${o.date}`;
      const it = o.item;
      const direction = it.kind === "income" ? "in" : "out";
      const eventKind = it.kind === "income" ? "income" : it.debtId ? "debt" : "bill";
      // The row that paid it: the forecast's own match, or (history) the row the plan wrote.
      const res = fx.RESOLUTIONS.find((r) => r.recurringItemId === o.itemId && r.occurrenceDate === o.date && r.status === "matched");
      const assumed = fx.SPECIAL.assumedPaid.get(key);
      const histId = `txn-${it.id.slice(3)}-${o.date.slice(2).replace(/-/g, "")}`;
      const txn = L.byId(res?.matchedTxnId ?? assumed?.txnId ?? histId);
      let fate = "not_due";
      let outcome = "not_due";
      let carriedTo = null;
      if (txn) {
        fate = assumed ? "suggested" : "matched";
        outcome = assumed ? "suggested" : direction === "in" ? "received" : "paid";
      } else if (fx.SPECIAL.carried.has(key)) {
        fate = "carried";
        outcome = "carried";
        carriedTo = "2026-11-11";
      } else if (fx.SPECIAL.incomeNotArrived.has(key)) {
        fate = "income_not_arrived";
        outcome = "not_received_yet";
      } else if (fx.SPECIAL.older.has(key)) {
        fate = "overdue_outside";
        outcome = "not_paid_yet";
      } else if (fx.SPECIAL.missed.has(key)) {
        fate = "missed";
        outcome = "missed";
      } else if (o.date >= TODAY) {
        fate = "on_curve";
        outcome = "not_due";
      }
      const plannedAmt = o.amount;
      const diff = txn ? r2(Number(txn.amount) - plannedAmt) : null;
      const dayDelta = txn ? L.daysBetween(o.date, txn.occurredOn) : null;
      if (txn && diff !== 0 && outcome !== "suggested") outcome = direction === "in" ? "received_different" : "paid_different";
      const varianceKind = !txn || diff === 0 ? null : direction === "in" ? (diff < 0 ? "less_than_expected" : "more_than_expected") : diff < 0 ? "over_planned" : "under_planned";
      const plan = {
        key,
        label: it.name,
        scheduledDate: o.date,
        planned: money(plannedAmt),
        difference: diff == null ? null : money(diff),
        dayDelta,
        eventKind,
        direction,
        expected: money(Math.abs(plannedAmt)),
        actual: txn ? money(Math.abs(Number(txn.amount))) : null,
        variance: diff == null ? null : money(Math.abs(diff)),
        varianceKind,
      };
      if (o.date >= from) plannedList.push({
        key,
        itemId: o.itemId,
        label: it.name,
        scheduledDate: o.date,
        occurrenceDate: o.date,
        planned: money(plannedAmt),
        fate,
        txnId: txn?.id ?? null,
        txnDate: txn?.occurredOn ?? null,
        txnAmount: txn?.amount ?? null,
        txnOnThisAccount: !!txn,
        difference: plan.difference,
        dayDelta,
        remainder: null,
        onCurve: fate === "on_curve" || fate === "carried",
        hook: null,
        carriedTo,
        eventKind,
        direction,
        expected: plan.expected,
        actual: plan.actual,
        variance: plan.variance,
        varianceKind,
        outcome,
      });
      if (!txn) continue;
      if (assumed) place.set(txn.id, { bucket: "uncertain", reason: "suggested_match", plan });
      else if (diff !== 0) place.set(txn.id, { bucket: "amountDifference", reason: "amount", plan });
      else if (Math.abs(dayDelta) > 3) place.set(txn.id, { bucket: "timingDifference", reason: "timing", plan });
      else place.set(txn.id, { bucket: "asPlanned", reason: "as_planned", plan });
    }
  }
  for (const t of rows) {
    if (place.has(t.id)) continue;
    if (!planned) place.set(t.id, { bucket: "uncertain", reason: "not_compared", plan: null });
    else if (t.unplannedAllowance) place.set(t.id, { bucket: "confirmedUnplanned", reason: "marked_unplanned", plan: null });
    else if (t.reviewed === false && t.occurredOn >= "2026-11-08") place.set(t.id, { bucket: "uncertain", reason: "needs_review", plan: null });
    else place.set(t.id, { bucket: "unmatched", reason: "no_plan", plan: null });
  }
  const row = (t) => {
    const p = place.get(t.id);
    const kind = kindOf(t);
    return {
      id: t.id,
      date: t.occurredOn,
      displayName: t.displayName,
      description: t.description,
      amount: t.amount,
      pending: t.pending,
      manual: false,
      category: t.categoryId ? { id: t.categoryId, name: L.categoryName(t.categoryId) } : null,
      flags: {
        unplannedAllowance: t.unplannedAllowance,
        weeklyAllowance: t.weeklyAllowance,
        monthlyAllowance: t.monthlyAllowance,
        reimbursable: t.reimbursable,
        transfer: t.isTransfer,
        cardPayment: t.isExternalCardPayment,
      },
      kind,
      direction: Number(t.amount) > 0 ? "in" : "out",
      classificationIssue: null,
      reason: p.reason,
      evidence: p.reason === "as_planned" || p.reason === "amount" || p.reason === "timing" ? "confirmed" : null,
      rowEvidence:
        p.reason === "needs_review"
          ? { class: "unresolved", reason: "no_contrary_evidence", items: [], suggestion: null }
          : p.reason === "suggested_match"
            ? {
                class: "unresolved",
                reason: "bill_suggestion",
                items: [{ field: "bill_suggestion", value: p.plan.label }],
                suggestion: { kind: "bill", detail: null, target: { kind: "bill", id: p.plan.key.split("|")[0], label: p.plan.label, planKey: p.plan.key, occurrenceDate: p.plan.scheduledDate, planned: p.plan.planned, skipped: false } },
              }
            : null,
      plan: p.plan,
    };
  };
  const KINDS = ["spending", "card_payment", "debt_payment", "transfer", "income", "refund", "other"];
  const bucket = (name) => {
    const list = rows.filter((t) => place.get(t.id).bucket === name);
    const t = totals(list);
    const diffs = list.map((x) => place.get(x.id).plan).filter(Boolean);
    const vIn = sum(diffs.filter((p) => p.direction === "in"), (p) => Number(p.difference));
    const vOut = sum(diffs.filter((p) => p.direction === "out"), (p) => Number(p.difference));
    const reasons = (r) => totals(list.filter((x) => place.get(x.id).reason === r));
    return {
      ...t,
      rows: list.slice(0, cap).map(row),
      truncated: list.length > cap,
      differenceTotal: name === "amountDifference" ? money(vIn + vOut) : null,
      varianceIn: name === "amountDifference" && vIn !== 0 ? money(vIn) : null,
      varianceOut: name === "amountDifference" && vOut !== 0 ? money(vOut) : null,
      byKind: name === "unmatched" ? Object.fromEntries(KINDS.map((k) => [k, totals(list.filter((x) => kindOf(x) === k))])) : null,
      byReason:
        name === "uncertain"
          ? { needs_review: reasons("needs_review"), suggested_match: reasons("suggested_match"), not_compared: reasons("not_compared"), evidence_unresolved: { ...ZERO } }
          : null,
    };
  };
  const notInPlan = {
    amountDifference: bucket("amountDifference"),
    timingDifference: bucket("timingDifference"),
    confirmedUnplanned: bucket("confirmedUnplanned"),
    uncertain: bucket("uncertain"),
    unmatched: bucket("unmatched"),
  };
  const asPlannedRows = rows.filter((t) => place.get(t.id).bucket === "asPlanned");
  const flow = totals(rows);
  const todayBal = L.balanceAtEndOf(acct, TODAY);
  const sp = home.spine();

  // One bucket's own page (the "show more" call).
  let page = null;
  const bucketName = q.get("bucket");
  if (bucketName && notInPlan[bucketName]) {
    const kind = q.get("kind");
    const list = rows.filter((t) => place.get(t.id).bucket === bucketName && (!kind || kindOf(t) === kind));
    const start = Number(q.get("cursor") ?? 0) || 0;
    const limit = Number(q.get("limit") ?? 50) || 50;
    page = { bucket: bucketName, kind: kind || null, rows: list.slice(start, start + limit).map(row), nextCursor: start + limit < list.length ? String(start + limit) : null, limit };
  }
  const openCount = notInPlan.uncertain.count;
  return {
    dataAsOf: { snapshotAt: fx.SNAPSHOT_AT, computedAt: fx.COMPUTED_AT },
    account: { id: acct.rowId, institution: acct.institution, name: acct.name, mask: acct.mask, isForecastAccount: planned, lastSyncedAt: fx.SNAPSHOT_AT },
    period: { from, to, today: TODAY, timezone: TZ },
    balance: {
      today: money(todayBal),
      asOf: fx.SNAPSHOT_AT,
      reading: planned ? money(fx.READING) : money(todayBal),
      start: money(L.balanceAtEndOf(acct, addDays(from, -1))),
      end: money(L.balanceAtEndOf(acct, through)),
      unavailableReason: null,
    },
    freshness: { source: "plaid", fetchedAt: fx.SNAPSHOT_AT, lastContactAt: fx.SNAPSHOT_AT, lastFailureAt: null, stale: false, staleReason: null },
    cashFlow: { moneyIn: flow.moneyIn, moneyOut: flow.moneyOut, net: flow.net, count: flow.count, pendingNet: flow.pendingNet, pendingCount: rows.filter((t) => t.pending).length, supersededExcluded: 0, otherExcluded: 0 },
    planComparison: planned
      ? { available: true, reason: null, comparedFrom: from, plansFrom: from, through }
      : { available: false, reason: "not_forecast_account", comparedFrom: null, plansFrom: null, through: null },
    planned: plannedList,
    notInPlan,
    asPlanned: { count: asPlannedRows.length, net: money(sum(asPlannedRows)), pendingNet: "0.00", varianceIn: null, varianceOut: null, withoutPlanDetail: 0 },
    reconciliation: { rowsPlaced: rows.length, rowsUnexplained: 0, unexplained: "0.00" },
    reviewInbox: { unresolvedInRange: openCount, unresolvedScope: "this account · this period", unresolvedFrom: from, unresolvedTo: through, badgeCount: sp.reviewCount, badgeScope: "planned account · this month" },
    balanceTie: { status: "ties", checkedAt: fx.SNAPSHOT_AT, unexplained: "0.00" },
    balanceCheck: {
      status: planned ? "matches" : "not_checked",
      reason: planned ? null : "not_forecast_account",
      stale: false,
      staleReason: null,
      checkedAt: planned ? fx.SNAPSHOT_AT : null,
      bank: planned ? { balance: money(fx.READING), at: fx.SNAPSHOT_AT, field: "available" } : null,
      h2: planned ? { balance: money(fx.READING) } : null,
      difference: planned ? "0.00" : null,
      direction: null,
      lastDrift: planned ? { checkedAt: "2026-10-21T03:05:00.000Z", difference: "18.40", direction: "bank_lower" } : null,
    },
    household: {
      scope: "all accounts · this week",
      weekStart: weekStartOf(TODAY),
      weekEnd: addDays(weekStartOf(TODAY), 6),
      spentWeek: sp.position.knownWeek,
      weekPlan: money(WEEK_PLAN),
      remainingWeek: sp.position.remainingWeek,
      knownWeek: sp.position.knownWeek,
      unresolvedWeek: sp.position.unresolvedWeek,
      provisional: false,
      remainingWeekKnown: sp.position.remainingWeekKnown,
    },
    page,
  };
}
