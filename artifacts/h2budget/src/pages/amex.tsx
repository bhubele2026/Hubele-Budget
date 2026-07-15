import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
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
import { AccountPageSkeleton } from "@/components/account-page/account-page-skeleton";
import { MatchedRuleChip } from "@/components/matched-rule-chip";
import { RowDateControls } from "@/components/row-date-controls";
import { MerchantRenamePopover } from "@/components/merchant-rename-popover";
import { AccountTransactionRow } from "@/components/account-page/transaction-row";
import {
  useBulkRecategorizePrompt,
  bulkRuleFromRepointed,
  bulkRuleFromRuleAction,
} from "@/hooks/use-bulk-recategorize-prompt";
import { customFetch } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Check,
  CreditCard,
  RefreshCw,
  X,
  ExternalLink,
} from "lucide-react";
import { CategoryPicker } from "@/components/category-picker";
import { TransactionWeeklyBucket } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ruleActionMessage } from "@/lib/ruleActionMessage";
import { useRuleActionUndo } from "@/lib/useRuleActionUndo";
import { formatCurrency, formatRelativeTime } from "@/lib/utils";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { PostLinkProgressBanner } from "@/components/post-link-progress";
import {
  PlaidReauthBannerView,
} from "@/components/plaid-reauth-banner";
import { SyncButton } from "@/components/sync-button";
import { useListPlaidItems } from "@workspace/api-client-react";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { cn } from "@/lib/utils";
import { relevantAmexPlaidItemIds } from "@/pages/amexPlaidScope";
import { makeAmexBalanceAtEndOf, resolveAmexDebt } from "@/lib/amexEndingBalance";
import { AMEX_BALANCE_DISTINCTION } from "@/lib/reportsBalances";
import {
  compareNewestFirst,
  computeRunningBalances,
  sortNewestFirst,
} from "@/lib/runningBalance";
import {
  AccountPageHeader,
  AccountFilterBar,
  BalanceTrendChart,
  DayGroup,
  MonthNavigator,
  StatChip,
  monthKeyOf,
  monthKeyFromISO,
  compareMonth,
  shiftMonth,
  monthFirstISO,
  monthLastISO,
  type MonthKey,
  type WindowConfig,
} from "@/components/account-page";
import { AmexLogo } from "@/components/brand-logos";
import { AmexCardBand } from "@/components/amex-card-band";
import { SectionHeader } from "@/components/stat";
import { TimeRangeToggle } from "@/components/time-range-toggle";
import { currentWeekRange, type RangeMode } from "@/lib/timeRange";
import { buildBalanceWindow } from "@/lib/amexBalanceWindow";

// The "American Express" page is really the credit-cards view. Apple Card
// rows are folded in here so they show alongside the Amex cards without
// renaming the page — both the Plaid form ("plaid:apple-card", if it ever
// links) and the FinanceKit/manual form ("apple-card", how it'll actually
// arrive from the iOS app).
const AMEX_SOURCES = ["amex", "plaid:amex", "plaid:apple-card", "apple-card"];

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function parseAbs(amount: string) {
  return Math.abs(parseFloat(amount) || 0);
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

// (#632 follow-up) Per-row chip for marking a card payment as going to a
// card OUTSIDE the household's debt avalanche (e.g. a spouse's external
// card). When set, the row is excluded from avalanche actuals on the
// server and from every dashboard bucket on the client. Surfaced on
// every row (not just isTransfer rows) so the user can pre-empt the
// classifier — but visually subtle until clicked.
function ExternalCardChip({
  t,
  onToggle,
  testIdSuffix,
}: {
  t: Transaction;
  onToggle: (next: boolean) => void;
  testIdSuffix: string;
}) {
  if (t.isExternalCardPayment) {
    return (
      <Badge
        variant="outline"
        className="inline-flex items-center gap-1 text-[10px] font-normal border-border text-muted-foreground bg-muted/40"
        title="Excluded from avalanche actuals and every dashboard bucket"
        data-testid={`badge-external-card-${testIdSuffix}`}
      >
        <ExternalLink className="w-3 h-3" />
        Not in avalanche
        <button
          type="button"
          aria-label="Clear external card flag"
          data-testid={`button-clear-external-card-${testIdSuffix}`}
          className="ml-0.5 inline-flex items-center justify-center rounded hover:bg-muted"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(false);
          }}
        >
          <X className="w-3 h-3" />
        </button>
      </Badge>
    );
  }
  // Only offer the affordance on rows that look like card payments —
  // i.e. already classified as a transfer. This keeps the noise down
  // on regular charges while still making the toggle reachable for
  // the rows that actually need it.
  if (!t.isTransfer) return null;
  return (
    <button
      type="button"
      data-testid={`button-mark-external-card-${testIdSuffix}`}
      title="Mark this payment as going to a card outside our avalanche"
      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground hover:underline"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(true);
      }}
    >
      <ExternalLink className="w-3 h-3" />
      Not in avalanche
    </button>
  );
}

