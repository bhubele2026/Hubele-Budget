import { occurrenceDateOf, type SignalEvent } from "./forecastPastDue";
import type { MarkerKind } from "./chartTokens";

/**
 * Display-only grouping for the expanded forecast chart and its selected-day
 * panel. Every amount here is one the cash signal already returned; nothing is
 * added, rounded or estimated. The only judgement is WHICH KIND an event is,
 * which picks a marker shape and a legend word.
 */

export type KindedEvent = {
  date: string;
  label: string;
  amount: number;
  itemId?: string;
  kind: MarkerKind;
  /** Pulled forward off its due date by the cash signal (past due). */
  dragged: boolean;
  originalDate?: string;
  occurrenceDate: string;
};

const CARD_WORDS = /\b(amex|american express|credit card|card payment|visa|mastercard|discover|chase card|citi)\b/i;

export const MARKER_LABEL: Record<MarkerKind, string> = {
  payday: "Payday",
  bill: "Bill",
  card: "Card payment",
  debt: "Debt payment",
};

/** Income is a payday; a recurring item linked to a debt is a debt payment,
 *  unless its name says it pays a card; anything else out is a bill. */
export function classifyEvent(
  e: { label: string; amount: number; itemId?: string },
  debtLinks: ReadonlyMap<string, string>,
): MarkerKind {
  if (e.amount > 0) return "payday";
  if (CARD_WORDS.test(e.label)) return "card";
  if (e.itemId && debtLinks.has(e.itemId)) return "debt";
  return "bill";
}

export function kindEvents(
  events: readonly SignalEvent[],
  debtLinks: ReadonlyMap<string, string>,
): KindedEvent[] {
  const out: KindedEvent[] = [];
  for (const e of events) {
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    out.push({
      date: e.date,
      label: e.label,
      amount,
      itemId: e.itemId,
      kind: classifyEvent({ label: e.label, amount, itemId: e.itemId }, debtLinks),
      dragged: !!e.originalDate && e.originalDate !== e.date,
      originalDate: e.originalDate,
      occurrenceDate: occurrenceDateOf(e),
    });
  }
  return out;
}

/** (T3) A checking row the walk counted (`CashSignal.dayItems`, kind `bank_row`). Signed. */
export type BankDayRow = {
  date: string;
  amount: number;
  /** The row's own description from the forecast bundle, else "Bank activity". */
  label: string;
  txnId: string;
  matched: boolean;
};

/** The shape of `CashSignal.dayItems[]` this module reads. */
export type DayItemLike = {
  date: string;
  kind: string;
  amount: string;
  label?: string;
  itemId?: string;
  originalDate?: string;
  occurrenceDate?: string;
  txnId?: string;
  matched?: boolean;
};

/**
 * ⭐ (T3) EVERY ITEM THE CURVE WALKED, KINDED. `CashSignal.dayItems` is the
 * walk read back (server-proven: each day's items move the previous close to
 * this close), so the day panel lists all of it: planned items become the same
 * `KindedEvent`s as `kindEvents` (income is a payday — the legend's Payday
 * finally has markers), and counted checking rows are `bank` rows, labelled
 * from the bundle's own rows. Nothing is added or rounded; amounts are the
 * server's. A zero plan moves nothing and is left out, as in `kindEvents`.
 */
export function kindDayItems(
  items: readonly DayItemLike[],
  debtLinks: ReadonlyMap<string, string>,
  bankLabel: (txnId: string) => string | null = () => null,
): { kinded: KindedEvent[]; bank: BankDayRow[] } {
  const kinded: KindedEvent[] = [];
  const bank: BankDayRow[] = [];
  for (const it of items) {
    const amount = Number(it.amount);
    if (!Number.isFinite(amount)) continue;
    if (it.kind === "bank_row") {
      if (!it.txnId) continue;
      bank.push({
        date: it.date,
        amount,
        label: bankLabel(it.txnId) ?? "Bank activity",
        txnId: it.txnId,
        matched: it.matched === true,
      });
      continue;
    }
    if (amount === 0) continue;
    const label = it.label ?? "";
    kinded.push({
      date: it.date,
      label,
      amount,
      itemId: it.itemId,
      kind: classifyEvent({ label, amount, itemId: it.itemId }, debtLinks),
      dragged: !!it.originalDate && it.originalDate !== it.date,
      originalDate: it.originalDate,
      occurrenceDate: occurrenceDateOf(it),
    });
  }
  return { kinded, bank };
}

export type MarkerGroup = {
  date: string;
  /** Number of events on the day; the marker shows it when above 1. */
  count: number;
  /** The kind of the largest event that day; picks the shape and colour. */
  kind: MarkerKind;
  kinds: MarkerKind[];
  balance: number;
  events: KindedEvent[];
};

/** One marker per day that has events, sitting on that day's balance. A crowded
 *  day is ONE marker with a count. Long horizons keep the `cap` largest days. */
