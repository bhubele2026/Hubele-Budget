// Avalanche / Snowball payoff simulator. Pure functions ported from the
// original H2 codebase. Input: list of active debts + extra/mo + strategy.
// Output: full month-by-month payoff schedule.
//
// This is the single isomorphic math engine shared by the client
// (artifacts/h2budget/src/lib/avalanche.ts re-exports it) and the server
// (artifacts/api-server/src/lib/avalancheSim.ts reuses simulate/targetIndex).
// Keep it framework-free: no Intl, no DOM, money stays as numbers here.

export type Strategy = "avalanche" | "snowball";

export type SimDebt = {
  id: string;
  name: string;
  apr: number;
  balance: number;
  minPayment: number;
  status?: string;
};

export type SimDebtSnapshot = {
  id: string;
  name: string;
  startBalance: number;
  endBalance: number;
  interest: number;
  minPaid: number;
  extraPaid: number;
  paidOffThisMonth: boolean;
};

export type SimMonthTarget = {
  id: string;
  name: string;
  extraPaid: number;
  killedThisMonth: boolean;
};

export type SimMonth = {
  monthIndex: number;
  date: Date;
  totalInterest: number;
  totalMinsPaid: number;
  totalExtraPaid: number;
  // Back-compat: the FIRST debt that received extra this month (or null
  // when there was no extra). Prefer `targets` for new code.
  activeTargetId: string | null;
  activeTargetName: string | null;
  // Every debt that received extra this month, in the order extra
  // cascaded into them. Empty when there was no extra to spill.
  targets: SimMonthTarget[];
  totalBalanceEnd: number;
  pctPaidOff: number;
  killedThisMonth: { id: string; name: string; apr: number; minFreed: number }[];
  perDebt: SimDebtSnapshot[];
};

export type DebtKill = {
  id: string;
  name: string;
  apr: number;
  minFreed: number;
  date: Date;
  monthIndex: number;
};

export type UnderwaterDebt = {
  id: string;
  name: string;
  apr: number;
  balance: number;
  minPayment: number;
  monthlyInterest: number;
  shortfallPerMonth: number;
};

export type SimResult = {
  months: SimMonth[];
  monthsToFreedom: number;
  debtFreeDate: Date | null;
  totalInterestPaid: number;
  startingTotalBalance: number;
  startingTotalMin: number;
  killedOrder: DebtKill[];
  ranOutOfTime: boolean;
  underwater: UnderwaterDebt[];
};

export const CENTS = 0.005;
export const MAX_MONTHS = 600;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function targetIndex(rows: { balance: number; apr: number }[], strat: Strategy): number {
  let bestIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.balance <= CENTS) continue;
    if (bestIdx === -1) { bestIdx = i; continue; }
    const best = rows[bestIdx];
    if (strat === "avalanche") {
      if (r.apr > best.apr || (r.apr === best.apr && r.balance < best.balance)) bestIdx = i;
    } else {
      if (r.balance < best.balance || (r.balance === best.balance && r.apr > best.apr)) bestIdx = i;
    }
  }
  return bestIdx;
}

// A debt is "underwater" when its monthly interest exceeds its minimum
// payment, so minimums alone will never pay it off. Computed from initial
// state, independent of whether the full plan converges.
export function identifyUnderwater(debts: SimDebt[]): UnderwaterDebt[] {
  const out: UnderwaterDebt[] = [];
  for (const d of debts) {
    if ((d.status ?? "active") !== "active") continue;
    if (!Number.isFinite(d.balance) || d.balance <= CENTS) continue;
    const apr = Number.isFinite(d.apr) ? d.apr : 0;
    if (apr <= 0) continue;
    const monthlyInterest = round2(d.balance * (apr / 12));
    const minPayment = Number.isFinite(d.minPayment) ? d.minPayment : 0;
    const shortfall = round2(monthlyInterest - minPayment);
    if (shortfall <= 0) continue;
    out.push({
      id: d.id,
      name: d.name,
      apr: d.apr,
      balance: d.balance,
      minPayment: d.minPayment,
      monthlyInterest,
      shortfallPerMonth: shortfall,
    });
  }
  return out;
}

