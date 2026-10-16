import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ledgerLoaded, useTxDeepLink } from "@/hooks/useTxDeepLink";
import { pinRowInView, stickyClearance } from "@/lib/pinRow";
import { Link, useLocation } from "wouter";
import {
  useListTransactions,
  useUpdateTransaction,
  useBulkUpdateTransactions,
  useListCategories,
  useListDebts,
  useListMappingRules,
  useGetAmexWeeklyPayoff,
  getListTransactionsQueryKey,
  getGetBudgetMonthQueryKey,
  type Transaction,
  type RepointedRule,
  type BulkUpdateTransactionsInput,
} from "@workspace/api-client-react";
import { LedgerChartSkeleton } from "@/components/account-page/account-page-skeleton";
import { Panel } from "@/components/next/Panel";
import { useNearViewport } from "@/hooks/useNearViewport";
import { buildEntries } from "@/pages/next/accounts/entries";
import { QueryRefreshBanner } from "@/components/query-refresh-banner";
import { AMEX_MONTH_LIMIT, amexAllScope, amexMonthParams, amexSummaryParams } from "./amexQueries";
import { displayAmount, formatDisplayAmount } from "@/lib/amountDisplay";
import { SplitByCategoryHost } from "@/components/splits/SplitByCategoryHost";
import {
  useBulkRecategorizePrompt,
  bulkRuleFromRepointed,
  bulkRuleFromRuleAction,
} from "@/hooks/use-bulk-recategorize-prompt";
import { customFetch } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { btnSm, card, emptyNote } from "@/ui";
import { scoped, amexSummaryMatches } from "@/lib/queryState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { TransactionWeeklyBucket } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ruleActionMessage } from "@/lib/ruleActionMessage";
import { useRuleActionUndo } from "@/lib/useRuleActionUndo";
import { formatCurrency } from "@/lib/utils";
import { householdToday } from "@/lib/householdDay";
import type { BucketKey } from "@/components/bucket-bubbles";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { PostLinkProgressBanner } from "@/components/post-link-progress";
import {
  PlaidReauthBannerView,
} from "@/components/plaid-reauth-banner";
import { SyncButton } from "@/components/sync-button";
import { useListPlaidItems } from "@workspace/api-client-react";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { relevantAmexPlaidItemIds } from "@/pages/amexPlaidScope";
import { accountPageHref } from "@/lib/accountPage";
import { currentRowDeepLink, rowDeepLinkStatus } from "@/lib/rowDeepLink";
import { useUrlState } from "@/hooks/useUrlState";
import { modeParam, monthParam, pickParam, urlHasMonth } from "@/lib/ledgerUrl";
import { makeAmexBalanceAtEndOf, resolveAmexDebt } from "@/lib/amexEndingBalance";
import { isCounted } from "@/lib/countedRows";
import { compareNewestFirst } from "@/lib/runningBalance";
import { cardWalkNote, walkCardBalancesBack } from "@/lib/cardBalanceWalk";
import { AmexCardBalances } from "@/components/amex-card-balances";
import {
  AccountPageHeader,
  AccountFilterBar,
  LedgerColumns,
  LedgerPanel,
  usePaneHeight,
  BalanceTrendChart,
  DayGroup,
  MonthNavigator,
  monthKeyOf,
  monthKeyFromISO,
  compareMonth,
  formatMonthLong,
  shiftMonth,
  monthFirstISO,
  monthLastISO,
  type MonthKey,
  type WindowConfig,
} from "@/components/account-page";
import { AmexLogo } from "@/components/brand-logos";
import { AmexCardBand, useAmexCardName } from "@/components/amex-card-band";
import { AmexSummaryPanel, type AmexAttentionGroup, type AmexLinkPeriod } from "@/components/amex-summary";
import { CardPayModes } from "@/components/amex-pay-mode";
import { AmexLedgerRow, AmexRowDetails } from "@/components/amex-row";
import { AddToAvalanche } from "@/components/add-card-to-avalanche";
import { amexLedgerGrid, type AmexRowMode } from "@/components/account-page/ledger-grid";
import { useGetAmexSummary, getGetAmexSummaryQueryKey } from "@workspace/api-client-react/features";
import {
  FIGURE_WORDS,
  amexRowKind,
  amexSummaryPeriod,
  monthNameOf,
  rowInFigure,
  summaryTitle,
  type AmexFigure,
} from "@/lib/amexSummaryView";
import { categoryProvenance, spendingWords } from "@/lib/amexRowWords";
import { shellScrollerOf } from "@/lib/shellScroll";
import { PageGrid } from "@/components/next/PageGrid";
import { cardOrderOf, identityOf, type AccountAccentName, type AccountIdentity } from "@/lib/accountIdentity";
import { TimeRangeToggle } from "@/components/time-range-toggle";
import { currentWeekRange, type RangeMode } from "@/lib/timeRange";
import { buildBalanceWindow } from "@/lib/amexBalanceWindow";
import { cardOwedView, needsLiability } from "@/lib/cardBalance";
import { getListDebtsQueryKey, getGetAmexWeeklyPayoffQueryKey } from "@workspace/api-client-react";

/** (P1) How the rows read: Review (words, the default) or Categorize (the bucket marks). Kept per browser. */
const ROW_MODE_KEY = "amex.rowMode";
function readRowMode(): AmexRowMode {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(ROW_MODE_KEY) === "categorize" ? "categorize" : "review";
  } catch {
    return "review";
  }
}

/** (P1) The To-review group the activity is narrowed to: a snapshot of the server's rows at the click. */
type AttentionLens = {
  group: AmexAttentionGroup;
  rows: ReadonlyArray<{ id: string; date: string }>;
  count: number;
  truncated: boolean;
};
const ATTN_WORDS: Record<AmexAttentionGroup, string> = {
  unplanned: "unplanned",
  unfiled: "not filed yet",
  uncategorized: "with no category",
};

// The "American Express" page is really the credit-cards view: AMEX_SOURCES
// (`lib/amexSources.ts`) folds the Apple Card sources in beside the Amex ones.
// (WP7) Shared with the transaction route rules, so a row this page lists is
// never told it has no ledger.

/** The household calendar day (America/Chicago) of an instant — never the UTC date. */
/** `GET /amex/anchor`'s answer, and the shape the summary's `owed` is read into. */
type AnchorResp = {
  amexEndingBalance: number | null;
  asOf: string;
  source: "debt" | "anchor" | "computed" | "plaid" | "missing";
};

function ymd(d: Date) {
  return householdToday(d);
}

/** The ledger sign rule (`amountDisplay.ts`): a purchase reads "-$12.00", a payment or refund "+$12.00". */
function signedAmount(t: { amount: string; source?: string | null }) {
  return formatDisplayAmount(displayAmount(t.amount, null, t.source));
}

/**
 * A day's money out and money in, apart, in cents: never one sum of absolute values.
 * (F6 round 3) An expired hold is listed but not in the day's totals (`isCounted`).
 */
function dayInOut(items: { amount: string; source?: string | null; expiredHold?: boolean | null }[]) {
  let out = 0;
  let inn = 0;
  for (const t of items) {
    if (!isCounted(t)) continue;
    const c = Math.round(displayAmount(t.amount, null, t.source) * 100);
    if (c < 0) out += -c;
    else inn += c;
  }
  return { out: out / 100, in: inn / 100 };
}

function parseSigned(amount: string) {
  return parseFloat(amount) || 0;
}

function defaultWeeklyBucketFor(categoryName: string): typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket] {
  const n = categoryName.toLowerCase();
  if (n.includes("grocer")) return TransactionWeeklyBucket.groceries;
  if (n.includes("dining") || n.includes("restaurant") || n.includes("food")) return TransactionWeeklyBucket.dining;
  if (n.includes("entertain")) return TransactionWeeklyBucket.entertainment;
  return TransactionWeeklyBucket.misc;
}

function currentBucket(t: Pick<Transaction, "weeklyAllowance" | "monthlyAllowance" | "unplannedAllowance">): "" | "weekly" | "monthly" | "unplanned" {
  if (t.weeklyAllowance) return "weekly";
  if (t.monthlyAllowance) return "monthly";
  if (t.unplannedAllowance) return "unplanned";
  return "";
}

/**
 * `embedded` + `accountId` are used by `/next/accounts/:plaidAccountId`: the
 * page drops its own title (the account page owns it) and opens on one card
 * (external Plaid account_id). Without props it behaves exactly as before.
 */
/**
 * `embedded` + `accountId` are used by `/next/accounts/:plaidAccountId`: the
 * page drops its own title and opens on one card (its external Plaid
 * account_id). (C10) `lead` is a panel the host puts first in the card row
 * (the account page's Summary), so the embedded card reads as one account
 * page. Without props it behaves exactly as before.
 */
