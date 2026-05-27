import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Link } from "wouter";
import {
  useListTransactions,
  useUpdateTransaction,
  useBulkUpdateTransactions,
  useListCategories,
  useListDebts,
  useListMappingRules,
  getListTransactionsQueryKey,
  getGetBudgetMonthQueryKey,
  type Transaction,
  type RepointedRule,
  type BulkUpdateTransactionsInput,
} from "@workspace/api-client-react";
import { MatchedRuleChip } from "@/components/matched-rule-chip";
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
import { Check, CreditCard, RefreshCw, X, ExternalLink } from "lucide-react";
import { CategoryPicker } from "@/components/category-picker";
import { TransactionWeeklyBucket } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ruleActionMessage } from "@/lib/ruleActionMessage";
import { useRuleActionUndo } from "@/lib/useRuleActionUndo";
import { formatCurrency, formatRelativeTime } from "@/lib/utils";
import { useWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { PostLinkProgressBanner } from "@/components/post-link-progress";
import {
  PlaidReauthBannerView,
} from "@/components/plaid-reauth-banner";
import { SyncButton } from "@/components/sync-button";
import { useListPlaidItems } from "@workspace/api-client-react";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { useOpportunisticPlaidSync } from "@/hooks/use-opportunistic-plaid-sync";
import { cn } from "@/lib/utils";
import { relevantAmexPlaidItemIds } from "@/pages/amexPlaidScope";
import { makeAmexBalanceAtEndOf, resolveAmexDebt } from "@/lib/amexEndingBalance";
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
  type TrendPoint,
} from "@/components/account-page";