export function simulate(opts: {
  debts: SimDebt[];
  extraPerMonth: number;
  strategy: Strategy;
  startDate?: Date;
}): SimResult {
  const startDate =
    opts.startDate ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const extra = Math.max(0, opts.extraPerMonth || 0);

  const work = opts.debts
    .filter((d) => (d.status ?? "active") === "active" && d.balance > CENTS)
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: d.apr,
      balance: d.balance,
      minPayment: d.minPayment,
    }));

  const startingTotalBalance = round2(work.reduce((s, d) => s + d.balance, 0));
  const startingTotalMin = round2(work.reduce((s, d) => s + d.minPayment, 0));

  const months: SimMonth[] = [];
  const killedOrder: DebtKill[] = [];
  let totalInterestPaid = 0;

  for (let m = 1; m <= MAX_MONTHS; m++) {
    const remaining = work.filter((d) => d.balance > CENTS);
    if (remaining.length === 0) break;

    const date = new Date(startDate.getFullYear(), startDate.getMonth() + (m - 1), 1);

    let monthInterest = 0;
    const perDebt: SimDebtSnapshot[] = [];
    for (const d of work) {
      if (d.balance <= CENTS) {
        perDebt.push({
          id: d.id, name: d.name,
          startBalance: 0, endBalance: 0, interest: 0,
          minPaid: 0, extraPaid: 0, paidOffThisMonth: false,
        });
        continue;
      }
      const startBal = d.balance;
      const interest = round2(startBal * (d.apr / 12));
      d.balance = round2(startBal + interest);
      monthInterest += interest;
      perDebt.push({
        id: d.id, name: d.name,
        startBalance: startBal, endBalance: d.balance, interest,
        minPaid: 0, extraPaid: 0, paidOffThisMonth: false,
      });
    }

    let monthMins = 0;
    let pool = extra;
    for (let i = 0; i < work.length; i++) {
      const d = work[i];
      if (d.balance <= CENTS) {
        pool += d.minPayment;
        continue;
      }
      const pay = Math.min(d.minPayment, d.balance);
      d.balance = round2(d.balance - pay);
      monthMins += pay;
      perDebt[i].minPaid = pay;
      perDebt[i].endBalance = d.balance;
    }

    let monthExtra = 0;
    let activeTargetId: string | null = null;
    let activeTargetName: string | null = null;
    const targetOrder: { id: string; name: string }[] = [];
    const extraByTarget = new Map<string, number>();
    while (pool > CENTS) {
      const idx = targetIndex(work, opts.strategy);
      if (idx === -1) break;
      const d = work[idx];
      if (!extraByTarget.has(d.id)) {
        targetOrder.push({ id: d.id, name: d.name });
        extraByTarget.set(d.id, 0);
      }
      if (activeTargetId === null) {
        activeTargetId = d.id;
        activeTargetName = d.name;
      }
      const pay = Math.min(pool, d.balance);
      d.balance = round2(d.balance - pay);
      pool = round2(pool - pay);
      monthExtra += pay;
      extraByTarget.set(d.id, round2((extraByTarget.get(d.id) ?? 0) + pay));
      perDebt[idx].extraPaid = round2(perDebt[idx].extraPaid + pay);
      perDebt[idx].endBalance = d.balance;
    }

    const killedThisMonth: SimMonth["killedThisMonth"] = [];
    for (let i = 0; i < work.length; i++) {
      const d = work[i];
      const wasAliveAtMonthStart = perDebt[i].startBalance > CENTS;
      const alreadyKilled = killedOrder.some((k) => k.id === d.id);
      if (wasAliveAtMonthStart && d.balance <= CENTS && !alreadyKilled) {
        perDebt[i].paidOffThisMonth = true;
        const entry: DebtKill = {
          id: d.id, name: d.name, apr: d.apr,
          minFreed: d.minPayment, date, monthIndex: m,
        };
        killedOrder.push(entry);
        killedThisMonth.push({ id: entry.id, name: entry.name, apr: entry.apr, minFreed: entry.minFreed });
      }
    }

    const totalBalanceEnd = round2(work.reduce((s, d) => s + d.balance, 0));
    totalInterestPaid = round2(totalInterestPaid + monthInterest);

    const targets: SimMonthTarget[] = targetOrder.map((t) => ({
      id: t.id,
      name: t.name,
      extraPaid: extraByTarget.get(t.id) ?? 0,
      killedThisMonth: killedThisMonth.some((k) => k.id === t.id),
    }));

    months.push({
      monthIndex: m,
      date,
      totalInterest: round2(monthInterest),
      totalMinsPaid: round2(monthMins),
      totalExtraPaid: round2(monthExtra),
      activeTargetId,
      activeTargetName,
      targets,
      totalBalanceEnd,
      pctPaidOff: startingTotalBalance > 0
        ? Math.max(0, Math.min(1, 1 - totalBalanceEnd / startingTotalBalance))
        : 1,
      killedThisMonth,
      perDebt,
    });

    if (totalBalanceEnd <= CENTS) break;
  }

  const last = months[months.length - 1];
  const ranOutOfTime = months.length === MAX_MONTHS && (last?.totalBalanceEnd ?? 0) > CENTS;
  const monthsToFreedom = ranOutOfTime ? Infinity : months.length;
  const debtFreeDate = ranOutOfTime || months.length === 0 ? null : last.date;

  const underwater = identifyUnderwater(opts.debts);

  return {
    months,
    monthsToFreedom,
    debtFreeDate,
    totalInterestPaid,
    startingTotalBalance,
    startingTotalMin,
    killedOrder,
    ranOutOfTime,
    underwater,
  };
}

