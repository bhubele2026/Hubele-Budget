// Avalanche / Snowball payoff simulator. Pure functions ported from the
// original H2 codebase. Input: list of active debts + extra/mo + strategy.
// Output: full month-by-month payoff schedule.

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

export type SimMonth = {
  monthIndex: number;
  date: Date;
  totalInterest: number;
  totalMinsPaid: number;
  totalExtraPaid: number;
  activeTargetId: string | null;
  activeTargetName: string | null;
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

export type SimResult = {
  months: SimMonth[];
  monthsToFreedom: number;
  debtFreeDate: Date | null;
  totalInterestPaid: number;
  startingTotalBalance: number;
  startingTotalMin: number;
  killedOrder: DebtKill[];
  ranOutOfTime: boolean;
};

const CENTS = 0.005;
const MAX_MONTHS = 600;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function targetIndex(rows: { balance: number; apr: number }[], strat: Strategy): number {
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
    while (pool > CENTS) {
      const idx = targetIndex(work, opts.strategy);
      if (idx === -1) break;
      if (activeTargetId === null) {
        activeTargetId = work[idx].id;
        activeTargetName = work[idx].name;
      }
      const d = work[idx];
      const pay = Math.min(pool, d.balance);
      d.balance = round2(d.balance - pay);
      pool = round2(pool - pay);
      monthExtra += pay;
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

    months.push({
      monthIndex: m,
      date,
      totalInterest: round2(monthInterest),
      totalMinsPaid: round2(monthMins),
      totalExtraPaid: round2(monthExtra),
      activeTargetId,
      activeTargetName,
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

  return {
    months,
    monthsToFreedom,
    debtFreeDate,
    totalInterestPaid,
    startingTotalBalance,
    startingTotalMin,
    killedOrder,
    ranOutOfTime,
  };
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

export function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function fmtMoneyCompact(n: number): string {
  if (Math.abs(n) >= 10000) {
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  }
  return fmtMoney(n);
}

export function fmtMonth(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", year: "numeric" });
}

export function fmtPct(p: number, digits = 2): string {
  return `${(p * 100).toFixed(digits)}%`;
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