export default function AmexPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { offerBulkRecategorize, previewDialog } = useBulkRecategorizePrompt();

  // Auto Plaid refresh on mount is DISABLED to avoid per-pull Plaid
  // charges — banks sync only on the manual Sync button now.

  // Filters
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");
  // Weekly-first: the ledger defaults to the CURRENT week within the loaded
  // month; Mo/Yr widen it back to the whole month. (The Amex balance chart is
  // an inherently forward-12-month projection, so the toggle scopes the
  // ledger, not that chart.)
  const [rangeMode, setRangeMode] = useState<RangeMode>("wk");
  // Honor `?accountId=<external Plaid account_id>` deep-links (the Kill Stack
  // rows + Home/Allowance per-card drills land here pre-filtered to one card).
  const [cardFilter, setCardFilter] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const a = new URLSearchParams(window.location.search).get("accountId");
      if (a) return a;
    }
    return "all";
  });
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
  const [selectedMonth, setSelectedMonth] = useState<MonthKey>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const m = params.get("month");
      if (m && /^\d{4}-\d{2}-01$/.test(m)) {
        return monthKeyFromISO(m);
      }
    }
    return currentMonth;
  });

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
  const MONTH_LIMIT = 1000;
  const sourceParam = useMemo(
    () =>
      sourceFilter && sourceFilter !== "all"
        ? sourceFilter
        : AMEX_SOURCES.join(","),
    [sourceFilter],
  );
  const monthQueryParams = useMemo(
    () => ({
      limit: MONTH_LIMIT,
      from: monthFirstISO(selectedMonth),
      to: monthLastISO(selectedMonth),
      source: sourceParam,
    }),
    [sourceParam, selectedMonth],
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
      limit: 5000,
      from: monthFirstISO(earlier),
      to: monthLastISO(later),
      source: sourceParam,
    };
  }, [sourceParam, selectedMonth, currentMonth]);

  // (#501) Auto-refresh the visible month when the Amex tab regains
  // focus or the user navigates back to the page. React Query keeps
  // the previously-fetched rows in cache while the background refetch
  // runs, so the list updates in place without flashing the loading
  // skeleton (the skeleton is gated on `isLoading`, which only fires
  // on the *initial* fetch — `isFetching` would, but we don't gate on
  // it). Only the focused month query opts in; the wider 12-month
  // trend query stays lazy to avoid extra work on every focus.
  const { data: monthTxns, isLoading } = useListTransactions(monthQueryParams, {
    query: {
      queryKey: getListTransactionsQueryKey(monthQueryParams),
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
    },
  });
  // Lower-priority — page renders as soon as the month query resolves.
  const { data: wideTxns } = useListTransactions(trendQueryParams);
  const { data: categories } = useListCategories();
  const { data: debts } = useListDebts();
  // Combined statement balance across the live Amex cards — used as the
  // all-cards forward-chart anchor when no debt/anchor is resolved (otherwise
  // the projection collapses to a flat $0 line).
  const { data: amexPayoff } = useGetAmexWeeklyPayoff();
  const { data: mappingRules } = useListMappingRules();
  // Server-provided Amex anchor: fallback used when the Amex debt row is
  // missing or renamed.
  const {
    data: amexAnchorResp,
    isLoading: amexAnchorLoading,
    isError: amexAnchorError,
    fetchStatus: amexAnchorFetchStatus,
  } = useQuery<{
    amexEndingBalance: number | null;
    asOf: string;
    source: "debt" | "anchor" | "computed" | "plaid" | "missing";
  }>({
    queryKey: ["/api/amex/anchor"],
    queryFn: () => customFetch("/api/amex/anchor", { method: "GET" }),
    staleTime: 60_000,
  });
  // (#748) Per-card anchor query. Only fires when the user picks a
  // specific card chip — the combined `amexAnchorResp` above keeps
  // powering "All cards". Cached under a separate queryKey per card so
  // switching chips doesn't blow away the combined cache (or vice
  // versa).
  const {
    data: amexAnchorPerCardResp,
    fetchStatus: amexAnchorPerCardFetchStatus,
  } = useQuery<{
    amexEndingBalance: number | null;
    asOf: string;
    source: "debt" | "anchor" | "computed" | "plaid" | "missing";
  }>({
    queryKey: ["/api/amex/anchor", cardFilter],
    queryFn: () =>
      customFetch(
        `/api/amex/anchor?accountId=${encodeURIComponent(cardFilter)}`,
        { method: "GET" },
      ),
    enabled: cardFilter !== "all",
    staleTime: 60_000,
  });
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
      if (hideReviewed && t.reviewed) return false;
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
  }, [monthScoped, search, memberFilter, cardFilter, categoryFilter, categoryById, from, to, hideReviewed, rangeMode, selectedMonth, currentMonth]);

  // Group by day (descending). Within each day, sort newest-first via
  // the canonical comparator so the per-row "bal $X" running statement
  // balance shown beside each row matches the order in which
  // `computeRunningBalances` walked the list.
  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of filtered) {
      const k = t.occurredOn.slice(0, 10);
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    for (const arr of map.values()) arr.sort(compareNewestFirst);
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  // Per-month totals: split by sign of `amount`. Charges are positive
  // (expenses on the card), payments/credits are negative.
  const monthTotals = useMemo(() => {
    let charges = 0;
    let paymentsAndCredits = 0;
    for (const t of filtered) {
      const a = parseSigned(t.amount);
      if (a >= 0) charges += a;
      else paymentsAndCredits += a; // negative
    }
    const netChange = charges + paymentsAndCredits; // charges - |payments|
    return { charges, paymentsAndCredits, netChange };
  }, [filtered]);

  // Distinct Plaid account IDs present on the Amex-source transactions.
  // These identify the actual Amex card account(s) feeding this page.
  const amexPlaidAccountIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of wideAll) {
      if (t.plaidAccountId) s.add(t.plaidAccountId);
    }
    return s;
  }, [wideAll]);

  // (#373) Mirror the Chase page's per-page item scoping. Map the Amex
  // card(s) currently shown back to their owning Plaid item id(s) so the
  // re-auth banner, the header SyncButton's inline error chip / Reconnect
  // popover, and the per-item "Refresh from Plaid" button only react to
  // the Plaid item(s) that own this page's data — Chase issues never
  // bleed onto the Amex page (and vice versa).
  const { data: plaidItemsForScope } = useListPlaidItems();
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
  useEffect(() => {
    if (cardFilter === "all") return;
    if (!cardFilterOptions.some((o) => o.value === cardFilter)) {
      setCardFilter("all");
    }
  }, [cardFilter, cardFilterOptions]);

  const { runSync, isPending: isAmexSyncing } = usePlaidSync();
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
    // Tier 1: per-card debt row (when the user has linked the card on /debts).
    if (cardScopedDebt) {
      const bal = parseSigned(cardScopedDebt.balance);
      if (Number.isFinite(bal)) {
        return {
          anchor: bal,
          resolvedSource: "debt" as const,
          asOf:
            cardScopedDebt.lastBalanceUpdate ??
            cardScopedDebt.plaidLastSyncedAt ??
            null,
        };
      }
    }
    // Tier 2: server-resolved per-card anchor (Plaid live liability or
    // settings.amexAnchor or computed-from-txns scoped to this card).
    // The /api/amex/anchor?accountId=... route does the heavy lifting
    // so the client doesn't need to know about plaid_accounts.
    if (
      amexAnchorPerCardResp &&
      amexAnchorPerCardResp.amexEndingBalance !== null &&
      amexAnchorPerCardResp.source !== "missing"
    ) {
      return {
        anchor: amexAnchorPerCardResp.amexEndingBalance,
        resolvedSource:
          amexAnchorPerCardResp.source === "debt"
            ? ("anchor" as const)
            : (amexAnchorPerCardResp.source as
                | "anchor"
                | "computed"
                | "plaid"),
        asOf: amexAnchorPerCardResp.asOf ?? null,
      };
    }
    // Tier 3: no per-card anchor available. Anchor at $0 with no
    // asOf so makeAmexBalanceAtEndOf becomes the running-sum of this
    // card's transactions, surfaced under the "computed" footer
    // ("Calculated"). This is the spec'd fallback for cards that
    // genuinely have no debt link and no Plaid liability — never fall
    // back to the combined anchor (that was the original bug).
    return {
      anchor: 0,
      resolvedSource: "computed" as const,
      asOf: null,
    };
  }, [cardFilter, cardScopedDebt, resolvedAnchor, amexAnchorPerCardResp, amexPayoff]);

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
  const runningBalanceMap = useMemo(() => {
    if (endingBalance.value === null) return new Map<string, number>();
    // (#748) When a single card is selected, walk only that card's
    // rows so the per-row "bal $X" matches the card-scoped ending
    // balance shown in the tile. Falls through to all rows when
    // cardFilter === "all" (current behavior).
    const series =
      cardFilter === "all"
        ? monthScoped
        : monthScoped.filter((t) => (t.plaidAccountId ?? "") === cardFilter);
    return computeRunningBalances(sortNewestFirst(series), endingBalance.value);
  }, [monthScoped, endingBalance.value, cardFilter]);

  const endingBalanceMeta = useMemo(() => {
    if (
      endingBalance.source !== "debt" &&
      endingBalance.source !== "anchor" &&
      endingBalance.source !== "computed" &&
      endingBalance.source !== "plaid"
    ) {
      return null;
    }
    const sourceLabel =
      endingBalance.source === "debt"
        ? "From debt row"
        : endingBalance.source === "anchor"
          ? "From saved anchor"
          : endingBalance.source === "plaid"
            ? "Live from Plaid"
            : "Calculated";
    let asOfLabel: string | null = null;
    if (endingBalance.asOf) {
      const d = new Date(endingBalance.asOf);
      if (!Number.isNaN(d.getTime())) {
        asOfLabel = d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      }
    }
    // (#498) For the live Plaid fallback, lead the footer with a
    // human-friendly "Updated X ago" so users can see at a glance how
    // fresh the balance actually is — the absolute date is preserved
    // in the tooltip below.
    const relativeAsOf =
      endingBalance.source === "plaid"
        ? formatRelativeTime(endingBalance.asOf)
        : "";
    // (#651) While the user's "Refresh from Plaid" click is in flight,
    // override the stale "Updated X ago" with a live "Refreshing…" label
    // so they get clear, immediate feedback that the new fetch is
    // running. Once the response lands the memo recomputes against the
    // fresh asOf and snaps to "Updated just now".
    const footer =
      endingBalance.source === "plaid"
        ? isAmexSyncing
          ? `${sourceLabel} · Refreshing…`
          : relativeAsOf
            ? `${sourceLabel} · Updated ${relativeAsOf}`
            : sourceLabel
        : asOfLabel
          ? `${sourceLabel} · as of ${asOfLabel}`
          : sourceLabel;
    const baseTooltip =
      endingBalance.source === "computed"
        ? `${footer}\nRunning sum of imported transactions. Set an actual balance to anchor the chip to the real card.`
        : endingBalance.source === "plaid" && asOfLabel
          ? `${sourceLabel} · as of ${asOfLabel}\nFetched directly from Plaid's per-account balance. Click refresh to re-fetch.`
          : footer;
    // (#884) Append the shared note explaining that this tile shows the
    // projected end-of-month balance while the Reports page shows the
    // current live balance, so a mid-month difference between the two
    // surfaces is expected — not a sync bug.
    const tooltip = `${baseTooltip}\n\n${AMEX_BALANCE_DISTINCTION.amexTooltipNote}`;
    return { sourceLabel, asOfLabel, relativeAsOf, footer, tooltip };
  }, [endingBalance, isAmexSyncing]);

  // (#809) Forward-looking ending-balance window, pinned to a fixed
  // 12-month span that rolls forward by month. Credit-card spending
  // isn't forecastable, so we plot only real history as it accumulates:
  // one point per Sun–Sat week (anchored on the Saturday that closes it)
  // from the window start through today. Weeks ending after today are
  // omitted so the right portion of the chart stays genuinely blank —
  // no flat carry-forward of the last value.
  const balanceWindow = useMemo<WindowConfig | null>(
    () =>
      buildBalanceWindow({
        anchorPresent: cardScopedAnchor.anchor !== null,
        currentMonth,
        balanceAtEndOf,
        transactions: wideAllForBalance,
      }),
    [cardScopedAnchor.anchor, balanceAtEndOf, wideAllForBalance, currentMonth],
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
      const visible = new Set(filtered.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filtered]);

  const invalidateTxns = () =>
    qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });

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

  // Smooth scroll to today on first load.
  const todayRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || isLoading) return;
    if (todayRef.current) {
      todayRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      scrolledRef.current = true;
    }
  }, [isLoading, groups.length]);

  // Measure the pinned top pane so day-group headers (and the bulk bar)
  // can stick directly beneath it via a CSS variable.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [paneH, setPaneH] = useState(0);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setPaneH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isLoading]);

  // Stale-while-revalidate: only show the account skeleton on a genuine cold
  // load (no cached rows yet). Once any month's rows exist, keepPreviousData
  // holds them on screen while the focused-month query revalidates, so the
  // page never blanks between visits.
  if (isLoading && !monthTxns) {
    return <AccountPageSkeleton />;
  }

  const todayKey = ymd(new Date());

  return (
    <div
      className="space-y-6"
      style={{ ["--pinned-pane-h" as string]: `${paneH}px` } as React.CSSProperties}
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
      <div
        ref={paneRef}
        className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-3 md:pt-4 pb-3 bg-background border-b shadow-sm space-y-3"
      >
        <AccountPageHeader
          title="American Express"
          icon={<AmexLogo className="h-6 w-7" />}
          actions={
            <>
              <SyncButton relevantItemIds={relevantPlaidItemIds} />
              <PlaidLinkButton
                label="Connect a card"
                viewTransactionsPath="/amex"
                inlineProgress={false}
              />
            </>
          }
        />

      {/* (#748 → drill) The card switcher is no longer a tablist — the
          per-card brand tiles (AmexCardBand, below) ARE the selector now;
          tapping a tile filters the ledger to that card. */}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <MonthNavigator value={selectedMonth} onChange={setSelectedMonth} />
          <TimeRangeToggle value={rangeMode} onChange={setRangeMode} />
        </div>
      </div>

      </div>

      {/* Per-card weekly cards are the PRIMARY view — tap a tile to filter
          the ledger to that card (drill). */}
      <div className="space-y-2">
        <SectionHeader eyebrow="Cards" title="Per-card · this week" />
        <AmexCardBand selected={cardFilter} onSelect={setCardFilter} />
      </div>

      <BalanceTrendChart
        caption="Ending balance — forward 12 months"
        window={balanceWindow ?? undefined}
        color="hsl(var(--chart-1))"
        valueLabel="Ending balance"
      />

      <SectionHeader eyebrow="Ledger" title="Activity" />

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div
          className="sticky z-20 flex items-center gap-3 rounded-md border border-border bg-muted px-4 py-2 shadow-sm"
          style={{ top: "var(--pinned-pane-h, 0px)" }}
        >
          <span className="text-sm font-medium text-foreground">
            {selected.size} selected
          </span>
          <BulkCategoryPicker
            categories={categories ?? []}
            onPick={bulkSetCategory}
          />
          <div className="flex items-center gap-1">
            <span className="text-xs text-foreground mr-1">Bucket:</span>
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
            <span className="text-xs text-foreground mr-1">Reimb:</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetReimbursable(true)}>
              Mark
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetReimbursable(false)}>
              Unmark
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-foreground mr-1">Reviewed:</span>
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
            <span className="text-xs text-foreground mr-1">Owed by:</span>
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
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 space-y-2"
          data-testid="panel-bulk-failures"
          role="alert"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-destructive">
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
            className="max-h-40 overflow-auto text-xs text-destructive space-y-1"
            data-testid="list-bulk-failures"
          >
            {bulkFailures.failures.map((f) => (
              <li
                key={f.id}
                className="flex items-baseline gap-2 border-t border-destructive/20 pt-1 first:border-t-0 first:pt-0"
                data-testid={`row-bulk-failure-${f.id}`}
              >
                <span className="font-medium truncate max-w-[40%]" title={f.description}>
                  {f.description}
                </span>
                <span className="text-destructive/80 truncate" title={f.error}>
                  {f.error}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Day groups */}
      {groups.length === 0 && (
        <Card><CardContent className="p-8 text-center text-muted-foreground">
          No transactions match these filters.
        </CardContent></Card>
      )}
      <DayGroupsList
        groups={groups}
        renderGroup={([dayKey, items]) => {
        const dayTotal = items.reduce((s, t) => s + parseAbs(t.amount), 0);
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
            containerRef={(el) => {
              if (isToday) todayRef.current = el;
            }}
            selectionState={allSelected ? true : someSelected ? "indeterminate" : false}
            onToggleAll={(on) => toggleDay(ids, on)}
            totalNode={formatCurrency(dayTotal)}
          >
              {/* Mobile: stacked card layout (below md) */}
              <div className="md:hidden divide-y divide-border">
                {items.map((t) => {
                  // (#629) Either reviewed OR Ignore'd dims the row — same
                  // visual treatment, so the bubble lights don't make a
                  // held-out line look "active". Purely cosmetic.
                  const isIgnored =
                    !!ignoreCatId && t.categoryId === ignoreCatId;
                  return (
                  <div
                    key={t.id}
                    className={cn(
                      "p-3 flex flex-col gap-2 hover:bg-muted/30 transition-colors",
                      (t.reviewed || isIgnored) && "opacity-50",
                    )}
                    data-reviewed={t.reviewed ? "true" : "false"}
                    data-ignored={isIgnored ? "true" : "false"}
                    data-testid={`row-amex-mobile-${t.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selected.has(t.id)}
                        onCheckedChange={() => toggleOne(t.id)}
                        aria-label="Select"
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <span
                            className="font-medium break-words"
                            title={t.description}
                          >
                            {t.displayName || t.description}
                          </span>
                          <MerchantRenamePopover tx={t} />
                        </div>
                        {t.notes && (
                          <div className="text-[11px] text-muted-foreground break-words" title={t.notes}>
                            {t.notes}
                          </div>
                        )}
                        <div
                          className="text-[11px] text-muted-foreground mt-0.5"
                          data-testid={`text-card-mobile-${t.id}`}
                        >
                          {(t.plaidAccountId &&
                            cardLabelByPlaidAccountId.get(t.plaidAccountId)) ||
                            "—"}
                        </div>
                      </div>
                      <div className="flex flex-col items-end">
                        <div className="text-sm font-mono tabular-nums whitespace-nowrap font-semibold">
                          {formatCurrency(parseAbs(t.amount))}
                        </div>
                        {runningBalanceMap.has(t.id) && (
                          <span
                            className="text-[11px] tabular-nums text-muted-foreground"
                            data-testid={`text-running-balance-mobile-${t.id}`}
                          >
                            bal {formatCurrency(runningBalanceMap.get(t.id)!)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pl-7">
                      <CategoryPicker
                        value={t.categoryId ?? null}
                        categories={categories ?? []}
                        description={t.description}
                        onChange={(id, remember) =>
                          setRowCategory(t.id, id, remember)
                        }
                      />
                      {/* Move a charge to the right Sun→Sat week.
                          Hidden on pending rows (Plaid restamps them). */}
                      {!t.pending && (
                        <RowDateControls
                          tx={t}
                          onMove={(raw) => handleQuickDate(t, raw)}
                          disabled={updateTx.isPending}
                        />
                      )}
                      {/* (#607) Transfer rows are excluded from budget
                          actuals, so weekly/monthly/unplanned bubbles
                          would never affect any roll-up. Hide them on
                          transfers to keep the row uncluttered. */}
                      {!t.isTransfer && (
                        <BucketBubbles
                          flags={{
                            weekly: t.weeklyAllowance,
                            monthly: t.monthlyAllowance,
                            unplanned: t.unplannedAllowance,
                            reimbursable: t.reimbursable,
                          }}
                          onToggle={(b, next) => onBubbleToggle(t, b, next)}
                        />
                      )}
                      {!t.isTransfer && t.isTransferUserOverridden && (
                        <Badge
                          variant="outline"
                          className="inline-flex items-center text-[10px] font-normal border-border text-muted-foreground bg-muted/40"
                          title="You cleared the auto-Transfer flag on this row. Future syncs won't re-add it."
                          data-testid={`badge-transfer-overridden-cleared-mobile-${t.id}`}
                        >
                          Manually set
                        </Badge>
                      )}
                      {t.isTransfer && (
                        <Badge
                          variant="outline"
                          className="inline-flex items-center gap-1 text-[10px] font-normal border-border text-muted-foreground bg-muted/40"
                          title={
                            t.isTransferUserOverridden
                              ? "Manually set — won't be re-flagged on the next sync"
                              : "Excluded from budget actuals"
                          }
                          data-testid={`badge-transfer-mobile-${t.id}`}
                        >
                          Transfer
                          {t.isTransferUserOverridden && (
                            <span
                              aria-hidden="true"
                              data-testid={`badge-transfer-overridden-mobile-${t.id}`}
                              className="text-slate-500 -ml-0.5"
                            >
                              *
                            </span>
                          )}
                          <button
                            type="button"
                            aria-label="Clear Transfer flag"
                            data-testid={`button-clear-transfer-mobile-${t.id}`}
                            className="ml-0.5 inline-flex items-center justify-center rounded hover:bg-slate-200/60"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateTx.mutate(
                                { id: t.id, data: { isTransfer: false } },
                                {
                                  onSuccess: () => {
                                    qc.invalidateQueries({
                                      queryKey: getListTransactionsQueryKey(),
                                    });
                                    qc.invalidateQueries({
                                      queryKey: getGetBudgetMonthQueryKey(
                                        `${t.occurredOn.slice(0, 7)}-01`,
                                      ),
                                    });
                                  },
                                },
                              );
                            }}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      )}
                      <ExternalCardChip
                        t={t}
                        onToggle={(v) =>
                          updateTx.mutate(
                            { id: t.id, data: { isExternalCardPayment: v } },
                            {
                              onSuccess: () => {
                                qc.invalidateQueries({
                                  queryKey: getListTransactionsQueryKey(),
                                });
                                qc.invalidateQueries({
                                  queryKey: getGetBudgetMonthQueryKey(
                                    `${t.occurredOn.slice(0, 7)}-01`,
                                  ),
                                });
                              },
                            },
                          )
                        }
                        testIdSuffix={`mobile-${t.id}`}
                      />
                      <MatchedRuleChip
                        categoryId={t.categoryId}
                        matchedRuleId={t.matchedRuleId}
                        rules={mappingRules}
                        testIdSuffix={`amex-mobile-${t.id}`}
                        variant="compact"
                      />
                    </div>
                  </div>
                  );
                })}
              </div>
              {/* Desktop: compact row list (md and up) */}
              <div className="hidden md:block divide-y divide-border">
                    {items.map((t) => {
                      // (#629) Either reviewed OR Ignore'd dims the row.
                      const isIgnored =
                        !!ignoreCatId && t.categoryId === ignoreCatId;
                      return (
                      <AccountTransactionRow
                        key={t.id}
                        tx={t}
                        selected={selected.has(t.id)}
                        onToggleSelect={() => toggleOne(t.id)}
                        categories={categories ?? []}
                        onCategoryChange={(id, remember) =>
                          setRowCategory(t.id, id, remember)
                        }
                        onBucketToggle={(b, next) => onBubbleToggle(t, b, next)}
                        onQuickDate={(raw) => handleQuickDate(t, raw)}
                        disabled={updateTx.isPending}
                        dimmed={t.reviewed || isIgnored}
                        hideDate={t.pending}
                        testId={`row-amex-${t.id}`}
                        rowData={{
                          "data-reviewed": t.reviewed ? "true" : "false",
                          "data-ignored": isIgnored ? "true" : "false",
                        }}
                        cardLabel={
                          (t.plaidAccountId &&
                            cardLabelByPlaidAccountId.get(t.plaidAccountId)) ||
                          null
                        }
                        metaNode={
                          t.notes ? (
                            <div
                              className="text-[11px] text-muted-foreground truncate"
                              title={t.notes}
                            >
                              {t.notes}
                            </div>
                          ) : null
                        }
                        chipsNode={
                          t.isTransfer ? (
                            <Badge
                              variant="outline"
                              className="inline-flex items-center gap-1 text-[10px] font-normal border-border text-muted-foreground bg-muted/40"
                              title={
                                t.isTransferUserOverridden
                                  ? "Manually set — won't be re-flagged on the next sync"
                                  : "Excluded from budget actuals"
                              }
                              data-testid={`badge-transfer-${t.id}`}
                            >
                              Transfer
                              <button
                                type="button"
                                aria-label="Clear Transfer flag"
                                data-testid={`button-clear-transfer-${t.id}`}
                                className="ml-0.5 inline-flex items-center justify-center rounded hover:bg-slate-200/60"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateTx.mutate(
                                    { id: t.id, data: { isTransfer: false } },
                                    {
                                      onSuccess: () => {
                                        qc.invalidateQueries({
                                          queryKey: getListTransactionsQueryKey(),
                                        });
                                        qc.invalidateQueries({
                                          queryKey: getGetBudgetMonthQueryKey(
                                            `${t.occurredOn.slice(0, 7)}-01`,
                                          ),
                                        });
                                      },
                                    },
                                  );
                                }}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </Badge>
                          ) : null
                        }
                        amountNode={
                          <div className="flex flex-col items-end">
                            <span className="font-semibold">
                              {formatCurrency(parseAbs(t.amount))}
                            </span>
                            {runningBalanceMap.has(t.id) && (
                              <span
                                className="text-[11px] text-muted-foreground"
                                data-testid={`text-running-balance-${t.id}`}
                              >
                                bal {formatCurrency(runningBalanceMap.get(t.id)!)}
                              </span>
                            )}
                          </div>
                        }
                      />
                      );
                    })}
              </div>
          </DayGroup>
        );
        }}
      />
      <datalist id={owedByListId}>
        {knownPayers.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
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
// them directly via `groups.map(...)` with a Tailwind `space-y-6`
// gap and call it a day.
function DayGroupsList<G>({
  groups,
  renderGroup,
}: {
  groups: [string, G[]][];
  renderGroup: (entry: [string, G[]]) => React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      {groups.map((entry) => (
        <div key={entry[0]} data-day-group-key={entry[0]}>
          {renderGroup(entry)}
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
        <Button size="sm" className="bg-primary hover:bg-primary/90">
          Set category
        </Button>
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
