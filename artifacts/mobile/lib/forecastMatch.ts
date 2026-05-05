import type { CashEvent } from "./forecast-types";

export type Transaction = {
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  forecastFlag: boolean;
  categoryId?: string | null;
  source?: string;
  plaidAccountId?: string | null;
};

/** True if a transaction belongs to a bank/checking-style account. */
export function isBankTxn(
  txn: Pick<Transaction, "source" | "plaidAccountId">,
  checkingPlaidAccountIds: Set<string>,
): boolean {
  const s = (txn.source ?? "manual").toLowerCase();
  if (txn.plaidAccountId) {
    return checkingPlaidAccountIds.has(txn.plaidAccountId);
  }
  if (s === "amex" || s === "plaid:amex") return false;
  if (s.startsWith("plaid:")) return false;
  return true;
}

export function filterForecastTxns<
  T extends Pick<Transaction, "forecastFlag" | "source" | "plaidAccountId">,
>(txns: T[], checkingPlaidAccountIds: Set<string>): T[] {
  return txns.filter(
    (t) => t.forecastFlag && isBankTxn(t, checkingPlaidAccountIds),
  );
}

export type Resolution = {
  id: string;
  recurringItemId: string | null;
  occurrenceDate: string | null;
  status: string;
  matchedTxnId: string | null;
  rescheduledTo?: string | null;
  txnDate?: string | null;
  txnDescription?: string | null;
  txnAmount?: string | null;
  txnForecastFlag?: boolean | null;
};

export type PlanLineStatus = "pending_plan" | "matched" | "missed" | "future";
export type BankLineStatus =
  | "pending_bank"
  | "matched"
  | "ignored_unforecasted";

export type PlanLine = {
  kind: "plan";
  date: string;
  itemId: string;
  label: string;
  amount: number;
  status: PlanLineStatus;
  resolutionId?: string;
  matchedTxnId?: string | null;
  originalDate?: string;
};

export type BankLine = {
  kind: "bank";
  date: string;
  txn: Transaction;
  amount: number;
  status: BankLineStatus;
  resolutionId?: string;
};

export type LineRow = (PlanLine | BankLine) & { runningBalance?: number };

const DAY = 86_400_000;

