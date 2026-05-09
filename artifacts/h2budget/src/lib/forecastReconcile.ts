import { isBankTxn, monthKey, type BankLine, type PlanLine } from "./forecastMatch";

export type ReconcileContributor = {
  kind: "matched" | "starting";
  label: string;
  delta: number;
  planKey?: string;
};

export type ReconcileResult = {
  pending: number;
  matched: number;
  unplanned: number;
  gap: number;
  total: number;
  forecastEnd: number;
  bankEnd: number;
  hasBank: boolean;
  isPriorMonth: boolean;
  matchedAmountDelta: number;
  startingBalanceDelta: number;
  contributors: ReconcileContributor[];
  largestContributor: ReconcileContributor | null;
};

export type ReconcileInput = {
  allBank: BankLine[];
  allPlan: PlanLine[];
  bankSnapshot: { at: string; balance: number | string } | null | undefined;
  settingsStartingBalance: number | string;
  fromDate: string;
  monthFilter: string;
  checkingPlaidAccountIds: Set<string>;
};

export const EMPTY_RECONCILE: ReconcileResult = {
  pending: 0,
  matched: 0,
  unplanned: 0,
  gap: 0,
  total: 0,
  forecastEnd: 0,
  bankEnd: 0,
  hasBank: false,
  isPriorMonth: false,
  matchedAmountDelta: 0,
  startingBalanceDelta: 0,
  contributors: [],
  largestContributor: null,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Reconcile the forecast against the live bank snapshot for the selected
 * month. See the long comment block in `forecast.tsx` (above the original
 * `bankReconcile` memo) for the full semantic rationale; the short
 * version:
 *
 *  - `forecastEnd` projects the bank snapshot balance forward by Σ planned
 *    items in (snapshot.at, end-of-month] that haven't been resolved.
 *  - `gap` is a like-for-like comparison of the forecast's projected
 *    balance AS OF the bank snapshot date vs the bank snapshot balance,
 *    decomposed into named contributors (matched-amount drift +
 *    starting-balance drift) and reported as Σ |delta| so signed
 *    over/undershoots can't cancel.
 */
export function computeBankReconcile(input: ReconcileInput): ReconcileResult {
  const {
    allBank,
    allPlan,
    bankSnapshot,
    settingsStartingBalance,
    fromDate,
    monthFilter,
    checkingPlaidAccountIds,
  } = input;

  let pending = 0;
  let matched = 0;
  let unplanned = 0;
  for (const b of allBank) {
    if (!isBankTxn(b.txn, checkingPlaidAccountIds)) continue;
    if (monthKey(b.date) !== monthFilter) continue;
    if (b.status === "pending_bank") pending += 1;
    else if (b.status === "matched") matched += 1;
    else if (b.status === "ignored_unforecasted") unplanned += 1;
  }

  const snapshotAtISO = bankSnapshot?.at ? bankSnapshot.at.slice(0, 10) : null;
  const startBal = bankSnapshot
    ? Number(bankSnapshot.balance) || 0
    : Number(settingsStartingBalance) || 0;

  const endOfMonthISO = `${monthFilter}-31`;
  const isPriorMonth = !!snapshotAtISO && endOfMonthISO < snapshotAtISO;

  let forecastEnd = startBal;
  if (!isPriorMonth) {
    for (const p of allPlan) {
      if (snapshotAtISO && p.date <= snapshotAtISO) continue;
      if (p.date > endOfMonthISO) continue;
      if (p.status === "matched" || p.status === "missed") continue;
      forecastEnd += p.amount;
    }
    forecastEnd = round2(forecastEnd);
  }

  const bankEnd = bankSnapshot
    ? Number(bankSnapshot.balance) || 0
    : forecastEnd;

  const settingsStart = Number(settingsStartingBalance) || 0;
  let forecastAtSnapshot = settingsStart;
  if (snapshotAtISO) {
    for (const p of allPlan) {
      if (p.date < fromDate || p.date > snapshotAtISO) continue;
      if (p.status === "missed") continue;
      forecastAtSnapshot += p.amount;
    }
    for (const b of allBank) {
      if (b.date < fromDate || b.date > snapshotAtISO) continue;
      if (b.status === "ignored_unforecasted") {
        forecastAtSnapshot += b.amount;
      }
    }
    forecastAtSnapshot = round2(forecastAtSnapshot);
  }
  const bankAtSnapshot = bankSnapshot
    ? Number(bankSnapshot.balance) || 0
    : forecastAtSnapshot;
  const rawGap = round2(forecastAtSnapshot - bankAtSnapshot);

  const contributors: ReconcileContributor[] = [];
  let matchedAmountDelta = 0;
  if (snapshotAtISO) {
    const bankByTxnId = new Map<string, BankLine>();
    for (const b of allBank) bankByTxnId.set(b.txn.id, b);
    for (const p of allPlan) {
      if (p.status !== "matched" || !p.matchedTxnId) continue;
      if (p.date < fromDate || p.date > snapshotAtISO) continue;
      const bank = bankByTxnId.get(p.matchedTxnId);
      if (!bank) continue;
      const delta = round2(p.amount - bank.amount);
      if (Math.abs(delta) >= 0.01) {
        matchedAmountDelta += delta;
        contributors.push({
          kind: "matched",
          label: `${p.label} on ${p.date} (plan ${p.amount.toFixed(2)} vs bank ${bank.amount.toFixed(2)})`,
          delta,
          planKey: `${p.itemId}|${p.date}`,
        });
      }
    }
    matchedAmountDelta = round2(matchedAmountDelta);
  }
  const startingBalanceDelta = round2(rawGap - matchedAmountDelta);
  if (bankSnapshot && Math.abs(startingBalanceDelta) >= 0.01) {
    contributors.push({
      kind: "starting",
      label: `Starting balance vs bank snapshot (off by ${startingBalanceDelta.toFixed(2)})`,
      delta: startingBalanceDelta,
    });
  }
  contributors.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const largestContributor = contributors[0] ?? null;

  const gap = round2(
    contributors.reduce((sum, c) => sum + Math.abs(c.delta), 0),
  );

  return {
    pending,
    matched,
    unplanned,
    gap,
    total: pending + matched + unplanned,
    forecastEnd,
    bankEnd,
    hasBank: !!bankSnapshot,
    isPriorMonth,
    matchedAmountDelta,
    startingBalanceDelta,
    contributors,
    largestContributor,
  };
}