export default function AmexPage({
  embedded = false,
  accountId,
  lead,
}: { embedded?: boolean; accountId?: string; lead?: ReactNode; params?: unknown } = {}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { offerBulkRecategorize, previewDialog } = useBulkRecategorizePrompt();
  // (F4) The charge whose "Split by category" dialog is open (from its merchant popover).
  const [splitTx, setSplitTx] = useState<Transaction | null>(null);

  // Auto Plaid refresh on mount is DISABLED to avoid per-pull Plaid
  // charges — banks sync only on the manual Sync button now.

  // Filters
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");
  // (WP7) A link to one row (`?tx=`, with its `?month=`), read once.
  const [rowLink] = useState(currentRowDeepLink);
  // Weekly-first: the ledger defaults to the CURRENT week within the loaded
  // month; Mo/Yr widen it back to the whole month. (The Amex balance chart is
  // an inherently forward-12-month projection, so the toggle scopes the
  // ledger, not that chart.) (WP7) A row link opens Month mode: Week mode hid a
  // row from earlier in the month.
  // (W1) Month, mode and card live in the address (`useUrlState`): a refresh,
  // a shared link and Back/Forward land on the same view. A month, a mode or a
  // row link chose it: the first-load jump below leaves it alone.
  const [rangeMode, setRangeMode] = useUrlState<RangeMode>("mode", modeParam, () =>
    rowLink.tx ? "mo" : "wk",
  );
  // `?card=<external Plaid account_id>` (the section tabs' and the band's link);
  // the older `?accountId=` still opens the same card. Embedded, the route
  // chose the card and the address is left alone.
  const [cardFilter, setCardFilterUrl] = useUrlState<string>("card", pickParam, () => {
    if (accountId) return accountId;
    if (typeof window !== "undefined") {
      const a = new URLSearchParams(window.location.search).get("accountId");
      if (a) return a;
    }
    return "all";
  }, { url: !embedded, push: true });
  // (Q4) A band click is a choice of place, like the section tabs: ONE history
  // entry per card, so Back returns to the card before.
  const setCardFilter = setCardFilterUrl;
  useEffect(() => {
    if (embedded) setCardFilter(accountId ?? "all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, accountId]);
  // (#495) "Hide reviewed" filter — once a row is marked reviewed via the
  // RV bubble it's just clutter, so let users collapse the list down to
  // what's still pending. Persisted to localStorage so it survives a
  // refresh / tab return mid-cleanup session.
  const [hideReviewed, setHideReviewed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("amex.hideReviewed") === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hideReviewed) {
      window.localStorage.setItem("amex.hideReviewed", "1");
    } else {
      window.localStorage.removeItem("amex.hideReviewed");
    }
  }, [hideReviewed]);
  // (P1) Review (words) or Categorize (the bucket marks), kept like Hide reviewed.
  const [rowMode, setRowModeState] = useState<AmexRowMode>(readRowMode);
  useEffect(() => {
    try {
      if (rowMode === "categorize") window.localStorage.setItem(ROW_MODE_KEY, "categorize");
      else window.localStorage.removeItem(ROW_MODE_KEY);
    } catch {
      /* storage unavailable: the mode lasts for this visit */
    }
  }, [rowMode]);
  // (P1) The rows whose details are open. Several may be open; each survives refetches,
  // a mode switch and Hide reviewed (an open row stays listed until it is closed).
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(() => new Set());
  const detailToggles = useRef(new Map<string, HTMLButtonElement>());

  // (#814) Reactive "today" so the forward-looking chart window rolls
  // forward without a reload. `currentMonth` is derived from this, so the
  // chart's subtitle, ticks, today marker, and series advance on their own
  // when the clock crosses into a new day/month — even on a tab that was
  // left open. We bump it on tab focus / visibility change and schedule a
  // timer for the next local midnight (so an idle, focused tab still
  // advances). To avoid needless re-renders, `today` only changes when the
  // local calendar day actually differs from the last value.
  const [today, setToday] = useState<Date>(() => new Date());
  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      setToday((prev) => {
        const next = new Date();
        if (
          next.getFullYear() === prev.getFullYear() &&
          next.getMonth() === prev.getMonth() &&
          next.getDate() === prev.getDate()
        ) {
          return prev; // same calendar day — no state change
        }
        return next;
      });
    };
    const scheduleMidnight = () => {
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        0,
        100,
      );
      timer = setTimeout(() => {
        bump();
        scheduleMidnight();
      }, nextMidnight.getTime() - now.getTime());
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", onVisible);
    scheduleMidnight();
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const currentMonth = useMemo<MonthKey>(() => monthKeyOf(today), [today]);
  // Task #168 — Budget page deep-links into the Amex page when a row's
  // actuals are Amex-dominated. Honor `?month=YYYY-MM-01` from that link
  // so the user lands on the same month they were viewing on Budget.
  // (WP7) A month a link chose (`?month=`, or a row link's) is never moved by
  // the first-load jump below.
  const monthPinnedFromUrlRef = useRef(!!rowLink.tx || urlHasMonth());
  const [selectedMonth, setSelectedMonth] = useUrlState<MonthKey>("month", monthParam, currentMonth);
  // (WP7) The month a row link opened, for "Showing <Month> for the row you opened".
  const rowLinkMonthRef = useRef<MonthKey | null>(rowLink.tx ? selectedMonth : null);

  // (W4) The summary's figure the owner opened (Purchases, Payments, Credits &
  // refunds) filters the activity below; the row a `?tx=` link names is
  // scrolled to and marked.
  const [figure, setFigureState] = useState<AmexFigure | null>(null);
  // (P1) A To-review group's rows (a snapshot of the server's ids). A figure and a group
  // never both narrow the activity: choosing one clears the other.
  const [attn, setAttn] = useState<AttentionLens | null>(null);
  const setFigure = (f: AmexFigure | null) => {
    setAttn(null);
    setFigureState(f);
  };
  const [focusTx, setFocusTx] = useState<string | null>(rowLink.tx);
  useEffect(() => {
    const onPop = () => setFocusTx(new URLSearchParams(window.location.search).get("tx"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const summaryPeriod = useMemo(
    () => amexSummaryPeriod(rangeMode, selectedMonth),
    [rangeMode, selectedMonth],
  );
  const summaryParams = amexSummaryParams(cardFilter, summaryPeriod);
  const summaryRaw = useGetAmexSummary(summaryParams, {
    query: {
      queryKey: getGetAmexSummaryQueryKey(summaryParams),
      enabled: !embedded && summaryPeriod != null,
    },
  });
  // (Q4) The summary on screen is the one for THIS card and period. While the
  // new one loads, the old scope's answer (the all-cards owed) is held back:
  // under another card's heading it is a wrong number.
  const summaryScoped = scoped(summaryRaw, (s) => amexSummaryMatches(s, summaryParams));
  const summaryQ = { ...summaryRaw, data: summaryScoped.data };
  // (P4) The summary answers the anchor question while it is enabled and has
  // not failed; embedded (summary off) or failed, the anchor is asked directly.
  const summaryAnswersAnchor = !embedded && summaryPeriod != null && !summaryQ.isError;

  // Task #168 — apply `?category=<name>` once categories load. Mirrors the
  // Transactions page implementation: matches by category name (the deep
  // link doesn't know the user's category UUIDs) and only runs on first
  // load so manual filter changes aren't clobbered on refetch.
  const categoryUrlApplied = useRef(false);

  // (#485) Two focused queries:
  //   1. `monthQueryParams` — the rows the visible list, stats, and
  //      day-group running balances need. Tightly capped to a single
  //      month so the page paints quickly.
  //   2. `trendQueryParams` — the wider 12-month window the trend
  //      chart needs, plus the rolling ending-balance computation
  //      (`netChangeByMonth`) and Plaid-item scoping. Hydrates after
  //      the list so it never blocks the first paint.
  const MONTH_LIMIT = AMEX_MONTH_LIMIT;
  // ⭐ (WP8b) Why the trend is ONE read of up to 5,000 rows — the size CLAUDE.md
  // §2 bans for list views. The forward chart (`buildBalanceWindow`) and the
  // balance roll-forward to the selected month (`makeAmexBalanceAtEndOf`) need
  // EVERY row of the window, and the server has no aggregate of a card's
  // balance by week yet. The read is bounded by `from`/`to` (the 12-month trend
  // window, out to today and back to the selected month), and this is not a
  // list: no screen lists these rows. The server answers newest first, so at
  // the cap it is the window's OLDEST rows that are left out, and the page says
  // so (`trendCapHit`). A per-week net aggregate on the server retires it.
  const TREND_LIMIT = 5000;
  const sourceParam = useMemo(
    () =>
      sourceFilter && sourceFilter !== "all"
        ? sourceFilter
        : (amexAllScope() as { source: string }).source,
    [sourceFilter],
  );
  // (WP7) Embedded for one card (`/next/accounts/:id`), the page asks for that
  // card's rows by its Plaid account (`plaidAccountId`), so a card from any bank
  // (a Chase Freedom) lists its own rows; the source list named only Amex and
  // Apple Card sources, so such a card's page was empty. Standalone it keeps the
  // source list: "All cards" is the one view that lists the workbook rows.
  const scopeParams = useMemo<{ plaidAccountId: string } | { source: string }>(
    () => (embedded && accountId ? { plaidAccountId: accountId } : { source: sourceParam }),
    [embedded, accountId, sourceParam],
  );
  const monthQueryParams = useMemo(
    () => amexMonthParams(selectedMonth, scopeParams),
    [scopeParams, selectedMonth],
  );
  const trendQueryParams = useMemo(() => {
    const trendStart = shiftMonth(selectedMonth, -11);
    const candidates = [selectedMonth, currentMonth, trendStart];
    let earlier = candidates[0];
    let later = candidates[0];
    for (const c of candidates) {
      if (compareMonth(c, earlier) < 0) earlier = c;
      if (compareMonth(c, later) > 0) later = c;
    }
    return {
      limit: TREND_LIMIT,
      from: monthFirstISO(earlier),
      to: monthLastISO(later),
      ...scopeParams,
    };
  }, [scopeParams, selectedMonth, currentMonth]);

  // (#501) Auto-refresh the visible month when the Amex tab regains
  // focus or the user navigates back to the page. React Query keeps
  // the previously-fetched rows in cache while the background refetch
  // runs, so the list updates in place without flashing the loading
  // skeleton (the skeleton is gated on `isLoading`, which only fires
  // on the *initial* fetch — `isFetching` would, but we don't gate on
  // it). Only the focused month query opts in; the wider 12-month
  // trend query stays lazy to avoid extra work on every focus.
  const monthQ = useListTransactions(monthQueryParams, {
    query: {
      queryKey: getListTransactionsQueryKey(monthQueryParams),
      // Inherits TXN_CACHE (2 min); sync + txn mutations invalidate the
      // key, so always-refetch only re-pulled a large payload per mount.
    },
  });
  // (Q4) Rows of ANOTHER month (kept while this month loads) are not this
  // month's rows: they would be filtered to nothing ("No transactions match").
  const monthTxns = monthQ.isPlaceholderData ? undefined : monthQ.data;
  const isLoading = monthQ.isLoading;
  const monthSwitching = monthQ.isPlaceholderData === true;
  const { data: categories } = useListCategories();
  const { data: debts, isError: debtsFailed } = useListDebts();
  // Combined statement balance across the live Amex cards — used as the
  // all-cards forward-chart anchor when no debt/anchor is resolved (otherwise
  // the projection collapses to a flat $0 line).
  const { data: amexPayoff } = useGetAmexWeeklyPayoff();
  const { data: mappingRules } = useListMappingRules();
  // Server-provided Amex anchor: fallback used when the Amex debt row is
  // missing or renamed.
  const {
    data: amexAnchorQ,
    isLoading: amexAnchorQLoading,
    isError: amexAnchorError,
    fetchStatus: amexAnchorQFetchStatus,
  } = useQuery<AnchorResp>({
    queryKey: ["/api/amex/anchor"],
    queryFn: () => customFetch("/api/amex/anchor", { method: "GET" }),
    staleTime: 60_000,
    // (P4) Where the summary is enabled, its `owed` IS this answer (the same
    // call), so the page asks once. Disabled only while the summary can answer.
    enabled: !(summaryAnswersAnchor && cardFilter === "all"),
  });
  // (#748) Per-card anchor query. Only fires when the user picks a
  // specific card chip — the combined `amexAnchorResp` above keeps
  // powering "All cards". Cached under a separate queryKey per card so
  // switching chips doesn't blow away the combined cache (or vice
  // versa).
  const {
    data: amexAnchorPerCardQ,
    fetchStatus: amexAnchorPerCardQFetchStatus,
    isError: amexAnchorPerCardFailed,
  } = useQuery<AnchorResp>({
    queryKey: ["/api/amex/anchor", cardFilter],
    queryFn: () =>
      customFetch(
        `/api/amex/anchor?accountId=${encodeURIComponent(cardFilter)}`,
        { method: "GET" },
      ),
    enabled: cardFilter !== "all" && !summaryAnswersAnchor,
    staleTime: 60_000,
    // (Q4) Another card's anchor is not this card's: no kept-over answer.
    placeholderData: undefined,
  });
  // (P4) The summary's `owed` is the anchor's own answer (same call, same
  // card), so where the summary is on, the anchor comes from it. The last
  // answer for THIS card is kept across month changes (owed is the card's
  // current balance, not the period's), so the figure never blinks.
  // (Q4) Derived, not written during render: the answer for this card and
  // period, else the last answer for THIS card (kept in state, keyed by card).
  const [owedKept, setOwedKept] = useState<{ card: string; owed: NonNullable<typeof summaryQ.data>["owed"] } | null>(null);
  const owedNow = summaryQ.data?.owed;
  useEffect(() => {
    if (owedNow) setOwedKept((prev) =>
        prev && prev.card === cardFilter && JSON.stringify(prev.owed) === JSON.stringify(owedNow) ? prev : { card: cardFilter, owed: owedNow },
      );
  }, [owedNow, cardFilter]);
  const owedHere = owedNow
    ? owedNow
    : owedKept?.card === cardFilter
      ? owedKept.owed
      : null;
  const anchorFromSummary: AnchorResp | undefined =
    summaryAnswersAnchor && owedHere
      ? {
          amexEndingBalance: owedHere.current == null ? null : Number(owedHere.current),
          asOf: owedHere.asOf ?? "",
          source: owedHere.source,
        }
      : undefined;
  // Waiting on the summary is "fetching", exactly as waiting on the anchor was.
  const waitingOnSummary = summaryAnswersAnchor && !owedHere;
  const amexAnchorResp = amexAnchorQ ?? (cardFilter === "all" ? anchorFromSummary : undefined);
  const amexAnchorPerCardResp = amexAnchorPerCardQ ?? (cardFilter !== "all" ? anchorFromSummary : undefined);
  const amexAnchorLoading = amexAnchorQLoading || (waitingOnSummary && cardFilter === "all");
  const amexAnchorFetchStatus = waitingOnSummary && cardFilter === "all" ? "fetching" : amexAnchorQFetchStatus;
  const amexAnchorPerCardFetchStatus =
    waitingOnSummary && cardFilter !== "all" ? "fetching" : amexAnchorPerCardQFetchStatus;

  // (P4) The 12-month trend (up to 5,000 rows) feeds the balance chart, the
  // running balances of a PAST month, and the first-load jump to the latest
  // month. It starts when the chart is near the viewport, or at once when one
  // of those needs it, so no figure on the page changes — only WHEN it loads.
  const [trendSlotRef, chartNear] = useNearViewport();
  const anchorNeedsRows =
    amexAnchorError ||
    amexAnchorResp?.source === "computed" ||
    amexAnchorResp?.source === "missing";
  const trendNeeded =
    chartNear ||
    cardFilter !== "all" ||
    compareMonth(selectedMonth, currentMonth) !== 0 ||
    (!monthPinnedFromUrlRef.current && monthTxns !== undefined && monthTxns.length === 0) ||
    anchorNeedsRows;
  const wideQ = useListTransactions(trendQueryParams, {
    query: { queryKey: getListTransactionsQueryKey(trendQueryParams), enabled: trendNeeded },
  });
  const trendFailed = wideQ.isError;
  // (Q4) Another window's rows are not this window's.
  const wideTxns = wideQ.isPlaceholderData ? undefined : wideQ.data;
  const updateTx = useUpdateTransaction();
  const bulkUpdateTx = useBulkUpdateTransactions();
  const buildRuleUndoAction = useRuleActionUndo();

  // "Set actual balance" popover (only surfaced when ending balance source
  // is "computed"). Persists the typed value to the server-side anchor at
  // settings.preferences.amexAnchor so the chip flips back to "From saved
  // anchor" on next refresh.
  const [anchorOpen, setAnchorOpen] = useState(false);
  const [anchorInput, setAnchorInput] = useState("");
  const [anchorSaving, setAnchorSaving] = useState(false);
  const [anchorClearing, setAnchorClearing] = useState(false);
  const clearAnchor = async () => {
    setAnchorClearing(true);
    try {
      await customFetch("/api/amex/anchor", { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["/api/amex/anchor"] });
      setAnchorOpen(false);
      setAnchorInput("");
      toast({
        title: "Cleared saved anchor",
        description:
          "The chip will now use your linked debt or computed balance.",
      });
    } catch (e) {
      toast({
        title: "Couldn't clear anchor",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setAnchorClearing(false);
    }
  };
  const submitAnchor = async () => {
    const n = Number(anchorInput);
    if (!Number.isFinite(n)) {
      toast({
        title: "Enter a valid balance",
        description: "Use a number like 1293.08.",
        variant: "destructive",
      });
      return;
    }
    setAnchorSaving(true);
    try {
      await customFetch("/api/amex/anchor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balance: n, asOf: new Date().toISOString() }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/amex/anchor"] });
      setAnchorOpen(false);
      setAnchorInput("");
      toast({
        title: "Saved actual balance",
        description: "The chip now shows your saved anchor.",
      });
    } catch (e) {
      toast({
        title: "Couldn't save balance",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setAnchorSaving(false);
    }
  };

  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // (#629) Resolve the system-managed "Ignore" category id once so we can
  // dim Ignore'd rows. Same lookup-by-name as `category-picker.tsx` —
  // Uncategorized/Transfer also carry `excludeFromBudget` but aren't the
  // user-pickable "Ignore" row this dimming targets.
  const ignoreCatId = useMemo(
    () => (categories ?? []).find((c) => c.name === "Ignore")?.id ?? null,
    [categories],
  );

  // Task #168 — once categories load, resolve `?category=<name>` from the
  // URL into the matching id and seed the filter dropdown with it. Guarded
  // so it only fires once; subsequent dropdown changes by the user stick.
  useEffect(() => {
    if (categoryUrlApplied.current || !categories?.length) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const catName = params.get("category");
    if (!catName) {
      categoryUrlApplied.current = true;
      return;
    }
    const match = categories.find((c) => c.name === catName);
    if (match) {
      setCategoryFilter(match.id);
    }
    categoryUrlApplied.current = true;
  }, [categories]);

  // (#485) `monthAll` drives the visible list/stats/filters and resolves
  // immediately from the focused month query. `wideAll` covers the rolling
  // 12-month window the trend chart and ending-balance roll-forward need.
  // Until the wider query hydrates, `wideAll` falls back to `monthAll` so
  // memos derived from it still produce reasonable values for the
  // selected month.
  const monthAll = monthTxns ?? [];
  const wideAll = wideTxns ?? monthAll;

  // On first load, never open to an empty ledger when Amex data exists. If the
  // latest data is in a PAST month, jump the navigator there (past months show
  // the whole month). If the latest data is the CURRENT month but this week has
  // no charges, drop the "Wk" scope to "Mo" so the month's charges are visible.
  const initialAmexJumpDone = useRef(false);
  useEffect(() => {
    if (initialAmexJumpDone.current) return;
    // (WP7) A link chose the month (and a row link, Month mode): keep both.
    if (monthPinnedFromUrlRef.current) {
      initialAmexJumpDone.current = true;
      return;
    }
    if (wideAll.length === 0) return; // wait for data to arrive
    initialAmexJumpDone.current = true;
    let latest: MonthKey | null = null;
    for (const t of wideAll) {
      const mk = monthKeyFromISO(t.occurredOn);
      if (!latest || compareMonth(mk, latest) > 0) latest = mk;
    }
    if (!latest) return;
    if (compareMonth(latest, currentMonth) !== 0) {
      setSelectedMonth(latest);
      return;
    }
    const wr = currentWeekRange();
    const thisWeekHasData = wideAll.some((t) => {
      const k = t.occurredOn.slice(0, 10);
      return (
        compareMonth(monthKeyFromISO(t.occurredOn), currentMonth) === 0 &&
        k >= wr.from &&
        k <= wr.to
      );
    });
    if (!thisWeekHasData) setRangeMode("mo");
  }, [wideAll, currentMonth]);

  // (#485) When the month query hits the server cap, surface a small hint
  // so users know their filters need to narrow rather than silently
  // truncating.
  const monthCapHit = monthAll.length >= MONTH_LIMIT;
  // (WP8b) The trend read reached its cap: its oldest rows are left out.
  const trendCapHit = (wideTxns?.length ?? 0) >= TREND_LIMIT;

  // Members from server-returned set so the dropdown reflects current source.
  const members = useMemo(() => {
    const s = new Set<string>();
    for (const t of monthAll) if (t.member) s.add(t.member);
    return Array.from(s).sort();
  }, [monthAll]);

  // The month query is already server-scoped to the selected month, but
  // we still pin the filter as a safety net (e.g. if a future caller
  // widens the query without updating this scope).
  const monthScoped = useMemo(() => {
    return monthAll.filter((t) => {
      const mk = monthKeyFromISO(t.occurredOn);
      return compareMonth(mk, selectedMonth) === 0;
    });
  }, [monthAll, selectedMonth]);

  // Apply client-side filters.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Weekly-first: when viewing the current month in Wk mode, scope the
    // ledger to this Sun–Sat week. On a past month (no "this week" in it) or
    // in Mo/Yr mode, fall back to the full loaded month.
    const weekR =
      rangeMode === "wk" && compareMonth(selectedMonth, currentMonth) === 0
        ? currentWeekRange()
        : null;
    return monthScoped.filter((t) => {
      const k = t.occurredOn.slice(0, 10);
      if (weekR && (k < weekR.from || k > weekR.to)) return false;
      if (from && k < from) return false;
      if (to && k > to) return false;
      if (memberFilter !== "all" && (t.member ?? "") !== memberFilter)
        return false;
      if (cardFilter !== "all" && (t.plaidAccountId ?? "") !== cardFilter)
        return false;
      // (P1) A row whose details are open stays listed until they close.
      if (hideReviewed && t.reviewed && !openDetails.has(t.id)) return false;
      if (figure && !rowInFigure(figure, amexRowKind(t, categories))) return false;
      if (categoryFilter !== "all") {
        if (categoryFilter === "uncategorized") {
          if (t.categoryId) return false;
        } else if (t.categoryId !== categoryFilter) return false;
      }
      if (q) {
        const hay = `${t.description} ${categoryById.get(t.categoryId ?? "") ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [monthScoped, search, memberFilter, cardFilter, categoryFilter, categoryById, from, to, hideReviewed, rangeMode, selectedMonth, currentMonth, figure, categories, openDetails]);

  // (P1) A To-review group narrows the activity to the server's rows for it, as they were
  // when it was chosen (a row filed since stays on screen, so the person sees it resolved).
  // It bypasses the week, Hide reviewed, the search and the category filter: those rows
  // ARE what the person asked to see. Rows of another month are counted in the note.
  const attnIds = useMemo(() => (attn ? new Set(attn.rows.map((r) => r.id)) : null), [attn]);
  const shown = useMemo(() => {
    if (!attnIds) return filtered;
    return monthScoped.filter((t) => attnIds.has(t.id) && (cardFilter === "all" || (t.plaidAccountId ?? "") === cardFilter));
  }, [attnIds, filtered, monthScoped, cardFilter]);
  const attnInMonth = attn ? attn.rows.filter((r) => compareMonth(monthKeyFromISO(r.date), selectedMonth) === 0).length : 0;
  const attnElsewhere = useMemo(() => {
    if (!attn) return null;
    const months = new Map<string, number>();
    for (const r of attn.rows) {
      const mk = monthKeyFromISO(r.date);
      if (compareMonth(mk, selectedMonth) === 0) continue;
      const key = r.date.slice(0, 7);
      months.set(key, (months.get(key) ?? 0) + 1);
    }
    if (months.size === 0) return null;
    // The newest month holding any of them is the one offered.
    const newest = [...months.keys()].sort().reverse()[0]!;
    const total = [...months.values()].reduce((a, b) => a + b, 0);
    return { total, month: monthKeyFromISO(`${newest}-01`), single: months.size === 1 };
  }, [attn, selectedMonth]);

  // Group by day (descending). Within each day, sort newest-first via
  // the canonical comparator so the per-row "bal $X" running statement
  // balance shown beside each row matches the order in which
  // `walkCardBalancesBack` walked the list.
  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of shown) {
      const k = t.occurredOn.slice(0, 10);
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    for (const arr of map.values()) arr.sort(compareNewestFirst);
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [shown]);

  // (W4) Scroll to the row a `?tx=` link named, once its month's rows have
  // loaded, and mark it.
  const focusedRef = useRef<string | null>(null);
  const pinCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => pinCancelRef.current?.(), []);
  // (P1) One row per transaction, phone and desktop alike.
  const nodesFor = (id: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="row-amex-${id}"]`));
  useEffect(() => {
    if (!focusTx) {
      focusedRef.current = null;
      return;
    }
    if (typeof document === "undefined") return;
    const nodes = nodesFor(focusTx);
    const el = nodes.find((n) => n.offsetParent !== null) ?? nodes[0];
    if (!el) return;
    el.setAttribute("data-focused", "true");
    el.style.outline = "2px solid var(--color-brand-navy, #19315b)";
    el.style.outlineOffset = "-2px";
    // Scroll once per row; the mark is re-applied whenever the rows re-render.
    if (focusedRef.current !== focusTx) {
      focusedRef.current = focusTx;
      // One scroll, after the row exists, below the pinned pane (the row's own
      // scroll-margin-top clears the sticky stack).
      el.scrollIntoView?.({ block: "start" });
      // Content above the row (the chart slot, the summary) can still change
      // height: hold the row where it landed until the person scrolls.
      pinCancelRef.current?.();
      pinCancelRef.current = pinRowInView(
        () => nodesFor(focusTx).find((n) => n.offsetParent !== null) ?? null,
        // The live bottom of the pinned pane + the row's day head, read each frame.
        { clearance: (row) => stickyClearance(row, paneRef.current) },
      );
    }
    return () => {
      el.removeAttribute("data-focused");
      el.style.outline = "";
      el.style.outlineOffset = "";
    };
  }, [focusTx, groups]);

  // Distinct Plaid account IDs present on the Amex-source transactions.
  // These identify the actual Amex card account(s) feeding this page.
  // (Q6b r3 review B) Plus every card the band knows (GET /amex/weekly-payoff): a newly
  // linked or dormant card has no rows yet, and the band still offers it.
  const amexPlaidAccountIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of wideAll) {
      if (t.plaidAccountId) s.add(t.plaidAccountId);
    }
    // `accountId` is the external Plaid account_id on both (`plaidAccountId` there is the internal row id).
    for (const c of amexPayoff?.cards ?? []) s.add(c.accountId);
    for (const c of amexPayoff?.debtLinkedCards ?? []) s.add(c.accountId);
    return s;
  }, [wideAll, amexPayoff]);

  // (#373) Mirror the Chase page's per-page item scoping. Map the Amex
  // card(s) currently shown back to their owning Plaid item id(s) so the
  // re-auth banner, the header SyncButton's inline error chip / Reconnect
  // popover, and the per-item "Refresh from Plaid" button only react to
  // the Plaid item(s) that own this page's data — Chase issues never
  // bleed onto the Amex page (and vice versa).
  const { data: plaidItemsForScope } = useListPlaidItems();
  // (T4) The household link carries the card: Spending's `?account=` is the plaid_accounts row id, the Amex filter the external one. Omitted when unknown.
  const whyAccountRowId = useMemo(
    () =>
      cardFilter === "all"
        ? undefined
        : buildEntries(plaidItemsForScope).find((e) => e.plaidAccountId === cardFilter)?.rowId,
    [cardFilter, plaidItemsForScope],
  );
  // Defense-in-depth scope signal: any debt that looks like Amex (by
  // name) and carries a `plaidAccountId` (internal row id) — covers
  // the freshly-linked-but-no-transactions case where the txn-derived
  // signal is empty.
  const amexDebtAccountRowIds = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const d of debts ?? []) {
      if (
        d.plaidAccountId &&
        /amex|american\s*express/i.test(d.name)
      ) {
        s.add(d.plaidAccountId);
      }
    }
    return s;
  }, [debts]);
  const relevantPlaidItemIds = useMemo<string[]>(
    () =>
      relevantAmexPlaidItemIds(
        plaidItemsForScope,
        amexPlaidAccountIds,
        amexDebtAccountRowIds,
      ),
    [amexPlaidAccountIds, amexDebtAccountRowIds, plaidItemsForScope],
  );
  const scopedPlaidItems = useMemo(() => {
    const items = plaidItemsForScope ?? [];
    if (relevantPlaidItemIds.length === 0) return [];
    const allow = new Set(relevantPlaidItemIds);
    return items.filter((it) => allow.has(it.id));
  }, [plaidItemsForScope, relevantPlaidItemIds]);
  // Map external Plaid `account_id` → short display label for the source
  // card (e.g. "Amex Gold ••1002"). Built from the linked Plaid items so
  // each Amex transaction row can show which physical card it came from.
  const cardLabelByPlaidAccountId = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of plaidItemsForScope ?? []) {
      for (const a of it.accounts ?? []) {
        const name = (a.name ?? a.officialName ?? "").trim();
        const mask = (a.mask ?? "").trim();
        let label: string;
        if (name && mask) label = `${name} ••${mask}`;
        else if (name) label = name;
        else if (mask) label = `••${mask}`;
        else continue;
        m.set(a.accountId, label);
      }
    }
    return m;
  }, [plaidItemsForScope]);
  // (C10) External Plaid account_id → the account's identity accent (Amex
  // teal; another card — an Apple Card on this page — its own token), for the
  // dot beside each row's card label. Colour only: the label names the card.
  const accentByPlaidAccountId = useMemo(() => {
    const flat = (plaidItemsForScope ?? []).flatMap((it) =>
      (it.accounts ?? []).map((a) => ({
        accountId: a.accountId,
        input: {
          id: a.id,
          name: a.name,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          institutionName: it.institutionName,
          institutionSlug: it.institutionSlug,
        },
      })),
    );
    const cardOrder = cardOrderOf(flat.map((f) => f.input));
    const m = new Map<string, AccountAccentName>();
    for (const f of flat) m.set(f.accountId, identityOf(f.input, { cardOrder }).accent);
    return m;
  }, [plaidItemsForScope]);
  // Card filter options — every Plaid Amex card currently feeding the
  // page, derived from the same `cardLabelByPlaidAccountId` map the
  // per-row card labels use, scoped to the cards that actually appear
  // in the visible (source-filtered) transactions.
  const cardFilterOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const id of amexPlaidAccountIds) {
      if (seen.has(id)) continue;
      const label = cardLabelByPlaidAccountId.get(id);
      if (!label) continue;
      seen.add(id);
      opts.push({ value: id, label });
    }
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }, [amexPlaidAccountIds, cardLabelByPlaidAccountId]);

  // If the selected card disappears (e.g. user changes source filter to
  // CSV-only), fall back to "All cards" so the page doesn't render empty.
  // (D3) Only once the options CAN be known — the month's rows and the linked
  // items have both answered. On a cold load the options are empty for a
  // moment, and resetting then dropped a `?accountId=` deep link to "All
  // cards" for good. Embedded, the route chose the card: never reset it.
  useEffect(() => {
    if (cardFilter === "all") return;
    if (embedded) return;
    if (monthTxns === undefined || plaidItemsForScope === undefined) return;
    // (Q6b r3) The options come from the 12-month rows: wait for them, or a card with no rows in
    // this month (or a failed wide read) drops to "All cards" on its own.
    if (wideTxns === undefined) return;
    // (Q6b r3 review B) …and for the band's cards, so a card with no rows yet is kept.
    if (amexPayoff === undefined) return;
    if (!cardFilterOptions.some((o) => o.value === cardFilter)) {
      setCardFilter("all", { replace: true });
    }
  }, [cardFilter, cardFilterOptions, embedded, monthTxns, plaidItemsForScope, wideTxns, amexPayoff]);

  const { runSync } = usePlaidSync();
  const handleRefreshAmex = () => {
    if (relevantPlaidItemIds.length === 0) return;
    // Sync every Amex-owning Plaid item in scope so multi-card / multi-
    // item households don't get a partial refresh from a single click.
    for (const itemId of relevantPlaidItemIds) {
      // This is the deliberate "Refresh from Plaid" action — force a
      // billable refresh so the live liability balance + pending charges
      // update. (Currently unwired; keeps intent correct if bound later.)
      void runSync({ itemId, force: true });
    }
  };

  // Find the linked Amex debt (if any) for the anchor balance. Prefer
  // matching by the Plaid account that actually feeds this page's
  // transactions so renaming the debt doesn't break the link. Fall back
  // to the legacy name regex when no Plaid link exists on either side.
  //
  // (#416) When the user's Amex login owns multiple physical cards (e.g.
  // three cards under one Plaid item, each with its own debt row), sum
  // the balances and adopt the most recent updatedAt as the anchor's
  // asOf so the Ending Balance tile reflects the combined liability
  // across every card on this page rather than just the first match.
  // (#574) Anchor-debt resolution lives in `@/lib/amexEndingBalance` so
  // the dashboard's "Amex ending balance" tile uses the exact same logic
  // and the two surfaces can never drift on which debt(s) feed the anchor.
  // (#748) Map the external Plaid `account_id` (chip value) → internal
  // `plaid_accounts.id` UUID so the per-card debt lookup (which keys
  // on the internal id; see schema/index.ts) can find the right debt.
  const externalAccountIdToRowId = useMemo(() => {
    const m = new Map<string, string>();
    for (const item of plaidItemsForScope ?? []) {
      for (const a of item.accounts ?? []) {
        if (a.accountId && a.id) m.set(a.accountId, a.id);
      }
    }
    return m;
  }, [plaidItemsForScope]);
  const selectedCardRowId = useMemo(
    () =>
      cardFilter === "all"
        ? null
        : (externalAccountIdToRowId.get(cardFilter) ?? null),
    [cardFilter, externalAccountIdToRowId],
  );
  const amexDebt = useMemo(
    () =>
      resolveAmexDebt({
        debts,
        amexPlaidAccountIds,
        plaidItemsForScope,
        // (#748) When a specific card is selected, scope the debt
        // anchor to that single card so the Ending Balance tile shows
        // the right per-card value instead of falling back to the
        // combined-Amex roll-up.
        selectedCardPlaidAccountRowId: selectedCardRowId,
      }),
    [debts, amexPlaidAccountIds, plaidItemsForScope, selectedCardRowId],
  );

  // Resolve the anchor (balance + as-of timestamp) from either the linked
  // Amex debt or the server-side anchor fallback.
  const resolvedAnchor = useMemo(() => {
    let anchor: number | null = null;
    let resolvedSource: "debt" | "anchor" | "computed" | "plaid" = "debt";
    let asOf: string | null = null;
    // (#651) Trust the server's resolved anchor first — it now prefers
    // the live Plaid liability balance over the cached `debts.balance`
    // row, which is the source of truth the user expects to see in the
    // Ending Balance tile. Fall back to the local debt row only while
    // the server response is still loading or genuinely missing.
    if (
      amexAnchorResp &&
      amexAnchorResp.amexEndingBalance !== null &&
      amexAnchorResp.source !== "missing"
    ) {
      anchor = amexAnchorResp.amexEndingBalance;
      resolvedSource =
        amexAnchorResp.source === "debt" ? "anchor" : amexAnchorResp.source;
      asOf = amexAnchorResp.asOf ?? null;
    } else if (amexDebt) {
      anchor = parseSigned(amexDebt.balance);
      resolvedSource = "debt";
      asOf = amexDebt.lastBalanceUpdate ?? amexDebt.plaidLastSyncedAt ?? null;
    }
    return { anchor, resolvedSource, asOf };
  }, [amexDebt, amexAnchorResp]);

  // (#748) When a single Amex card is selected via the pill row, scope
  // both the anchor and the transaction series so the Ending Balance
  // tile, the per-row running balance, and the 12-month trend chart
  // all reflect just that card. When "All cards" is active, fall
  // through to the existing combined-anchor + combined-transactions
  // behavior so the prior roll-up view is preserved exactly.
  const cardScopedDebt = useMemo(() => {
    if (cardFilter === "all" || !selectedCardRowId) return null;
    // (#748) Match the internal `plaid_accounts.id` UUID, not the
    // external account_id chip value — see externalAccountIdToRowId.
    for (const d of debts ?? []) {
      if (d.plaidAccountId && d.plaidAccountId === selectedCardRowId) return d;
    }
    return null;
  }, [debts, cardFilter, selectedCardRowId]);

  const cardScopedAnchor = useMemo(() => {
    if (cardFilter === "all") {
      if (resolvedAnchor.anchor !== null) return resolvedAnchor;
      // No debt/anchor resolved for the combined view — anchor at the combined
      // statement balance so the forward chart projects a real line instead of
      // collapsing to a flat $0. (Nothing invented: it's the cards' own balance.)
      const combined = Number(amexPayoff?.combinedStatementBalance);
      if (Number.isFinite(combined) && combined !== 0) {
        return {
          anchor: combined,
          resolvedSource: "computed" as const,
          asOf: null,
        };
      }
      return resolvedAnchor;
    }
    // ⭐ (WP8b) ONE CARD RUNS ON ITS OWN CURRENT BALANCE — the card model's
    // `creditorCurrent` (WP3), the figure the account Summary labels "Card's
    // current balance", from the same inputs: the card's debt row, or Plaid's
    // stored liability balance when the card has no debt row or an archived
    // one (`needsLiability`). The per-card /api/amex/anchor answers that Plaid
    // figure for ANY credit card (it answered only the Amex set). Never the
    // netted Owed: the rows below are the card's own activity. With no figure
    // there is no anchor — no running "bal", no chart, and the pane says so;
    // never a running sum from $0 (a non-Amex card's page ran its "bal" and its
    // chart up from a $0 "Calculated" balance while its Summary showed the
    // card's real one).
    // The debts read decides which input applies: wait for it.
    if (debts === undefined) {
      return { anchor: null, resolvedSource: "plaid" as const, asOf: null };
    }
    const plaidFigure =
      amexAnchorPerCardResp?.source === "plaid" &&
      amexAnchorPerCardResp.amexEndingBalance !== null
        ? {
            balance: String(amexAnchorPerCardResp.amexEndingBalance),
            lastFetchedAt: amexAnchorPerCardResp.asOf ?? null,
          }
        : null;
    const fromPlaid = needsLiability(cardScopedDebt) && plaidFigure !== null;
    const creditor = cardOwedView({
      debt: cardScopedDebt,
      liability: fromPlaid ? plaidFigure : null,
    }).creditorCurrent;
    if (!creditor) {
      return { anchor: null, resolvedSource: "plaid" as const, asOf: null };
    }
    if (fromPlaid) {
      return { anchor: creditor.balance, resolvedSource: "plaid" as const, asOf: creditor.asOf };
    }
    // The debt row's figure. The anchor month keeps its established as-of
    // (`lastBalanceUpdate ?? plaidLastSyncedAt`), so no running "bal" moves.
    return {
      anchor: creditor.balance,
      resolvedSource: "debt" as const,
      asOf:
        cardScopedDebt?.lastBalanceUpdate ??
        cardScopedDebt?.plaidLastSyncedAt ??
        null,
    };
  }, [cardFilter, cardScopedDebt, debts, resolvedAnchor, amexAnchorPerCardResp, amexPayoff]);
  // (WP8b) The selected card's figure is still being read (the debts, or the
  // per-card anchor): no words about a missing balance yet. A read that failed
  // is said as that.
  const cardAnchorPending =
    cardFilter !== "all" &&
    ((debts === undefined && !debtsFailed) ||
      (amexAnchorPerCardResp === undefined &&
        amexAnchorPerCardFetchStatus === "fetching"));
  const cardAnchorFailed =
    cardFilter !== "all" &&
    ((debts === undefined && debtsFailed) ||
      (amexAnchorPerCardResp === undefined && amexAnchorPerCardFailed));

  const wideAllForBalance = useMemo(() => {
    if (cardFilter === "all") return wideAll;
    return wideAll.filter((t) => (t.plaidAccountId ?? "") === cardFilter);
  }, [wideAll, cardFilter]);

  // (#476) Pre-build the shared end-of-month balance closure once per
  // (anchor + transactions) change. Both the visible-month
  // `endingBalance` tile and the forward-looking `balanceWindow` chart
  // call through this same closure so they always agree, and the same
  // helper backs the (future) dashboard "Amex ending balance" tile.
  const balanceAtEndOf = useMemo(
    () =>
      makeAmexBalanceAtEndOf({
        anchor:
          cardScopedAnchor.anchor === null
            ? null
            : { balance: cardScopedAnchor.anchor, asOf: cardScopedAnchor.asOf },
        amexTransactions: wideAllForBalance,
        fallbackMonth: currentMonth,
      }),
    [
      cardScopedAnchor.anchor,
      cardScopedAnchor.asOf,
      wideAllForBalance,
      currentMonth,
    ],
  );

  const endingBalance = useMemo(() => {
    if (cardScopedAnchor.anchor === null) {
      // (#483) Treat the tile as "loading" only while the anchor query
      // is genuinely in flight (initial fetch with no cached data).
      // Once the response has landed (or errored out), fall through to
      // the existing "Not set" empty state so the tile never sits on
      // "Loading…" indefinitely when the server resolves to missing.
      const loading =
        amexAnchorLoading &&
        amexAnchorFetchStatus === "fetching" &&
        amexAnchorResp === undefined &&
        !amexAnchorError;
      return {
        value: null as number | null,
        source: (loading ? "loading" : "missing") as "loading" | "missing",
        asOf: null as string | null,
      };
    }
    // (#748) When a card chip is active and the per-card anchor query
    // is still in flight (first hit for that chip, no cached data),
    // show the loading state instead of momentarily flashing the
    // tier-3 $0 computed fallback while the network request resolves.
    if (
      cardFilter !== "all" &&
      !cardScopedDebt &&
      amexAnchorPerCardResp === undefined &&
      amexAnchorPerCardFetchStatus === "fetching"
    ) {
      return {
        value: null as number | null,
        source: "loading" as const,
        asOf: null as string | null,
      };
    }
    return {
      value: balanceAtEndOf(selectedMonth),
      source: cardScopedAnchor.resolvedSource,
      asOf: cardScopedAnchor.asOf,
    };
  }, [
    cardScopedAnchor,
    amexAnchorResp,
    amexAnchorLoading,
    amexAnchorFetchStatus,
    amexAnchorError,
    amexAnchorPerCardResp,
    amexAnchorPerCardFetchStatus,
    cardFilter,
    cardScopedDebt,
    balanceAtEndOf,
    selectedMonth,
  ]);

  // Anchor every same-day balance assignment to the canonical
  // newest-first comparator so the "bal $X" register-style statement
  // balance shown beside each row matches the row's actual position
  // in the day list. Computed off the full month (pre-filter) so that
  // typing in Search / picking a category doesn't reshuffle the
  // displayed balances.
  // ⭐ (Q3) ONE CARD'S rows, walked as what the card OWES
  // (`walkCardBalancesBack`): a purchase raised it, a payment or a refund
  // lowered it, whatever sign the row's source stores. Posted rows only — a
  // pending row shows no "bal". "All cards" has none: the cards' balances are
  // read at different times, from different sources, and a combined walk
  // would mix them; each card's balance shows in the panel instead.
  const cardMonthRows = useMemo(
    () =>
      cardFilter === "all"
        ? []
        : monthScoped.filter((t) => (t.plaidAccountId ?? "") === cardFilter),
    [monthScoped, cardFilter],
  );
  const runningBalanceMap = useMemo(() => {
    if (cardFilter === "all" || endingBalance.value === null) return new Map<string, number>();
    return walkCardBalancesBack(cardMonthRows, endingBalance.value);
  }, [cardMonthRows, endingBalance.value, cardFilter]);

  // (WP3) Say what the register's "bal" runs on when it is the card's own
  // debt row, and put the netted Owed beside it, second: the account Summary
  // and the dashboard lead with Owed, and this is the same card.
  // (WP8b) The same words when it is Plaid's figure for the card, and words —
  // never a $0 — when the card has no figure at all.
  const anchorNote = useMemo(() => {
    if (cardFilter === "all") return null;
    if (cardScopedAnchor.anchor === null) {
      if (cardAnchorFailed) return "The card's balance did not load, so there is no running balance or chart.";
      if (cardAnchorPending) return null;
      return "No running balance or chart: this card has not reported a current balance yet.";
    }
    if (endingBalance.value === null) return null;
    // (Q3) What the "bal" figures count from: the card's current balance and
    // its date, or — for a month before it — that month's end. A debt row's
    // figure prints the date the account Summary prints for it.
    const debtView =
      cardScopedAnchor.resolvedSource !== "plaid" && cardScopedDebt
        ? cardOwedView({ debt: cardScopedDebt })
        : null;
    const lead = cardWalkNote({
      anchor: { balance: cardScopedAnchor.anchor, asOf: cardScopedAnchor.asOf },
      ...(debtView?.creditorCurrent ? { shownAsOf: debtView.creditorCurrent.asOf } : {}),
      selectedMonth,
      monthEndBalance: endingBalance.value,
      monthRows: cardMonthRows,
      fallbackMonth: currentMonth,
    });
    if (!debtView || debtView.owed == null || !debtView.pending) return lead;
    return `${lead} Owed after payments not yet posted: ${formatCurrency(debtView.owed)}.`;
  }, [cardFilter, cardScopedDebt, cardScopedAnchor, cardAnchorPending, cardAnchorFailed, endingBalance.value, selectedMonth, cardMonthRows, currentMonth]);

  // (#809) Forward-looking ending-balance window, pinned to a fixed
  // 12-month span that rolls forward by month. Credit-card spending
  // isn't forecastable, so we plot only real history as it accumulates:
  // one point per Sun–Sat week (anchored on the Saturday that closes it)
  // from the window start through today. Weeks ending after today are
  // omitted so the right portion of the chart stays genuinely blank —
  // no flat carry-forward of the last value.
  // (Q3) One card only: "All cards" draws no combined line (see the per-row
  // walk above); it lists each card's balance instead.
  const balanceWindow = useMemo<WindowConfig | null>(
    () =>
      cardFilter === "all"
        ? null
        : buildBalanceWindow({
            anchorPresent: cardScopedAnchor.anchor !== null,
            currentMonth,
            balanceAtEndOf,
            transactions: wideAllForBalance,
          }),
    [cardFilter, cardScopedAnchor.anchor, balanceAtEndOf, wideAllForBalance, currentMonth],
  );

  const knownPayers = useMemo(() => {
    const set = new Set<string>();
    for (const t of wideAll) {
      const v = (t.owedBy ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set).sort();
  }, [wideAll]);
  const owedByListId = "amex-owed-by-suggestions";

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleDay = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());
  useEffect(() => {
    // Drop selections that are no longer visible.
    setSelected((prev) => {
      const visible = new Set(shown.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [shown]);

  // (P1) The Summary's figures and To-review counts, and the plan state its link reads,
  // move with any row write. Page-local on purpose: the global write invalidation sits
  // on the landing path, which has no room for these keys.
  const invalidateSummary = () => {
    void qc.invalidateQueries({ queryKey: ["/api/amex/summary"] });
    void qc.invalidateQueries({ queryKey: ["/api/money/period-breakdown"] });
  };
  const invalidateTxns = () => {
    invalidateSummary();
    return qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  };

  const monthStartOf = (occurredOn: string): string =>
    `${occurredOn.slice(0, 7)}-01`;

  const invalidateBudgetMonths = (monthStarts: Iterable<string>) => {
    const seen = new Set<string>();
    for (const m of monthStarts) {
      if (seen.has(m)) continue;
      seen.add(m);
      qc.invalidateQueries({ queryKey: getGetBudgetMonthQueryKey(m) });
    }
  };

  // Move a row to a different day. The weekly allowance buckets on
  // `occurredOn`, so this is how a "paid Saturday, posted Sunday" charge
  // gets pulled back into the correct Sun→Sat week. Persisting the edit
  // also flips `occurredOnUserOverridden` server-side so the next Plaid
  // sync won't restamp it back to Plaid's date. Invalidates both the
  // source and destination budget months when the move crosses a boundary.
  // Mark / unmark a card payment as going to a card outside the avalanche.
  // (P1) From the row's details.
  const setExternalCard = (t: Transaction, v: boolean) =>
    updateTx.mutate(
      { id: t.id, data: { isExternalCardPayment: v } },
      {
        onSuccess: () => {
          void invalidateTxns();
          qc.invalidateQueries({
            queryKey: getGetBudgetMonthQueryKey(`${t.occurredOn.slice(0, 7)}-01`),
          });
        },
      },
    );
  // Count a transfer as spending (clears the row's Transfer flag; the server records it was by hand).
  const clearTransfer = (t: Transaction) =>
    updateTx.mutate(
      { id: t.id, data: { isTransfer: false } },
      {
        onSuccess: () => {
          void invalidateTxns();
          qc.invalidateQueries({
            queryKey: getGetBudgetMonthQueryKey(`${t.occurredOn.slice(0, 7)}-01`),
          });
        },
      },
    );

  const handleQuickDate = async (
    t: Transaction,
    raw: string,
  ): Promise<boolean> => {
    const next = (raw ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) {
      toast({ title: "Pick a date", variant: "destructive" });
      return false;
    }
    if (next === t.occurredOn.slice(0, 10)) return true;
    try {
      const updated = await updateTx.mutateAsync({
        id: t.id,
        data: { occurredOn: next },
      });
      invalidateTxns();
      invalidateBudgetMonths([
        monthStartOf(t.occurredOn),
        monthStartOf(updated.occurredOn),
      ]);
      toast({ title: "Date updated" });
      return true;
    } catch (e) {
      toast({
        title: "Couldn't update date",
        description: (e as Error).message,
        variant: "destructive",
      });
      return false;
    }
  };

  const setRowCategory = async (
    id: string,
    categoryId: string | null,
    rememberPattern?: string | null,
  ) => {
    const tx = wideAll.find((t) => t.id === id);
    try {
      const updated = await updateTx.mutateAsync({
        id,
        data: {
          categoryId,
          ...(rememberPattern ? { rememberPattern } : {}),
        },
      });
      invalidateTxns();
      if (tx) invalidateBudgetMonths([monthStartOf(tx.occurredOn)]);
      // Task #185 — surface what the auto-learn flow did to the user's
      // mapping rules. The legacy `rememberPattern` (explicit "remember
      // this") path produced a hand-rolled toast describing the new
      // rule. Now we always prefer the server's RuleAction summary
      // (covers created / created-over-generic / skipped-generic /
      // repointed) and fall back to the legacy explicit-remember toast
      // only when the user explicitly opted in via rememberPattern.
      if (categoryId) {
        const ruleDescription = ruleActionMessage(updated.ruleAction);
        // Task #209 — create the toast first so we have its id, then
        // attach the Undo action that knows how to dismiss this exact
        // toast on click. Avoids the parent toast lingering after Undo
        // is consumed.
        let categorizedToast: ReturnType<typeof toast> | null = null;
        if (ruleDescription) {
          categorizedToast = toast({
            title: "Categorized",
            description: ruleDescription,
          });
        } else if (rememberPattern) {
          categorizedToast = toast({
            title: "Categorized & remembered",
            description: `Future "${rememberPattern}" will auto-categorize.`,
          });
        }
        if (categorizedToast) {
          const undoAction = buildRuleUndoAction(
            updated.ruleAction,
            categorizedToast.id,
          );
          if (undoAction) {
            categorizedToast.update({
              id: categorizedToast.id,
              action: undoAction,
            });
          }
        }
        // Tasks #182/#195 — when the auto-learn flow either repoints an
        // existing seed rule or creates a brand-new specific rule,
        // surface a follow-up "apply to past charges?" prompt so the
        // user can flip the matching historical rows in one click
        // instead of touching each row by hand. Mirrors the
        // Transactions page UX so both entry points behave the same.
        const repointedRules: RepointedRule[] = updated.repointedRules ?? [];
        for (const rule of repointedRules) {
          const bulkRule = bulkRuleFromRepointed(
            rule,
            categoryById.get(rule.toCategoryId) ?? undefined,
          );
          if (bulkRule) offerBulkRecategorize(bulkRule);
        }
        const createdRule = bulkRuleFromRuleAction(
          updated.ruleAction,
          updated.ruleAction?.toCategoryId
            ? categoryById.get(updated.ruleAction.toCategoryId) ?? undefined
            : undefined,
        );
        if (createdRule) offerBulkRecategorize(createdRule);
      }
    } catch (e) {
      toast({
        title: "Couldn't update category",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // Per-row mutation queue: serialize bubble mutations for the same
  // transaction so the server processes rapid clicks in click order.
  // Mutations for different rows still run in parallel.
  const bubbleQueueRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const queueBubbleMutation = <T,>(
    id: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const prev = bubbleQueueRef.current.get(id) ?? Promise.resolve();
    const p: Promise<T> = prev.catch(() => undefined).then(fn);
    bubbleQueueRef.current.set(id, p);
    p.finally(() => {
      if (bubbleQueueRef.current.get(id) === p)
        bubbleQueueRef.current.delete(id);
    });
    return p;
  };

  // Optimistically patch a single transaction across every cached
  // listTransactions query. Returns a snapshot of the previous values for
  // the patched fields so callers can revert on error.
  const patchTransactionInCache = (
    id: string,
    patch: Partial<Transaction>,
  ): Partial<Transaction> | null => {
    let prev: Partial<Transaction> | null = null;
    qc.setQueriesData<Transaction[] | undefined>(
      { queryKey: [`/api/transactions`] },
      (data) => {
        if (!data) return data;
        let changed = false;
        const next = data.map((t) => {
          if (t.id !== id) return t;
          if (!prev) {
            const snap: Partial<Transaction> = {};
            for (const k of Object.keys(patch) as (keyof Transaction)[]) {
              (snap as Record<string, unknown>)[k as string] = t[k];
            }
            prev = snap;
          }
          changed = true;
          return { ...t, ...patch } as Transaction;
        });
        return changed ? next : data;
      },
    );
    return prev;
  };

  // Conditionally patch a transaction's fields, but only for those whose
  // current cache value still equals `expected`. Used both to revert
  // failed optimistic edits (expected = our optimistic patch, replacement
  // = the pre-edit snapshot) and to reconcile successful ones to the
  // server's confirmed values (expected = our optimistic patch,
  // replacement = the server response). Fields that a newer click has
  // since changed are left alone, so concurrent edits to the same row
  // never trample the user's latest intent.
  const patchTransactionIfMatching = (
    id: string,
    expected: Partial<Transaction>,
    replacement: Partial<Transaction>,
  ): boolean => {
    let didChange = false;
    qc.setQueriesData<Transaction[] | undefined>(
      { queryKey: [`/api/transactions`] },
      (data) => {
        if (!data) return data;
        let changed = false;
        const next = data.map((t) => {
          if (t.id !== id) return t;
          const merged: Record<string, unknown> = { ...t };
          let rowChanged = false;
          for (const k of Object.keys(expected) as (keyof Transaction)[]) {
            const key = k as string;
            if (
              (merged[key] as unknown) ===
              (expected as Record<string, unknown>)[key]
            ) {
              const repl = (replacement as Record<string, unknown>)[key];
              if (merged[key] !== repl) {
                merged[key] = repl;
                rowChanged = true;
              }
            }
          }
          if (!rowChanged) return t;
          changed = true;
          didChange = true;
          return merged as unknown as Transaction;
        });
        return changed ? next : data;
      },
    );
    return didChange;
  };

  const setRowBucket = async (
    t: Transaction,
    bucket: "" | "weekly" | "monthly" | "unplanned",
    weeklyBucket?: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket] | null,
  ) => {
    let wb: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket] | null | undefined = null;
    if (bucket === "weekly") {
      wb =
        weeklyBucket ??
        t.weeklyBucket ??
        defaultWeeklyBucketFor(categoryById.get(t.categoryId ?? "") ?? "");
    }
    // (#615) Picking a bucket is itself the act of reviewing the row,
    // so fold `reviewed` into the same patch — choosing any bucket
    // marks reviewed=true; clearing the bucket back to none unmarks
    // it. One PATCH, atomic optimistic update.
    const reviewed = bucket !== "";
    const patch: Partial<Transaction> = {
      weeklyAllowance: bucket === "weekly",
      monthlyAllowance: bucket === "monthly",
      unplannedAllowance: bucket === "unplanned",
      weeklyBucket: wb ?? null,
      reviewed,
    };
    // Stop any in-flight transactions refetch from racing the optimistic
    // write — otherwise a stale server payload could overwrite it.
    await qc.cancelQueries({ queryKey: [`/api/transactions`] });
    const prev = patchTransactionInCache(t.id, patch);
    queueBubbleMutation(t.id, async () => {
      try {
        const updated = await updateTx.mutateAsync({
          id: t.id,
          data: {
            weeklyAllowance: patch.weeklyAllowance,
            monthlyAllowance: patch.monthlyAllowance,
            unplannedAllowance: patch.unplannedAllowance,
            weeklyBucket: wb,
            reviewed,
          },
        });
        // Reconcile to the server's confirmed values, but only for
        // fields whose cache value still equals our optimistic write.
        // Fields a newer click has changed are left alone.
        patchTransactionIfMatching(t.id, patch, {
          weeklyAllowance: updated.weeklyAllowance,
          monthlyAllowance: updated.monthlyAllowance,
          unplannedAllowance: updated.unplannedAllowance,
          weeklyBucket: updated.weeklyBucket,
          reviewed: updated.reviewed,
        });
        invalidateSummary();
      } catch (e) {
        // Field-level revert: only restore fields whose cache value is
        // still our optimistic value. A newer click's optimistic edit
        // on a different field is preserved, while the rejected fields
        // snap back so the bubble visibly reverts.
        if (prev) patchTransactionIfMatching(t.id, patch, prev);
        toast({
          title: "Couldn't update bucket",
          description: (e as Error).message,
          variant: "destructive",
        });
      }
    });
  };

  const setRowReimbursable = async (t: Transaction, next: boolean) => {
    // (#615/#616) Picking RE counts as reviewing the row, just like
    // WK/MO/UN. Turning RE off only unreviews when no other bucket is
    // active — if WK/MO/UN is on, those carry the reviewed signal
    // independently and we leave `reviewed` alone.
    const hasOtherBucket = currentBucket(t) !== "";
    const reviewedPatch: Partial<Transaction> = next
      ? { reviewed: true }
      : hasOtherBucket
        ? {}
        : { reviewed: false };
    const patch: Partial<Transaction> = {
      reimbursable: next,
      ...(next ? {} : { reimbursed: false }),
      ...reviewedPatch,
    };
    await qc.cancelQueries({ queryKey: [`/api/transactions`] });
    const prev = patchTransactionInCache(t.id, patch);
    queueBubbleMutation(t.id, async () => {
      try {
        const updated = await updateTx.mutateAsync({
          id: t.id,
          data: {
            reimbursable: next,
            ...(next ? {} : { reimbursed: false }),
            ...reviewedPatch,
          },
        });
        patchTransactionIfMatching(t.id, patch, {
          reimbursable: updated.reimbursable,
          reimbursed: updated.reimbursed,
          ...("reviewed" in reviewedPatch ? { reviewed: updated.reviewed } : {}),
        });
        invalidateSummary();
      } catch (e) {
        if (prev) patchTransactionIfMatching(t.id, patch, prev);
        toast({
          title: "Couldn't update reimbursable",
          description: (e as Error).message,
          variant: "destructive",
        });
      }
    });
  };

  const onBubbleToggle = (t: Transaction, bucket: BucketKey, next: boolean) => {
    if (bucket === "reimbursable") {
      setRowReimbursable(t, next);
      return;
    }
    if (next) {
      setRowBucket(t, bucket);
    } else {
      // Toggling off — only clear if this bubble was the active bucket.
      if (currentBucket(t) === bucket) setRowBucket(t, "");
    }
  };

  // (#485) Bulk progress chip — drives the determinate "Updating X of N…"
  // affordance on the bulk action bar. `total === 0` means idle.
  // (#502) Now usually flips done == total in a single tick because
  // every bulk action is one server-side request, but kept around so
  // the bulk-bucket grouping path (which can issue a small handful of
  // requests, one per derived weeklyBucket value) still shows progress.
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  // (#508) After a partial-failure bulk action, surface *which* rows
  // failed (and why) so users can see and retry just those — instead
  // of a single toast leaking only the first error message.
  const [bulkFailures, setBulkFailures] = useState<{
    label: string;
    failures: { id: string; description: string; error: string }[];
    retry: (() => Promise<void>) | null;
    retrying: boolean;
  } | null>(null);
  const reportBulkOutcome = (
    results: { id: string; ok: boolean; err?: string }[],
    opts: {
      successTitle: (okCount: number) => string;
      failureTitle: (okCount: number, failCount: number) => string;
      retry?: (failedIds: string[]) => Promise<void>;
    },
  ) => {
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      setBulkFailures(null);
      toast({ title: opts.successTitle(okCount) });
      return;
    }
    const lookupDesc = (id: string) =>
      monthScoped.find((t) => t.id === id)?.description ??
      wideAll.find((t) => t.id === id)?.description ??
      id;
    const failures = failed.map((r) => ({
      id: r.id,
      description: lookupDesc(r.id),
      error: r.err ?? "Unknown error",
    }));
    const title = opts.failureTitle(okCount, failed.length);
    setBulkFailures({
      label: title,
      failures,
      retry: opts.retry
        ? () => opts.retry!(failed.map((r) => r.id))
        : null,
      retrying: false,
    });
    toast({
      title,
      description: `See the failed list below to review or retry.`,
      variant: "destructive",
    });
  };
  const dismissBulkFailures = () => setBulkFailures(null);
  const runBulkRetry = async () => {
    if (!bulkFailures?.retry) return;
    setBulkFailures((prev) => (prev ? { ...prev, retrying: true } : prev));
    try {
      await bulkFailures.retry();
    } finally {
      setBulkFailures((prev) =>
        prev ? { ...prev, retrying: false } : prev,
      );
    }
  };
  // (#502) Generic bulk runner shared by every bulk action below.
  // Replaces the old per-row PATCH /transactions/{id} fan-out with a
  // single POST /transactions/bulk-update per *unique patch*, so a
  // 500-row recategorize collapses from 500 HTTP round-trips to 1.
  // The bulk-bucket caller derives the per-row weeklyBucket from each
  // row's category, so it groups ids by stable patch-key and fires
  // one bulk request per group (still tiny — at most 4 groups).
  const runBulkPatch = async (
    ids: string[],
    buildPatch: (
      id: string,
    ) => BulkUpdateTransactionsInput["patch"] | null,
  ): Promise<{ id: string; ok: boolean; err?: string }[]> => {
    if (!ids.length) return [];
    // Group ids by JSON-stringified patch so callers that produce the
    // same patch for every id (the common case) make a single request.
    const groups = new Map<
      string,
      { patch: BulkUpdateTransactionsInput["patch"]; ids: string[] }
    >();
    const results: { id: string; ok: boolean; err?: string }[] = [];
    for (const id of ids) {
      const patch = buildPatch(id);
      if (!patch) {
        results.push({ id, ok: false, err: "missing" });
        continue;
      }
      const key = JSON.stringify(patch);
      const existing = groups.get(key);
      if (existing) existing.ids.push(id);
      else groups.set(key, { patch, ids: [id] });
    }
    const total = Array.from(groups.values()).reduce(
      (acc, g) => acc + g.ids.length,
      0,
    );
    let done = 0;
    setBulkProgress({ done: 0, total });
    try {
      for (const { patch, ids: groupIds } of groups.values()) {
        try {
          const res = await bulkUpdateTx.mutateAsync({
            data: { ids: groupIds, patch },
          });
          const okSet = new Set(
            res.results.filter((r) => r.ok).map((r) => r.id),
          );
          for (const id of groupIds) {
            if (okSet.has(id)) {
              results.push({ id, ok: true });
            } else {
              const r = res.results.find((x) => x.id === id);
              results.push({
                id,
                ok: false,
                err: r?.error ?? "not found",
              });
            }
          }
        } catch (e) {
          for (const id of groupIds) {
            results.push({ id, ok: false, err: (e as Error).message });
          }
        }
        done += groupIds.length;
        setBulkProgress({ done, total });
      }
    } finally {
      setBulkProgress({ done: 0, total: 0 });
    }
    return results;
  };

  const bulkSetBucket = async (
    bucket: "" | "weekly" | "monthly" | "unplanned",
    weeklyBucket?: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket],
    idsOverride?: string[],
  ) => {
    const ids = idsOverride ?? Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(
      [...filtered, ...wideAll].map((t) => [t.id, t] as const),
    );
    const results = await runBulkPatch(ids, (id) => {
      const t = byId.get(id);
      if (!t) return null;
      let wb:
        | typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket]
        | null = null;
      if (bucket === "weekly") {
        wb =
          weeklyBucket ??
          t.weeklyBucket ??
          defaultWeeklyBucketFor(categoryById.get(t.categoryId ?? "") ?? "");
      }
      return {
        weeklyAllowance: bucket === "weekly",
        monthlyAllowance: bucket === "monthly",
        unplannedAllowance: bucket === "unplanned",
        weeklyBucket: wb,
      };
    });
    invalidateTxns();
    reportBulkOutcome(results, {
      successTitle: (n) => `Tagged ${n} transaction${n === 1 ? "" : "s"}`,
      failureTitle: (ok, fail) => `Tagged ${ok}, ${fail} failed`,
      retry: (failedIds) => bulkSetBucket(bucket, weeklyBucket, failedIds),
    });
  };

  const bulkSetCategory = async (
    categoryId: string | null,
    idsOverride?: string[],
  ) => {
    const ids = idsOverride ?? Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(wideAll.map((t) => [t.id, t] as const));
    const results = await runBulkPatch(ids, () => ({ categoryId }));
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
    invalidateTxns();
    invalidateBudgetMonths(
      Array.from(okIds)
        .map((id) => byId.get(id)?.occurredOn)
        .filter((d): d is string => !!d)
        .map(monthStartOf),
    );
    setSelected((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (!okIds.has(id)) next.add(id);
      return next;
    });
    reportBulkOutcome(results, {
      successTitle: (n) => `Updated ${n} transaction${n === 1 ? "" : "s"}`,
      failureTitle: (ok, fail) => `Updated ${ok}, ${fail} failed`,
      retry: (failedIds) => bulkSetCategory(categoryId, failedIds),
    });
  };

  const bulkSetOwedBy = async (raw: string, idsOverride?: string[]) => {
    const ids = idsOverride ?? Array.from(selected);
    if (!ids.length) return;
    const trimmed = raw.trim();
    const next: string | null = trimmed.length === 0 ? null : trimmed;
    const results = await runBulkPatch(ids, () => ({ owedBy: next }));
    invalidateTxns();
    const label = next === null ? "Cleared owed by on" : `Set owed by to ${next} on`;
    reportBulkOutcome(results, {
      successTitle: (n) => `${label} ${n} transaction${n === 1 ? "" : "s"}`,
      failureTitle: (ok, fail) => `${ok} updated, ${fail} failed`,
      retry: (failedIds) => bulkSetOwedBy(raw, failedIds),
    });
  };

  const bulkSetReviewed = async (next: boolean, idsOverride?: string[]) => {
    const ids = idsOverride ?? Array.from(selected);
    if (!ids.length) return;
    // (#502) Was a bespoke 6-way concurrent fan-out — now one server-
    // side bulk-update call, same as the other bulk actions.
    const results = await runBulkPatch(ids, () => ({ reviewed: next }));
    invalidateTxns();
    reportBulkOutcome(results, {
      successTitle: (n) => `${next ? "Marked" : "Unmarked"} ${n} as reviewed`,
      failureTitle: (ok, fail) => `${ok} updated, ${fail} failed`,
      retry: (failedIds) => bulkSetReviewed(next, failedIds),
    });
  };

  const bulkSetReimbursable = async (next: boolean, idsOverride?: string[]) => {
    const ids = idsOverride ?? Array.from(selected);
    if (!ids.length) return;
    const results = await runBulkPatch(ids, () => ({ reimbursable: next }));
    invalidateTxns();
    reportBulkOutcome(results, {
      successTitle: (n) => `${next ? "Marked" : "Unmarked"} ${n} as reimbursable`,
      failureTitle: (ok, fail) => `${ok} updated, ${fail} failed`,
      retry: (failedIds) => bulkSetReimbursable(next, failedIds),
    });
  };

  // (Q6b) The page opens at the top, summary first: nothing scrolls on its own
  // when a card opens or changes. The only scrolls are a `?tx=` deep link (one,
  // in the focus effect above) and a To-review button (to the Activity heading).
  const scrolledRef = useRef(false);

  // (F8) `?tx=<id>` — an Ask answer's charge link — scrolls to that row once
  // the month is on screen, as the Chase page does (CH-09).
  useTxDeepLink({
    ready: !isLoading,
    rowTestIds: (id) => [`row-amex-${id}`],
    scrolledRef,
    scroll: false,
    // (Q6b) A row that never appears: once this card's month has loaded, drop the link
    // (and its "for the row you opened" words); so does switching card first.
    // Only a successful read of this scope counts: a failed fetch keeps the link for a reload.
    loaded: ledgerLoaded(monthQ),
    scopeKey: cardFilter,
    onGiveUp: () => {
      rowLinkMonthRef.current = null;
      setFocusTx(null);
    },
    deps: [groups.length],
  });

  // (C10) Measure the ledger's pinned pane so the day-group heads and the
  // bulk bar stick directly beneath it, via `--page-sticky-top` on the page
  // root. The pane mounts after the cold skeleton, hence the re-attach.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const paneH = usePaneHeight(paneRef, [isLoading, !!monthTxns]);

  // Stale-while-revalidate: only show the account skeleton on a genuine cold
  // load (no cached rows yet). Once any month's rows exist, keepPreviousData
  // holds them on screen while the focused-month query revalidates, so the
  // page never blanks between visits.
  // (P4) Only the chart and the ledger wait for the month's rows: the head, the
  // card band and the summary render as soon as their own answers arrive.
  const ledgerPending = isLoading && !monthTxns;

  const todayKey = ymd(new Date());

  // (C10) The card on screen, as its identity (accent, name, ••mask): the
  // chip under the title when one card is selected. "All cards" otherwise.
  const selectedCardIdentity = (() => {
    if (cardFilter === "all") return null;
    for (const it of plaidItemsForScope ?? []) {
      for (const a of it.accounts ?? []) {
        if (a.accountId !== cardFilter) continue;
        return identityOf({
          id: a.id,
          name: a.name,
          mask: a.mask,
          type: a.type ?? "credit",
          subtype: a.subtype,
          institutionName: it.institutionName,
          institutionSlug: it.institutionSlug,
        });
      }
    }
    return null;
  })();
  // External Plaid account_id → last four, for the band's card panels.
  const cardMasks = (() => {
    const m = new Map<string, string>();
    for (const it of plaidItemsForScope ?? []) {
      for (const a of it.accounts ?? []) {
        const mask = (a.mask ?? "").trim();
        if (a.accountId && mask) m.set(a.accountId, mask);
      }
    }
    return m;
  })();

  // (WP7) Embedded, the page lists one card's rows (`scopeParams`), so the band
  // does not filter in place: another card opens that card's own page, and
  // "All cards" opens the American Express page.
  const openCardFromBand = (id: string) => {
    if (id === cardFilter) return;
    navigate(id === "all" ? "/amex" : accountPageHref({ plaidAccountId: id }));
  };

  // (P1) The card on screen is named ONCE, in the header chip, with the words of its tab
  // (the household's name for it ••last4). While those words are still being read the chip
  // keeps its place as a placeholder: never "All cards" under one card's tab.
  const cardName = useAmexCardName(cardFilter, cardMasks);
  const headIdentity: AccountIdentity | null = (() => {
    if (cardFilter === "all") return null;
    if (cardName) {
      const base: AccountIdentity = selectedCardIdentity ?? {
        id: cardFilter, kind: "amex", label: cardName.name, shortLabel: cardName.name, mask4: "", accent: "amex", isCard: true,
      };
      return { ...base, label: cardName.name, shortLabel: cardName.name, mask4: cardName.mask || base.mask4 };
    }
    return cardName === null ? selectedCardIdentity : null;
  })();
  const headUnknown = cardFilter !== "all" && headIdentity === null && (cardName === undefined || plaidItemsForScope === undefined);

  const isThisMonth = compareMonth(selectedMonth, currentMonth) === 0;
  const linkPeriod: AmexLinkPeriod =
    rangeMode === "wk" && isThisMonth
      ? { kind: "week" }
      : rangeMode === "yr"
        ? { kind: "year" }
        : { kind: "month", start: monthFirstISO(selectedMonth), monthName: monthNameOf(selectedMonth) };

  // (P1) Each card's household name ••last4 for the rows' Card column (All cards), from the
  // summary's own cards (the tab's words); Plaid's label until those are in.
  const summaryCardLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of summaryQ.data?.scope.cards ?? []) {
      const mask = cardMasks.get(c.accountId) || c.mask || "";
      m.set(c.accountId, mask ? `${c.name} ••${mask}` : c.name);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryQ.data, plaidItemsForScope]);
  const rowCardLabel = (t: Transaction): string | null =>
    (t.plaidAccountId && (summaryCardLabel.get(t.plaidAccountId) ?? cardLabelByPlaidAccountId.get(t.plaidAccountId))) || null;

  // (P1) The server's "not filed yet" rows, for a row's spending words.
  const unfiledIds = useMemo(
    () => new Set((summaryQ.data?.needsAttention.unfiled.rows ?? []).map((r) => r.id)),
    [summaryQ.data],
  );
  const uncategorizedCatId = useMemo(
    () => (categories ?? []).find((c) => c.name === "Uncategorized")?.id ?? null,
    [categories],
  );

  // (P1) A To-review button: the activity shows that group's rows (the server's, up to 50),
  // and the keyboard lands on the Activity heading.
  const ledgerTitleRef = useRef<HTMLHeadingElement | null>(null);
  const focusActivity = () => {
    requestAnimationFrame(() => {
      const h = ledgerTitleRef.current;
      if (!h) return;
      h.scrollIntoView?.({ block: "start" });
      h.focus({ preventScroll: true });
    });
  };
  const chooseAttention = (g: AmexAttentionGroup | null) => {
    const grp = g ? summaryQ.data?.needsAttention[g] : undefined;
    if (!g || !grp) {
      setAttn(null);
      return;
    }
    setFigureState(null);
    setAttn({ group: g, rows: grp.rows.map((r) => ({ id: r.id, date: r.date })), count: grp.count, truncated: grp.truncated });
    focusActivity();
  };
  const chooseFigure = (f: AmexFigure | null) => setFigure(f);
  // A different card shows different rows: a group chosen on another card is dropped.
  useEffect(() => setAttn(null), [cardFilter]);

  // (P1) Details: open / close; closing gives focus back to the row's Details button.
  const toggleDetails = (id: string) =>
    setOpenDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const closeDetails = (id: string) => {
    setOpenDetails((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    detailToggles.current.get(id)?.focus();
  };

  // (P1) Switching Review ⇄ Categorize changes the rows' height. Scrolled into the
  // activity (the pane pinned at the top), the first row in view stays where it was: its
  // top is measured before the switch and restored after. Above that, nothing over the
  // switch moves, so the page is left alone (the button stays under the finger).
  const modeAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const setRowMode = (next: AmexRowMode) => {
    if (next === rowMode) return;
    modeAnchorRef.current = null;
    const pane = paneRef.current;
    const ledger = pane?.closest<HTMLElement>('[data-testid="amex-ledger"]');
    if (pane && ledger) {
      const scroller = shellScrollerOf(pane);
      const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const pinned = ledger.getBoundingClientRect().top < viewTop;
      if (pinned) {
        const paneBottom = pane.getBoundingClientRect().bottom;
        const rows = Array.from(ledger.querySelectorAll<HTMLElement>('[data-testid^="row-amex-"]'));
        const first = rows.find((r) => r.getBoundingClientRect().bottom > paneBottom + 1);
        if (first) modeAnchorRef.current = { id: first.getAttribute("data-testid")!, top: first.getBoundingClientRect().top };
      }
    }
    setRowModeState(next);
  };
  useLayoutEffect(() => {
    const a = modeAnchorRef.current;
    modeAnchorRef.current = null;
    if (!a) return;
    const el = document.querySelector<HTMLElement>(`[data-testid="${a.id}"]`);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - a.top;
    if (Math.abs(delta) < 1) return;
    const scroller = shellScrollerOf(el);
    if (scroller) scroller.scrollTop += delta;
    else window.scrollBy?.(0, delta);
  }, [rowMode]);

  // The single card's "How this card is paid" (with Add to Avalanche for a card not on the debt plan).
  const refreshAfterAdd = async () => {
    await qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    await qc.invalidateQueries({ queryKey: getGetAmexWeeklyPayoffQueryKey() });
    invalidateSummary();
  };
  const payoffCard = cardFilter === "all" ? undefined : amexPayoff?.cards?.find((c) => c.accountId === cardFilter);
  const addNode = payoffCard ? <AddToAvalanche card={payoffCard} onCreated={refreshAfterAdd} /> : null;
  const summaryCard =
    summaryQ.data && summaryQ.data.scope.kind === "card"
      ? summaryQ.data.scope.cards.find((c) => c.accountId === summaryQ.data!.scope.accountId && c.payoffMode != null)
      : undefined;
  const payBlock = summaryCard ? (
    <CardPayModes cards={[summaryCard]} addNode={addNode} />
  ) : addNode ? (
    <div data-testid="amex-paymode-add">{addNode}</div>
  ) : null;

  const scrollToHistory = () => {
    const el = document.getElementById("amex-balance-history");
    el?.scrollIntoView?.({ block: "start" });
    el?.querySelector<HTMLElement>("h2, [tabindex]")?.focus?.({ preventScroll: true });
  };

  const showCardColumn = cardFilter === "all" && !embedded;

  const pageActions = (
    <>
      <SyncButton relevantItemIds={relevantPlaidItemIds} />
      <PlaidLinkButton
        label="Connect a card"
        viewTransactionsPath="/amex"
        inlineProgress={false}
      />
    </>
  );

  const chart =
    ledgerPending || cardFilter === "all" ? null : wideTxns === undefined && !trendFailed ? (
      // (P4) The 12-month pull has not started (the chart is still far
      // down the page) or is on its way: the chart says so.
      <div ref={trendSlotRef} className="span-12" data-testid="amex-trend-pending" id={embedded ? undefined : "amex-balance-history"}>
        <Panel title="Balance history · last 12 months" span={12} variant="static" accent="amex">
          <p className="flex h-[220px] items-center justify-center text-label text-neutral-600 md:h-[260px]" role="status">
            Loading the last 12 months…
          </p>
        </Panel>
      </div>
    ) : (
      <div className="span-12" id={embedded ? undefined : "amex-balance-history"}>
        <BalanceTrendChart
          caption="Balance history · last 12 months"
          window={balanceWindow ?? undefined}
          color="hsl(var(--chart-1))"
          valueLabel="Actual balance"
          accent="amex"
        />
      </div>
    );

  return (
    <div
      className="space-y-4"
      data-testid="amex-page"
      style={{ ["--page-sticky-top" as string]: `${paneH}px` } as React.CSSProperties}
    >
      {/* (#373) Suppress the global Plaid re-auth banner on the Amex
          page and instead render it filtered to just the Amex card's
          Plaid item(s) — Chase issues must not appear on this page.
          When no Amex Plaid item is in scope (manual-only), nothing
          renders, mirroring the Chase page's `!isManualAccount`
          suppression. */}
      {scopedPlaidItems.length > 0 && (
        <PlaidReauthBannerView items={scopedPlaidItems} />
      )}
      {/* (#379) Shared post-link import banner — same channel as the
          Chase page, so a card link initiated from either surface
          progresses visibly through "waiting on bank → syncing →
          done — N imported" (or failed + Retry). */}
      <PostLinkProgressBanner viewTransactionsPath="/amex" />

      {/* (P1) The account page on the 12-column grid: head, controls, ONE Summary
          (titled by its period), the activity, then — one card only — its balance
          history. The shell's card tabs choose the card. Embedded
          (`/next/accounts/:id`) keeps its card band and chart above the ledger: the
          account page has no card tabs, and its own Summary comes first (`lead`). */}
      <PageGrid>
        <div className="span-12">
          {embedded ? (
            <div className="flex flex-wrap items-start justify-end gap-2" data-testid="amex-embedded-actions">
              {pageActions}
            </div>
          ) : (
            <AccountPageHeader
              title="American Express"
              icon={<AmexLogo className="h-6 w-7" />}
              identity={headIdentity}
              meta={
                cardFilter === "all" ? (
                  // (Q6b) Same height as a card's identity chip, so choosing a card does not move the page below.
                  <span className="chip gray py-1 text-label" data-testid="amex-head-all-cards">
                    All cards
                  </span>
                ) : headIdentity ? null : headUnknown ? (
                  <span
                    className="inline-block h-[1.625rem] w-32 rounded-control bg-platinum-2 motion-safe:animate-pulse"
                    aria-hidden
                    data-testid="amex-head-card-loading"
                  />
                ) : (
                  <span className="chip gray py-1 text-label" data-testid="amex-head-card">Card</span>
                )
              }
              actions={pageActions}
            />
          )}
        </div>

        <div className="span-12 flex flex-wrap items-center justify-between gap-2" data-testid="amex-controls">
          <div className="flex flex-wrap items-center gap-3">
            <MonthNavigator value={selectedMonth} onChange={setSelectedMonth} />
            {rangeMode === "mo" &&
            rowLinkMonthRef.current &&
            compareMonth(selectedMonth, rowLinkMonthRef.current) === 0 ? (
              <span role="status" className="text-label text-neutral-600" data-testid="amex-row-link-status">
                {rowDeepLinkStatus(selectedMonth)}
              </span>
            ) : null}
          </div>
          <TimeRangeToggle value={rangeMode} onChange={setRangeMode} />
        </div>

        {lead}

        {!embedded && summaryQ.data ? (
          <QueryRefreshBanner q={summaryRaw} data-testid="amex-summary-refresh" />
        ) : null}
        {!embedded ? (
          <AmexSummaryPanel
            summary={summaryQ.data}
            failed={summaryQ.isError}
            onRetry={() => void summaryRaw.refetch?.()}
            title={summaryTitle(rangeMode, selectedMonth)}
            allCards={cardFilter === "all"}
            mode={rangeMode}
            isThisWeek={isThisMonth}
            figure={figure}
            onFigure={chooseFigure}
            attention={attn?.group ?? null}
            onAttention={chooseAttention}
            linkPeriod={linkPeriod}
            accountRowId={whyAccountRowId}
            byCard={
              <AmexCardBalances
                summary={summaryQ.data}
                failed={summaryQ.isError}
                pending={summaryQ.isFetching === true}
                masks={cardMasks}
                onSelect={setCardFilter}
              />
            }
            payBlock={payBlock}
            onOwedHistory={scrollToHistory}
          />
        ) : (
          <>
            {/* Embedded: the card band moves between card pages, and the chart sits above the ledger. */}
            <AmexCardBand
              selected={cardFilter}
              onSelect={openCardFromBand}
              masks={cardMasks}
              leadCount={lead ? 1 : 0}
              period={summaryPeriod}
              showPurchases
            />
            {ledgerPending ? <LedgerChartSkeleton /> : chart}
          </>
        )}

        {ledgerPending ? (
          embedded ? null : <LedgerChartSkeleton />
        ) : (
        <LedgerPanel
          title="Activity"
          accent="amex"
          paneRef={paneRef}
          titleRef={ledgerTitleRef}
          legend={rowMode === "categorize"}
          data-testid="amex-ledger"
          pane={
            /* (D2) Visible control for the persisted hide-reviewed filter.
               Rows are never hidden from a stored value without this on
               screen. (P1) The Categorize switch shows the bucket marks. */
            <div className="space-y-1">
              <div className="flex min-h-8 flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={rowMode === "categorize" ? "default" : "outline"}
                  className="h-8 text-xs"
                  aria-pressed={rowMode === "categorize"}
                  data-testid="amex-rowmode-toggle"
                  onClick={() => setRowMode(rowMode === "categorize" ? "review" : "categorize")}
                >
                  {rowMode === "categorize" ? "Done categorizing" : "Categorize"}
                </Button>
                <Button
                  size="sm"
                  variant={hideReviewed ? "default" : "outline"}
                  className="h-8 text-xs"
                  aria-pressed={hideReviewed}
                  data-testid="button-hide-reviewed"
                  onClick={() => setHideReviewed((v) => !v)}
                >
                  {hideReviewed ? "Show reviewed" : "Hide reviewed"}
                </Button>
                {hideReviewed && !attn && (
                  <span className="text-micro text-neutral-600" data-testid="text-hide-reviewed-note">
                    Reviewed rows are hidden.
                  </span>
                )}
              </div>
              {figure ? (
                <p className="text-micro text-neutral-600" role="status" data-testid="amex-figure-note">
                  Showing {FIGURE_WORDS[figure].toLowerCase()}.{" "}
                  <button type="button" className="font-semibold text-brand-navy underline" onClick={() => setFigure(null)}>Show all</button>
                </p>
              ) : null}
              {attn ? (
                <p className="text-micro text-neutral-600" role="status" data-testid="amex-attn-note">
                  {attn.truncated
                    ? `Showing the largest ${attnInMonth} of ${attn.count} ${ATTN_WORDS[attn.group]}`
                    : `Showing ${attnInMonth} ${ATTN_WORDS[attn.group]}`}
                  {attnElsewhere
                    ? `; ${attnElsewhere.total} more ${attnElsewhere.total === 1 ? "is" : "are"} in ${
                        attnElsewhere.single ? monthNameOf(attnElsewhere.month) : "other months"
                      }.`
                    : "."}{" "}
                  {attnElsewhere ? (
                    <>
                      <button
                        type="button"
                        className="font-semibold text-brand-navy underline"
                        onClick={() => {
                          setRangeMode("mo");
                          setSelectedMonth(attnElsewhere.month);
                        }}
                        data-testid="amex-attn-open-month"
                      >
                        Open {monthNameOf(attnElsewhere.month)}
                      </button>{" "}
                    </>
                  ) : null}
                  <button type="button" className="font-semibold text-brand-navy underline" onClick={() => setAttn(null)} data-testid="amex-attn-show-all">
                    Show all
                  </button>
                </p>
              ) : null}
              {anchorNote ? (
                <p className="text-micro text-neutral-600" data-testid="amex-anchor-note">{anchorNote}</p>
              ) : null}
              {/* (WP8b) A capped read says so (CLAUDE.md §2). */}
              {monthCapHit ? (
                <p className="text-micro text-neutral-600" data-testid="amex-month-cap">
                  Showing the most recent {MONTH_LIMIT.toLocaleString("en-US")} rows of this month.
                </p>
              ) : null}
              {trendCapHit ? (
                <p className="text-micro text-neutral-600" data-testid="amex-trend-cap">
                  Only the most recent {TREND_LIMIT.toLocaleString("en-US")} rows feed the chart and earlier
                  months&apos; running balances.
                </p>
              ) : null}
            </div>
          }
        >
          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div
              className="sticky z-20 flex flex-wrap items-center gap-3 border-b border-brand-navy/25 bg-ok-bg px-4 py-2"
              style={{ top: "var(--page-sticky-top, 0px)" }}
              data-testid="amex-bulk-bar"
            >
              <span className="font-mono text-label font-semibold tabular-nums text-brand-navy">
                {selected.size} selected
              </span>
              <BulkCategoryPicker
                categories={categories ?? []}
                onPick={bulkSetCategory}
              />
              <div className="flex items-center gap-1">
                <span className="mr-1 text-micro font-semibold uppercase tracking-wide text-neutral-500">Bucket:</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetBucket("")}>
                  —
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetBucket("weekly")}>
                  Weekly
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetBucket("monthly")}>
                  Monthly
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetBucket("unplanned")}>
                  Unplanned
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <span className="mr-1 text-micro font-semibold uppercase tracking-wide text-neutral-500">Reimb:</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetReimbursable(true)}>
                  Mark
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetReimbursable(false)}>
                  Unmark
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <span className="mr-1 text-micro font-semibold uppercase tracking-wide text-neutral-500">Reviewed:</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  data-testid="button-bulk-mark-reviewed"
                  onClick={() => bulkSetReviewed(true)}
                >
                  Mark
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  data-testid="button-bulk-unmark-reviewed"
                  onClick={() => bulkSetReviewed(false)}
                >
                  Unmark
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <span className="mr-1 text-micro font-semibold uppercase tracking-wide text-neutral-500">Owed by:</span>
                <Input
                  placeholder="Owed by…"
                  list={owedByListId}
                  aria-label="Bulk set owed by for selected transactions"
                  data-testid="input-bulk-owed-by"
                  className="h-7 w-32 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const value = e.currentTarget.value;
                      void bulkSetOwedBy(value);
                      e.currentTarget.value = "";
                      (e.currentTarget as HTMLInputElement).blur();
                    } else if (e.key === "Escape") {
                      e.currentTarget.value = "";
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  data-testid="button-bulk-clear-owed-by"
                  onClick={() => bulkSetOwedBy("")}
                >
                  Clear
                </Button>
              </div>
              {bulkProgress.total > 0 && (
                <span
                  className="text-xs text-foreground font-mono tabular-nums"
                  data-testid="text-bulk-progress"
                >
                  Updating {bulkProgress.done}/{bulkProgress.total}…
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={clearSelection} className="ml-auto">
                Clear
              </Button>
            </div>
          )}
          {/* (#508) Failed-rows panel — shows after a partial-failure
              bulk action so users can see which transactions failed
              and retry just those, instead of guessing from a toast. */}
          {bulkFailures && (
            <div className="px-4 py-3">
              <div
                className="space-y-2 rounded-card bg-bad-bg p-3 ring-1 ring-bad/25"
                data-testid="panel-bulk-failures"
                role="alert"
              >
                <div className="flex items-center gap-2">
                  <span className="text-label font-semibold text-bad">
                    {bulkFailures.label}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    {bulkFailures.retry && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-destructive/40 text-destructive bg-background hover:bg-destructive/10"
                        onClick={() => void runBulkRetry()}
                        disabled={bulkFailures.retrying}
                        data-testid="button-bulk-retry-failed"
                      >
                        {bulkFailures.retrying
                          ? "Retrying…"
                          : `Retry ${bulkFailures.failures.length} failed`}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-destructive hover:bg-destructive/10"
                      onClick={dismissBulkFailures}
                      data-testid="button-bulk-dismiss-failures"
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
                <ul
                  className="max-h-40 space-y-1 overflow-auto text-micro text-bad"
                  data-testid="list-bulk-failures"
                >
                  {bulkFailures.failures.map((f) => (
                    <li
                      key={f.id}
                      className="flex items-baseline gap-2 border-t border-bad/20 pt-1 first:border-t-0 first:pt-0"
                      data-testid={`row-bulk-failure-${f.id}`}
                    >
                      <span className="max-w-[40%] truncate font-medium" title={f.description}>
                        {f.description}
                      </span>
                      <span className="truncate text-neutral-600" title={f.error}>
                        {f.error}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {/* Day groups */}
          {groups.length === 0 && (monthSwitching ? (
            <div className={emptyNote} role="status" data-testid="amex-month-loading">
              Loading {formatMonthLong(selectedMonth)}…
            </div>
          ) : (
            <div className={emptyNote} data-testid="amex-empty">
              No transactions match these filters.
            </div>
          ))}
          <DayGroupsList
            groups={groups}
            renderGroup={([dayKey, items], groupIndex) => {
            const dayFlow = dayInOut(items);
            const ids = items.map((t) => t.id);
            const allSelected = ids.every((id) => selected.has(id));
            const someSelected = !allSelected && ids.some((id) => selected.has(id));
            const isToday = dayKey === todayKey;
            return (
              <DayGroup
                key={dayKey}
                dayKey={dayKey}
                count={items.length}
                isToday={isToday}
                todayAccent="blue"
                variant="flush"
                selectionState={allSelected ? true : someSelected ? "indeterminate" : false}
                onToggleAll={(on) => toggleDay(ids, on)}
                totalNode={
                  <span className="tabular-nums" data-testid={`day-total-${dayKey}`}>
                    {dayFlow.out > 0 && <span>-{formatCurrency(dayFlow.out)} out</span>}
                    {dayFlow.out > 0 && dayFlow.in > 0 && <span> · </span>}
                    {dayFlow.in > 0 && <span>+{formatCurrency(dayFlow.in)} in</span>}
                    {dayFlow.out === 0 && dayFlow.in === 0 && <span>{formatCurrency(0)}</span>}
                  </span>
                }
                // Once per ledger, on the first day only.
                columnHeader={
                  groupIndex === 0 ? (
                    // (Q3) "All cards" shows no "bal": the column says only Amount.
                    <LedgerColumns
                      gridClass={amexLedgerGrid(rowMode, showCardColumn)}
                      cardLabel={showCardColumn ? "Card" : null}
                      bucketsLabel={rowMode === "review" ? "Spending" : "Buckets"}
                      {...(cardFilter === "all" ? { amountLabel: "Amount" } : {})}
                    />
                  ) : undefined
                }
              >
              {/* (P1) One row per transaction, phone and desktop alike. */}
              <div className="divide-y divide-brand-line/70">
                {items.map((t) => {
                  const isIgnored = !!ignoreCatId && t.categoryId === ignoreCatId;
                  const open = openDetails.has(t.id);
                  const label = rowCardLabel(t);
                  return (
                    <AmexLedgerRow
                      key={t.id}
                      t={t}
                      mode={rowMode}
                      showCard={showCardColumn}
                      cardLabel={label}
                      cardAccent={
                        t.plaidAccountId && label ? (accentByPlaidAccountId.get(t.plaidAccountId) ?? null) : null
                      }
                      selected={selected.has(t.id)}
                      onToggleSelect={() => toggleOne(t.id)}
                      categories={categories}
                      onCategoryChange={(id, remember) => setRowCategory(t.id, id, remember)}
                      onBucketToggle={(b, next) => onBubbleToggle(t, b, next)}
                      ignored={isIgnored}
                      spending={spendingWords(t, {
                        ignored: isIgnored,
                        unfiled: unfiledIds.has(t.id),
                        kind: amexRowKind(t, categories),
                      })}
                      disabled={updateTx.isPending}
                      amountNode={
                        <div className="flex flex-col items-end">
                          <span className="font-semibold text-brand-navy" data-testid={`amount-${t.id}`}>
                            {signedAmount(t)}
                          </span>
                          {runningBalanceMap.has(t.id) && (
                            <span
                              className="font-mono text-micro tabular-nums text-neutral-600"
                              data-testid={`text-running-balance-${t.id}`}
                            >
                              bal {formatCurrency(runningBalanceMap.get(t.id)!)}
                            </span>
                          )}
                        </div>
                      }
                      detailsOpen={open}
                      onToggleDetails={() => toggleDetails(t.id)}
                      toggleRef={(el) => {
                        if (el) detailToggles.current.set(t.id, el);
                        else detailToggles.current.delete(t.id);
                      }}
                      details={
                        open ? (
                          <AmexRowDetails
                            t={t}
                            mode={rowMode}
                            cardLabel={label}
                            categoryName={
                              t.categoryId && t.categoryId !== uncategorizedCatId
                                ? (categoryById.get(t.categoryId) ?? null)
                                : null
                            }
                            provenance={categoryProvenance(t, mappingRules, uncategorizedCatId)}
                            ignored={isIgnored}
                            onBucketToggle={(b, next) => onBubbleToggle(t, b, next)}
                            onClearTransfer={() => clearTransfer(t)}
                            onSetExternal={(v) => setExternalCard(t, v)}
                            onQuickDate={(raw) => handleQuickDate(t, raw)}
                            onSetReviewed={(next) => void bulkSetReviewed(next, [t.id])}
                            onSplit={() => setSplitTx(t)}
                            onClose={() => closeDetails(t.id)}
                            disabled={updateTx.isPending}
                          />
                        ) : null
                      }
                    />
                  );
                })}
              </div>
          </DayGroup>
        );
        }}
      />
          {/* (P4 → P1) The 12-month read starts when the bottom of the activity nears the
              viewport (All cards draws no combined chart; one card's chart has its own slot). */}
          {cardFilter === "all" && !embedded ? <div ref={trendSlotRef} aria-hidden className="h-0" data-testid="amex-trend-slot" /> : null}
        </LedgerPanel>
        )}

        {!embedded ? chart : null}
      </PageGrid>
      <datalist id={owedByListId}>
        {knownPayers.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <SplitByCategoryHost tx={splitTx} categories={categories ?? []} onClose={() => setSplitTx(null)} />
      {previewDialog}
    </div>
  );
}

// (#772) Plain (non-virtualized) list of day groups. Earlier
// revisions (#485/#744/#761/#767) wrapped this in a
// `useWindowVirtualizer` to keep render cost down, but with
// `MONTH_LIMIT = 1000` capping the page at ~30 day-group nodes the
// perf headroom was never the bottleneck — every round of patches
// produced a new "bottom of the month is clipped" bug because the
// measured group heights kept diverging from the estimate. Render
// them directly via `groups.map(...)` and call it a day. (C10) The groups
// are flush sections of the ledger panel, so they sit edge to edge.
function DayGroupsList<G>({
  groups,
  renderGroup,
}: {
  groups: [string, G[]][];
  /** `index` lets the caller head only the FIRST group's columns. */
  renderGroup: (entry: [string, G[]], index: number) => React.ReactNode;
}) {
  return (
    <div>
      {groups.map((entry, index) => (
        <div key={entry[0]} data-day-group-key={entry[0]}>
          {renderGroup(entry, index)}
        </div>
      ))}
    </div>
  );
}

function BulkCategoryPicker({
  categories,
  onPick,
}: {
  categories: { id: string; name: string }[];
  onPick: (categoryId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={btnSm}>
          Set category
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
              <CommandItem onSelect={() => { onPick(null); setOpen(false); }}>
                Uncategorized
              </CommandItem>
              {categories.map((c) => (
                <CommandItem
                  key={c.id}
                  onSelect={() => {
                    onPick(c.id);
                    setOpen(false);
                  }}
                >
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
