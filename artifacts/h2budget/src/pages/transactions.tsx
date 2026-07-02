import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListTransactions,
  useCreateTransaction,
  useUpdateTransaction,
  useClearTransferOverride,
  useDeleteTransaction,
  useListCategories,
  useListMappingRules,
  useGetForecast,
  useRefreshForecastBank,
  useSeedAprilChase,
  useBulkSetForecastFlag,
  useSendTransactionsToReview,
  useUnsendTransactionsFromReview,
  getListTransactionsQueryKey,
  getGetForecastQueryKey,
  getGetBudgetMonthQueryKey,
  useListPlaidItems,
  useGetForecastCashSignal,
  type Transaction,
  type RepointedRule,
  type MappingRule,
  type CreateTransactionInput,
} from "@workspace/api-client-react";
import { MerchantRenamePopover } from "@/components/merchant-rename-popover";
import { RowDateControls } from "@/components/row-date-controls";
import { AccountTransactionRow } from "@/components/account-page/transaction-row";
import { AccountPageSkeleton } from "@/components/account-page/account-page-skeleton";
import {
  useBulkRecategorizePrompt,
  bulkRuleFromRepointed,
  bulkRuleFromRuleAction,
} from "@/hooks/use-bulk-recategorize-prompt";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { TimeRangeToggle } from "@/components/time-range-toggle";
import { rangeForMode, type RangeMode } from "@/lib/timeRange";
import { Sparkline, StackBar, DeltaPill, MoneyText } from "@/components/viz";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate, cn, moneyColorClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Edit2,
  Trash2,
  Send,
  Inbox,
  Landmark,
  RefreshCw,
  CalendarDays,
  X,
} from "lucide-react";
import { isBankTxn } from "@/lib/forecastMatch";
import { ruleActionMessage } from "@/lib/ruleActionMessage";
import { useRuleActionUndo } from "@/lib/useRuleActionUndo";
import { type BucketKey } from "@/components/bucket-bubbles";
import {
  TransactionRowChips,
  CHIP_BASE,
} from "@/components/transaction-row-chips";
import {
  makeChaseBalanceAtEndOf,
  makeChaseBalanceAtEndOfDate,
  scopeChaseTransactions,
} from "@/lib/chaseEndingBalance";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import {
  compareNewestFirst,
  computeRunningBalances,
  sortNewestFirst,
} from "@/lib/runningBalance";
import { useToast } from "@/hooks/use-toast";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { ToastAction } from "@/components/ui/toast";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { PostLinkProgressBanner } from "@/components/post-link-progress";
import { PlaidReauthBanner } from "@/components/plaid-reauth-banner";
import { SyncButton } from "@/components/sync-button";
import {
  AccountPageHeader,
  AccountFilterBar,
  BalanceTrendChart,
  DayGroup,
  MonthNavigator,
  monthKeyOf,
  monthKeyFromISO,
  compareMonth,
  type MonthKey,
  type BalanceSeriesPoint,
} from "@/components/account-page";
import { ChaseLogo } from "@/components/brand-logos";
import { ChaseInsightStrip } from "@/components/chase-insight-strip";
import { AiInsightBar } from "@/components/ai-insight-bar";
import {
  formSchema,
  matchRuleClient,
  normalizeAmount,
  parseSigned,
  type FormValues,
} from "./transactions/transactionsShared";
import { InlineAmountEditor } from "./transactions/InlineAmountEditor";
import { TransactionEditDialog } from "./transactions/TransactionEditDialog";

