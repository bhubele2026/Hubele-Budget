import type { CashEvent } from "./forecast";

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

/** True if a transaction belongs to a bank/checking-style account.
 *  Account metadata wins: a Plaid txn whose `plaidAccountId` matches a
 *  known checking/depository account is bank, regardless of source string.
 *  Otherwise: `amex`/`plaid:amex` are not bank; other Plaid txns without a
 *  matching checking account are credit-card-side and excluded.
 *  Manual rows default to bank — that's the primary flow for them. */
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

export type ResolutionStatus =
  | "matched"
  | "missed"
  | "dismissed"
  | "ignored_unforecasted"
  | "unplanned";

export type Resolution = {
  id: string;
  recurringItemId: string | null;
  occurrenceDate: string | null;
  status: string;
  matchedTxnId: string | null;
  txnDate?: string | null;
  txnDescription?: string | null;
  txnAmount?: string | null;
  txnForecastFlag?: boolean | null;
};

export type PlanLineStatus = "pending_plan" | "matched" | "missed" | "future";
export type BankLineStatus = "pending_bank" | "matched" | "ignored_unforecasted";

export type PlanLine = {
  kind: "plan";
  date: string;
  itemId: string;
  label: string;
  amount: number;
  status: PlanLineStatus;
  resolutionId?: string;
  matchedTxnId?: string | null;
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
  /** Optional snapshot anchor (YYYY-MM-DD). Items dated on/before this date are
   *  treated as already baked into startBalance and skipped from the running
   *  balance calculation. */
  snapshotISO?: string | null;
}): { rows: LineRow[]; allPlan: PlanLine[]; allBank: BankLine[] } {
  const { events, txns, resolutions, closedMonths, startBalance, fromISO, toISO, snapshotISO } = opts;
  const today = opts.today ?? new Date();
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
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
    const evMs = parseISO(ev.date);
    const key = `${ev.itemId}|${ev.date}`;
    const stored = byEventKey.get(key);
    let status: PlanLineStatus;
    if (stored?.status === "matched") status = "matched";
    else if (stored?.status === "missed" || stored?.status === "dismissed") status = "missed";
    else if (evMs > todayMs) status = "future";
    else status = "pending_plan";
    return {
      kind: "plan" as const,
      date: ev.date,
      itemId: ev.itemId,
      label: ev.label,
      amount: ev.amount,
      status,
      resolutionId: stored?.id,
      matchedTxnId: stored?.matchedTxnId ?? null,
    };
  });

  const allBank: BankLine[] = txns.map((t) => {
    const stored = byTxn.get(t.id);
    let status: BankLineStatus;
    if (stored?.status === "matched") status = "matched";
    else if (stored?.status === "ignored_unforecasted" || stored?.status === "unplanned")
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
    // Items on/before snapshot anchor are already in the snapshot balance.
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

  if (bankInWindowAll.length === 0) {
    let proj = startBalance;
    for (const r of rows) {
      if (anchorMs !== null && parseISO(r.date) <= anchorMs) {
        r.runningBalance = proj;
        continue;
      }
      proj = Math.round((proj + r.amount) * 100) / 100;
      r.runningBalance = proj;
    }
  }

  return { rows, allPlan, allBank };
}

export function findCandidates(row: LineRow, rows: LineRow[], days = 7): LineRow[] {
  const targetMs = parseISO(row.date);
  const wantSign = Math.sign(row.amount);
  const wantKind = row.kind === "bank" ? "plan" : "bank";
  return rows
    .filter((r) => r.kind === wantKind)
    .filter((r) => {
      if (r.kind === "plan" && r.status !== "pending_plan" && r.status !== "future") return false;
      if (r.kind === "bank" && r.status !== "pending_bank") return false;
      if (Math.sign(r.amount) !== wantSign) return false;
      const dMs = Math.abs(parseISO(r.date) - targetMs);
      return dMs <= days * DAY;
    })
    .sort((a, b) => {
      const da = Math.abs(parseISO(a.date) - targetMs);
      const db = Math.abs(parseISO(b.date) - targetMs);
      if (da !== db) return da - db;
      const am = Math.abs(Math.abs(a.amount) - Math.abs(row.amount));
      const bm = Math.abs(Math.abs(b.amount) - Math.abs(row.amount));
      return am - bm;
    });
}

export type BucketEntry = {
  id: string;
  status: "matched" | "missed" | "ignored_unforecasted" | "unplanned";
  date: string;
  label: string;
  amount: number;
  monthKey: string;
  recurringItemId?: string | null;
  occurrenceDate?: string | null;
  matchedTxnId?: string | null;
};

export function buildBucket(opts: {
  allPlan: PlanLine[];
  allBank: BankLine[];
  resolutions: Resolution[];
  closedMonths: Set<string>;
  monthFilter: string;
}): BucketEntry[] {
  const { allPlan, allBank, resolutions, closedMonths, monthFilter } = opts;
  if (closedMonths.has(monthFilter)) return [];

  const planByKey = new Map(allPlan.map((p) => [`${p.itemId}|${p.date}`, p]));
  const bankById = new Map(allBank.map((b) => [b.txn.id, b]));

  const out: BucketEntry[] = [];
  for (const r of resolutions) {
    let date: string | null = null;
    let label = "";
    let amount = 0;

    if (r.recurringItemId && r.occurrenceDate) {
      const p = planByKey.get(`${r.recurringItemId}|${r.occurrenceDate}`);
      if (p) {
        date = p.date;
        label = p.label;
        amount = p.amount;
      } else {
        date = r.occurrenceDate;
      }
    } else if (r.matchedTxnId) {
      const b = bankById.get(r.matchedTxnId);
      if (b) {
        date = b.date;
        label = b.txn.description;
        amount = b.amount;
      } else if (r.txnDate) {
        date = r.txnDate;
        label = r.txnDescription ?? "";
        amount = Number(r.txnAmount) || 0;
      }
    }
    if (!date) continue;
    const mk = monthKey(date);
    if (mk !== monthFilter) continue;

    let status: BucketEntry["status"];
    if (r.status === "matched") status = "matched";
    else if (r.status === "missed" || r.status === "dismissed") status = "missed";
    else if (r.status === "ignored_unforecasted") status = "ignored_unforecasted";
    else if (r.status === "unplanned") status = "unplanned";
    else continue;

    out.push({
      id: r.id,
      status,
      date,
      label,
      amount,
      monthKey: mk,
      recurringItemId: r.recurringItemId,
      occurrenceDate: r.occurrenceDate,
      matchedTxnId: r.matchedTxnId,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