const AMEX_SOURCES = ["amex", "plaid:amex"];

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
        className="inline-flex items-center gap-1 text-[10px] border-amber-300 text-amber-800 bg-amber-50"
        title="Excluded from avalanche actuals and every dashboard bucket"
        data-testid={`badge-external-card-${testIdSuffix}`}
      >
        <ExternalLink className="w-3 h-3" />
        Not in avalanche
        <button
          type="button"
          aria-label="Clear external card flag"
          data-testid={`button-clear-external-card-${testIdSuffix}`}
          className="ml-0.5 inline-flex items-center justify-center rounded hover:bg-amber-200/60"
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
      className="inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-amber-700 hover:underline"
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

  // (#673) Layer 4 — fire a silent best-effort Plaid sync when the
  // user opens the Amex page or returns to the tab from background,
  // so a just-swiped pending charge is on screen without a Sync
  // click. Module-level cooldown inside the hook keeps tab-flip
  // bursts down to a single call.
  useOpportunisticPlaidSync();

  // Filters
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");
  const [cardFilter, setCardFilter] = useState<string>("all");
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

  const currentMonth = useMemo<MonthKey>(() => monthKeyOf(new Date()), []);
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
  const updateTx = useUpdateTransaction();
  const bulkUpdateTx = useBulkUpdateTransactions();
  const buildRuleUndoAction = useRuleActionUndo();
  const weeklyLabels = useWeeklyBucketLabels();

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
    return monthScoped.filter((t) => {
      const k = t.occurredOn.slice(0, 10);
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
  }, [monthScoped, search, memberFilter, cardFilter, categoryFilter, categoryById, from, to, hideReviewed]);

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
      void runSync({ itemId });
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
  const amexDebt = useMemo(
    () =>
      resolveAmexDebt({
        debts,
        amexPlaidAccountIds,
        plaidItemsForScope,
      }),
    [debts, amexPlaidAccountIds, plaidItemsForScope],
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
    if (cardFilter === "all") return null;
    for (const d of debts ?? []) {
      if (d.plaidAccountId && d.plaidAccountId === cardFilter) return d;
    }
    return null;
  }, [debts, cardFilter]);

  const cardScopedAnchor = useMemo(() => {
    if (cardFilter === "all") return resolvedAnchor;
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
    // No per-card debt link — fall back to the combined anchor so the
    // tile keeps showing something usable rather than collapsing to
    // "Not set" the moment the user picks a card without a debt row.
    return resolvedAnchor;
  }, [cardFilter, cardScopedDebt, resolvedAnchor]);

  const wideAllForBalance = useMemo(() => {
    if (cardFilter === "all") return wideAll;
    return wideAll.filter((t) => (t.plaidAccountId ?? "") === cardFilter);
  }, [wideAll, cardFilter]);

  // (#476) Pre-build the shared end-of-month balance closure once per
  // (anchor + transactions) change. Both the visible-month
  // `endingBalance` tile and the 12-point `balanceTrend` chart call
  // through this same closure so they always agree, and the same
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
    const tooltip =
      endingBalance.source === "computed"
        ? `${footer}\nRunning sum of imported transactions. Set an actual balance to anchor the chip to the real card.`
        : endingBalance.source === "plaid" && asOfLabel
          ? `${sourceLabel} · as of ${asOfLabel}\nFetched directly from Plaid's per-account balance. Click refresh to re-fetch.`
          : footer;
    return { sourceLabel, asOfLabel, relativeAsOf, footer, tooltip };
  }, [endingBalance, isAmexSyncing]);

  // Trailing 12-month ending-balance series, anchored at the snapshot
  // month's known Amex balance and rolled month-by-month using the same
  // shared helper that powers `endingBalance` above.
  const balanceTrend = useMemo<TrendPoint[]>(() => {
    if (cardScopedAnchor.anchor === null) return [];
    const points: TrendPoint[] = [];
    for (let i = 11; i >= 0; i--) {
      const mk = shiftMonth(selectedMonth, -i);
      const d = new Date(mk.year, mk.month, 1);
      points.push({
        key: `${mk.year}-${mk.month}`,
        label: d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        shortLabel: d.toLocaleDateString("en-US", { month: "short" }),
        balance: balanceAtEndOf(mk) ?? 0,
        isSelected: compareMonth(mk, selectedMonth) === 0,
      });
    }
    return points;
  }, [cardScopedAnchor.anchor, balanceAtEndOf, selectedMonth]);

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

  if (isLoading) {
    return null;
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
        className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-4 md:pt-8 pb-4 bg-background border-b shadow-sm space-y-4"
      >
        <AccountPageHeader
          title="American Express"
          subtitle="Day-by-day card spending — categorized into your budget."
          icon={<CreditCard className="h-7 w-7 text-blue-600" />}
          actions={
            <>
              {relevantPlaidItemIds.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefreshAmex}
                  disabled={isAmexSyncing}
                  data-testid="button-refresh-amex"
                >
                  <RefreshCw
                    className={cn(
                      "w-4 h-4 mr-1.5",
                      isAmexSyncing && "animate-spin",
                    )}
                  />
                  Refresh from Plaid
                </Button>
              )}
              <SyncButton relevantItemIds={relevantPlaidItemIds} />
              <PlaidLinkButton
                label="Connect a card"
                viewTransactionsPath="/amex"
                inlineProgress={false}
              />
            </>
          }
        />

      {/* (#748) Promote the card switcher to a prominent segmented
          pill row directly under the page title. Hidden when only a
          single card is linked (no need for a one-pill selector). */}
      {cardFilterOptions.length > 1 && (
        <div
          className="flex items-center gap-2 flex-wrap"
          data-testid="amex-card-pills"
          role="tablist"
          aria-label="Amex card filter"
        >
          <Button
            type="button"
            size="sm"
            variant={cardFilter === "all" ? "default" : "outline"}
            className="h-8 rounded-full px-3"
            onClick={() => setCardFilter("all")}
            role="tab"
            aria-selected={cardFilter === "all"}
            data-testid="button-card-filter-all"
          >
            All cards
            <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[10px]">
              {cardFilterOptions.length}
            </Badge>
          </Button>
          {cardFilterOptions.map((o) => (
            <Button
              key={o.value}
              type="button"
              size="sm"
              variant={cardFilter === o.value ? "default" : "outline"}
              className="h-8 rounded-full px-3"
              onClick={() => setCardFilter(o.value)}
              role="tab"
              aria-selected={cardFilter === o.value}
              data-testid={`button-card-filter-${o.value}`}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="shrink-0">
          <MonthNavigator value={selectedMonth} onChange={setSelectedMonth} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1 min-w-[280px]">
          {endingBalance.source === "missing" ||
          (endingBalance.source !== "loading" &&
            endingBalance.value === null) ? (
            <div
              className="rounded-md border border-dashed border-blue-300 bg-blue-50/60 px-3 py-2 text-blue-900 min-w-0"
              data-testid="stat-ending-balance"
            >
              <div className="text-[10px] uppercase tracking-widest text-blue-700">
                Ending balance
              </div>
              <div className="font-mono tabular-nums font-semibold text-base text-blue-900/70">
                Not set
              </div>
              <div className="mt-1 flex flex-col gap-1 min-w-0">
                <Popover
                  open={anchorOpen}
                  onOpenChange={(o) => {
                    setAnchorOpen(o);
                    if (o) setAnchorInput("");
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px] border-blue-400 text-blue-900 bg-white/70 hover:bg-white w-fit"
                      data-testid="button-set-amex-balance"
                    >
                      Set Amex balance
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-3" align="start">
                    <div className="space-y-2">
                      <div className="text-xs font-medium">
                        Set actual Amex balance
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Enter your current card balance. We'll save it as your
                        anchor and roll it month-to-month.
                      </div>
                      <Input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        value={anchorInput}
                        onChange={(e) => setAnchorInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void submitAnchor();
                          }
                        }}
                        placeholder="1293.08"
                        autoFocus
                        data-testid="input-actual-balance"
                      />
                      <div className="flex justify-end gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAnchorOpen(false)}
                          disabled={anchorSaving}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void submitAnchor()}
                          disabled={anchorSaving || !anchorInput.trim()}
                          data-testid="button-save-actual-balance"
                        >
                          {anchorSaving ? "Saving…" : "Save"}
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
                <Link
                  href="/debts"
                  className="text-[10px] leading-tight text-blue-700 hover:text-blue-900 underline-offset-2 hover:underline"
                  data-testid="link-amex-debts"
                >
                  or link an Amex debt in Debts
                </Link>
              </div>
            </div>
          ) : endingBalance.source === "loading" ? (
            <div
              className="rounded-md border bg-card px-3 py-2 min-w-0"
              data-testid="stat-ending-balance"
            >
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Ending balance
              </div>
              <div className="font-mono tabular-nums font-semibold text-base text-muted-foreground">
                Loading…
              </div>
              <Skeleton
                className="h-3 w-16 mt-1"
                data-testid="stat-ending-balance-loading"
              />
            </div>
          ) : (
            <StatChip
              label="Ending balance"
              value={endingBalance.value ?? 0}
              accent="bg-blue-50 text-blue-900 border-blue-200"
              footer={endingBalanceMeta?.footer}
              tooltip={endingBalanceMeta?.tooltip}
              testId="stat-ending-balance"
              action={
                endingBalance.source === "plaid" ? (
                  // (#498) Refresh affordance for the live Plaid balance.
                  // Triggers `runSync` for every Amex-owning Plaid item in
                  // scope and the success path inside `usePlaidSync`
                  // already invalidates `["/api/amex/anchor"]`, so the
                  // tile picks up the fresh per-account balance without
                  // a full page reload. While the sync is in flight we
                  // keep the existing cached value visible and only swap
                  // the button label, so we don't re-introduce the
                  // stuck-loading regression Task #483 fixed.
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] border-blue-300 text-blue-900 bg-white/60 hover:bg-white"
                    onClick={handleRefreshAmex}
                    disabled={
                      isAmexSyncing || relevantPlaidItemIds.length === 0
                    }
                    data-testid="button-refresh-plaid-balance"
                    title="Re-fetch the live Amex balance from Plaid"
                  >
                    <RefreshCw
                      className={cn(
                        "h-3 w-3 mr-1",
                        isAmexSyncing && "animate-spin",
                      )}
                    />
                    {isAmexSyncing ? "Refreshing…" : "Refresh"}
                  </Button>
                ) : endingBalance.source === "computed" ||
                  endingBalance.source === "anchor" ? (
                  <Popover
                    open={anchorOpen}
                    onOpenChange={(o) => {
                      setAnchorOpen(o);
                      if (o) {
                        setAnchorInput(
                          endingBalance.value != null
                            ? endingBalance.value.toFixed(2)
                            : "",
                        );
                      }
                    }}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px] border-blue-300 text-blue-900 bg-white/60 hover:bg-white"
                        data-testid={
                          endingBalance.source === "anchor"
                            ? "button-edit-actual-balance"
                            : "button-set-actual-balance"
                        }
                      >
                        {endingBalance.source === "anchor"
                          ? "Edit"
                          : "Set actual balance"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-3" align="start">
                      <div className="space-y-2">
                        <div className="text-xs font-medium">
                          {endingBalance.source === "anchor"
                            ? "Edit saved Amex balance"
                            : "Set actual Amex balance"}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {endingBalance.source === "anchor"
                            ? "Update your saved anchor or clear it to fall back to the linked debt or computed balance."
                            : "Enter the real card balance. We'll save it as your anchor."}
                        </div>
                        <Input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={anchorInput}
                          onChange={(e) => setAnchorInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void submitAnchor();
                            }
                          }}
                          placeholder="1293.08"
                          autoFocus
                          data-testid="input-actual-balance"
                        />
                        <div className="flex items-center justify-between gap-2 pt-1">
                          {endingBalance.source === "anchor" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => void clearAnchor()}
                              disabled={anchorSaving || anchorClearing}
                              data-testid="button-clear-actual-balance"
                            >
                              {anchorClearing ? "Clearing…" : "Clear"}
                            </Button>
                          ) : (
                            <span />
                          )}
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setAnchorOpen(false)}
                              disabled={anchorSaving || anchorClearing}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => void submitAnchor()}
                              disabled={
                                anchorSaving ||
                                anchorClearing ||
                                !anchorInput.trim()
                              }
                              data-testid="button-save-actual-balance"
                            >
                              {anchorSaving ? "Saving…" : "Save"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                ) : null
              }
            />
          )}
          {/* (#464) Pass `loading={!monthTxns}` so these tiles render an
              explicit "Loading…" affordance instead of a misleading $0.00
              if the underlying month query hasn't resolved yet — matches
              the hardened Ending balance tile from #455. */}
          <StatChip
            label="Charges"
            value={monthTxns ? monthTotals.charges : null}
            loading={!monthTxns}
            testId="stat-charges"
          />
          <StatChip
            label="Payments & credits"
            value={
              monthTxns ? Math.abs(monthTotals.paymentsAndCredits) : null
            }
            loading={!monthTxns}
            valueClassName="text-emerald-700"
            testId="stat-payments-credits"
          />
          <StatChip
            label="Net change"
            value={monthTxns ? monthTotals.netChange : null}
            loading={!monthTxns}
            valueClassName={
              monthTotals.netChange > 0
                ? "text-rose-700"
                : monthTotals.netChange < 0
                  ? "text-emerald-700"
                  : undefined
            }
            signed
            testId="stat-net-change"
          />
        </div>
      </div>

        <AccountFilterBar
          search={search}
          onSearchChange={setSearch}
          from={from}
          onFromChange={setFrom}
          to={to}
          onToChange={setTo}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          sourceOptions={[
            { value: "all", label: "All Amex sources" },
            { value: "plaid:amex", label: "Amex (Plaid)" },
            { value: "amex", label: "Amex (CSV)" },
            { value: "manual", label: "Manual" },
            { value: "import", label: "Imported" },
          ]}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={setCategoryFilter}
          categories={categories ?? []}
          members={members}
          memberFilter={memberFilter}
          onMemberFilterChange={setMemberFilter}
          extraFilters={
            <>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                  Reviewed
                </label>
                <Button
                  type="button"
                  variant={hideReviewed ? "default" : "outline"}
                  size="sm"
                  className="h-9"
                  onClick={() => setHideReviewed((v) => !v)}
                  aria-pressed={hideReviewed}
                  data-testid="button-hide-reviewed"
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 mr-1.5",
                      hideReviewed ? "opacity-100" : "opacity-40",
                    )}
                    strokeWidth={3}
                  />
                  Hide reviewed
                </Button>
              </div>
            </>
          }
          rightSlot={
            <div className="text-xs ml-auto flex flex-col items-end" data-testid="text-row-count">
              <span className="text-muted-foreground">
                {filtered.length} of {monthScoped.length} txns
              </span>
              {monthCapHit && (
                <span
                  className="text-[10px] text-amber-700"
                  data-testid="text-month-cap-hit"
                >
                  Showing first {MONTH_LIMIT} — narrow your filters
                </span>
              )}
            </div>
          }
        />
      </div>

      <BalanceTrendChart
        caption="Ending balance · trailing 12 months"
        data={balanceTrend}
        color="hsl(var(--chart-1))"
        valueLabel="Ending balance"
      />

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div
          className="sticky z-20 flex items-center gap-3 rounded-md border border-blue-300 bg-blue-50 px-4 py-2 shadow-sm"
          style={{ top: "var(--pinned-pane-h, 0px)" }}
        >
          <span className="text-sm font-medium text-blue-900">
            {selected.size} selected
          </span>
          <BulkCategoryPicker
            categories={categories ?? []}
            onPick={bulkSetCategory}
          />
          <div className="flex items-center gap-1">
            <span className="text-xs text-blue-900 mr-1">Bucket:</span>
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
            <span className="text-xs text-blue-900 mr-1">Reimb:</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetReimbursable(true)}>
              Mark
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkSetReimbursable(false)}>
              Unmark
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-blue-900 mr-1">Reviewed:</span>
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
            <span className="text-xs text-blue-900 mr-1">Owed by:</span>
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
              className="text-xs text-blue-900 font-mono tabular-nums"
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
          className="rounded-md border border-red-300 bg-red-50 p-3 space-y-2"
          data-testid="panel-bulk-failures"
          role="alert"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-red-900">
              {bulkFailures.label}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {bulkFailures.retry && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-red-400 text-red-900 bg-white hover:bg-red-100"
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
                className="h-7 text-xs text-red-900 hover:bg-red-100"
                onClick={dismissBulkFailures}
                data-testid="button-bulk-dismiss-failures"
              >
                Dismiss
              </Button>
            </div>
          </div>
          <ul
            className="max-h-40 overflow-auto text-xs text-red-900 space-y-1"
            data-testid="list-bulk-failures"
          >
            {bulkFailures.failures.map((f) => (
              <li
                key={f.id}
                className="flex items-baseline gap-2 border-t border-red-200 pt-1 first:border-t-0 first:pt-0"
                data-testid={`row-bulk-failure-${f.id}`}
              >
                <span className="font-medium truncate max-w-[40%]" title={f.description}>
                  {f.description}
                </span>
                <span className="text-red-700/80 truncate" title={f.error}>
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
      <VirtualizedDayGroups
        groups={groups}
        todayKey={todayKey}
        todayRef={todayRef}
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
                        <div className="font-medium break-words" title={t.description}>
                          {t.description}
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
                      {/* (#638) Per-row weekly-bucket picker. Always
                          rendered in a fixed-size slot so toggling WK
                          on/off doesn't change the row height and
                          bounce the virtualized list (#626). The
                          inner Select is only mounted (and only
                          interactive) when WK is on. */}
                      {!t.isTransfer && (
                        <div
                          className="h-7 w-28 shrink-0"
                          aria-hidden={t.weeklyAllowance ? undefined : true}
                          style={
                            t.weeklyAllowance
                              ? undefined
                              : { visibility: "hidden", pointerEvents: "none" }
                          }
                          data-testid={`slot-weekly-bucket-mobile-${t.id}`}
                        >
                          {t.weeklyAllowance ? (
                            <Select
                              value={t.weeklyBucket ?? TransactionWeeklyBucket.misc}
                              onValueChange={(v) =>
                                setRowBucket(
                                  t,
                                  "weekly",
                                  v as typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket],
                                )
                              }
                            >
                              <SelectTrigger
                                className="h-7 w-28 text-xs"
                                data-testid={`select-weekly-bucket-mobile-${t.id}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={TransactionWeeklyBucket.groceries}>{weeklyLabels.groceries}</SelectItem>
                                <SelectItem value={TransactionWeeklyBucket.dining}>{weeklyLabels.dining}</SelectItem>
                                <SelectItem value={TransactionWeeklyBucket.entertainment}>{weeklyLabels.entertainment}</SelectItem>
                                <SelectItem value={TransactionWeeklyBucket.misc}>{weeklyLabels.misc}</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : null}
                        </div>
                      )}
                      {!t.isTransfer && t.isTransferUserOverridden && (
                        <Badge
                          variant="outline"
                          className="inline-flex items-center text-[10px] font-normal border-slate-200 text-slate-500 bg-slate-50/60"
                          title="You cleared the auto-Transfer flag on this row. Future syncs won't re-add it."
                          data-testid={`badge-transfer-overridden-cleared-mobile-${t.id}`}
                        >
                          Manually set
                        </Badge>
                      )}
                      {t.isTransfer && (
                        <Badge
                          variant="outline"
                          className="inline-flex items-center gap-1 text-[10px] border-slate-300 text-slate-700 bg-slate-50"
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
              {/* Desktop: table layout (md and up) */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <tbody>
                    {items.map((t) => {
                      // (#629) Either reviewed OR Ignore'd dims the row.
                      const isIgnored =
                        !!ignoreCatId && t.categoryId === ignoreCatId;
                      return (
                      <tr
                        key={t.id}
                        className={cn(
                          "border-t hover:bg-muted/30 transition-colors",
                          (t.reviewed || isIgnored) && "opacity-50",
                        )}
                        data-reviewed={t.reviewed ? "true" : "false"}
                        data-ignored={isIgnored ? "true" : "false"}
                        data-testid={`row-amex-${t.id}`}
                      >
                        <td className="px-3 py-2 w-8">
                          <Checkbox
                            checked={selected.has(t.id)}
                            onCheckedChange={() => toggleOne(t.id)}
                            aria-label="Select"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium truncate max-w-[420px]" title={t.description}>
                            {t.description}
                          </div>
                          {t.notes && (
                            <div className="text-[11px] text-muted-foreground truncate" title={t.notes}>
                              {t.notes}
                            </div>
                          )}
                        </td>
                        <td
                          className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap"
                          data-testid={`text-card-${t.id}`}
                        >
                          {(t.plaidAccountId &&
                            cardLabelByPlaidAccountId.get(t.plaidAccountId)) ||
                            "—"}
                        </td>
                        <td className="px-3 py-2">
                          <CategoryPicker
                            value={t.categoryId ?? null}
                            categories={categories ?? []}
                            description={t.description}
                            onChange={(id, remember) =>
                              setRowCategory(t.id, id, remember)
                            }
                          />
                          {!t.isTransfer && t.isTransferUserOverridden && (
                            <Badge
                              variant="outline"
                              className="mt-1 inline-flex items-center text-[10px] font-normal border-slate-200 text-slate-500 bg-slate-50/60"
                              title="You cleared the auto-Transfer flag on this row. Future syncs won't re-add it."
                              data-testid={`badge-transfer-overridden-cleared-${t.id}`}
                            >
                              Manually set
                            </Badge>
                          )}
                          {t.isTransfer && (
                            <Badge
                              variant="outline"
                              className="mt-1 inline-flex items-center gap-1 text-[10px] border-slate-300 text-slate-700 bg-slate-50"
                              title={
                                t.isTransferUserOverridden
                                  ? "Manually set — won't be re-flagged on the next sync"
                                  : "Excluded from budget actuals"
                              }
                              data-testid={`badge-transfer-${t.id}`}
                            >
                              Transfer
                              {t.isTransferUserOverridden && (
                                <span
                                  aria-hidden="true"
                                  data-testid={`badge-transfer-overridden-${t.id}`}
                                  className="text-slate-500 -ml-0.5"
                                >
                                  *
                                </span>
                              )}
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
                          )}
                          <div className="mt-1">
                            <ExternalCardChip
                              t={t}
                              onToggle={(v) =>
                                updateTx.mutate(
                                  {
                                    id: t.id,
                                    data: { isExternalCardPayment: v },
                                  },
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
                              testIdSuffix={`${t.id}`}
                            />
                          </div>
                          <div className="mt-1">
                            <MatchedRuleChip
                              categoryId={t.categoryId}
                              matchedRuleId={t.matchedRuleId}
                              rules={mappingRules}
                              testIdSuffix={`amex-${t.id}`}
                              variant="compact"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            {/* (#607) Hide bucket bubbles on transfer
                                rows — see mobile layout above. */}
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
                            {/* (#638) Per-row weekly-bucket picker.
                                Always rendered in a fixed-size slot so
                                toggling WK on/off doesn't change the
                                row height and bounce the virtualized
                                list (#626). The inner Select is only
                                mounted (and only interactive) when WK
                                is on. */}
                            {!t.isTransfer && (
                              <div
                                className="h-7 w-28 shrink-0"
                                aria-hidden={t.weeklyAllowance ? undefined : true}
                                style={
                                  t.weeklyAllowance
                                    ? undefined
                                    : { visibility: "hidden", pointerEvents: "none" }
                                }
                                data-testid={`slot-weekly-bucket-${t.id}`}
                              >
                                {t.weeklyAllowance ? (
                                  <Select
                                    value={t.weeklyBucket ?? TransactionWeeklyBucket.misc}
                                    onValueChange={(v) =>
                                      setRowBucket(
                                        t,
                                        "weekly",
                                        v as typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket],
                                      )
                                    }
                                  >
                                    <SelectTrigger
                                      className="h-7 w-28 text-xs"
                                      data-testid={`select-weekly-bucket-${t.id}`}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={TransactionWeeklyBucket.groceries}>{weeklyLabels.groceries}</SelectItem>
                                      <SelectItem value={TransactionWeeklyBucket.dining}>{weeklyLabels.dining}</SelectItem>
                                      <SelectItem value={TransactionWeeklyBucket.entertainment}>{weeklyLabels.entertainment}</SelectItem>
                                      <SelectItem value={TransactionWeeklyBucket.misc}>{weeklyLabels.misc}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                          <div className="flex flex-col items-end">
                            <span>{formatCurrency(parseAbs(t.amount))}</span>
                            {runningBalanceMap.has(t.id) && (
                              <span
                                className="text-[11px] text-muted-foreground"
                                data-testid={`text-running-balance-${t.id}`}
                              >
                                bal {formatCurrency(runningBalanceMap.get(t.id)!)}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
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

// (#485) Window-virtualized list of day groups. Renders only the
// groups currently in the viewport (plus a small overscan), so the
// Amex page stays smooth even when a month has hundreds of rows.
// Uses padding spacers (instead of absolute positioning) so the
// `position: sticky` day-header inside `DayGroup` continues to work
// against the page scroll container.
function VirtualizedDayGroups<G>({
  groups,
  todayKey,
  todayRef,
  renderGroup,
}: {
  groups: [string, G[]][];
  todayKey: string;
  todayRef: React.MutableRefObject<HTMLDivElement | null>;
  renderGroup: (entry: [string, G[]]) => React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setScrollMargin(rect.top + window.scrollY);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // (#744) The 24px gap rendered between day-group wrappers below must
  // be baked into both the estimate and the per-item measured size,
  // otherwise `getTotalSize()` is strictly smaller than the actual
  // scroll height and the virtualizer believes the user has reached
  // the end of the list before the oldest day-groups (May 1–16 in the
  // reported case) come into view, leaving the bottom of the month
  // silently trimmed.
  const ITEM_GAP_PX = 24;
  const virtualizer = useWindowVirtualizer({
    count: groups.length,
    estimateSize: (i) => 64 + groups[i][1].length * 72 + ITEM_GAP_PX,
    overscan: 4,
    scrollMargin,
  });

  // Find the index of today's group so we can ensure it stays mounted
  // (the auto-scroll-to-today effect relies on its DOM ref).
  const todayIdx = useMemo(
    () => groups.findIndex(([k]) => k === todayKey),
    [groups, todayKey],
  );

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  // With useWindowVirtualizer + scrollMargin, virtualItems[i].start is an
  // absolute offset against the document scroll position, not the parent
  // container. We must subtract scrollMargin so the paddingTop spacer
  // sits flush under the previous element instead of reserving a
  // ~scrollMargin-sized empty gap above the first rendered day.
  const paddingTop =
    virtualItems.length > 0 ? virtualItems[0].start - scrollMargin : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - (virtualItems[virtualItems.length - 1].end - scrollMargin)
      : 0;

  // Collect indices to render: the virtual window plus today (so the
  // initial scroll-into-view always finds an element).
  const indices = new Set(virtualItems.map((vi) => vi.index));
  if (todayIdx >= 0) indices.add(todayIdx);
  const sorted = Array.from(indices).sort((a, b) => a - b);

  return (
    <div ref={parentRef}>
      <div style={{ paddingTop, paddingBottom }}>
        {sorted.map((index) => (
          <div
            key={groups[index][0]}
            data-index={index}
            ref={virtualizer.measureElement}
            // (#744) The inter-group gap is rendered as paddingBottom
            // on the measured wrapper (rather than via `space-y-6` on
            // the parent) so that `measureElement.getBoundingClientRect`
            // includes it in the virtualizer's totalSize. Otherwise the
            // accumulated gap height was not tracked and the bottom of
            // the month silently dropped out of the rendered window.
            style={{
              paddingBottom: index < groups.length - 1 ? ITEM_GAP_PX : 0,
            }}
          >
            {renderGroup(groups[index])}
          </div>
        ))}
      </div>
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
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
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