// Task #451 — Render a transaction's `source` (e.g. `plaid:chase`,
// `amex`, `manual`) as a calm, human-readable label for the
// transactions list. Plaid-tagged sources surface the institution
// name first ("Chase") with a muted " · Plaid" suffix so the user
// knows where the row came from without the raw colon-separated
// string shouting at them. Falls back to a Title-Cased version of
// the raw source for anything we don't recognize.
function formatTransactionSource(source: string | null | undefined): string {
  if (!source) return "";
  const s = source.trim();
  if (!s) return "";
  const titleCase = (w: string) =>
    w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w;
  if (s.toLowerCase().startsWith("plaid:")) {
    const inst = s.slice("plaid:".length);
    return `${titleCase(inst) || "Plaid"} · Plaid`;
  }
  return titleCase(s);
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

// #103 — persisted chase-page account picker. Stored under a stable key
// so it survives reloads / browser restarts even when the user clears
// the URL. URL takes precedence so shareable links still win.
const CHASE_ACCOUNT_STORAGE_KEY = "h2budget:chase-account";

function readInitialChaseAccount(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("account");
    if (fromUrl) return fromUrl;
    return window.localStorage.getItem(CHASE_ACCOUNT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export default function TransactionsPage() {
  // Auto Plaid refresh on mount is DISABLED to avoid per-pull Plaid
  // charges — banks sync only on the manual Sync button now.
  const { data: transactions, isLoading } = useListTransactions({ limit: 5000 });
  const { data: categories } = useListCategories();
  const { data: mappingRules } = useListMappingRules();
  // (#perf-2) Share the same {days:90} forecast key as Home/Reports so the
  // ambient forecast bundle is fetched once and reused, not twice under two
  // keys (no-params vs days:90). The Forecast page keeps its own interactive
  // horizon query.
  const { data: forecastData } = useGetForecast({ days: 90 });
  // Stable "today" (YYYY-MM-DD) used as the actual/forecast split anchor
  // and as the projection's `fromDate` so the dashed forecast line starts
  // at today and the cash-signal series aligns with the chart window.
  const todayISO = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }, []);
  // Forward-looking projection that powers the actual-vs-forecast trend
  // chart's dashed line. Sourced from the SAME cash-signal daily series
  // the /forecast page's projected-balance chart consumes (`proj.daily`),
  // requested over a 12-month horizon from today.
  const { data: cashProjection } = useGetForecastCashSignal({
    horizonDays: 365,
    fromDate: todayISO,
  });
  const refreshBank = useRefreshForecastBank();
  const seedAprilChase = useSeedAprilChase();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  // One-shot seed of the user's April 2026 Chase activity. Idempotent on the
  // server (skips rows whose plaid_transaction_id already exists), so it's
  // safe to fire on every initial mount.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (isLoading) return;
    seededRef.current = true;
    seedAprilChase.mutate(undefined, {
      onSuccess: (res) => {
        if (res.inserted > 0 || res.rulesAdded > 0) {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          queryClient.invalidateQueries({
            queryKey: getGetBudgetMonthQueryKey("2026-04-01"),
          });
          if (res.inserted > 0) {
            toast({
              title: `Loaded ${res.inserted} April Chase transactions`,
              description: `Ending balance ${formatCurrency(res.endingBalance)}`,
            });
          }
        } else if (res.snapshotRepaired) {
          // Snapshot was rewritten from the legacy ending balance to the
          // corrected one — refresh the forecast bundle so the cached UI
          // picks up the new bank snapshot value.
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
        }
      },
      onError: (e) => {
        // Non-fatal — page still renders whatever the user already has.
        // eslint-disable-next-line no-console
        console.warn("April Chase seed failed:", (e as Error).message);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const bankSnapshot = forecastData?.bankSnapshot ?? null;
  const accountSnapshots = forecastData?.accountSnapshots ?? {};
  // (#797) Scope the linked-checking list to Chase only. The forecast
  // API's `listCheckingAccounts` filters purely by subtype/type, so any
  // depository account from another institution (PayPal, etc.) leaks in.
  // We match by institution name (case-insensitive "chase") here — and
  // by Plaid's `ins_56` institution id when that field is present on the
  // payload — so the "View account" dropdown and every account-scoping
  // derivation below can never select or be driven by a non-Chase account.
  const chaseOnlyPlaidCheckingAccounts = useMemo(() => {
    const accounts = forecastData?.plaidCheckingAccounts ?? [];
    return accounts.filter((a) => {
      const inst = (a.institutionName ?? "").toLowerCase();
      const instId = (
        (a as { institution_id?: string | null }).institution_id ?? ""
      ).toLowerCase();
      return inst.includes("chase") || instId === "ins_56";
    });
  }, [forecastData?.plaidCheckingAccounts]);
  // #103 — multi-checking households: let the user pick which linked
  // checking account powers this page. The selected key is either
  // `"manual"` (transactions without a plaidAccountId) or the internal
  // id of a row in `plaidCheckingAccounts`. The selection is persisted
  // across reloads via a `?account=` URL param plus a localStorage
  // fallback so deep-links share the same view.
  const [selectedAccountKey, setSelectedAccountKey] = useState<string | null>(
    () => readInitialChaseAccount(),
  );
  // The effective key falls back to the snapshot's account (or "manual"
  // when there is no snapshot) so a fresh user with no preference still
  // lands on the same account they would have seen before #103.
  const defaultAccountKey = bankSnapshot?.accountId ?? "manual";
  const effectiveAccountKey = selectedAccountKey ?? defaultAccountKey;
  const isManualAccount = effectiveAccountKey === "manual";
  const effectiveAccountInternalId = isManualAccount ? null : effectiveAccountKey;
  // (#357) Map the currently-viewed account back to its owning Plaid
  // item so the header SyncButton's inline error chip / Reconnect popover
  // only surfaces failures relevant to *this* view. Manual accounts get
  // an empty allow-list, which silences the chip entirely — a Chase
  // re-auth error must not pollute the Manual account view.
  const { data: plaidItemsForScope } = useListPlaidItems();
  const relevantPlaidItemIds = useMemo<string[] | undefined>(() => {
    if (isManualAccount) return [];
    if (!effectiveAccountInternalId) return undefined;
    const items = plaidItemsForScope ?? [];
    const owning = items.find((it) =>
      (it.accounts ?? []).some((a) => a.id === effectiveAccountInternalId),
    );
    return owning ? [owning.id] : [];
  }, [isManualAccount, effectiveAccountInternalId, plaidItemsForScope]);
  // True when the user is viewing the same account that the bank
  // snapshot anchors. Used by header meta + as a "this is the primary
  // account" hint in the picker dropdown.
  const usingSnapshotAccount =
    !!bankSnapshot &&
    effectiveAccountKey === (bankSnapshot.accountId ?? "manual");
  // #296 — pick whichever snapshot anchors the *currently-viewed*
  // account: the primary `bankSnapshot` if we're on its account,
  // otherwise the per-account entry from `accountSnapshots`. Manual
  // (non-Plaid) accounts have no anchor and stay null.
  const effectiveSnapshot = useMemo<{
    balance: string;
    at: string;
    source: "manual" | "plaid";
    name: string | null;
    mask: string | null;
  } | null>(() => {
    // (#429) Includes a post-dedupe fallback: when a survivor row is
    // briefly missing from `accountSnapshots` but matches the primary
    // bankSnapshot by (institutionName, mask), reuse the primary so
    // the Starting / Ending balance tiles stay populated instead of
    // dropping to the "Unavailable" placeholder.
    return deriveEffectiveSnapshot({
      bankSnapshot,
      accountSnapshots,
      selectedAccountInternalId: effectiveAccountInternalId,
      plaidCheckingAccounts: chaseOnlyPlaidCheckingAccounts,
    });
  }, [
    bankSnapshot,
    effectiveAccountInternalId,
    accountSnapshots,
    chaseOnlyPlaidCheckingAccounts,
  ]);
  const chasePlaidAccountId = useMemo(() => {
    if (!effectiveAccountInternalId) return null;
    const acct = chaseOnlyPlaidCheckingAccounts.find(
      (a) => a.id === effectiveAccountInternalId,
    );
    return acct?.accountId ?? null;
  }, [effectiveAccountInternalId, chaseOnlyPlaidCheckingAccounts]);
  // (#462) Equivalent external Plaid account_ids for the selected
  // account, collapsed by (institutionName, mask). During the brief
  // mid-re-link window before `dedupePlaidAccountsForUser` collapses
  // duplicate `plaid_accounts` rows, transactions can briefly land
  // on the duplicate row's external account_id. Treating the duplicate
  // as the same physical account keeps that activity counted under the
  // real account so the Ending Balance tile doesn't lose rows the
  // user will see again once dedupe lands. Mirrors the Amex page's
  // `amexDebt` (institution, mask) collapse from #449.
  const chasePlaidAccountIds = useMemo<Set<string> | null>(() => {
    if (chasePlaidAccountId === null) return null;
    const accounts = chaseOnlyPlaidCheckingAccounts;
    const selected = accounts.find(
      (a) => a.id === effectiveAccountInternalId,
    );
    const ids = new Set<string>();
    ids.add(chasePlaidAccountId);
    if (!selected) return ids;
    const selInst = (selected.institutionName ?? "").toLowerCase();
    const selMask = (selected.mask ?? "").toLowerCase();
    if (!selInst || !selMask) return ids;
    for (const a of accounts) {
      if (a.id === selected.id) continue;
      if (!a.accountId) continue;
      const inst = (a.institutionName ?? "").toLowerCase();
      const mask = (a.mask ?? "").toLowerCase();
      if (inst === selInst && mask === selMask) {
        ids.add(a.accountId);
      }
    }
    return ids;
  }, [
    chasePlaidAccountId,
    effectiveAccountInternalId,
    chaseOnlyPlaidCheckingAccounts,
  ]);
  // The currently selected account row (if it's a Plaid account) — used
  // by the meta line under the header so the user always sees the
  // institution / mask of the account they're viewing, not just the
  // snapshot account.
  const selectedPlaidAccount = useMemo(() => {
    if (!effectiveAccountInternalId) return null;
    return (
      chaseOnlyPlaidCheckingAccounts.find(
        (a) => a.id === effectiveAccountInternalId,
      ) ?? null
    );
  }, [effectiveAccountInternalId, chaseOnlyPlaidCheckingAccounts]);

  // Persist the picker selection so reloads / deep-links land on the
  // same account. We update both `?account=` (visible, shareable) and
  // localStorage (so it sticks even when the user clears the URL).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (selectedAccountKey) {
      params.set("account", selectedAccountKey);
      try {
        window.localStorage.setItem(
          CHASE_ACCOUNT_STORAGE_KEY,
          selectedAccountKey,
        );
      } catch {
        // localStorage may be blocked (private mode); URL still works.
      }
    } else {
      params.delete("account");
      try {
        window.localStorage.removeItem(CHASE_ACCOUNT_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }, [selectedAccountKey]);

  // If the persisted selection points at an account that no longer
  // exists (linked bank removed, account closed), drop it back to the
  // default so the picker doesn't render an empty value.
  useEffect(() => {
    if (!selectedAccountKey) return;
    if (!forecastData?.plaidCheckingAccounts) return;
    // (#797) Legacy "manual" selection self-heal. The "Manual entries"
    // picker option was removed, so a persisted `manual` selection can no
    // longer be switched away from in the UI. When the user actually has
    // a Chase account, drop back to the default (Chase) account so they
    // aren't stranded on a manual-only view behind a blank picker trigger.
    // When no Chase account exists we keep `manual` — that's still the
    // legitimate source-based fallback surface.
    if (selectedAccountKey === "manual") {
      if (chaseOnlyPlaidCheckingAccounts.length > 0) {
        setSelectedAccountKey(null);
      }
      return;
    }
    if (!chaseOnlyPlaidCheckingAccounts.some((a) => a.id === selectedAccountKey)) {
      setSelectedAccountKey(null);
    }
  }, [
    selectedAccountKey,
    forecastData?.plaidCheckingAccounts,
    chaseOnlyPlaidCheckingAccounts,
  ]);

  // Scope to the linked checking account (or manual rows when nothing linked).
  // (#443) Dedupe by Plaid transaction id (or row id) so duplicate survivor
  // rows left behind by the #429/#408 dedupe work cannot inflate the
  // Money in / Money out tiles or the rolling-balance net change.
  // (#475) Both the per-account scoping/dedupe and the per-account
  // fallback live in `scopeChaseTransactions` so the dashboard's
  // "Chase ending balance" tile sees exactly the same activity set.
  // (#448) When no Plaid checking account is linked, the helper
  // tightens the fallback to only Chase-source + manual rows so the
  // Chase page can't sweep in Amex / debt activity.
  const chaseTransactions = useMemo(() => {
    return scopeChaseTransactions(
      transactions ?? [],
      chasePlaidAccountIds ?? null,
    );
  }, [transactions, chasePlaidAccountIds]);

  // ---- Filters & month navigation ----
  const currentMonth = useMemo<MonthKey>(() => monthKeyOf(new Date()), []);
  // Seed selectedMonth from a `?month=YYYY-MM-01` URL param (used by Budget
  // page deep-links), falling back to the current month.
  // (#400) Track whether the initial selected month came from a `?month=`
  // URL param so the post-import auto-jump effect below can respect a
  // deliberate deep-link and not yank the user away from it.
  const monthPinnedFromUrlRef = useRef(false);
  const [selectedMonth, setSelectedMonth] = useState<MonthKey>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const m = params.get("month");
      if (m && /^\d{4}-\d{2}-01$/.test(m)) {
        monthPinnedFromUrlRef.current = true;
        return monthKeyFromISO(m);
      }
    }
    return currentMonth;
  });
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Weekly-first: the summary + balance trend lead with THIS week. Mo/Yr opt-in.
  const [rangeMode, setRangeMode] = useState<RangeMode>("wk");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const categoryUrlApplied = useRef(false);
  useEffect(() => {
    if (categoryUrlApplied.current || !categories?.length) return;
    const params = new URLSearchParams(window.location.search);
    const catName = params.get("category");
    if (catName) {
      const match = categories.find((c) => c.name === catName);
      if (match) {
        setCategoryFilter(match.id);
        categoryUrlApplied.current = true;
      }
    }
  }, [categories]);
  const [memberFilter, setMemberFilter] = useState<string>("all");

  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // (#629) Resolve the system-managed "Ignore" category id once so we can
  // dim rows whose categoryId points at it. Matches `category-picker.tsx`
  // which also looks Ignore up by name (it's the single
  // `excludeFromBudget` category users can pick — Uncategorized/Transfer
  // also carry that flag but aren't user-selectable as "Ignore").
  const ignoreCatId = useMemo(
    () => (categories ?? []).find((c) => c.name === "Ignore")?.id ?? null,
    [categories],
  );

  const sourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of chaseTransactions) if (t.source) set.add(t.source);
    return [
      { value: "all", label: "All sources" },
      ...Array.from(set)
        .sort()
        .map((s) => ({ value: s, label: s })),
    ];
  }, [chaseTransactions]);

  const members = useMemo(() => {
    const s = new Set<string>();
    for (const t of chaseTransactions) if (t.member) s.add(t.member);
    return Array.from(s).sort();
  }, [chaseTransactions]);

  // (#400) After a fresh Plaid link/import, jump the month navigator to
  // the most recent month that actually has imported rows for the
  // currently-viewed account. Without this, the user lands on whatever
  // month they had selected before linking — frequently a month with
  // zero new rows — and sees an empty table even though the import
  // succeeded ("Ready — 116 added"). The flag is armed by the
  // PlaidLinkButton's onImportReady callback and consumed by the effect
  // below once `chaseTransactions` has updated to reflect the import.
  // We never override an explicit `?month=` deep-link — those represent
  // deliberate user intent (e.g. coming from the Budget page) and the
  // user should stay where they asked to be even if that month is empty.
  const [pendingPostImportJump, setPendingPostImportJump] = useState(false);
  useEffect(() => {
    if (!pendingPostImportJump) return;
    if (monthPinnedFromUrlRef.current) {
      setPendingPostImportJump(false);
      return;
    }
    if (chaseTransactions.length === 0) return;
    const currentHasData = chaseTransactions.some(
      (t) => compareMonth(monthKeyFromISO(t.occurredOn), selectedMonth) === 0,
    );
    if (currentHasData) {
      setPendingPostImportJump(false);
      return;
    }
    let max: MonthKey | null = null;
    for (const t of chaseTransactions) {
      const mk = monthKeyFromISO(t.occurredOn);
      if (!max || compareMonth(mk, max) > 0) max = mk;
    }
    if (max) setSelectedMonth(max);
    setPendingPostImportJump(false);
  }, [pendingPostImportJump, chaseTransactions, selectedMonth]);

  // (#chase-empty) On first load, if the current month has no Chase rows but
  // earlier months do, jump the navigator to the latest month that actually has
  // data — so the page never opens to an empty table when data exists elsewhere.
  // Runs once; respects a `?month=` deep-link and never fights later manual nav.
  const initialMonthJumpDone = useRef(false);
  useEffect(() => {
    if (initialMonthJumpDone.current) return;
    if (monthPinnedFromUrlRef.current) {
      initialMonthJumpDone.current = true;
      return;
    }
    if (chaseTransactions.length === 0) return; // wait for data to arrive
    initialMonthJumpDone.current = true;
    const currentHasData = chaseTransactions.some(
      (t) => compareMonth(monthKeyFromISO(t.occurredOn), selectedMonth) === 0,
    );
    if (currentHasData) return;
    let max: MonthKey | null = null;
    for (const t of chaseTransactions) {
      const mk = monthKeyFromISO(t.occurredOn);
      if (!max || compareMonth(mk, max) > 0) max = mk;
    }
    if (max) setSelectedMonth(max);
  }, [chaseTransactions, selectedMonth]);

  const monthScoped = useMemo(() => {
    return chaseTransactions.filter((t) => {
      const mk = monthKeyFromISO(t.occurredOn);
      return compareMonth(mk, selectedMonth) === 0;
    });
  }, [chaseTransactions, selectedMonth]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return monthScoped.filter((t) => {
      const k = t.occurredOn.slice(0, 10);
      if (from && k < from) return false;
      if (to && k > to) return false;
      if (sourceFilter !== "all" && t.source !== sourceFilter) return false;
      if (memberFilter !== "all" && (t.member ?? "") !== memberFilter)
        return false;
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
  }, [monthScoped, search, from, to, sourceFilter, memberFilter, categoryFilter, categoryById]);

  // (#475) Anchor + per-month balance math is shared with the
  // dashboard's "Chase ending balance" tile via `makeChaseBalanceAtEndOf`,
  // so the two surfaces always agree for any month. The closure
  // returns `null` when no effective snapshot is available (Manual
  // account, or Plaid account that has never been refreshed).
  const balanceAtEndOf = useMemo(
    () =>
      makeChaseBalanceAtEndOf({
        effectiveSnapshot,
        chaseTransactions,
      }),
    [effectiveSnapshot, chaseTransactions],
  );

  const endingBalance = useMemo(
    () => balanceAtEndOf(selectedMonth),
    [balanceAtEndOf, selectedMonth],
  );

  // Date-bucketed sibling of `balanceAtEndOf`, used by the actual-vs-
  // forecast trend chart to get the end-of-week (Sun–Sat) checking
  // balance for each historical weekly bucket. Shares the same snapshot
  // anchor + scoped transaction set as the month closure.
  const balanceAtEndOfDate = useMemo(
    () =>
      makeChaseBalanceAtEndOfDate({
        effectiveSnapshot,
        chaseTransactions,
      }),
    [effectiveSnapshot, chaseTransactions],
  );

  // ---- Weekly-first range summary (the household lives by the week) ----
  // Computed straight from chaseTransactions scoped to the selected range, so
  // it always populates from the same data the ledger renders — sidestepping
  // the month-scoped totals path that could read $0.00 on an empty month.
  const range = useMemo(() => rangeForMode(rangeMode), [rangeMode]);
  const rangeTotals = useMemo(() => {
    let moneyIn = 0;
    let moneyOut = 0;
    for (const t of chaseTransactions) {
      const k = t.occurredOn.slice(0, 10);
      if (k < range.from || k > range.to) continue;
      const a = Number(t.amount) || 0;
      if (a >= 0) moneyIn += a;
      else moneyOut += -a;
    }
    return { moneyIn, moneyOut, net: moneyIn - moneyOut };
  }, [chaseTransactions, range]);
  // Start/end checking balance + a daily balance sparkline (sampled so a year
  // view never renders 365 points).
  const rangeBalances = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const start = new Date(`${range.from}T00:00:00`);
    const end = new Date(`${range.to}T00:00:00`);
    const totalDays = Math.max(
      1,
      Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1,
    );
    const step = totalDays > 40 ? Math.ceil(totalDays / 40) : 1;
    const series: number[] = [];
    for (let i = 0; i < totalDays; i += step) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const b = balanceAtEndOfDate(iso(d));
      if (b != null) series.push(b);
    }
    const dayBefore = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
    return {
      series,
      startBal: balanceAtEndOfDate(iso(dayBefore)),
      endBal: balanceAtEndOfDate(range.to),
    };
  }, [range, balanceAtEndOfDate]);

  // The forward-looking actual-vs-forecast trend chart series. Window:
  // start = max(2026-05-01, current month start); end = today + 12 months.
  // We walk Sun–Sat weeks (bucketed on the week-ending Saturday) and
  // build three weekly series that all share today's actual balance as
  // their common anchor, so the historical solid line meets today and
  // both forward lines diverge from that same point.
  const balanceTrend = useMemo(() => {
    if (!effectiveSnapshot) return null;

    const pad = (n: number) => String(n).padStart(2, "0");
    const toISO = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const now = new Date();
    // Window start: floor at May 2026, else the current month's first day.
    const FLOOR = new Date(2026, 4, 1); // 2026-05-01
    const curMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const windowStart = curMonthStart > FLOOR ? curMonthStart : FLOOR;
    // Window end: 12 months from today.
    const windowEnd = new Date(
      now.getFullYear(),
      now.getMonth() + 12,
      now.getDate(),
    );

    // Today's actual balance — the common anchor for all three series.
    const todayBalance = balanceAtEndOfDate(todayISO) ?? 0;

    // First week-ending Saturday on/after the window start.
    const firstSat = new Date(windowStart);
    firstSat.setDate(firstSat.getDate() + ((6 - firstSat.getDay() + 7) % 7));

    const historicalActual: BalanceSeriesPoint[] = [];
    for (
      let sat = new Date(firstSat);
      sat <= windowEnd;
      sat.setDate(sat.getDate() + 7)
    ) {
      const satISO = toISO(sat);
      if (satISO >= todayISO) break; // today + future handled below
      // Don't fabricate a $0 point when the balance for a date can't be
      // computed — skip it and let the chart connect real points (connectNulls)
      // instead of drawing a misleading flat line at zero.
      const bal = balanceAtEndOfDate(satISO);
      if (bal == null) continue;
      historicalActual.push({ date: satISO, balance: bal });
    }

    // Projected end-of-day balance per ISO date from the cash signal.
    const projByDate = new Map<string, number>();
    for (const d of cashProjection?.daily ?? []) {
      const n = Number(d.balance);
      if (Number.isFinite(n)) projByDate.set(d.date, n);
    }

    // Forecast: seeded at today's actual balance, then weekly Saturday
    // buckets pulled from the projection. We deliberately STOP at the
    // last Saturday the projection actually covers — if the server
    // horizon is shorter than the 12-month window we do NOT carry the
    // last value forward to fill the gap (that would draw a misleading
    // flat dashed tail). Leave this trim in place.
    const forecastFromToday: BalanceSeriesPoint[] = [
      { date: todayISO, balance: todayBalance },
    ];
    for (
      let sat = new Date(firstSat);
      sat <= windowEnd;
      sat.setDate(sat.getDate() + 7)
    ) {
      const satISO = toISO(sat);
      if (satISO <= todayISO) continue;
      const projected = projByDate.get(satISO);
      if (projected == null) continue; // beyond horizon — do not extend
      forecastFromToday.push({ date: satISO, balance: projected });
    }

    // Actual-from-today: just today's seed on day one. Future real
    // balance points will accrue naturally as later syncs land and the
    // historical/date closure starts returning post-today values.
    const actualFromToday: BalanceSeriesPoint[] = [
      { date: todayISO, balance: todayBalance },
    ];

    // Full weekly date scaffold across the whole window (every week-ending
    // Saturday + today). Passed to the chart so the monthly x-axis ticks
    // span the entire ~12-month window even while the projection is still
    // loading or the server horizon is shorter than 12 months — the lines
    // themselves still stop at the last real point (no flat extension).
    const axisDates: string[] = [todayISO];
    for (
      let sat = new Date(firstSat);
      sat <= windowEnd;
      sat.setDate(sat.getDate() + 7)
    ) {
      axisDates.push(toISO(sat));
    }

    const fmtMonthYear = (d: Date) =>
      d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    const subtitle = `${fmtMonthYear(windowStart)} – ${fmtMonthYear(windowEnd)}`;

    return {
      historicalActual,
      forecastFromToday,
      actualFromToday,
      axisDates,
      subtitle,
    };
  }, [
    effectiveSnapshot,
    balanceAtEndOfDate,
    cashProjection,
    todayISO,
  ]);

  // Anchor every same-day balance assignment to the canonical
  // newest-first comparator (occurredOn DESC, occurredAt DESC nulls
  // last, id DESC). The day-group display below uses the SAME
  // comparator so the "bal $X" shown beside each row matches the
  // row's actual position in the register-style list.
  const runningBalanceMap = useMemo(() => {
    if (endingBalance === null) return new Map<string, number>();
    return computeRunningBalances(sortNewestFirst(monthScoped), endingBalance);
  }, [monthScoped, endingBalance]);

  // ---- Day grouping ----
  // Within each day, sort items newest-first via the same canonical
  // comparator used to compute the running balance. Without this,
  // Postgres returns same-day rows in an unspecified order and the
  // running balance values shown beside them appear non-monotonic.
  // (#728) Split pending Plaid charges out of the dated day-groups
  // and into a single pinned "Pending" group rendered above them.
  // Pending rows occurredOn drifts (Plaid often stamps them as
  // today even when they'll post earlier) and they vanish/re-key
  // when Plaid surfaces the posted twin — so burying them inside
  // their drifted day made it impossible to scan "what's still
  // settling?" at a glance. Pinning them keeps the lifecycle
  // explicit. Totals on monthly tiles still include these rows
  // (they're real money) — only the visual grouping changes.
  // Pending is "live money still settling", so surface ALL of it for this
  // account regardless of the selected week/month window. Plaid drifts pending
  // occurredOn (often stamps "today" even when it'll post earlier), so scoping
  // pending to the viewed week/month silently hid settling charges — the exact
  // "I know I'm missing expenses" symptom. Honor only the NON-date filters
  // (search / source / member / category) so those still scope it; never the
  // date window. Display-only: monthly tile totals still come from `filtered`.
  const pendingItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return chaseTransactions
      .filter((t) => {
        if (!t.pending) return false;
        if (sourceFilter !== "all" && t.source !== sourceFilter) return false;
        if (memberFilter !== "all" && (t.member ?? "") !== memberFilter)
          return false;
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
      })
      .slice()
      .sort(compareNewestFirst);
  }, [chaseTransactions, search, sourceFilter, memberFilter, categoryFilter, categoryById]);
  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of filtered) {
      if (t.pending) continue;
      const k = t.occurredOn.slice(0, 10);
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    for (const arr of map.values()) arr.sort(compareNewestFirst);
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  // ---- Mutations & dialog ----
  const createTx = useCreateTransaction();
  const updateTx = useUpdateTransaction();
  const clearTransferOverride = useClearTransferOverride();
  const deleteTx = useDeleteTransaction();
  const bulkSetForecastFlag = useBulkSetForecastFlag();
  // (#762 — Phase B) Manual Send-to-Review gate mutations. The
  // unsend variant backs both the symmetric "Unsend" affordance on
  // an already-promoted row and the 5-second Undo on the bulk /
  // per-row success toast.
  const sendToReview = useSendTransactionsToReview();
  const unsendFromReview = useUnsendTransactionsFromReview();
  const buildRuleUndoAction = useRuleActionUndo();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      occurredOn: new Date().toISOString().split("T")[0],
      description: "",
      amount: "",
      kind: "expense",
      categoryId: null,
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      reimbursable: false,
      reimbursed: false,
      isTransfer: false,
    },
  });

  // Tracks whether the user has manually picked a category in the
  // Add-Transaction dialog. Once true, the live "as you type" auto-pick
  // (the description -> matching rule effect) stops overwriting their
  // pick — including the empty/cleared state. Reset whenever the dialog
  // is reopened so the next entry starts fresh.
  const categoryManuallyPickedRef = useRef(false);

  const handleOpenNew = () => {
    setEditingTx(null);
    categoryManuallyPickedRef.current = false;
    form.reset({
      occurredOn: new Date().toISOString().split("T")[0],
      description: "",
      amount: "",
      kind: "expense",
      categoryId: null,
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      reimbursable: false,
      reimbursed: false,
      isTransfer: false,
    });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (tx: Transaction) => {
    setEditingTx(tx);
    // Edit dialog surfaces the Category combobox pre-filled with the
    // row's current category (Task #234). The live "as you type"
    // auto-pick effect intentionally short-circuits on `editingTx` so
    // typing in the description field doesn't silently overwrite the
    // user's existing category — flipping `categoryManuallyPickedRef`
    // mirrors that intent and keeps the picker stable.
    categoryManuallyPickedRef.current = true;
    const numeric = parseFloat(tx.amount);
    form.reset({
      occurredOn: tx.occurredOn.split("T")[0],
      description: tx.description,
      amount: Math.abs(numeric).toFixed(2),
      kind: numeric >= 0 ? "income" : "expense",
      categoryId: tx.categoryId ?? null,
      weeklyAllowance: tx.weeklyAllowance,
      monthlyAllowance: tx.monthlyAllowance,
      unplannedAllowance: tx.unplannedAllowance,
      reimbursable: tx.reimbursable,
      reimbursed: tx.reimbursed,
      isTransfer: tx.isTransfer,
    });
    setIsDialogOpen(true);
  };

  // Live "as you type" auto-pick for the new-transaction dialog: re-run
  // the same priority-ordered matchRule the server uses (Tasks #207 /
  // #218) every time the description changes, and keep the Category
  // combobox in sync until the user manually picks something. Mirrors
  // POST /transactions's auto-categorize semantics so the preview the
  // user sees in the dialog matches what the server would have picked
  // on submit.
  const watchedDescription = form.watch("description");
  const dialogAutoMatchedRule = useMemo(
    () => (isDialogOpen && !editingTx ? matchRuleClient(watchedDescription ?? "", mappingRules) : null),
    [isDialogOpen, editingTx, watchedDescription, mappingRules],
  );
  // Task #234 — when the Edit dialog is open, surface the rule that the
  // server originally attributed the row to (`tx.matchedRuleId`) so the
  // combobox's MatchedRuleChip can keep showing "matched by rule X" while
  // the user hasn't changed the category. The picker only displays the
  // chip when the rule's categoryId equals the picker's current value, so
  // the chip naturally disappears if the user picks a different category.
  const editingMatchedRule = useMemo(() => {
    if (!isDialogOpen || !editingTx?.matchedRuleId) return null;
    return (mappingRules ?? []).find((r) => r.id === editingTx.matchedRuleId) ?? null;
  }, [isDialogOpen, editingTx, mappingRules]);
  useEffect(() => {
    if (!isDialogOpen || editingTx) return;
    if (categoryManuallyPickedRef.current) return;
    const next = dialogAutoMatchedRule?.categoryId ?? null;
    const current = form.getValues("categoryId") ?? null;
    if (next !== current) {
      form.setValue("categoryId", next, { shouldDirty: false });
    }
  }, [isDialogOpen, editingTx, dialogAutoMatchedRule, form]);

  const onSubmit = (values: FormValues) => {
    const { kind, categoryId, isTransfer, ...rest } = values;
    const basePayload = { ...rest, amount: normalizeAmount(values.amount, kind) };
    if (editingTx) {
      // (#479) Only forward `isTransfer` when the toggle's value differs
      // from the row's current flag — saving unrelated edits on a row the
      // user never intended to reclassify must not silently set
      // `isTransferUserOverridden` server-side.
      const transferChanged = isTransfer !== editingTx.isTransfer;
      // Task #234 — Edit dialog now exposes the same Category combobox
      // the Add dialog uses. Only forward `categoryId` when the user
      // actually picked something different so a no-op save doesn't
      // trip PATCH /transactions's mapping-rule auto-learn / repoint
      // side effects. When the category *did* change, mirror the row
      // chip's `handleQuickCategorize` flow: surface the same
      // ruleAction-aware "Categorized" toast (with `useRuleActionUndo`
      // affordance) plus any bulk recategorize prompts the response
      // suggests.
      const categoryChanged =
        (categoryId ?? null) !== (editingTx.categoryId ?? null);
      const editPayload: Record<string, unknown> = { ...basePayload };
      if (categoryChanged) editPayload.categoryId = categoryId ?? null;
      if (transferChanged) editPayload.isTransfer = isTransfer;
      updateTx.mutate(
        { id: editingTx.id, data: editPayload },
        {
          onSuccess: (updated) => {
            queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
            setIsDialogOpen(false);
            if (!categoryChanged) {
              toast({ title: "Transaction updated" });
              return;
            }
            queryClient.invalidateQueries({
              queryKey: getGetBudgetMonthQueryKey(
                `${updated.occurredOn.slice(0, 7)}-01`,
              ),
            });
            const ruleDescription = ruleActionMessage(updated.ruleAction);
            const categorizedToast = toast({
              title: "Categorized",
              ...(ruleDescription ? { description: ruleDescription } : {}),
            });
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
          },
        },
      );
    } else {
      // New transactions always include `categoryId` in the POST body so
      // the server respects an explicit pick from the dialog combobox
      // (including a deliberate "leave uncategorized" null). The
      // server's auto-categorize fallback only fires when the body
      // omits the key — so a user-confirmed pick (even if it matches
      // what auto-categorize would have chosen) bypasses that fallback
      // and keeps `autoCategorizedRuleId` null in the response, which
      // suppresses the redundant "Categorized by rule X" toast.
      const payload: CreateTransactionInput = {
        ...basePayload,
        categoryId: categoryId ?? null,
      };
      // (#479) Only forward isTransfer on create when the user explicitly
      // toggled it on — otherwise let the server's auto-categorize pipeline
      // (POST handler) compute the flag from the description heuristic.
      if (isTransfer) payload.isTransfer = true;
      createTx.mutate(
        { data: payload as never },
        {
          onSuccess: (created) => {
            queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
            setIsDialogOpen(false);
            // Task #218 — POST /transactions runs the same auto-categorize
            // pipeline import / Plaid-sync uses (Task #207). When that
            // pipeline filled in the new row's category from a mapping
            // rule, the server returns the rule's id as
            // `autoCategorizedRuleId`. Surface a small "Categorized"
            // toast naming the rule (linking to the Mapping Rules page)
            // with an Undo affordance that PATCHes the new row to clear
            // the auto-picked category — without deleting the row
            // itself. Mirrors the PATCH `ruleAction` toast on the
            // quick-categorize flow. When there's no auto-attribution
            // (explicit categoryId, no rule matched) we fall back to
            // the plain "Transaction created" toast so the user still
            // gets a confirmation.
            const ruleId = created.autoCategorizedRuleId;
            const matchedRule = ruleId
              ? (mappingRules ?? []).find((r) => r.id === ruleId) ?? null
              : null;
            if (matchedRule) {
              // Pass the Undo action directly into the initial toast()
              // call rather than via the toast().update() pattern used
              // by the PATCH ruleAction toast. The update path closes
              // over the toast id so it can self-dismiss on click, but
              // with TOAST_LIMIT=1 it can race a re-render and hide
              // the action button before the user can hit it. Skipping
              // the explicit dismiss is fine here — the follow-up
              // "Cleared the auto-picked category" toast displaces the
              // parent automatically (LIMIT=1).
              toast({
                title: "Categorized",
                description: (
                  <span>
                    Matched by your{" "}
                    <Link
                      href={`/mapping-rules?focus=${encodeURIComponent(matchedRule.id)}`}
                      className="underline underline-offset-2 hover:text-foreground"
                      data-testid="link-auto-categorized-rule"
                    >
                      <span className="font-mono">"{matchedRule.pattern}"</span>
                    </Link>{" "}
                    rule.
                  </span>
                ),
                action: (
                  <ToastAction
                    altText="Undo auto-categorize"
                    data-testid="action-undo-auto-categorize"
                    onClick={() => {
                      updateTx.mutate(
                        { id: created.id, data: { categoryId: null } },
                        {
                          onSuccess: () => {
                            queryClient.invalidateQueries({
                              queryKey: getListTransactionsQueryKey(),
                            });
                            queryClient.invalidateQueries({
                              queryKey: getGetBudgetMonthQueryKey(
                                `${created.occurredOn.slice(0, 7)}-01`,
                              ),
                            });
                            toast({ title: "Cleared the auto-picked category" });
                          },
                          onError: (e) => {
                            toast({
                              title: "Couldn't undo",
                              description: (e as Error).message,
                              variant: "destructive",
                            });
                          },
                        },
                      );
                    }}
                  >
                    Undo
                  </ToastAction>
                ),
              });
            } else {
              toast({ title: "Transaction created" });
            }
          },
        },
      );
    }
  };

  const handleDelete = (id: string) => {
    if (confirm("Delete this transaction?")) {
      deleteTx.mutate(
        { id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
            toast({ title: "Transaction deleted" });
          },
        },
      );
    }
  };

  // (#422) Index forecast resolutions by their matched bank txn id so we
  // can show a per-row state badge ("In Review Bucket" while awaiting a
  // match, "Matched", or "Unplanned") and derive the header pending-count
  // chip without an extra API call. Both surfaces stay live because the
  // Forecast page already invalidates `getGetForecastQueryKey()` on
  // every match / unplanned action.
  const resolutionByTxnId = useMemo(() => {
    const m = new Map<string, { status: string }>();
    for (const r of forecastData?.resolutions ?? []) {
      if (r.matchedTxnId) m.set(r.matchedTxnId, { status: r.status });
    }
    return m;
  }, [forecastData?.resolutions]);

  // (#fix) Powers the clickable header chip. Previously this was a local
  // tally over the *viewed* month's forecast-flagged rows (including pending
  // and rows the Review Bucket filters out), so it disagreed with the actual
  // Forecast Review Bucket the chip links to — showing "4 awaiting" when the
  // bucket was empty. Now it reads the SAME canonical count the bucket uses,
  // so the chip and the destination always agree.
  const awaitingMatchCount = useReviewInboxCount();

  // The configured Chase checking account's external Plaid account_id.
  // Forecast is scoped to this single account, not to all depository
  // accounts the user might have linked.
  const checkingPlaidAccountIdSet = useMemo(() => {
    if (chasePlaidAccountIds && chasePlaidAccountIds.size > 0) {
      return new Set(chasePlaidAccountIds);
    }
    const s = new Set<string>();
    if (chasePlaidAccountId) s.add(chasePlaidAccountId);
    return s;
  }, [chasePlaidAccountId, chasePlaidAccountIds]);

  // Forecast is bank-only. The Send-to-Forecast affordance is hidden for
  // any non-checking (Amex / credit) row so we never flag credit-card
  // activity into the cash projection.
  const canSendToForecast = (tx: Transaction): boolean =>
    isBankTxn(
      { source: tx.source, plaidAccountId: tx.plaidAccountId ?? null },
      checkingPlaidAccountIdSet,
    );

  const handleToggleForecast = (tx: Transaction) => {
    const next = !tx.forecastFlag;
    if (next && !canSendToForecast(tx)) {
      toast({
        title: "Forecast is bank-only",
        description: "Only Chase checking transactions can be sent to Forecast.",
        variant: "destructive",
      });
      return;
    }
    if (next && !tx.categoryId) {
      toast({
        title: "Categorize this transaction first",
        description: "Pick a category before sending it to Forecast.",
        variant: "destructive",
      });
      return;
    }
    updateTx.mutate(
      { id: tx.id, data: { forecastFlag: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          toast({ title: next ? "Sent to Forecast" : "Removed from Forecast" });
        },
      },
    );
  };

  const { offerBulkRecategorize, previewDialog } = useBulkRecategorizePrompt();

  const handleQuickCategorize = async (
    tx: Transaction,
    categoryId: string | null,
  ) => {
    try {
      const updated = await updateTx.mutateAsync({
        id: tx.id,
        data: { categoryId },
      });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetBudgetMonthQueryKey(`${tx.occurredOn.slice(0, 7)}-01`),
      });
      // Task #185 — describe what the auto-learn flow actually did to
      // the user's mapping rules (created / created-over-generic /
      // skipped / repointed). Skips the description on no-op cases so
      // we don't show a misleading "will auto-categorize" promise when
      // the server actually did nothing (e.g. clobber-guard kicked in).
      const ruleDescription = ruleActionMessage(updated.ruleAction);
      // Task #209 — create the toast first so we have its id, then
      // attach the Undo action that knows how to dismiss this exact
      // toast on click. Avoids the parent toast lingering after Undo
      // is consumed.
      const categorizedToast = toast({
        title: "Categorized",
        ...(ruleDescription ? { description: ruleDescription } : {}),
      });
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
      // If the auto-learn flow repointed an existing seed rule (e.g. an
      // Amex / Cap One / Discover debt-payment rule pre-pointed at
      // "Misc / Buffer"), surface a follow-up prompt offering to also
      // re-categorize the historical transactions still sitting in the
      // rule's old category. We prompt for each repointed rule that has
      // remaining candidates so the user can fix all of them in one go.
      const repointedRules: RepointedRule[] = updated.repointedRules ?? [];
      for (const rule of repointedRules) {
        const bulkRule = bulkRuleFromRepointed(
          rule,
          categoryById.get(rule.toCategoryId) ?? undefined,
        );
        if (bulkRule) offerBulkRecategorize(bulkRule);
      }
      // Task #195 — when the auto-learn flow *creates* a brand-new
      // specific rule, the server reports a candidate count of older
      // *uncategorized* rows that match the new pattern. Surface the
      // same "apply to past charges?" prompt so the user can flip
      // them in one click instead of touching each row by hand.
      const createdRule = bulkRuleFromRuleAction(
        updated.ruleAction,
        updated.ruleAction?.toCategoryId
          ? categoryById.get(updated.ruleAction.toCategoryId) ?? undefined
          : undefined,
      );
      if (createdRule) offerBulkRecategorize(createdRule);
    } catch (e) {
      toast({
        title: "Couldn't categorize",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // Task #454 — Inline amount edit. Mirrors the Edit dialog's PATCH
  // path (same `updateTx` mutation, same `normalizeAmount` sign /
  // currency formatting) so flipping a typo'd amount on a row stays
  // in sync with the rest of the page (totals, running balance,
  // forecast invalidation). Sign is preserved from the row's current
  // amount: an expense stays an expense, income stays income.
  const handleQuickAmount = async (tx: Transaction, raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      toast({
        title: "Enter an amount",
        variant: "destructive",
      });
      return false;
    }
    const parsed = parseFloat(trimmed);
    if (Number.isNaN(parsed)) {
      toast({
        title: "Invalid amount",
        description: "Enter a number like 12.34.",
        variant: "destructive",
      });
      return false;
    }
    const currentKind: "expense" | "income" =
      parseSigned(tx.amount) >= 0 ? "income" : "expense";
    const next = normalizeAmount(trimmed, currentKind);
    if (next === tx.amount) return true;
    try {
      const updated = await updateTx.mutateAsync({
        id: tx.id,
        data: { amount: next },
      });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetBudgetMonthQueryKey(
          `${updated.occurredOn.slice(0, 7)}-01`,
        ),
      });
      toast({ title: "Amount updated" });
      return true;
    } catch (e) {
      toast({
        title: "Couldn't update amount",
        description: (e as Error).message,
        variant: "destructive",
      });
      return false;
    }
  };

  // Task #454 — Inline date edit. Same PATCH path / invalidations as
  // the Edit dialog so the row visibly hops to its new day group and
  // any month-scoped totals (forecast, budget actuals) refresh. Both
  // the source and destination months are invalidated when the move
  // crosses a month boundary so the budget page's "this month" view
  // doesn't show stale numbers either.
  const handleQuickDate = async (tx: Transaction, raw: string) => {
    const next = (raw ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) {
      toast({
        title: "Pick a date",
        variant: "destructive",
      });
      return false;
    }
    if (next === tx.occurredOn.slice(0, 10)) return true;
    try {
      const updated = await updateTx.mutateAsync({
        id: tx.id,
        data: { occurredOn: next },
      });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
      const oldMonth = `${tx.occurredOn.slice(0, 7)}-01`;
      const newMonth = `${updated.occurredOn.slice(0, 7)}-01`;
      queryClient.invalidateQueries({
        queryKey: getGetBudgetMonthQueryKey(oldMonth),
      });
      if (newMonth !== oldMonth) {
        queryClient.invalidateQueries({
          queryKey: getGetBudgetMonthQueryKey(newMonth),
        });
      }
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

  // Task #471 — Inline expense ↔ income flip. Mirrors `handleQuickAmount`
  // (same `updateTx` PATCH path, same invalidations) but instead of
  // changing the magnitude it re-runs `normalizeAmount` against the
  // *opposite* kind so the persisted amount and the visible color/sign
  // update together. Closes the last common quick-edit gap left by
  // #454 (which intentionally preserved the row's existing sign).
  const handleQuickFlipKind = async (tx: Transaction) => {
    const currentKind: "expense" | "income" =
      parseSigned(tx.amount) >= 0 ? "income" : "expense";
    const nextKind: "expense" | "income" =
      currentKind === "income" ? "expense" : "income";
    const absStr = Math.abs(parseSigned(tx.amount)).toFixed(2);
    const next = normalizeAmount(absStr, nextKind);
    if (next === tx.amount) return true;
    try {
      const updated = await updateTx.mutateAsync({
        id: tx.id,
        data: { amount: next },
      });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetBudgetMonthQueryKey(
          `${updated.occurredOn.slice(0, 7)}-01`,
        ),
      });
      toast({
        title: nextKind === "income" ? "Marked as income" : "Marked as expense",
      });
      return true;
    } catch (e) {
      toast({
        title: "Couldn't flip",
        description: (e as Error).message,
        variant: "destructive",
      });
      return false;
    }
  };

  const handleRefreshBank = () => {
    refreshBank.mutate({ data: { plaidAccountId: effectiveAccountInternalId ?? null } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        toast({ title: "Refreshed from Plaid" });
      },
      onError: (e) => {
        // Task #385 — the server returns a structured `code: "no_balance"`
        // body (with the account name + mask) when Plaid succeeds but the
        // account itself doesn't expose a current/available balance — e.g.
        // a brokerage sub-account silently linked under the same item.
        // Surface that as an account-aware toast that names the row that
        // failed and points the user at the manual-balance fallback,
        // instead of the dead-end "Plaid did not return a balance" string.
        const data = (e as { data?: unknown }).data as
          | {
              code?: string;
              error?: string;
              account?: { name?: string | null; mask?: string | null };
            }
          | undefined;
        const fallbackAccount = selectedPlaidAccount
          ? {
              name: selectedPlaidAccount.name ?? null,
              mask: selectedPlaidAccount.mask ?? null,
            }
          : null;
        const acct = data?.account ?? fallbackAccount;
        const acctLabel = acct
          ? [acct.name ?? "this account", acct.mask ? `••${acct.mask}` : null]
              .filter(Boolean)
              .join(" ")
          : "this account";
        if (data?.code === "no_balance") {
          toast({
            title: `${acctLabel} doesn't have a refreshable balance`,
            description:
              "Plaid didn't return a current balance for this account (often the case with brokerage or sub-accounts). Set the balance manually on the Forecast page, or relink the bank.",
            variant: "destructive",
            action: (
              <ToastAction
                altText="Set bank balance manually"
                data-testid="action-refresh-bank-set-manual"
                onClick={() => navigate("/forecast")}
              >
                Set manually
              </ToastAction>
            ),
          });
          return;
        }
        toast({
          title: `Couldn't refresh ${acctLabel}`,
          description: (e as Error).message,
          variant: "destructive",
        });
      },
    });
  };

  // ---- Bulk selection ----
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

  // Reverses a bulk Send-to-Forecast / Remove-from-Forecast by re-issuing
  // the same endpoint with `forecastFlag` inverted, scoped to the exact
  // ids the original bulk flipped. Rows the user has since toggled back
  // by hand are silently skipped server-side because their current value
  // already matches the new target. Surfaces the count of rows that
  // actually reverted so the user can tell when an Undo is a no-op
  // because they'd already moved everything elsewhere.
  const undoBulkForecast = (affectedIds: string[], originalNext: boolean) => {
    if (affectedIds.length === 0) return;
    bulkSetForecastFlag.mutate(
      { data: { ids: affectedIds, forecastFlag: !originalNext } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({
            queryKey: getListTransactionsQueryKey(),
          });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          toast({
            title:
              res.updated === 0
                ? "Nothing to undo"
                : `Restored ${res.updated} transaction${res.updated === 1 ? "" : "s"}`,
          });
        },
        onError: (e) => {
          toast({
            title: "Couldn't undo",
            description: (e as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

  // (#762 — Phase B) Manual Send-to-Review gate. Mirrors the
  // bulkSetForecast / undoBulkForecast pair above. Toggling a row
  // does NOT remove it from the Chase page — the source-of-truth list
  // keeps showing every row, only the Review tab on /forecast filters
  // on `sent_to_review_at`. Undo runs the inverse mutation against the
  // ids the server actually touched, so a re-click of the toast within
  // the 5-second window cleanly reverts the change even if the user
  // has since manually toggled some rows back.
  const undoReviewToggle = (affectedIds: string[], wasSend: boolean) => {
    if (affectedIds.length === 0) return;
    const mutation = wasSend ? unsendFromReview : sendToReview;
    mutation.mutate(
      { data: { transactionIds: affectedIds } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({
            queryKey: getListTransactionsQueryKey(),
          });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          toast({
            title:
              res.updated === 0
                ? "Nothing to undo"
                : `Restored ${res.updated} transaction${res.updated === 1 ? "" : "s"}`,
          });
        },
        onError: (e) => {
          toast({
            title: "Couldn't undo",
            description: (e as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

  // Promote (or revoke) one row. Re-uses the bulk endpoint with a
  // single id so the toast / Undo wiring is identical to the bulk
  // path. Capped well below the 200-id server ceiling by construction.
  const handleToggleReview = async (tx: Transaction) => {
    const wasSend = tx.sentToReviewAt == null;
    const mutation = wasSend ? sendToReview : unsendFromReview;
    try {
      const res = await mutation.mutateAsync({
        data: { transactionIds: [tx.id] },
      });
      queryClient.invalidateQueries({
        queryKey: getListTransactionsQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
      if (res.updated === 0) {
        toast({ title: wasSend ? "Already in review" : "Not in review" });
        return;
      }
      toast({
        title: wasSend ? "Sent to Review" : "Removed from Review",
        action: (
          <ToastAction
            altText={wasSend ? "Undo send to Review" : "Undo unsend from Review"}
            data-testid={
              wasSend
                ? `action-undo-send-review-${tx.id}`
                : `action-undo-unsend-review-${tx.id}`
            }
            onClick={() => undoReviewToggle([tx.id], wasSend)}
          >
            Undo
          </ToastAction>
        ),
      });
    } catch (e) {
      toast({
        title: "Couldn't update Review status",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // Bulk Send-to-Review. Only acts on currently-not-sent rows in the
  // selection so a mixed selection (some already sent) doesn't churn
  // the timestamp on the already-sent rows. The 200-id server cap is
  // duplicated here as a guard rail; in practice the bulk-bar tops
  // out far below that, but a hand-crafted multi-page selection
  // could in theory bump against it.
  const bulkSendToReview = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(filtered.map((t) => [t.id, t] as const));
    const candidates = ids
      .map((id) => byId.get(id))
      .filter((t): t is Transaction => !!t && t.sentToReviewAt == null);
    if (candidates.length === 0) {
      toast({ title: "Selected items already in Review" });
      return;
    }
    const capped = candidates.slice(0, 200);
    const cappedOut = candidates.length - capped.length;
    const targetIds = capped.map((t) => t.id);
    try {
      const res = await sendToReview.mutateAsync({
        data: { transactionIds: targetIds },
      });
      queryClient.invalidateQueries({
        queryKey: getListTransactionsQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
      clearSelection();
      const suffix = cappedOut > 0 ? ` · capped ${cappedOut}` : "";
      toast({
        title: `Sent ${res.updated} to Review${suffix}`,
        ...(res.updated > 0
          ? {
              action: (
                <ToastAction
                  altText="Undo bulk send to Review"
                  data-testid="action-undo-bulk-send-review"
                  onClick={() => undoReviewToggle(targetIds, true)}
                >
                  Undo
                </ToastAction>
              ),
            }
          : {}),
      });
    } catch (e) {
      queryClient.invalidateQueries({
        queryKey: getListTransactionsQueryKey(),
      });
      toast({
        title: "Bulk send to Review failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const bulkSetForecast = async (next: boolean) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(filtered.map((t) => [t.id, t] as const));
    const candidates = ids
      .map((id) => byId.get(id))
      .filter((t): t is Transaction => !!t && t.forecastFlag !== next);
    // Forecast is Chase-checking-only — bulk-send must skip any
    // non-checking (Amex / credit) rows that happen to be selected.
    const bankEligible = next
      ? candidates.filter((t) => canSendToForecast(t))
      : candidates;
    const skippedNonBank = next ? candidates.length - bankEligible.length : 0;
    const targets = next
      ? bankEligible.filter((t) => !!t.categoryId)
      : bankEligible;
    const skippedUncat = next ? bankEligible.length - targets.length : 0;
    if (!targets.length) {
      const reason =
        next && skippedNonBank > 0 && skippedUncat === 0
          ? "Only Chase checking transactions can be sent to Forecast."
          : next && skippedUncat > 0
            ? "Categorize these first to send them to Forecast"
            : next
              ? "Selected items already in Forecast"
              : "Selected items not in Forecast";
      toast({ title: reason });
      return;
    }
    const targetIds = targets.map((t) => t.id);
    try {
      const res = await bulkSetForecastFlag.mutateAsync({
        data: { ids: targetIds, forecastFlag: next },
      });
      queryClient.invalidateQueries({
        queryKey: getListTransactionsQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
      clearSelection();
      const parts: string[] = [];
      if (skippedUncat > 0) parts.push(`${skippedUncat} uncategorized`);
      if (skippedNonBank > 0) parts.push(`${skippedNonBank} non-checking`);
      const suffix = parts.length ? ` · skipped ${parts.join(", ")}` : "";
      const okCount = res.updated;
      const undoIds = res.affectedIds;
      toast({
        title: next
          ? `Sent ${okCount} to Forecast${suffix}`
          : `Removed ${okCount} from Forecast`,
        ...(undoIds.length > 0
          ? {
              action: (
                <ToastAction
                  altText={
                    next
                      ? "Undo bulk send to Forecast"
                      : "Undo bulk remove from Forecast"
                  }
                  data-testid={
                    next
                      ? "action-undo-bulk-send-forecast"
                      : "action-undo-bulk-remove-forecast"
                  }
                  onClick={() => undoBulkForecast(undoIds, next)}
                >
                  Undo
                </ToastAction>
              ),
            }
          : {}),
      });
    } catch (e) {
      queryClient.invalidateQueries({
        queryKey: getListTransactionsQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
      toast({
        title: "Bulk update failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
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

  // (#488) Deep-link from the dashboard's Unplanned spending recent list.
  // When `?tx=<id>` is present we scroll the matching row into view and
  // pulse a temporary highlight ring so the user can see exactly which
  // row corresponds to the dashboard line they tapped. The param is then
  // stripped from the URL so reloads / future navigation don't re-trigger
  // the highlight after the user has interacted with the page.
  const [focusTxId, setFocusTxId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("tx");
  });
  const focusHandledRef = useRef(false);
  useEffect(() => {
    if (!focusTxId || focusHandledRef.current) return;
    if (isLoading) return;
    // Wait until the row is mounted (the right month / filters might still
    // be settling). requestAnimationFrame defers past the current commit.
    const tryScroll = () => {
      const el = document.querySelector(
        `[data-testid="row-tx-${CSS.escape(focusTxId)}"]`,
      );
      if (!el) return false;
      (el as HTMLElement).scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      // Override the "scroll to today" effect so it doesn't yank focus
      // away after we've landed on the deep-linked row.
      scrolledRef.current = true;
      return true;
    };
    requestAnimationFrame(() => {
      if (!tryScroll()) {
        // Row may not be mounted yet — try once more on the next frame.
        requestAnimationFrame(() => {
          tryScroll();
        });
      }
    });
    focusHandledRef.current = true;
    // Strip the `?tx=` param so a reload doesn't re-pulse the highlight,
    // but keep `?month=` and other params intact.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.delete("tx");
      const qs = params.toString();
      const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", next);
    }
    // Clear the highlight after a short pulse so the row settles back.
    const t = setTimeout(() => setFocusTxId(null), 2000);
    return () => clearTimeout(t);
  }, [focusTxId, isLoading, groups.length]);

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

  // Gate on data only — global keepPreviousData keeps the previous
  // transactions list visible during refetches so we never flash a
  // skeleton after the first load.
  if (!transactions) {
    return <AccountPageSkeleton tiles={5} />;
  }

  // (#741/#742) The shared row-chip cluster moved into
  // `<TransactionRowChips />`. The pending and posted day-group blocks
  // below funnel through it so the cluster stays in lockstep (the gap
  // #740 fixed was exactly that drift). The mutation glue lives here as
  // small callbacks so the component has no implicit dependency on this
  // page's hooks / query keys / toast.
  const handleClearTransfer = (tx: Transaction) => {
    updateTx.mutate(
      { id: tx.id, data: { isTransfer: false } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListTransactionsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetBudgetMonthQueryKey(
              `${tx.occurredOn.slice(0, 7)}-01`,
            ),
          });
          toast({ title: "Cleared Transfer flag" });
        },
      },
    );
  };
  const handleToggleBucket = (
    tx: Transaction,
    bucket: BucketKey,
    next: boolean,
  ) => {
    const data: Record<string, boolean> = {};
    if (bucket === "weekly") data.weeklyAllowance = next;
    else if (bucket === "monthly") data.monthlyAllowance = next;
    else if (bucket === "unplanned") data.unplannedAllowance = next;
    else if (bucket === "reimbursable") data.reimbursable = next;
    updateTx.mutate(
      { id: tx.id, data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListTransactionsQueryKey(),
          });
        },
        // (#642) Surface the server-side "transfer can't be
        // tagged Unplanned" rejection as a short toast so the
        // user understands why nothing happened when they click
        // the UN bubble on a transfer-looking row. Same toast
        // for any other rejection (e.g. transient network error)
        // so we don't silently swallow failures.
        onError: (e: unknown) => {
          toast({
            title: "Couldn't update bucket",
            description: (e as Error)?.message ?? "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const todayKey = ymd(new Date());
  // #103/#296 — Starting/Ending balance render whenever the
  // currently-viewed account has a snapshot we can anchor to (primary
  // or per-account). Refresh-from-Plaid is offered for any selected
  // Plaid checking account so the user can populate / advance that
  // account's snapshot directly from this page.
  const hasLinkedChecking = !!effectiveSnapshot;
  const isPlaidLinked =
    !isManualAccount && !!effectiveAccountInternalId;

  return (
    <div
      className="space-y-3"
      style={{ ["--pinned-pane-h" as string]: `${paneH}px` } as React.CSSProperties}
    >
      {/* (#357) Suppress the global Plaid re-auth banner while the user
          is viewing a Manual account — the failing item isn't this view's
          data, so the banner is misleading noise here. The banner is
          still rendered on every other tab and on Settings. */}
      {!isManualAccount && <PlaidReauthBanner />}
      {/* (#379) Shared post-link import banner — published from
          PlaidLinkButton.pollAfterLink and rendered above the header so
          users see "waiting on bank → syncing → done — N imported"
          (or failed + Retry) instead of staring at silence after the
          link toast. */}
      <PostLinkProgressBanner viewTransactionsPath="/transactions" />
      <div
        ref={paneRef}
        className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-3 md:pt-4 pb-3 bg-background border-b shadow-sm space-y-3"
      >
      <AccountPageHeader
        title="Chase"
        icon={<ChaseLogo className="h-7 w-7" />}
        actions={
          <>
            <Button onClick={handleOpenNew} variant="outline" size="sm" data-testid="button-add-transaction">
              <Plus className="w-4 h-4 mr-1.5" /> Add transaction
            </Button>
            <SyncButton relevantItemIds={relevantPlaidItemIds} />
            <PlaidLinkButton
              label="Connect a bank"
              onImportReady={() => setPendingPostImportJump(true)}
              inlineProgress={false}
            />
          </>
        }
      />

      <div className="space-y-3">
        {/* Weekly-first range control. Month stepper only when in Month mode. */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <TimeRangeToggle value={rangeMode} onChange={setRangeMode} />
            <span className="text-sm font-medium tabular-nums text-muted-foreground">
              {range.label}
            </span>
          </div>
          {rangeMode === "mo" && (
            <MonthNavigator value={selectedMonth} onChange={setSelectedMonth} />
          )}
        </div>

        {hasLinkedChecking ? (
          <div className="grid gap-3 lg:grid-cols-2 items-start stagger-children">
            {/* Money in vs out + net */}
            <Card>
              <CardContent className="p-5">
                <div className="flex items-baseline justify-between gap-2 mb-3">
                  <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                    Money in vs out
                  </span>
                  <DeltaPill
                    value={
                      rangeBalances.startBal && rangeBalances.startBal !== 0
                        ? (rangeTotals.net / Math.abs(rangeBalances.startBal)) * 100
                        : 0
                    }
                  />
                </div>
                <StackBar
                  segments={[
                    { label: "In", value: rangeTotals.moneyIn, color: "hsl(var(--positive))" },
                    { label: "Out", value: rangeTotals.moneyOut, color: "hsl(var(--negative))" },
                  ]}
                  legendMax={2}
                />
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    Net
                  </span>
                  <MoneyText
                    amount={rangeTotals.net}
                    colored
                    signed
                    className="text-xl font-bold"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Checking balance trend across the range */}
            <Card>
              <CardContent className="p-5">
                <div className="flex items-baseline justify-between gap-2 mb-2">
                  <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                    Checking balance
                  </span>
                  <MoneyText
                    amount={rangeBalances.endBal ?? endingBalance ?? 0}
                    className="text-xl font-bold"
                  />
                </div>
                {rangeBalances.series.length > 1 ? (
                  <Sparkline
                    data={rangeBalances.series}
                    variant="area"
                    color={
                      (rangeBalances.endBal ?? 0) < 0
                        ? "hsl(var(--negative))"
                        : "hsl(var(--chart-1))"
                    }
                    height={40}
                  />
                ) : (
                  <div className="h-10 grid place-items-center text-xs text-muted-foreground">
                    Not enough history for a trend yet
                  </div>
                )}
                <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                  <span>
                    Start{" "}
                    <MoneyText
                      amount={rangeBalances.startBal ?? 0}
                      className="text-foreground"
                    />
                  </span>
                  <span>
                    End{" "}
                    <MoneyText
                      amount={rangeBalances.endBal ?? 0}
                      className="text-foreground"
                    />
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              Connect a checking account to see your weekly money flow.
            </CardContent>
          </Card>
        )}
      </div>

      {/* (cleanup) The verbose "Plaid · Chase ··5526 · Current balance …
          Last auto-updated" snapshot line was removed — the balance already
          shows in the stat tiles, and the single "Last synced" note next to
          the Sync button is the one source of truth for freshness now that
          background auto-updates are disabled. */}
      {!usingSnapshotAccount && isManualAccount && (
        <div
          className="text-xs text-muted-foreground"
          data-testid="text-snapshot-meta"
        >
          Manual entries · No bank balance is tracked for hand-entered rows.
        </div>
      )}
      {/* (#422) Header pending-count chip — at-a-glance signal of how
          many "sent" rows for this account/period are still sitting in
          the Forecast Review Bucket awaiting a match. Clickable so the
          user can jump straight to the bucket and resolve them. */}
      <div className="flex items-center gap-2 flex-wrap" data-testid="chase-bucket-summary">
        {awaitingMatchCount > 0 ? (
          <Link
            href="/forecast#bucket"
            data-testid="link-bucket-pending-count"
            className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 text-warning px-2.5 py-0.5 text-xs hover-elevate active-elevate-2"
            title="Open the Forecast Review Bucket"
          >
            <Inbox className="w-3 h-3" />
            <span className="font-medium tabular-nums">{awaitingMatchCount}</span>
            <span>awaiting match in Review Bucket</span>
          </Link>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            data-testid="text-bucket-empty"
          >
            All sent items reconciled.
          </span>
        )}
      </div>
      {(() => {
        // (#797) Show the picker only when there are 2+ *Chase* checking
        // accounts to switch between. When there are no Chase accounts the
        // picker hides entirely and the page falls through to the existing
        // source-based fallback (`isChaseFallbackSource`), which still
        // renders Chase + manual rows. The dead "Manual entries" pseudo-
        // account option was removed — it was leaking a non-Chase view onto
        // the Chase page.
        return chaseOnlyPlaidCheckingAccounts.length > 1;
      })() && (
        <div className="flex items-center gap-2" data-testid="chase-account-picker">
          <span className="text-xs text-muted-foreground">View account:</span>
          <Select
            value={effectiveAccountKey}
            onValueChange={(v) => setSelectedAccountKey(v)}
          >
            <SelectTrigger aria-label="View account" className="h-7 text-xs w-64" data-testid="select-chase-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-testid="chase-account-options">
              {chaseOnlyPlaidCheckingAccounts.map((a) => {
                const name = a.institutionName ?? a.name ?? "Checking";
                const mask = a.mask ?? null;
                const isSnapshot = bankSnapshot?.accountId === a.id;
                return (
                  <SelectItem
                    key={a.id}
                    value={a.id}
                    data-testid={`option-chase-account-${a.id}`}
                  >
                    {name}
                    {mask ? ` ••${mask}` : ""}
                    {isSnapshot ? " · snapshot" : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}

      </div>

      {/* Sassy AI one-liner + week-over-week spend + category mix. */}
      <AiInsightBar />
      <ChaseInsightStrip txns={transactions ?? []} categories={categories ?? []} />

      {balanceTrend && (
        <BalanceTrendChart
          caption="Checking balance — actual vs forecast"
          subtitle={balanceTrend.subtitle}
          historicalActual={balanceTrend.historicalActual}
          forecastFromToday={balanceTrend.forecastFromToday}
          actualFromToday={balanceTrend.actualFromToday}
          axisDates={balanceTrend.axisDates}
          todayISO={todayISO}
          valueLabel="Balance"
        />
      )}

      <TransactionEditDialog
        isDialogOpen={isDialogOpen}
        setIsDialogOpen={setIsDialogOpen}
        editingTx={editingTx}
        setEditingTx={setEditingTx}
        form={form}
        onSubmit={onSubmit}
        categories={categories}
        categoryManuallyPickedRef={categoryManuallyPickedRef}
        editingMatchedRule={editingMatchedRule}
        dialogAutoMatchedRule={dialogAutoMatchedRule}
        mappingRules={mappingRules}
        clearTransferOverride={clearTransferOverride}
        createTx={createTx}
        updateTx={updateTx}
      />

      {previewDialog}

      {selected.size > 0 && (
        <div
          className="sticky z-20 flex items-center gap-3 rounded-md border border-positive/30 bg-positive/10 px-4 py-2 shadow-sm"
          style={{ top: "var(--pinned-pane-h, 0px)" }}
          data-testid="bulk-bar"
        >
          <span className="text-sm font-medium text-positive">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            onClick={() => bulkSetForecast(true)}
            disabled={bulkSetForecastFlag.isPending}
            data-testid="bulk-send-forecast"
          >
            <Send className="w-3.5 h-3.5 mr-1.5" /> Send to Forecast
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => bulkSetForecast(false)}
            disabled={bulkSetForecastFlag.isPending}
            data-testid="bulk-remove-forecast"
          >
            Remove from Forecast
          </Button>
          {/* Single-flow restore: "Send to Forecast" IS "in Review" now.
              The separate bulk Send-to-Review button (#762 Phase B) is
              gone — a forecast-flagged row shows up in the Review tab
              and on the curve immediately. */}
          <Button variant="ghost" size="sm" onClick={clearSelection} className="ml-auto">
            Clear
          </Button>
        </div>
      )}

      {groups.length === 0 && pendingItems.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No transactions match these filters.
          </CardContent>
        </Card>
      )}

      {/* (#728) Pinned "Pending" section above the dated day-groups.
          Renders the same row markup as the day-groups (reusing
          DayGroup) so quick-categorize, the matched-rule chip, and
          row selection work identically — only the header and
          ordering change. dayKey is "pending" so the existing
          selection / day-net handlers can address it the same way
          as any other day-group. Hidden when no pending rows exist
          so we don't render an empty header. */}
      {pendingItems.length > 0 && (() => {
        const items = pendingItems;
        const ids = items.map((t) => t.id);
        const allSelected = ids.every((id) => selected.has(id));
        const someSelected =
          !allSelected && ids.some((id) => selected.has(id));
        const dayNet = items.reduce((s, t) => s + parseSigned(t.amount), 0);
        const dayNetNode = (
          <span
            className={cn("tabular-nums", moneyColorClass(dayNet))}
            data-testid="day-net-pending"
          >
            {dayNet > 0 ? `+${formatCurrency(dayNet)}` : formatCurrency(dayNet)}
          </span>
        );
        return (
          <DayGroup
            key="pending"
            dayKey="pending"
            headerLabel="Pending"
            todayBadgeLabel="Pending"
            count={items.length}
            isToday
            todayAccent="amber"
            selectionState={
              allSelected ? true : someSelected ? "indeterminate" : false
            }
            onToggleAll={(on) => toggleDay(ids, on)}
            totalNode={dayNetNode}
          >
            <div
              className="divide-y divide-border"
              data-testid="group-pending"
            >
                {items.map((tx) => {
                  const isIgnored =
                    !!ignoreCatId && tx.categoryId === ignoreCatId;
                  return (
                    <AccountTransactionRow
                      key={tx.id}
                      tx={tx}
                      selected={selected.has(tx.id)}
                      onToggleSelect={() => toggleOne(tx.id)}
                      categories={categories ?? []}
                      onCategoryChange={(id) => handleQuickCategorize(tx, id)}
                      onBucketToggle={(b, next) =>
                        handleToggleBucket(tx, b, next)
                      }
                      onQuickDate={(raw) => handleQuickDate(tx, raw)}
                      disabled={updateTx.isPending}
                      dimmed={tx.forecastFlag || isIgnored}
                      hideDate
                      cardLabel={formatTransactionSource(tx.source)}
                      testId={`row-tx-${tx.id}`}
                      rowData={{ "data-pending": "true" }}
                      metaNode={
                        tx.forecastFlag ? (
                          (() => {
                            // Single-flow restore: forecast-flagged === in the
                            // Review pipeline. Show the real triage state
                            // (Matched / Unplanned / In Review) — no separate
                            // sent_to_review gate, no "Not in review" half-state.
                            const r = resolutionByTxnId.get(tx.id);
                            const state =
                              r?.status === "matched"
                                ? { attr: "matched", label: "Matched" }
                                : r?.status === "ignored_unforecasted" ||
                                    r?.status === "unplanned"
                                  ? { attr: "unplanned", label: "Unplanned" }
                                  : {
                                      attr: "in-review-bucket",
                                      label: "In Review",
                                    };
                            return (
                              <Badge
                                variant="outline"
                                className={`text-[10px] font-normal ${CHIP_BASE}`}
                                data-testid={`badge-forecast-state-${tx.id}`}
                                data-forecast-state={state.attr}
                              >
                                <Inbox className="w-3 h-3 mr-1" /> {state.label}
                              </Badge>
                            );
                          })()
                        ) : null
                      }
                      amountNode={
                        <span
                          className={cn(
                            "tabular-nums font-medium",
                            moneyColorClass(parseSigned(tx.amount)),
                          )}
                          data-testid={`amount-${tx.id}`}
                        >
                          {formatCurrency(parseSigned(tx.amount))}
                        </span>
                      }
                      actionsNode={
                        tx.forecastFlag ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleToggleForecast(tx)}
                            disabled={updateTx.isPending}
                            title="Remove from Forecast"
                            data-testid={`button-remove-forecast-${tx.id}`}
                          >
                            <Send className="w-4 h-4 rotate-180 text-primary" />
                          </Button>
                        ) : !canSendToForecast(tx) ? null : tx.categoryId ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleToggleForecast(tx)}
                            disabled={updateTx.isPending}
                            title="Send to Forecast"
                            data-testid={`button-send-forecast-${tx.id}`}
                          >
                            <Inbox className="w-4 h-4 text-primary" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled
                            title="Categorize this transaction first to send it to Forecast"
                            data-testid={`button-send-forecast-${tx.id}`}
                          >
                            <Send className="w-4 h-4 text-muted-foreground/40" />
                          </Button>
                        )
                      }
                    />
                  );
                })}
            </div>
          </DayGroup>
        );
      })()}

      {groups.map(([dayKey, items]) => {
        const ids = items.map((t) => t.id);
        const allSelected = ids.every((id) => selected.has(id));
        const someSelected = !allSelected && ids.some((id) => selected.has(id));
        const isToday = dayKey === todayKey;
        const dayNet = items.reduce((s, t) => s + parseSigned(t.amount), 0);
        const dayNetNode = (
          <span
            className={cn("tabular-nums", moneyColorClass(dayNet))}
            data-testid={`day-net-${dayKey}`}
          >
            {dayNet > 0 ? `+${formatCurrency(dayNet)}` : formatCurrency(dayNet)}
          </span>
        );
        return (
          <div key={dayKey} data-day-group-key={dayKey}>
          <DayGroup
            dayKey={dayKey}
            count={items.length}
            isToday={isToday}
            todayAccent="emerald"
            containerRef={(el) => {
              if (isToday) todayRef.current = el;
            }}
            selectionState={
              allSelected ? true : someSelected ? "indeterminate" : false
            }
            onToggleAll={(on) => toggleDay(ids, on)}
            totalNode={dayNetNode}
          >
            <div className="divide-y divide-border">
                {items.map((tx) => {
                  // (#629) Dim Ignore'd rows the same way forecast-sent rows
                  // are dimmed, so the bubble lights don't make a held-out
                  // line look "active".
                  const isIgnored =
                    !!ignoreCatId && tx.categoryId === ignoreCatId;
                  return (
                    <AccountTransactionRow
                      key={tx.id}
                      tx={tx}
                      selected={selected.has(tx.id)}
                      onToggleSelect={() => toggleOne(tx.id)}
                      categories={categories ?? []}
                      onCategoryChange={(id) => handleQuickCategorize(tx, id)}
                      onBucketToggle={(b, next) =>
                        handleToggleBucket(tx, b, next)
                      }
                      onQuickDate={(raw) => handleQuickDate(tx, raw)}
                      disabled={updateTx.isPending}
                      dimmed={tx.forecastFlag || isIgnored}
                      cardLabel={formatTransactionSource(tx.source)}
                      testId={`row-tx-${tx.id}`}
                      rowData={{
                        "data-sent": tx.forecastFlag ? "true" : "false",
                        "data-ignored": isIgnored ? "true" : "false",
                      }}
                      metaNode={
                        tx.forecastFlag ? (
                          (() => {
                            // Single-flow restore: forecast-flagged === in the
                            // Review pipeline. Show the real triage state
                            // (Matched / Unplanned / In Review) — no separate
                            // sent_to_review gate, no "Not in review" half-state.
                            const r = resolutionByTxnId.get(tx.id);
                            const state =
                              r?.status === "matched"
                                ? { attr: "matched", label: "Matched" }
                                : r?.status === "ignored_unforecasted" ||
                                    r?.status === "unplanned"
                                  ? { attr: "unplanned", label: "Unplanned" }
                                  : {
                                      attr: "in-review-bucket",
                                      label: "In Review",
                                    };
                            return (
                              <Badge
                                variant="outline"
                                className={`text-[10px] font-normal ${CHIP_BASE}`}
                                data-testid={`badge-forecast-state-${tx.id}`}
                                data-forecast-state={state.attr}
                              >
                                <Inbox className="w-3 h-3 mr-1" /> {state.label}
                              </Badge>
                            );
                          })()
                        ) : null
                      }
                      amountNode={
                        <div className="flex flex-col items-end">
                          <InlineAmountEditor
                            tx={tx}
                            onSave={(raw) => handleQuickAmount(tx, raw)}
                            onFlipKind={() => handleQuickFlipKind(tx)}
                            disabled={updateTx.isPending}
                          />
                          {runningBalanceMap.has(tx.id) && (
                            <span
                              className="text-[11px] tabular-nums text-muted-foreground"
                              data-testid={`text-running-balance-${tx.id}`}
                            >
                              bal {formatCurrency(runningBalanceMap.get(tx.id)!)}
                            </span>
                          )}
                        </div>
                      }
                      actionsNode={
                        <>
                          {tx.forecastFlag ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleToggleForecast(tx)}
                              disabled={updateTx.isPending}
                              title="Remove from Forecast"
                              data-testid={`button-remove-forecast-${tx.id}`}
                            >
                              <Send className="w-4 h-4 rotate-180 text-primary" />
                            </Button>
                          ) : !canSendToForecast(tx) ? null : tx.categoryId ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleToggleForecast(tx)}
                              disabled={updateTx.isPending}
                              title="Send to Forecast"
                              data-testid={`button-send-forecast-${tx.id}`}
                            >
                              <Inbox className="w-4 h-4 text-primary" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled
                              title="Categorize this transaction first to send it to Forecast"
                              data-testid={`button-send-forecast-${tx.id}`}
                            >
                              <Send className="w-4 h-4 text-muted-foreground/40" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleOpenEdit(tx)}
                            title="Edit"
                            data-testid={`button-edit-tx-${tx.id}`}
                          >
                            <Edit2 className="w-4 h-4 text-muted-foreground" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(tx.id)}
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </>
                      }
                    />
                  );
                })}
            </div>
          </DayGroup>
          </div>
        );
      })}
    </div>
  );
}