export function groupMarkers(
  events: readonly KindedEvent[],
  balanceByDate: ReadonlyMap<string, number>,
  cap = 80,
): MarkerGroup[] {
  const byDate = new Map<string, KindedEvent[]>();
  for (const e of events) {
    if (!balanceByDate.has(e.date)) continue;
    const slot = byDate.get(e.date) ?? [];
    slot.push(e);
    byDate.set(e.date, slot);
  }
  const groups: MarkerGroup[] = [];
  for (const [date, evs] of byDate) {
    const sorted = [...evs].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    groups.push({
      date,
      count: sorted.length,
      kind: sorted[0].kind,
      kinds: Array.from(new Set(sorted.map((x) => x.kind))),
      balance: balanceByDate.get(date) ?? 0,
      events: sorted,
    });
  }
  groups.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (groups.length <= cap) return groups;
  const keep = new Set(
    [...groups]
      .sort(
        (a, b) =>
          b.events.reduce((s, e) => s + Math.abs(e.amount), 0) -
          a.events.reduce((s, e) => s + Math.abs(e.amount), 0),
      )
      .slice(0, cap)
      .map((g) => g.date),
  );
  return groups.filter((g) => keep.has(g.date));
}

export type RiskRange = { x1: string; x2: string };

/** Runs of consecutive days where the balance sits under `limit`. A run of one
 *  day is widened to its neighbours so it is visible. */
export function runsBelow(
  series: ReadonlyArray<{ rawDate: string; balance: number }>,
  limit: number,
): RiskRange[] {
  if (!Number.isFinite(limit)) return [];
  const out: RiskRange[] = [];
  let start = -1;
  const close = (end: number) => {
    const a = Math.max(0, start - (start === end ? 1 : 0));
    const b = Math.min(series.length - 1, end + (start === end ? 1 : 0));
    out.push({ x1: series[a].rawDate, x2: series[b].rawDate });
    start = -1;
  };
  for (let i = 0; i < series.length; i++) {
    const under = series[i].balance < limit;
    if (under && start < 0) start = i;
    if (!under && start >= 0) close(i - 1);
  }
  if (start >= 0) close(series.length - 1);
  return out;
}

export type DaySummary = {
  date: string;
  inWindow: boolean;
  /** Previous day's close; on the window's first day the curve's own start
   *  (`startingBalance`) when given, else null. */
  opening: number | null;
  /** The day's projected close, straight from the series; null outside it. */
  close: number | null;
  income: number;
  outflows: Record<Exclude<MarkerKind, "payday">, number>;
  /** (T3) Counted checking rows that day: money in (≥ 0) and out (≤ 0, signed). */
  bankIn: number;
  bankOut: number;
  bankRows: BankDayRow[];
  events: KindedEvent[];
  scheduledCount: number;
  carriedForwardCount: number;
};

/**
 * One day of the curve, grouped for the day panel. With `dayItems` (T3) the
 * events and bank rows are everything the walk applied that day, so
 * `opening + income + bankIn + outflows + bankOut = close` (outflows signed) —
 * the server proves it per day; this only groups the server's amounts.
 */
export function daySummary(
  date: string,
  series: ReadonlyArray<{ rawDate: string; balance: number }>,
  events: readonly KindedEvent[],
  opts: { bank?: readonly BankDayRow[]; startingBalance?: number | null } = {},
): DaySummary {
  const idx = series.findIndex((d) => d.rawDate === date);
  const evs = events.filter((e) => e.date === date).sort((a, b) => a.amount - b.amount);
  const outflows = { bill: 0, card: 0, debt: 0 };
  let income = 0;
  for (const e of evs) {
    if (e.kind === "payday") income += e.amount;
    else outflows[e.kind] += e.amount;
  }
  const bankRows = (opts.bank ?? []).filter((b) => b.date === date).sort((a, b) => a.amount - b.amount);
  let bankIn = 0;
  let bankOut = 0;
  for (const b of bankRows) {
    if (b.amount > 0) bankIn += b.amount;
    else bankOut += b.amount;
  }
  const start = opts.startingBalance;
  return {
    date,
    inWindow: idx >= 0,
    opening:
      idx > 0 ? series[idx - 1].balance : idx === 0 && start != null && Number.isFinite(start) ? start : null,
    close: idx >= 0 ? series[idx].balance : null,
    income,
    outflows,
    bankIn,
    bankOut,
    bankRows,
    events: evs,
    scheduledCount: evs.filter((e) => !!e.itemId && !e.dragged).length,
    carriedForwardCount: evs.filter((e) => e.dragged).length,
  };
}

/** Next/previous day inside the window, for the arrow keys. Outside the window,
 *  Right goes to the first day and Left to the last. */
export function stepDate(
  series: ReadonlyArray<{ rawDate: string }>,
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (series.length === 0) return null;
  const idx = current ? series.findIndex((d) => d.rawDate === current) : -1;
  if (idx < 0) return (dir === 1 ? series[0] : series[series.length - 1]).rawDate;
  const next = Math.min(series.length - 1, Math.max(0, idx + dir));
  return series[next].rawDate;
}