// Runs `simulate`; if it hits MAX_MONTHS and some (but not all) debts are
// underwater, re-runs on the solvable subset so callers get finite numbers.
// The full underwater list is re-attached for banners/captions.
export function simulateWithSolvableFallback(opts: {
  debts: SimDebt[];
  extraPerMonth: number;
  strategy: Strategy;
  startDate?: Date;
}): {
  sim: SimResult;
  usingSolvableSubset: boolean;
  effectiveDebts: SimDebt[];
  excludedUnderwaterCount: number;
} {
  const rawSim = simulate(opts);
  const underwaterIds = new Set(rawSim.underwater.map((u) => u.id));
  const activeCount = opts.debts.filter(
    (d) => (d.status ?? "active") === "active",
  ).length;
  const usingSolvableSubset =
    rawSim.ranOutOfTime &&
    underwaterIds.size > 0 &&
    underwaterIds.size < activeCount;
  if (!usingSolvableSubset) {
    return {
      sim: rawSim,
      usingSolvableSubset: false,
      effectiveDebts: opts.debts,
      excludedUnderwaterCount: 0,
    };
  }
  const effectiveDebts = opts.debts.filter((d) => !underwaterIds.has(d.id));
  const fallback = simulate({ ...opts, debts: effectiveDebts });
  return {
    sim: { ...fallback, underwater: rawSim.underwater },
    usingSolvableSubset: true,
    effectiveDebts,
    excludedUnderwaterCount: rawSim.underwater.length,
  };
}

