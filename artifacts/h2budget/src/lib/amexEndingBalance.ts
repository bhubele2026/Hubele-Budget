// (#476) Shared helper that computes the Amex end-of-month balance.
//
// Mirrors `chaseEndingBalance.ts` for the Amex page so that if/when a
// dashboard "Amex ending balance" tile is added, both surfaces compute
// from the same logic and can never drift across past, current, or
// future months.
//
// Encapsulates:
//  - Anchor month selection (the month containing the asOf timestamp,
//    falling back to the supplied `fallbackMonth` — typically today's
//    month — when no asOf is available).
//  - Mid-month snapshot reconstruction
//    (`endOfAnchorMonth = anchor + sum(post-anchor anchor-month txns)`).
//  - Per-month net change roll forward / backward.
//
// Anchor resolution itself (debt row vs. server-side `/api/amex/anchor`
// fallback) lives on the page because it depends on hooks and the
// Amex-specific debt-matching rules; this helper takes the already-
// resolved anchor as input.
import {
  compareMonth,
  monthKeyFromISO,
  monthKeyOf,
  type MonthKey,
} from "@/components/account-page";
import { computeBalanceAtEndOf } from "./accountBalance";

export type AmexTxnInput = {
  occurredOn: string;
  amount: string | number;
};

export type AmexAnchor = {
  balance: number;
  asOf: string | null;
};

// Structural shapes for the shared `resolveAmexDebt` helper. Kept loose
// so both `amex.tsx` and `dashboard.tsx` can pass their own
// `useListDebts` / `useListPlaidItems` row types without converting.
export type AmexDebtLike = {
  name: string;
  balance: string;
  plaidAccountId?: string | null;
  lastBalanceUpdate?: string | null;
  plaidLastSyncedAt?: string | null;
};

export type AmexPlaidAccountLike = {
  accountId?: string | null;
  id?: string | null;
  mask?: string | null;
};

export type AmexPlaidItemLike = {
  institutionName?: string | null;
  accounts?: ReadonlyArray<AmexPlaidAccountLike> | null;
};

const AMEX_NAME_REGEX = /amex|american\s*express/i;

function parseSignedAmount(amount: string): number {
  return parseFloat(amount) || 0;
}

/**
 * Shared Amex-debt anchor resolver used by both the Amex page and the
 * dashboard "Amex ending balance" tile. Mirrors the page's historical
 * logic so both surfaces compute against the same anchor and can never
 * drift apart for a given user state. See `artifacts/h2budget/src/pages/
 * amex.tsx` (#373, #416, #449) for the original notes.
 *
 *  1. Prefer Amex debts linked to the Plaid `account_id`s that actually
 *     feed the page's transactions. Fall back to the legacy name regex
 *     match when no Plaid link exists on either side (so freshly-linked
 *     debts and CSV-only accounts still resolve).
 *  2. When multiple matches share the same physical card
 *     (institution + mask), collapse them — keeping the most recently
 *     updated row — before aggregating, so a mid-relink dedupe race
 *     can't cause us to count the same liability twice (#449).
 *  3. When >1 matches remain, sum their balances and adopt the latest
 *     `lastBalanceUpdate ?? plaidLastSyncedAt` as the anchor's `asOf`
 *     so households with multiple physical Amex cards see the combined
 *     liability rather than just the first match (#416).
 */
export function resolveAmexDebt<T extends AmexDebtLike>(args: {
  debts: ReadonlyArray<T> | null | undefined;
  amexPlaidAccountIds: ReadonlySet<string>;
  plaidItemsForScope: ReadonlyArray<AmexPlaidItemLike> | null | undefined;
}): T | null {
  const { debts, amexPlaidAccountIds, plaidItemsForScope } = args;
  if (!debts || debts.length === 0) return null;
  let matches: T[] = [];
  if (amexPlaidAccountIds.size > 0) {
    matches = debts.filter(
      (d) => !!d.plaidAccountId && amexPlaidAccountIds.has(d.plaidAccountId),
    );
  }
  if (matches.length === 0) {
    matches = debts.filter((d) => AMEX_NAME_REGEX.test(d.name));
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const accountMeta = new Map<string, { institution: string; mask: string }>();
    for (const item of plaidItemsForScope ?? []) {
      const inst = (item.institutionName ?? "").toLowerCase();
      for (const acct of item.accounts ?? []) {
        const id = acct.accountId ?? acct.id ?? null;
        if (id && acct.mask) {
          accountMeta.set(id, {
            institution: inst,
            mask: acct.mask.toLowerCase(),
          });
        }
      }
    }
    const byPhysicalCard = new Map<string, T>();
    const ungrouped: T[] = [];
    for (const d of matches) {
      const meta = d.plaidAccountId ? accountMeta.get(d.plaidAccountId) : undefined;
      if (!meta) {
        ungrouped.push(d);
        continue;
      }
      const key = `${meta.institution}|${meta.mask}`;
      const existing = byPhysicalCard.get(key);
      if (!existing) {
        byPhysicalCard.set(key, d);
      } else {
        const a = existing.lastBalanceUpdate ?? existing.plaidLastSyncedAt ?? "";
        const b = d.lastBalanceUpdate ?? d.plaidLastSyncedAt ?? "";
        if (b > a) byPhysicalCard.set(key, d);
      }
    }
    matches = [...byPhysicalCard.values(), ...ungrouped];
  }
  if (matches.length === 1) return matches[0];
  const totalBalance = matches.reduce(
    (acc, d) => acc + parseSignedAmount(d.balance),
    0,
  );
  const latestUpdate = matches.reduce<string | null>((acc, d) => {
    const cand = d.lastBalanceUpdate ?? d.plaidLastSyncedAt ?? null;
    if (!cand) return acc;
    if (!acc) return cand;
    return cand > acc ? cand : acc;
  }, null);
  return {
    ...matches[0],
    balance: String(totalBalance),
    lastBalanceUpdate: latestUpdate,
  };
}