function parseISO(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function monthKey(iso: string) {
  return iso.slice(0, 7);
}

function txnSigned(t: Transaction): number {
  return Number(t.amount) || 0;
}

export function buildLineRegister(opts: {
  events: CashEvent[];
  txns: Transaction[];
  resolutions: Resolution[];
  closedMonths: Set<string>;
  startBalance: number;
  fromISO: string;
  toISO: string;
  today?: Date;
  snapshotISO?: string | null;
}): { rows: LineRow[]; allPlan: PlanLine[]; allBank: BankLine[] } {
  const {
    events,
    txns,
    resolutions,
    closedMonths,
    startBalance,
    fromISO,
    toISO,
    snapshotISO,
  } = opts;
  const today = opts.today ?? new Date();
  const todayMs = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const fromMs = parseISO(fromISO);
  const toMs = parseISO(toISO);
  const anchorMs = snapshotISO ? parseISO(snapshotISO) : null;

  const byEventKey = new Map<string, Resolution>();
  const byTxn = new Map<string, Resolution>();
  for (const r of resolutions) {
    if (r.recurringItemId && r.occurrenceDate) {
      byEventKey.set(`${r.recurringItemId}|${r.occurrenceDate}`, r);
    }
    if (r.matchedTxnId) byTxn.set(r.matchedTxnId, r);
  }

  const allPlan: PlanLine[] = events.map((ev) => {
    const origKey = `${ev.itemId}|${ev.date}`;
    const origRes = byEventKey.get(origKey);
    let date = ev.date;
    let stored: Resolution | undefined = origRes;
    if (origRes?.status === "rescheduled" && origRes.rescheduledTo) {
      date = origRes.rescheduledTo;
      const atNew = byEventKey.get(`${ev.itemId}|${date}`);
      if (atNew && atNew.id !== origRes.id) stored = atNew;
    }
    const evMs = parseISO(date);
    let status: PlanLineStatus;
    if (stored?.status === "matched") status = "matched";
    else if (stored?.status === "missed" || stored?.status === "dismissed")
      status = "missed";
    else if (evMs > todayMs) status = "future";
    else status = "pending_plan";
    return {
      kind: "plan" as const,
      date,
      itemId: ev.itemId,
      label: ev.label,
      amount: ev.amount,
      status,
      resolutionId: stored?.id,
      matchedTxnId: stored?.matchedTxnId ?? null,
      originalDate: date !== ev.date ? ev.date : undefined,
    };
  });

  const allBank: BankLine[] = txns.map((t) => {
    const stored = byTxn.get(t.id);
    let status: BankLineStatus;
    if (stored?.status === "matched") status = "matched";
    else if (
      stored?.status === "ignored_unforecasted" ||
      stored?.status === "unplanned"
    )
      status = "ignored_unforecasted";
    else status = "pending_bank";
    return {
      kind: "bank" as const,
      date: t.occurredOn,
      txn: t,
      amount: txnSigned(t),
      status,
      resolutionId: stored?.id,
    };
  });

  const isHiddenByClosedMonth = (iso: string, isResolved: boolean) =>
    isResolved && closedMonths.has(monthKey(iso));

  const activePlan = allPlan.filter(
    (p) =>
      (p.status === "pending_plan" || p.status === "future") &&
      !isHiddenByClosedMonth(p.date, false),
  );
  const activeBank = allBank.filter(
    (b) => b.status === "pending_bank" && !isHiddenByClosedMonth(b.date, false),
  );

  const inWindow = (iso: string) => {
    const ms = parseISO(iso);
    return ms >= fromMs && ms <= toMs;
  };

  const bankInWindowAll = allBank.filter((b) => inWindow(b.date));
  bankInWindowAll.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  let bal = startBalance;
  const balanceByTxnId = new Map<string, number>();
  for (const b of bankInWindowAll) {
    if (anchorMs !== null && parseISO(b.date) <= anchorMs) {
      balanceByTxnId.set(b.txn.id, bal);
      continue;
    }
    bal = Math.round((bal + b.amount) * 100) / 100;
    balanceByTxnId.set(b.txn.id, bal);
  }

  const visibleBank = activeBank.filter((b) => inWindow(b.date));
  const visiblePlan = activePlan.filter((p) => inWindow(p.date));

  const rows: LineRow[] = [];
  for (const b of visibleBank) {
    rows.push({ ...b, runningBalance: balanceByTxnId.get(b.txn.id) });
  }
  for (const p of visiblePlan) {
    rows.push(p);
  }
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "bank" ? -1 : 1;
    return 0;
  });

  return { rows, allPlan, allBank };
}

export type MatchConfidence = "high" | "medium" | "low";

export type PlanSuggestion = {
  plan: PlanLine;
  score: number;
  confidence: MatchConfidence;
  daysAway: number;
  amountDelta: number;
  labelMatch: boolean;
};

export function suggestPlanMatchesForBank(
  bank: BankLine,
  planRows: PlanLine[],
  opts: { maxDays?: number; limit?: number } = {},
): PlanSuggestion[] {
  const maxDays = opts.maxDays ?? 14;
  const limit = opts.limit ?? 3;
  const wantSign = Math.sign(bank.amount);
  if (!wantSign) return [];
  const targetMs = parseISO(bank.date);
  const want = Math.abs(bank.amount);
  const desc = (bank.txn.description ?? "").toLowerCase();

  const out: PlanSuggestion[] = [];
  for (const p of planRows) {
    if (p.status !== "pending_plan" && p.status !== "future") continue;
    if (Math.sign(p.amount) !== wantSign) continue;
    const daysAway = Math.round(Math.abs(parseISO(p.date) - targetMs) / DAY);
    if (daysAway > maxDays) continue;

    const amountDelta =
      Math.round(Math.abs(Math.abs(p.amount) - want) * 100) / 100;
    const relDelta = want > 0 ? amountDelta / want : amountDelta;

    const tokens = (p.label ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    const labelMatch = tokens.some((t) => desc.includes(t));

    const score = amountDelta * 100 + daysAway - (labelMatch ? 2 : 0);

    let confidence: MatchConfidence;
    if (amountDelta < 0.01 && daysAway <= 5) confidence = "high";
    else if (amountDelta < 0.01 && labelMatch && daysAway <= maxDays)
      confidence = "high";
    else if (amountDelta < 0.01 && daysAway <= maxDays) confidence = "medium";
    else if (relDelta <= 0.02 && daysAway <= 7) confidence = "medium";
    else confidence = "low";

    out.push({ plan: p, score, confidence, daysAway, amountDelta, labelMatch });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, limit);
}
