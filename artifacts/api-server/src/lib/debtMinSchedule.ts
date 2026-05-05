import { debtsTable, recurringItemsTable } from "@workspace/db";
import type { CashEvent } from "./cashSignal";
import { fmtISO, expandItem } from "./cashSignal";

type DebtRow = typeof debtsTable.$inferSelect;
type RecurringRow = typeof recurringItemsTable.$inferSelect;

export type DebtMinRow = {
  debtId: string;
  debtName: string;
  amount: string;
  minPayment: string;
  nextOccurrence: string | null;
  source: "plaid" | "manual";
  locked: true;
  linkedRecurringId: string | null;
  dueDay: number | null;
  endsThisCycle: boolean;
};

function activeDebt(d: DebtRow): boolean {
  return (
    (d.status ?? "active") === "active" &&
    Number(d.minPayment) > 0 &&
    Number(d.balance) > 0.005
  );
}

// Paid off this calendar month: balance ~0, positive minPayment, updatedAt
// within current month. Status-agnostic so both auto-archived and manually
// zeroed debts surface the one-cycle "stops at payoff" row.
function justPaidOffDebt(d: DebtRow, today: Date): boolean {
  if (Number(d.balance) > 0.005) return false;
  if (Number(d.minPayment) <= 0) return false;
  const updated = d.updatedAt ? new Date(d.updatedAt) : null;
  if (!updated || Number.isNaN(updated.getTime())) return false;
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  return updated >= monthStart;
}

function activeRecurring(r: RecurringRow): boolean {
  return r.active === "true";
}

function nextDueFromDay(dueDay: number, today: Date): Date {
  const y = today.getFullYear();
  const m = today.getMonth();
  const lastThis = new Date(y, m + 1, 0).getDate();
  const candidate = new Date(y, m, Math.min(dueDay, lastThis));
  if (candidate >= today) return candidate;
  const lastNext = new Date(y, m + 2, 0).getDate();
  return new Date(y, m + 1, Math.min(dueDay, lastNext));
}

function nextDueFromRecurring(r: RecurringRow, today: Date): Date | null {
  const horizon = new Date(
    today.getFullYear() + 2,
    today.getMonth(),
    today.getDate(),
  );
  const events = expandItem(r, today, horizon);
  if (events.length === 0) return null;
  const [y, m, d] = events[0].date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Build the locked debt-minimum rows for the Bills page.
 *
 * For each active debt with a positive minPayment, emit one virtual row that
 * carries the debt's minimum as a bill. If a recurring item is explicitly
 * linked to that debt (via `recurringItem.debtId`), reuse its next occurrence
 * but still mark the row as a debt minimum and suppress the recurring item
 * from the regular bills list to avoid double-counting.
 */
export function buildDebtMinSchedule(
  debts: DebtRow[],
  recurring: RecurringRow[],
  today: Date,
): {
  rows: DebtMinRow[];
  suppressedRecurringIds: Set<string>;
} {
  const recurringByDebt = new Map<string, RecurringRow>();
  for (const r of recurring) {
    if (!activeRecurring(r)) continue;
    if (r.kind === "income") continue;
    if (!r.debtId) continue;
    if (!recurringByDebt.has(r.debtId)) recurringByDebt.set(r.debtId, r);
  }

  const rows: DebtMinRow[] = [];
  const suppressed = new Set<string>();
  for (const d of debts) {
    const isActive = activeDebt(d);
    const justPaidOff = !isActive && justPaidOffDebt(d, today);
    if (!isActive && !justPaidOff) continue;
    const linked = recurringByDebt.get(d.id) ?? null;
    let nextOccurrence: string | null = null;
    if (isActive) {
      if (linked) {
        const dt = nextDueFromRecurring(linked, today);
        if (dt) nextOccurrence = fmtISO(dt);
      }
      if (!nextOccurrence && d.dueDay && d.dueDay >= 1 && d.dueDay <= 31) {
        nextOccurrence = fmtISO(nextDueFromDay(d.dueDay, today));
      }
    }
    const minStr = Number(d.minPayment).toFixed(2);
    // amount=0 for paid-off rows so they don't inflate totals; minPayment
    // preserved so the UI can show the historical amount struck through.
    const amount = justPaidOff
      ? "0.00"
      : (-Math.abs(Number(d.minPayment))).toFixed(2);
    rows.push({
      debtId: d.id,
      debtName: d.name,
      amount,
      minPayment: minStr,
      nextOccurrence,
      source: d.minPaymentSource === "plaid" ? "plaid" : "manual",
      locked: true,
      linkedRecurringId: linked?.id ?? null,
      dueDay: d.dueDay ?? null,
      endsThisCycle: justPaidOff,
    });
    if (linked) suppressed.add(linked.id);
  }
  return { rows, suppressedRecurringIds: suppressed };
}

/**
 * Expand a debt's monthly minimum payment into CashEvents within [from, to].
 * Used by the forecast and cash-signal projections so the Bills "debt
 * minimum" series is the same series the cash projection consumes.
 */
export function expandDebtMin(
  debt: DebtRow,
  linked: RecurringRow | null,
  from: Date,
  to: Date,
): CashEvent[] {
  if (!activeDebt(debt)) return [];
  // If a recurring item is explicitly linked to this debt, the recurring
  // item's own expansion is the source of truth — caller is expected to keep
  // that recurring item in the events list (and not also emit synthetic
  // debt-min events for the same debt).
  if (linked) return [];
  const day = debt.dueDay && debt.dueDay >= 1 && debt.dueDay <= 31
    ? debt.dueDay
    : 1;
  const amt = -Math.abs(Number(debt.minPayment) || 0);
  const out: CashEvent[] = [];
  let y = from.getFullYear();
  let m = from.getMonth();
  while (true) {
    const lastDay = new Date(y, m + 1, 0).getDate();
    const dt = new Date(y, m, Math.min(day, lastDay));
    if (dt > to) break;
    if (dt >= from) {
      out.push({
        date: fmtISO(dt),
        itemId: `debt:${debt.id}`,
        label: `${debt.name} minimum`,
        kind: "expense",
        amount: amt,
      });
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/**
 * Identify recurring items that should be skipped in the cash projection
 * because their associated debt minimum is sourced from the debts table
 * directly (the user explicitly linked the recurring item to a debt).
 *
 * NOTE: This intentionally suppresses ONLY recurring items whose debt is
 * also feeding the projection elsewhere — i.e., when the recurring item
 * stays in the events list, no synthetic debt event is added; when the
 * recurring item is suppressed, a synthetic debt event is added.
 *
 * Current policy: keep linked recurring items as-is (they ARE the debt's
 * cashflow), and only emit synthetic debt events for unlinked debts. This
 * matches the bills/summary semantics so "no double counting" holds across
 * Bills, Forecast, and Dashboard.
 */
export function pickRecurringSuppressionForForecast(
  _debts: DebtRow[],
  _recurring: RecurringRow[],
): Set<string> {
  return new Set();
}