// Minimums-only sim: each debt pays exactly its own min every month, with
// no cascade of freed minimums into the next debt. Returns the same shape
// as `simulate`.
export function simulateMinimumsOnly(opts: {
  debts: SimDebt[];
  strategy: Strategy;
  startDate?: Date;
}): SimResult {
  const startDate =
    opts.startDate ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const work = opts.debts
    .filter((d) => (d.status ?? "active") === "active" && d.balance > CENTS)
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: d.apr,
      balance: d.balance,
      minPayment: d.minPayment,
    }));
  const startingTotalBalance = round2(work.reduce((s, d) => s + d.balance, 0));
  const startingTotalMin = round2(work.reduce((s, d) => s + d.minPayment, 0));
  const months: SimMonth[] = [];
  const killedOrder: DebtKill[] = [];
  let totalInterestPaid = 0;

  for (let m = 1; m <= MAX_MONTHS; m++) {
    const remaining = work.filter((d) => d.balance > CENTS);
    if (remaining.length === 0) break;
    const date = new Date(startDate.getFullYear(), startDate.getMonth() + (m - 1), 1);

    let monthInterest = 0;
    let monthMins = 0;
    const perDebt: SimDebtSnapshot[] = [];
    for (const d of work) {
      if (d.balance <= CENTS) {
        perDebt.push({
          id: d.id, name: d.name,
          startBalance: 0, endBalance: 0, interest: 0,
          minPaid: 0, extraPaid: 0, paidOffThisMonth: false,
        });
        continue;
      }
      const startBal = d.balance;
      const interest = round2(startBal * (d.apr / 12));
      let bal = round2(startBal + interest);
      monthInterest += interest;
      const pay = Math.min(d.minPayment, bal);
      bal = round2(bal - pay);
      monthMins += pay;
      d.balance = bal;
      perDebt.push({
        id: d.id, name: d.name,
        startBalance: startBal, endBalance: bal, interest,
        minPaid: pay, extraPaid: 0, paidOffThisMonth: false,
      });
    }

    const killedThisMonth: SimMonth["killedThisMonth"] = [];
    for (let i = 0; i < work.length; i++) {
      const d = work[i];
      const wasAliveAtMonthStart = perDebt[i].startBalance > CENTS;
      const alreadyKilled = killedOrder.some((k) => k.id === d.id);
      if (wasAliveAtMonthStart && d.balance <= CENTS && !alreadyKilled) {
        perDebt[i].paidOffThisMonth = true;
        const entry: DebtKill = {
          id: d.id, name: d.name, apr: d.apr,
          minFreed: d.minPayment, date, monthIndex: m,
        };
        killedOrder.push(entry);
        killedThisMonth.push({ id: entry.id, name: entry.name, apr: entry.apr, minFreed: entry.minFreed });
      }
    }

    const totalBalanceEnd = round2(work.reduce((s, d) => s + d.balance, 0));
    totalInterestPaid = round2(totalInterestPaid + monthInterest);
    months.push({
      monthIndex: m,
      date,
      totalInterest: round2(monthInterest),
      totalMinsPaid: round2(monthMins),
      totalExtraPaid: 0,
      activeTargetId: null,
      activeTargetName: null,
      targets: [],
      totalBalanceEnd,
      pctPaidOff: startingTotalBalance > 0
        ? Math.max(0, Math.min(1, 1 - totalBalanceEnd / startingTotalBalance))
        : 1,
      killedThisMonth,
      perDebt,
    });
    if (totalBalanceEnd <= CENTS) break;
  }

  const last = months[months.length - 1];
  const ranOutOfTime = months.length === MAX_MONTHS && (last?.totalBalanceEnd ?? 0) > CENTS;
  const monthsToFreedom = ranOutOfTime ? Infinity : months.length;
  const debtFreeDate = ranOutOfTime || months.length === 0 ? null : last.date;
  const underwater = identifyUnderwater(opts.debts);

  return {
    months,
    monthsToFreedom,
    debtFreeDate,
    totalInterestPaid,
    startingTotalBalance,
    startingTotalMin,
    killedOrder,
    ranOutOfTime,
    underwater,
  };
}