/**
 * Resolve the Amex anchor (balance + asOf) the same way both the Amex
 * page and the dashboard tile do: prefer the linked Amex debt, else
 * fall through to the server-side `/api/amex/anchor` response. Returns
 * `null` when neither source can supply a usable anchor.
 */
export function resolveAmexAnchor(args: {
  amexDebt: AmexDebtLike | null;
  amexAnchorResp:
    | {
        amexEndingBalance: number | null;
        asOf?: string | null;
        source: "debt" | "anchor" | "computed" | "plaid" | "missing";
      }
    | null
    | undefined;
}): AmexAnchor | null {
  const { amexDebt, amexAnchorResp } = args;
  if (amexDebt) {
    const bal = parseSignedAmount(amexDebt.balance);
    if (Number.isFinite(bal)) {
      return {
        balance: bal,
        asOf:
          amexDebt.lastBalanceUpdate ?? amexDebt.plaidLastSyncedAt ?? null,
      };
    }
  }
  if (
    amexAnchorResp &&
    amexAnchorResp.amexEndingBalance !== null &&
    amexAnchorResp.source !== "missing"
  ) {
    return {
      balance: amexAnchorResp.amexEndingBalance,
      asOf: amexAnchorResp.asOf ?? null,
    };
  }
  return null;
}

/**
 * Build a `(target) => number | null` closure that returns the Amex
 * end-of-month balance at the end of any month. Returns `() => null`
 * when no anchor is available (e.g. no linked Amex debt and no saved
 * anchor on the server).
 *
 * Pre-computes `netChangeByMonth` and `anchorMonthTxns` once so the
 * Amex page can call it 12+ times for the trend chart without
 * re-walking the transaction list.
 */
export function makeAmexBalanceAtEndOf(args: {
  anchor: AmexAnchor | null;
  amexTransactions: ReadonlyArray<AmexTxnInput>;
  fallbackMonth?: MonthKey;
}): (target: MonthKey) => number | null {
  const { anchor, amexTransactions, fallbackMonth } = args;
  if (!anchor) return () => null;

  const anchorMonth = anchor.asOf
    ? monthKeyFromISO(anchor.asOf)
    : (fallbackMonth ?? monthKeyOf(new Date()));

  const netChangeByMonth = new Map<string, number>();
  for (const t of amexTransactions) {
    const mk = monthKeyFromISO(t.occurredOn);
    const k = `${mk.year}-${mk.month}`;
    netChangeByMonth.set(
      k,
      (netChangeByMonth.get(k) ?? 0) + (Number(t.amount) || 0),
    );
  }

  const anchorMonthTxns = amexTransactions.filter(
    (t) => compareMonth(monthKeyFromISO(t.occurredOn), anchorMonth) === 0,
  );

  return (target: MonthKey) =>
    computeBalanceAtEndOf({
      anchorBalance: anchor.balance,
      anchorMonth,
      netChangeByMonth,
      target,
      anchorAt: anchor.asOf,
      anchorMonthTxns,
    });
}

/**
 * Convenience one-shot: compute the Amex end-of-month balance for a
 * single target month identified by its `YYYY-MM-01` start string.
 * Intended for use by a future dashboard "Amex ending balance" tile so
 * it agrees with the Amex page's header for any month.
 */
export function computeAmexEndOfMonthBalance(args: {
  monthStart: string;
  anchor: AmexAnchor | null;
  amexTransactions: ReadonlyArray<AmexTxnInput>;
  fallbackMonth?: MonthKey;
}): number | null {
  const at = makeAmexBalanceAtEndOf({
    anchor: args.anchor,
    amexTransactions: args.amexTransactions,
    fallbackMonth: args.fallbackMonth,
  });
  return at(monthKeyFromISO(args.monthStart));
}
