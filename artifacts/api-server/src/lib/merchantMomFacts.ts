// Per-merchant month-over-month facts — the deterministic numbers behind the
// reworked Banking buckets ("Starbucks down $18 · 3 fewer visits", "Mooyah
// creeping up, ~$1,700/yr eating out"). PURE: it takes already-fetched rows +
// the spend context and a reference date, so it unit-tests without a DB.
//
// Every figure here is computed in code (CLAUDE.md §1). Merchants are grouped
// by the cross-month-STABLE merchantSignature() (STARBUCKS #123 → "starbucks")
// so a chain's charges collapse across store numbers and months. Noise
// (transfers, uncategorized, Ignore/Reimbursement/Transfer, debt, card
// payments, income) is excluded via the shared isRealSpend() predicate.

import { cleanMerchant, merchantSignature } from "./merchantNameExtract";
import {
  isRealSpend,
  spendAmount,
  type SpendContext,
  type SpendTxn,
} from "./spendingFilter";

export interface MerchantMomTxn {
  occurredOn: string; // "YYYY-MM-DD" (may carry a time suffix)
  description: string | null;
  amount: string | number;
  source: string | null;
  categoryId: string | null;
  isTransfer: boolean;
}

export interface MerchantMomEntry {
  signature: string;
  display: string;
  categoryName: string | null;
  /** This month, from the 1st through today. */
  curSpend: number;
  /** Last month, same point (day ≤ today's day-of-month) — like-for-like. */
  lastSpend: number;
  /** cur − last: negative = spending LESS than last month. */
  deltaAmount: number;
  /** Distinct days visited this month-to-date. */
  curVisits: number;
  /** Distinct days visited last month through the same day-of-month. */
  lastVisits: number;
  /** cur − last visits: negative = fewer trips. */
  deltaVisits: number;
  /** Real spend across the whole observed window (both months). */
  windowSpend: number;
  /** Annualized run-rate from the observed window (windowSpend / days × 365). */
  annualRunRate: number;
  /** Present this month but absent all of last month. */
  isNew: boolean;
}

export interface ComputeMerchantMomOptions {
  /** Reference "today" (defaults to now). The window is [prevMonthStart, today]. */
  now?: Date;
  /** Min distinct visits across both months to be trustworthy (guards mis-grouped noise). */
  minVisits?: number;
}

function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Group the window's real spend by merchant signature and compute this-month-to-
 * date vs same-point-last-month spend + visit counts, an annualized run-rate,
 * and a "new this month" flag. Rows outside [prevMonthStart, today] are ignored.
 */
export function computeMerchantMom(
  txns: MerchantMomTxn[],
  ctx: SpendContext,
  opts: ComputeMerchantMomOptions = {},
): MerchantMomEntry[] {
  const now = opts.now ?? new Date();
  const minVisits = opts.minVisits ?? 2;

  const monthStart = isoDateUTC(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  );
  const prevMonthStart = isoDateUTC(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  );
  const dayOfMonth = now.getUTCDate();

  // Observed-window length in days (prevMonthStart → today inclusive), used to
  // annualize the run-rate. Shared across all merchants.
  const windowDays = Math.max(
    1,
    Math.round(
      (Date.parse(`${isoDateUTC(now)}T00:00:00Z`) -
        Date.parse(`${prevMonthStart}T00:00:00Z`)) /
        86_400_000,
    ) + 1,
  );

  interface Acc {
    signature: string;
    display: string;
    categoryName: string | null;
    curSpend: number;
    lastSpend: number;
    windowSpend: number;
    curDays: Set<string>;
    lastDays: Set<string>;
    lastMonthAnySpend: number;
  }
  const groups = new Map<string, Acc>();

  for (const t of txns) {
    const day10 = (t.occurredOn ?? "").slice(0, 10);
    if (!day10 || day10 < prevMonthStart) continue;
    if (day10 > isoDateUTC(now)) continue; // never count the future

    const tx: SpendTxn = {
      amount: t.amount,
      source: t.source ?? "",
      isTransfer: t.isTransfer,
      categoryId: t.categoryId,
      description: t.description ?? "",
    };
    if (!isRealSpend(tx, ctx)) continue;
    const spend = spendAmount(tx);
    if (spend <= 0) continue;

    const raw = t.description ?? "";
    const sig = merchantSignature(raw);
    if (!sig) continue;

    let g = groups.get(sig);
    if (!g) {
      const catName = t.categoryId
        ? ctx.categoriesById.get(t.categoryId)?.name ?? null
        : null;
      g = {
        signature: sig,
        display: cleanMerchant(raw) || raw.trim() || sig,
        categoryName: catName,
        curSpend: 0,
        lastSpend: 0,
        windowSpend: 0,
        curDays: new Set(),
        lastDays: new Set(),
        lastMonthAnySpend: 0,
      };
      groups.set(sig, g);
    }

    g.windowSpend += spend;
    const dom = Number(day10.slice(8, 10));

    if (day10 >= monthStart) {
      g.curSpend += spend;
      g.curDays.add(day10);
    } else {
      // last month
      g.lastMonthAnySpend += spend;
      if (dom <= dayOfMonth) {
        g.lastSpend += spend;
        g.lastDays.add(day10);
      }
    }
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const out: MerchantMomEntry[] = [];
  for (const g of groups.values()) {
    const curVisits = g.curDays.size;
    const lastVisits = g.lastDays.size;
    if (curVisits + lastVisits < minVisits) continue; // trust gate
    const curSpend = round2(g.curSpend);
    const lastSpend = round2(g.lastSpend);
    out.push({
      signature: g.signature,
      display: g.display,
      categoryName: g.categoryName,
      curSpend,
      lastSpend,
      deltaAmount: round2(curSpend - lastSpend),
      curVisits,
      lastVisits,
      deltaVisits: curVisits - lastVisits,
      windowSpend: round2(g.windowSpend),
      annualRunRate: Math.round((g.windowSpend / windowDays) * 365),
      isNew: curSpend > 0 && g.lastMonthAnySpend <= 0,
    });
  }
  return out;
}