// Smallest monthly extra (dollars) that pays off all active debts within
// `maxMonths` using `strategy`. Returns null when no amount works.
export function findExtraForPayoff(
  debts: SimDebt[],
  strategy: Strategy,
  maxMonths = 60,
): number | null {
  const active = debts.filter((d) => (d.status ?? "active") === "active" && d.balance > CENTS);
  if (active.length === 0) return 0;
  const totalBalance = active.reduce((s, d) => s + d.balance, 0);
  // Upper bound: pay off everything in one month at most.
  let lo = 0;
  let hi = Math.max(totalBalance, 1000);
  // Sanity: try the upper bound first.
  const top = simulate({ debts, extraPerMonth: hi, strategy });
  if (top.ranOutOfTime || top.monthsToFreedom > maxMonths) {
    // Even paying off the entire balance in a month isn't enough? unlikely.
    return Math.ceil(hi);
  }
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const r = simulate({ debts, extraPerMonth: mid, strategy });
    if (r.ranOutOfTime || r.monthsToFreedom > maxMonths) lo = mid;
    else hi = mid;
    if (hi - lo < 25) break;
  }
  return Math.ceil(hi / 25) * 25;
}

export function monthsIfMinOnly(debt: SimDebt): number | null {
  const r = debt.apr / 12;
  const P = debt.balance;
  const M = debt.minPayment;
  if (P <= 0) return 0;
  if (M <= 0) return null;
  if (r <= 0) return Math.ceil(P / M);
  if (M <= P * r) return null;
  const n = -Math.log(1 - (r * P) / M) / Math.log(1 + r);
  return Math.ceil(n);
}

export function interestIfMinOnly(debt: SimDebt): number | null {
  const months = monthsIfMinOnly(debt);
  if (months === null) return null;
  return round2(months * debt.minPayment - debt.balance);
}

export function dailyInterest(debt: SimDebt): number {
  return round2((debt.balance * debt.apr) / 365);
}

export function sortDebts<T extends SimDebt>(debts: T[], strat: Strategy): T[] {
  return [...debts].sort((a, b) => {
    if (strat === "avalanche") {
      if (b.apr !== a.apr) return b.apr - a.apr;
      return a.balance - b.balance;
    }
    if (a.balance !== b.balance) return a.balance - b.balance;
    return b.apr - a.apr;
  });
}

// ── The debt-balance basis ──────────────────────────────────────────────────

/**
 * ⭐ THE ONE DEBT-BALANCE BASIS FOR THE WHOLE PRODUCT — CLIENT *AND* SERVER.
 *
 * ⚠️ THIS IS A MOVE, NOT A NEW CALCULATION. The body is the #421 helper
 * verbatim, which shipped file-local inside `pages/avalanche.tsx`, moved to
 * `artifacts/h2budget/src/lib/debtBalance.ts` in C3, and lands here in C10.
 * Each move widened who could reach it; nothing changed what it computes.
 *
 * It lives in `avalanche-core` — not in the web app, not in an api-server lib —
 * because this package is already the single isomorphic math engine both sides
 * import (see the file header, and `payoffPct` below). A copy on each side
 * would agree the day it was written and drift the first time one was edited;
 * that drift is the exact bug this PR closes. The client's
 * `lib/debtBalance.ts` now re-exports these, so "one implementation on the
 * client and one on the server" is satisfied by there being **one, shared**.
 *
 * Brad's call (2026-08-23): **net the pending payments everywhere.**
 *
 * ⚠️ STRUCTURAL, NOT NOMINAL, TYPES. A caller may hand us an API `Debt`
 * (strings, `pendingPaymentTotal` present) or a raw Drizzle debt row (no such
 * column). A row that cannot carry pending simply nets zero and returns its
 * reported balance — the same number it returned before — so passing an
 * un-enriched row is safe, merely un-netted. Server callers that want the
 * netting must enrich first (`lib/debtPending.ts`).
 */
export type PendingAwareDebt = {
  balance: number | string;
  pendingPaymentTotal?: number | string | null;
};

