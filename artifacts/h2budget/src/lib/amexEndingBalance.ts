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
  // (#689) Plaid account type cached on the debt row when it was
  // first linked / refreshed (artifacts/api-server/src/routes/debts.ts
  // sets this to `acct.type`). Used here to filter Amex
  // installment / Pay-Over-Time / "Plan-It" LOAN sub-accounts out of
  // the credit-card ending-balance resolver — they share the "Amex"
  // name on the same login but represent a separate liability that
  // belongs on /debts, not in the Amex card tile.
  type?: string | null;
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

// (#689 round 3) Names that clearly identify an Amex *loan* product
// rather than the revolving credit card. Used by `resolveAmexDebt` to
// keep manually entered loan debts out of the Amex card resolver,
// matching the real user case `{name: "Amex Loan", type: ""}` whose
// $20,000 balance kept showing up in the Amex Ending Balance tile.
// Covers Amex's installment products by name: "Plan-It" / "Plan It",
// "Pay Over Time", "installment", and the generic word "loan".
const AMEX_LOAN_NAME_REGEX =
  /\bloan\b|\bplan[\s-]?it\b|\bpay\s+over\s+time\b|\binstallment\b/i;

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
  // (#748) When the Amex page's card-filter pill is set to a specific
  // card (i.e. NOT "All cards"), narrow the debt anchor to that one
  // card's debts. `debts.plaid_account_id` is the *internal*
  // `plaid_accounts.id` UUID (see lib/db/src/schema/index.ts), NOT the
  // external Plaid `account_id` string that the chip's `value` holds —
  // so the caller must translate the chip's external id via
  // `plaidItemsForScope[].accounts[].accountId → .id` and pass the
  // resulting internal UUID here. Returns `null` when the selected
  // card has no linked debt so the page's anchor fallback chain can
  // take over (server per-card anchor → computed-from-txns) instead
  // of silently collapsing back onto the combined-Amex debt total.
  selectedCardPlaidAccountRowId?: string | null;
}): T | null {
  const {
    debts,
    amexPlaidAccountIds,
    plaidItemsForScope,
    selectedCardPlaidAccountRowId,
  } = args;
  if (!debts || debts.length === 0) return null;
  // (#748) Per-card short-circuit. We match `debt.plaidAccountId`
  // (internal `plaid_accounts.id` UUID) against the caller-translated
  // row id for the selected card. If no debt is linked to that card,
  // we return null — do NOT fall through to the combined-Amex
  // matchers below, otherwise we'd reintroduce the original bug
  // (Blue Cash chip selected → tile shows combined Amex debt).
  if (selectedCardPlaidAccountRowId) {
    const perCard = debts.filter(
      (d) =>
        !!d.plaidAccountId &&
        d.plaidAccountId === selectedCardPlaidAccountRowId &&
        (d.type ?? "").toLowerCase() !== "loan" &&
        !AMEX_LOAN_NAME_REGEX.test(d.name),
    );
    return perCard[0] ?? null;
  }
  // (#689) Pre-filter out Amex installment / Pay-Over-Time / "Plan-It"
  // LOAN sub-accounts before any matching. These share the "Amex"
  // name and even the same Plaid login as the credit card, so without
  // this filter a $20,000 loan balance can be reported as the user's
  // Amex card "Ending Balance" tile. The Amex page is specifically
  // about the revolving credit card; loans belong on /debts.
  //
  // Two-pronged exclusion:
  //  1. `type === 'loan'` — catches Plaid-synced loan sub-accounts.
  //     The server (routes/debts.ts) copies `acct.type` into the
  //     debts row when a Plaid account is auto-linked.
  //  2. Name match against `AMEX_LOAN_NAME_REGEX` — catches manually
  //     entered debts (no Plaid link, `type` empty/null) like the
  //     real user row `{name: "Amex Loan", balance: 20000, type: ""}`
  //     that slipped past round 2 of this fix. Patterns covered:
  //     "loan", "plan-it"/"plan it", "pay over time", "installment".
  //     This intentionally never matches plain "Amex", "Amex
  //     Platinum", "Amex Blue Cash", "American Express Gold", etc.
  const creditCardDebts = debts.filter((d) => {
    const t = (d.type ?? "").toLowerCase();
    if (t === "loan") return false;
    if (AMEX_LOAN_NAME_REGEX.test(d.name)) return false;
    // Delta SkyMiles is a pay-in-full CHARGE card, not revolving Amex credit —
    // exclude it from the ending-balance anchor so it doesn't inflate the Amex
    // chart/tile (~$11.5k). Mirrors reportsBalances' DELTA_RE exclusion. This is
    // Delta-specific and does NOT touch plain "Amex Gold" / "American Express Gold".
    if (/delta/i.test(d.name)) return false;
    return true;
  });
  if (creditCardDebts.length === 0) return null;
  let matches: T[] = [];
  if (amexPlaidAccountIds.size > 0) {
    matches = creditCardDebts.filter(
      (d) => !!d.plaidAccountId && amexPlaidAccountIds.has(d.plaidAccountId),
    );
  }
  if (matches.length === 0) {
    matches = creditCardDebts.filter((d) => AMEX_NAME_REGEX.test(d.name));
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