/**
 * The portion of a debt's reported balance the user has already paid but the
 * creditor has not reported yet.
 */
export function pendingPaymentTotalOf(d: PendingAwareDebt): number {
  return d.pendingPaymentTotal != null ? Number(d.pendingPaymentTotal) || 0 : 0;
}

/**
 * (#421) Tagged checking-account payments to a debt show up immediately even
 * before the creditor reports the new balance via Plaid. We subtract any
 * pendingPaymentTotal from the reported balance so the avalanche math, the
 * totals, and the projected payoff dates reflect what the user has already
 * paid — clamped at zero so a tagging mistake can't push the balance below 0.
 */
export function effectiveDebtBalance(d: PendingAwareDebt): number {
  const reported = Number(d.balance) || 0;
  const pending = pendingPaymentTotalOf(d);
  return Math.max(0, reported - pending);
}

// ── Payoff progress ─────────────────────────────────────────────────────────

/**
 * ⭐ THE ONE NUMBER THE LANDING IS ALLOWED TO SHOW, AND ITS ONLY DEFINITION.
 *
 * ⚠️ THIS IS A MOVE, NOT A NEW CALCULATION. Every line below is the expression
 * that already shipped in `artifacts/h2budget/src/pages/landing.tsx`
 * (`AvalancheTile.overallPaid` — the "% paid" the Future Goal tile has been
 * rendering), lifted here verbatim so the server can serve it on `/api/spine`
 * without the client fetching every debt BALANCE just to derive a percentage.
 * The standing rule is that no landing-facing surface may carry an amount owed;
 * the only way to honour that AND keep the number is to compute the ratio where
 * the balances already live and ship only the ratio.
 *
 * ⚠️ `min(balance, originalBalance)`, NOT `original - balance`. A balance can
 * exceed its own anchor — a card charged back up past the peak we recorded, or
 * an anchor captured after the debt had already been paid down. Subtracting raw
 * would hand back a NEGATIVE contribution and let one misbehaving card drag the
 * household's progress below where it truly is. Clamping per debt keeps every
 * debt's contribution inside [0, original].
 *
 * ⚠️ DEBTS WITH NO ANCHOR ARE EXCLUDED FROM BOTH SIDES OF THE RATIO, not
 * counted as 0% paid. A debt we have no "original" for is unknown, not
 * unstarted, and treating it as unstarted would understate real progress.
 *
 * ⚠️ (C10) THE BALANCE SIDE IS THE **NETTED** BALANCE. A payment you have
 * already made and tagged counts as progress the moment you tag it, not weeks
 * later when the creditor gets around to reporting it — that is Brad's
 * 2026-08-23 call, applied here so the landing's "% paid" and the Avalanche
 * hero (both of which read this one number off the spine) move the moment a
 * payment is recorded. Callers must pass rows carrying `pendingPaymentTotal`
 * to get the netting; a row without it nets zero and behaves exactly as before.
 *
 * Returns percent in [0, 100] (NOT a 0–1 fraction), or `null` when no debt
 * carries an anchor — `null` means "nothing to show", never "0% paid".
 */
export function payoffPct(
  debts: Array<
    PendingAwareDebt & {
      originalBalance?: number | string | null;
      status?: string | null;
    }
  >,
): number | null {
  // `status !== "paid_off"` — the landing's own filter. A retired debt must not
  // keep inflating the numerator forever after it is gone.
  const active = debts.filter((d) => d.status !== "paid_off");
  let sumOrig = 0;
  let sumBal = 0;
  for (const d of active) {
    const bal = effectiveDebtBalance(d);
    const orig = Number(d.originalBalance ?? 0) || 0;
    if (orig > 0) {
      sumOrig += orig;
      sumBal += Math.min(bal, orig);
    }
  }
  if (sumOrig <= 0) return null;
  return Math.max(0, Math.min(1, (sumOrig - sumBal) / sumOrig)) * 100;
}
