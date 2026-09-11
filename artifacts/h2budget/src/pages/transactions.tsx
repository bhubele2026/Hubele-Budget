import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useCreateTransaction,
  useUpdateTransaction,
  useClearTransferOverride,
  useDeleteTransaction,
  useListCategories,
  useListMappingRules,
  useGetForecast,
  useRefreshForecastBank,
  useBulkSetForecastFlag,
  useUpsertForecastResolution,
  useDeleteForecastResolution,
  useSendTransactionsToReview,
  useUnsendTransactionsFromReview,
  getListTransactionsQueryKey,
  getGetForecastQueryKey,
  getGetBudgetMonthQueryKey,
  useListPlaidItems,
  useGetForecastCashSignal,
  type Transaction,
  type LedgerRow,
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
import { TimeRangeToggle } from "@/components/time-range-toggle";
import { currentMonthRange, rangeForMode, type RangeMode } from "@/lib/timeRange";
import { Sparkline, StackBar, DeltaPill, MoneyText } from "@/components/viz";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate, cn, moneyColorClass } from "@/lib/utils";
import { householdMonthStartOf, householdToday } from "@/lib/householdDay";
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
  Check,
  ArrowRight,
} from "lucide-react";
import { isBankTxn } from "@/lib/forecastMatch";
import { rowDecisionsByTxn } from "@/lib/forecastRowState";
import { inForecast } from "@workspace/avalanche-core";
import { ruleActionMessage } from "@/lib/ruleActionMessage";
import { useRuleActionUndo } from "@/lib/useRuleActionUndo";
import { type BucketKey } from "@/components/bucket-bubbles";
import {
  TransactionRowChips,
  CHIP_BASE,
} from "@/components/transaction-row-chips";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import { compareNewestFirst } from "@/lib/runningBalance";
import { invalidateBankLedger } from "@/lib/mutationInvalidation";
import {
  useGetTransactionsBalances,
  getGetTransactionsBalancesQueryKey,
  useGetTransactionsLedger,
  getGetTransactionsLedgerQueryKey,
} from "@workspace/api-client-react/ledger";
import { useSpine } from "@/hooks/useSpine";
import { FreshnessLine } from "@/components/data-state";
import { useToast } from "@/hooks/use-toast";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { ToastAction } from "@/components/ui/toast";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { PostLinkProgressBanner } from "@/components/post-link-progress";
import { PlaidReauthBanner } from "@/components/plaid-reauth-banner";
import { SyncButton } from "@/components/sync-button";
import { card, cardHead, emptyNote, fieldLabel, Help, errorBanner, btnLink } from "@/ui";
import {
  AccountPageHeader,
  AccountFilterBar,
  BalanceTrendChart,
  DayGroup,
  LedgerColumns,
  MonthNavigator,
  monthKeyOf,
  monthKeyFromISO,
  compareMonth,
  type MonthKey,
  type BalanceSeriesPoint,
} from "@/components/account-page";
import { ChaseLogo } from "@/components/brand-logos";
import { ChaseInsightStrip } from "@/components/chase-insight-strip";
import { invalidateForecastFamily } from "@/lib/invalidateForecast";
import {
  formSchema,
  matchRuleClient,
  normalizeAmount,
  parseSigned,
  type FormValues,
} from "./transactions/transactionsShared";
import { InlineAmountEditor } from "./transactions/InlineAmountEditor";
import { TransactionEditDialog } from "./transactions/TransactionEditDialog";
import {
  LEDGER_CACHE,
  balanceDates,
  moneyOrNull,
  sampleDays,
  splitAtToday,
  sumCounted,
  toBulkFilter,
  toLedgerParams,
  type ChaseListFilter,
} from "./transactions/chaseLedger";
import { useChaseLedger } from "./transactions/useChaseLedger";
import { useChaseHideReviewed } from "./transactions/useChaseHideReviewed";
import { useChaseReviewWrites } from "./transactions/useChaseReviewWrites";
import {
  ChaseLedgerPager,
  ChaseReviewControls,
  ChaseSelectAllBanner,
  LedgerRowLabels,
  MonoCount,
} from "./transactions/ChaseReviewInbox";

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

/** The household calendar day (America/Chicago) of an instant — never the UTC date. */
function ymd(d: Date) {
  return householdToday(d);
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
  //
  // (PR14) The list, its totals and its balances come from the server's ledger
  // (GET /transactions/ledger, paged 50 at a time) further down, once the range
  // and filters are known. The 1,000-row pull and the browser's own scoping,
  // totals and running balances are gone.
  const { data: categories } = useListCategories();
  const { data: mappingRules } = useListMappingRules();
  // (#perf-2) Share the same {days:90} forecast key as Home/Reports so the
  // ambient forecast bundle is fetched once and reused, not twice under two
  // keys (no-params vs days:90). The Forecast page keeps its own interactive
  // horizon query.
  const { data: forecastData, isError: forecastDataError } = useGetForecast({ days: 90 });
  // Stable "today" (YYYY-MM-DD) used as the actual/forecast split anchor
  // and as the projection's `fromDate` so the dashed forecast line starts
  // at today and the cash-signal series aligns with the chart window.
  // The HOUSEHOLD day (America/Chicago), never the browser's: late in the
  // Chicago evening a browser east of Chicago is already on tomorrow.
  const todayISO = useMemo(() => householdToday(new Date()), []);
  // Forward-looking projection that powers the actual-vs-forecast trend
  // chart's dashed line. Sourced from the SAME cash-signal daily series
  // the /forecast page's projected-balance chart consumes (`proj.daily`),
  // requested over a 12-month horizon from today.
  const { data: cashProjection } = useGetForecastCashSignal({
    horizonDays: 365,
    fromDate: todayISO,
  });
  const refreshBank = useRefreshForecastBank();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  // The bank balance's freshness, read from the spine the app already holds.
  const spine = useSpine();

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


  // ---- Filters & month navigation ----
  // (PR14 third review) The household's month (America/Chicago), not the browser's:
  // at 21:00 on September 30 in Chicago a UTC browser is already in October.
  const currentMonth = useMemo<MonthKey>(() => monthKeyFromISO(householdMonthStartOf()), []);
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
  // Weekly-first: the summary + balance trend lead with THIS week. Mo/Yr opt-in.
  // (PR14) The list follows the range too, so a `?month=` deep-link (the Budget
  // page) opens in Month mode on the month it names.
  const [rangeMode, setRangeMode] = useState<RangeMode>(() =>
    monthPinnedFromUrlRef.current ? "mo" : "wk",
  );
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

  // ---- (PR14) The Chase ledger, from the server ----
  // One window for the stats and the list: this week, the navigator's month, or
  // this year.
  const range = useMemo(
    () =>
      rangeMode === "mo"
        ? currentMonthRange(
            // (PR14 third review) `currentMonthRange` reads an INSTANT on the household
            // calendar (main, household months). Noon UTC on the 1st is inside that
            // day in Chicago from any browser; a browser-local midnight is still the
            // previous month in Chicago for a UTC or Eastern browser, which loaded
            // last month's rows, totals and select-all count.
            new Date(
              `${selectedMonth.year}-${String(selectedMonth.month + 1).padStart(2, "0")}-01T12:00:00Z`,
            ),
          )
        : rangeForMode(rangeMode),
    [rangeMode, selectedMonth],
  );
  // The household's today (Chicago): the day the ledger splits the range at.
  const ledgerToday = householdToday();
  const { register: registerWindow, after: afterWindow } = splitAtToday(range, ledgerToday);
  // A view setting only: totals and balances never depend on it.
  const [hideReviewed, setHideReviewed] = useChaseHideReviewed();
  // Name the account only when the user picked one. Otherwise the server resolves
  // the snapshot's account itself, so the first request never waits for the
  // forecast bundle (and never asks twice once it arrives).
  const ledgerAccount =
    selectedAccountKey && selectedAccountKey !== "manual" ? selectedAccountKey : undefined;
  const baseFilter: ChaseListFilter = {
    ...(ledgerAccount ? { account: ledgerAccount } : {}),
    ...(categoryFilter === "all"
      ? {}
      : categoryFilter === "uncategorized"
        ? { uncategorized: true }
        : { categoryId: categoryFilter }),
    ...(hideReviewed ? { reviewed: false } : {}),
  };
  // The register: the range through today. Its counts, totals and balances are
  // the page's.
  const registerFilter: ChaseListFilter | null = registerWindow
    ? { ...baseFilter, ...registerWindow }
    : null;
  const register = useChaseLedger(registerFilter);
  // (#728) Pending is live money still settling, so the pinned group lists ALL of
  // it for this account whatever the range: Plaid restamps a pending row's date,
  // and a range-scoped list hid settling charges ("I know I'm missing expenses").
  // (PR14 review LOW-1) No `to`: a pending row dated after today is settling money
  // too. It is listed in the group, labelled "After today", and left out of the
  // group's total.
  const pendingLedger = useChaseLedger({ ...baseFilter, pending: true });
  // Days after today: listed and labelled, never totalled (see `splitAtToday`).
  const afterLedger = useChaseLedger(afterWindow ? { ...baseFilter, ...afterWindow } : null);
  const isLoading = register.isLoading;

  const registerPage = register.first;
  const registerRows = register.rows;
  const matchingCount = registerPage?.matchingCount ?? null;
  // (PR14 review LOW-2) While a new range or filter loads, the cache still holds the
  // last one's figures. They are never shown under the new label: "—" until it answers.
  const statsStale = register.isPlaceholderData;
  const toReviewCount = statsStale ? null : (registerPage?.review.unreviewed ?? null);
  const reviewedCount = registerPage?.review.reviewed ?? 0;
  // (PR14 review H1) An account other than the bank balance's: rows, totals and
  // review counts, and no balance (the server computes none for it).
  const balanceUnavailable = registerPage?.balanceUnavailableReason === "not_snapshot_account";
  // (PR14 review H1) A saved account the ledger refuses (not a Chase account of this
  // household, or gone) falls back to the default account, clearing `?account=` and
  // the saved choice, instead of failing on every visit.
  useEffect(() => {
    if (!selectedAccountKey || selectedAccountKey === "manual") return;
    if (register.errorCode !== "account_not_ledger" && register.errorCode !== "invalid_account") return;
    setSelectedAccountKey(null);
    toast({ title: "That account has no ledger. Showing the bank balance account." });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register.errorCode, selectedAccountKey]);

  // Every row on screen, once. The bulk actions and the selection read this.
  const filtered = useMemo<Transaction[]>(() => {
    const seen = new Set<string>();
    const out: LedgerRow[] = [];
    for (const t of [...afterLedger.rows, ...registerRows, ...pendingLedger.rows]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out;
  }, [afterLedger.rows, registerRows, pendingLedger.rows]);

  // The pinned Pending group: every pending row for the account, plus any the
  // register page carries that the pending list has not loaded yet.
  const pendingItems = useMemo(() => {
    const byId = new Map<string, LedgerRow>();
    for (const t of pendingLedger.rows) byId.set(t.id, t);
    for (const t of [...registerRows, ...afterLedger.rows]) {
      if (t.pending && !byId.has(t.id)) byId.set(t.id, t);
    }
    return Array.from(byId.values()).sort(compareNewestFirst);
  }, [pendingLedger.rows, registerRows, afterLedger.rows]);
  const visiblePending = pendingItems;
  const visiblePosted = useMemo(
    () => [...afterLedger.rows, ...registerRows].filter((t) => !t.pending),
    [afterLedger.rows, registerRows],
  );
  const groups = useMemo(() => {
    const map = new Map<string, LedgerRow[]>();
    for (const t of visiblePosted) {
      const k = t.occurredOn.slice(0, 10);
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    for (const arr of map.values()) arr.sort(compareNewestFirst);
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [visiblePosted]);
  // The oldest loaded day may continue on the next page, so its day total would
  // be part of a day: it shows "—" until the rest is loaded.
  const partialDayKey =
    register.hasNextPage && registerRows.length > 0
      ? registerRows[registerRows.length - 1]!.occurredOn.slice(0, 10)
      : null;

  // ---- Range stats: the ledger's totals and balances, never re-derived ----
  const rangeTotals = registerPage && !statsStale
    ? {
        moneyIn: Number(registerPage.totals.moneyIn),
        moneyOut: Number(registerPage.totals.moneyOut),
        net: Number(registerPage.totals.net),
      }
    : null;
  // The sparkline's days, through today; the trend chart's week-ending Saturdays.
  const sparkDays = useMemo(
    () => (registerWindow ? sampleDays(registerWindow.from, registerWindow.to) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registerWindow?.from, registerWindow?.to],
  );
  const trendWindow = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const toISO = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    // Look back ~6 months so the ACTUAL line has history to draw, never before
    // the tracking-start floor (May 2026); forward 12 months.
    const FLOOR = new Date(2026, 4, 1); // 2026-05-01
    const lookback = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const windowStart = lookback > FLOOR ? lookback : FLOOR;
    const windowEnd = new Date(now.getFullYear(), now.getMonth() + 12, now.getDate());
    const firstSat = new Date(windowStart);
    firstSat.setDate(firstSat.getDate() + ((6 - firstSat.getDay() + 7) % 7));
    const saturdays: string[] = [];
    for (let sat = new Date(firstSat); sat <= windowEnd; sat.setDate(sat.getDate() + 7)) {
      saturdays.push(toISO(sat));
    }
    return { windowStart, windowEnd, saturdays };
  }, []);
  // One balances request for both: end-of-day balances on the same register as
  // the list, null after today and without a snapshot (≤120 dates).
  const balanceDatesParam = useMemo(
    () =>
      balanceDates(
        trendWindow.saturdays.filter((s) => s < todayISO),
        sparkDays,
      ).join(","),
    [trendWindow, sparkDays, todayISO],
  );
  const balancesParams = {
    dates: balanceDatesParam,
    ...(ledgerAccount ? { account: ledgerAccount } : {}),
  };
  const { data: ledgerBalances } = useGetTransactionsBalances(balancesParams, {
    query: {
      queryKey: getGetTransactionsBalancesQueryKey(balancesParams),
      enabled: !!effectiveSnapshot && !balanceUnavailable && balanceDatesParam !== "",
      staleTime: LEDGER_CACHE.staleTime,
      gcTime: LEDGER_CACHE.gcTime,
    },
  });
  const balanceByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of ledgerBalances?.balances ?? []) {
      const n = moneyOrNull(b.balance);
      if (n != null) m.set(b.date, n);
    }
    return m;
  }, [ledgerBalances]);
  const rangeBalances = {
    series: statsStale
      ? []
      : sparkDays.flatMap((d) => {
          const b = balanceByDate.get(d);
          return b == null ? [] : [b];
        }),
    startBal: statsStale ? null : moneyOrNull(registerPage?.balanceStart),
    endBal: statsStale ? null : moneyOrNull(registerPage?.balanceEnd),
  };

  // The forward-looking actual-vs-forecast trend chart. Weekly (Sun–Sat, on the
  // week-ending Saturday) actual balances from the ledger, and the cash signal's
  // projection, both meeting at today's balance.
  const balanceTrend = useMemo(() => {
    if (!effectiveSnapshot || balanceUnavailable) return null;
    const { windowStart, windowEnd, saturdays } = trendWindow;

    // Today's balance: the spine's, as the ledger carries it. Without it there is no
    // seed at all, never a $0 one (PR14 review LOW-5): the cash signal's bankToday
    // is not used, because without a snapshot it is a starting balance that
    // belongs to no day.
    const todayBalance =
      moneyOrNull(registerPage?.balanceToday ?? pendingLedger.first?.balanceToday) ??
      moneyOrNull(ledgerBalances?.anchor.todayBalance);

    // A date whose balance the register cannot give is skipped, never drawn at 0.
    const historicalActual: BalanceSeriesPoint[] = [];
    for (const satISO of saturdays) {
      if (satISO >= todayISO) break;
      const bal = balanceByDate.get(satISO);
      if (bal == null) continue;
      historicalActual.push({ date: satISO, balance: bal });
    }

    const projByDate = new Map<string, number>();
    for (const d of cashProjection?.daily ?? []) {
      const n = Number(d.balance);
      if (Number.isFinite(n)) projByDate.set(d.date, n);
    }

    // Forecast: seeded at today's balance, then the projection's Saturdays. It
    // STOPS at the last Saturday the projection covers: no flat dashed tail.
    const forecastFromToday: BalanceSeriesPoint[] =
      todayBalance == null ? [] : [{ date: todayISO, balance: todayBalance }];
    for (const satISO of saturdays) {
      if (satISO <= todayISO) continue;
      const projected = projByDate.get(satISO);
      if (projected == null) continue; // beyond horizon — do not extend
      forecastFromToday.push({ date: satISO, balance: projected });
    }
    const actualFromToday: BalanceSeriesPoint[] =
      todayBalance == null ? [] : [{ date: todayISO, balance: todayBalance }];

    // The full weekly scaffold so the axis spans the window while data loads.
    const axisDates: string[] = [todayISO, ...saturdays];

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
    balanceUnavailable,
    trendWindow,
    registerPage?.balanceToday,
    pendingLedger.first?.balanceToday,
    ledgerBalances,
    balanceByDate,
    cashProjection,
    todayISO,
  ]);

  // ---- Mutations & dialog ----
  const createTx = useCreateTransaction();
  const updateTx = useUpdateTransaction();
  const clearTransferOverride = useClearTransferOverride();
  const deleteTx = useDeleteTransaction();
  const bulkSetForecastFlag = useBulkSetForecastFlag();
  // Posted rows leave Review by resolution, not by flag (`inForecast`).
  const upsertResolution = useUpsertForecastResolution();
  const deleteResolution = useDeleteForecastResolution();
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
      occurredOn: householdToday(),
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
      occurredOn: householdToday(),
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
  // (PR5b) "Not this" answers never decide a row, so they are left out — a
  // rejection beside a real match can't hide it, and a row whose only answer
  // is a rejection is still in Review. See `rowDecisionsByTxn`.
  const resolutionByTxnId = useMemo(
    () => rowDecisionsByTxn(forecastData?.resolutions ?? []),
    [forecastData?.resolutions],
  );

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

  // The server's "today" (sent with the forecast bundle) so a row's in-Review
  // state here agrees with the review badge; the browser date is a fallback.
  const forecastToday = forecastData?.today ?? todayISO;

  // `inForecast` on the Chase page: a checking row that has already happened
  // is in the forecast — on the curve and in Review — whatever its flag says,
  // because it moved real money. The flag decides only rows that haven't
  // happened. Non-checking rows keep the flag alone.
  const isInForecastRow = (tx: Transaction): boolean =>
    canSendToForecast(tx) ? inForecast(tx, forecastToday) : tx.forecastFlag;
  const isPostedCheckingRow = (tx: Transaction): boolean =>
    canSendToForecast(tx) && tx.occurredOn <= forecastToday;

  // A posted row can't leave the cash it already moved. Taking it out of
  // Review records the decision instead — "not a planned payment", the same
  // resolution the Review page's "Unplanned" writes — rather than flipping a
  // flag that would no longer remove it from anything.
  const handleNotPlanned = (tx: Transaction) => {
    upsertResolution.mutate(
      { data: { status: "ignored_unforecasted", matchedTxnId: tx.id } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          invalidateForecastFamily(queryClient);
          toast({ title: "Marked not a planned payment" });
        },
        onError: (e) => {
          toast({
            title: "Couldn't save",
            description: (e as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

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
          invalidateForecastFamily(queryClient);
          toast({ title: next ? "Sent to Forecast" : "Removed from Forecast" });
        },
      },
    );
  };

  // The in-forecast status chip: one unambiguous per-row control. It signals the
  // triage state (In Review / Matched / Not planned), links straight to the
  // Forecast Review Bucket to match it, and carries an explicit "×" to remove
  // the row from the forecast. Replaces the old teal paper-plane, which was a
  // "Remove" button that read like a "go/advance" action. Shared by the pending
  // and posted row blocks so they can't drift. Returns null when the row isn't
  // in the forecast.
  const renderForecastChip = (tx: Transaction) => {
    if (!isInForecastRow(tx)) return null;
    const r = resolutionByTxnId.get(tx.id);
    // Tone follows the palette rule: navy for the resting states, grey for
    // "not planned". None of them is an alarm, so none of them is orange —
    // THE LABEL is what says which state the row is in.
    const state =
      r?.status === "matched"
        ? { attr: "matched", label: "Matched", icon: Check, tone: "ok" }
        : r?.status === "partial"
          ? { attr: "partial", label: "Partly paid", icon: Check, tone: "ok" }
        : r?.status === "ignored_unforecasted" || r?.status === "unplanned"
          ? { attr: "unplanned", label: "Not planned", icon: Inbox, tone: "gray" }
          : { attr: "in-review-bucket", label: "In Review", icon: Inbox, tone: "info" };
    const StateIcon = state.icon;
    // What the "×" does. A future row leaves the forecast. A posted row still
    // awaiting review is marked "not a planned payment". A posted row that is
    // already matched or marked not planned has nothing to take away here —
    // its match is managed in Review, and flipping its flag would change
    // nothing (it stays cash).
    // (PR5b) A partly-paid row offers nothing here: it paid part of a plan,
    // and every write this chip could make would replace that partial.
    const removal = state.attr === "partial"
      ? null
      : !isPostedCheckingRow(tx)
      ? {
          label: "Remove from forecast",
          onClick: () => handleToggleForecast(tx),
          pending: updateTx.isPending,
        }
      : state.attr === "in-review-bucket"
        ? {
            label: "Not a planned payment",
            onClick: () => handleNotPlanned(tx),
            pending: upsertResolution.isPending,
          }
        : null;
    return (
      <span
        className="inline-flex items-center gap-1"
        data-forecast-state={state.attr}
        data-testid={`badge-forecast-state-${tx.id}`}
      >
        <Link
          href="/forecast#bucket"
          className={`chip ${state.tone} press inline-flex items-center gap-1 hover:bg-platinum-5`}
          title="Match this in the Forecast Review Bucket"
          data-testid={`link-forecast-state-${tx.id}`}
        >
          <StateIcon className="h-3 w-3" /> {state.label}
        </Link>
        {removal && (
          <button
            type="button"
            onClick={removal.onClick}
            disabled={removal.pending}
            title={removal.label}
            aria-label={removal.label}
            className="press inline-flex items-center rounded-control p-0.5 text-neutral-400 hover:text-brand-navy disabled:opacity-50"
            data-testid={`button-remove-forecast-${tx.id}`}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </span>
    );
  };

  // The forecast action for a row that is NOT yet in the forecast: an upright
  // paper-plane = "Send to Forecast". (The plane now means "send" in exactly one
  // place; removal lives on the status chip's "×" above.) Null once the row is
  // in the forecast — a posted checking row always is — or for non-bank rows
  // that can't be forecast at all.
  const renderSendForecastAction = (tx: Transaction) => {
    if (isInForecastRow(tx)) return null;
    if (!canSendToForecast(tx)) return null;
    if (!tx.categoryId) {
      return (
        <Button
          variant="ghost"
          size="icon"
          disabled
          title="Categorize this transaction first to send it to Forecast"
          data-testid={`button-send-forecast-${tx.id}`}
        >
          <Send className="h-4 w-4 text-neutral-300" />
        </Button>
      );
    }
    // ⚠️ ONE CLICK, NO GATE. This is the whole Send-to-Forecast flow: the
    // plane calls `handleToggleForecast` directly and the row is on the
    // curve. Never put a confirm dialog, a review step, or a second button
    // in front of it — that gate existed once (#762) and was deliberately
    // deleted. STYLE ONLY BELOW THIS LINE.
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => handleToggleForecast(tx)}
        disabled={updateTx.isPending}
        title="Send to Forecast"
        data-testid={`button-send-forecast-${tx.id}`}
      >
        <Send className="h-4 w-4 text-brand-navy" />
      </Button>
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
      invalidateForecastFamily(queryClient);
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
      invalidateForecastFamily(queryClient);
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
      invalidateForecastFamily(queryClient);
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
        invalidateForecastFamily(queryClient);
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
  // (PR14) "Select all N matching": the register's filter and the count shown
  // when it was clicked. Bulk review is held to that count, so it never marks
  // rows the user was not shown a number for: a changed count is a 409.
  const [allMatching, setAllMatching] = useState<{
    filter: ChaseListFilter;
    count: number;
  } | null>(null);
  const toggleOne = (id: string) => {
    setAllMatching(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleDay = (ids: string[], on: boolean) => {
    setAllMatching(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  };
  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(null);
  };
  // A different filter is a different set of rows: the confirmed count lapses.
  const registerFilterKey = JSON.stringify(registerFilter);
  useEffect(() => {
    setAllMatching(null);
  }, [registerFilterKey]);
  const pageIds = registerRows.map((t) => t.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  // (PR14 third review NIT) The select-all banner's condition, shared by the banner and
  // the posted count below, so the count is asked for only while the banner is up.
  const selectAllBannerShown =
    matchingCount != null &&
    (!!allMatching || (pageAllSelected && matchingCount > registerRows.length));
  // (PR14 second review N1) "Select all" never covers pending rows. The sync keeps a
  // reviewed row when the bank drops it (plaidSync skips reviewed rows), so a
  // reviewed pending hold would stay counted in money out and the start balance.
  // A pending row can still be reviewed on its own row. The count is the server's,
  // for the register's filter with pending=false, asked only while the banner is up.
  const postedFilter: ChaseListFilter | null = registerFilter
    ? { ...registerFilter, pending: false }
    : null;
  const postedParams = postedFilter ? { ...toLedgerParams(postedFilter), limit: 1 } : undefined;
  const postedCountQuery = useGetTransactionsLedger(postedParams, {
    query: {
      queryKey: getGetTransactionsLedgerQueryKey(postedParams),
      enabled: !!postedFilter && selectAllBannerShown,
      staleTime: LEDGER_CACHE.staleTime,
      gcTime: LEDGER_CACHE.gcTime,
    },
  });
  const postedCount = postedCountQuery.isPlaceholderData
    ? null
    : (postedCountQuery.data?.matchingCount ?? null);
  const selectPage = () => {
    setAllMatching(null);
    setSelected(new Set(pageIds));
  };
  const selectAllMatching = () => {
    if (!postedFilter || postedCount == null || register.isPlaceholderData) return;
    setAllMatching({ filter: postedFilter, count: postedCount });
  };

  // Reviewing writes only `reviewed`: no balance, total or forecast moves.
  const reviewWrites = useChaseReviewWrites();
  const reviewByIds = async (ids: string[], reviewed: boolean, pendingLeft = 0) => {
    if (!ids.length) return;
    // The write refetches the Chase lists itself, once (PR14 review M3).
    const { succeeded, failed } = await reviewWrites.reviewIds(ids, reviewed);
    // (PR14 second review LOW) A failed id that is not on a loaded page cannot stay
    // selected (the selection follows the rows on screen), so the toast says so.
    const onScreen = new Set(filtered.map((t) => t.id));
    const failedOffScreen = failed.some((id) => !onScreen.has(id));
    // (PR14 review LOW-4) Merge, never replace: saved rows leave the selection and
    // failed rows stay in it, and anything selected meanwhile (before a later
    // Undo, say) is kept.
    setAllMatching(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of succeeded) next.delete(id);
      for (const id of failed) next.add(id);
      return next;
    });
    toast({
      title: (
        <>
          <MonoCount n={succeeded.size} /> {reviewed ? "marked reviewed" : "restored for review"}
          {failed.length ? (
            <>
              , <MonoCount n={failed.length} /> failed
            </>
          ) : null}
          {pendingLeft ? (
            <>
              {" · "}
              <MonoCount n={pendingLeft} /> pending left unreviewed
            </>
          ) : null}
        </>
      ),
      description: !failed.length
        ? "Balances and forecast are unchanged."
        : failedOffScreen
          ? "Failed rows on the loaded pages remain selected. Try again."
          : "Failed rows remain selected. Try again.",
      variant: failed.length ? "destructive" : "default",
      action: succeeded.size ? <ToastAction altText="Undo reviewed status" onClick={() => void reviewByIds(Array.from(succeeded), !reviewed)}>Undo</ToastAction> : undefined,
    });
  };
  const setReviewed = async (rows: Transaction[], reviewed: boolean) => {
    await reviewByIds(rows.filter((t) => !!t.reviewed !== reviewed).map((t) => t.id), reviewed);
  };
  // (PR14 third review LOW) The bulk bar never marks a pending row reviewed, as
  // "Select all" does not (second review N1): the sync keeps a reviewed pending row
  // when the bank drops it, and "Select this page" or the Pending group's checkbox
  // would shield every loaded one at once. A pending row's own button still can.
  const reviewSelection = async () => {
    const rows = filtered.filter((t) => selected.has(t.id));
    const pendingLeft = rows.filter((t) => t.pending && !t.reviewed).length;
    const ids = rows.filter((t) => !t.pending && !t.reviewed).map((t) => t.id);
    if (!ids.length) {
      if (pendingLeft) {
        toast({
          title: (
            <>
              <MonoCount n={pendingLeft} /> pending left unreviewed
            </>
          ),
          description: "Review a pending row on its own row.",
        });
      }
      return;
    }
    await reviewByIds(ids, true, pendingLeft);
  };
  const reviewAllMatching = async (reviewed: boolean) => {
    if (!allMatching) return;
    const outcome = await reviewWrites.reviewMatching(
      toBulkFilter(allMatching.filter),
      reviewed,
      allMatching.count,
    );
    if (outcome.kind === "ok") {
      clearSelection();
      toast({
        title: (
          <>
            <MonoCount n={outcome.updated} /> {reviewed ? "marked reviewed" : "restored for review"}
          </>
        ),
        description: "Balances and forecast are unchanged.",
        action: outcome.updatedIds.length ? <ToastAction altText="Undo reviewed status" onClick={() => void reviewByIds(outcome.updatedIds, !reviewed)}>Undo</ToastAction> : undefined,
      });
      return;
    }
    if (outcome.kind === "count_changed") {
      // Nothing was written. Show the new count and make the user choose again.
      setAllMatching(null);
      toast({
        title: "The count changed. Nothing was marked.",
        description:
          outcome.matchingCount != null ? (
            <>
              <MonoCount n={outcome.matchingCount} /> match now. Select again to review them.
            </>
          ) : (
            "Select again to review them."
          ),
        variant: "destructive",
      });
      return;
    }
    if (outcome.kind === "too_many") {
      setAllMatching(null);
      toast({
        title: (
          <>
            Over <MonoCount n={1000} /> match. Nothing was marked.
          </>
        ),
        description: "Narrow the range and try again.",
        variant: "destructive",
      });
      return;
    }
    // The selection stays, so a retry is one click.
    toast({ title: "Couldn't mark reviewed", description: outcome.message, variant: "destructive" });
  };
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
          invalidateForecastFamily(queryClient);
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
          invalidateForecastFamily(queryClient);
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
      invalidateForecastFamily(queryClient);
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
      invalidateForecastFamily(queryClient);
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

  // Reverses the "not a planned payment" half of a bulk Remove by deleting
  // exactly the resolutions that action created.
  const undoNotPlanned = async (resolutionIds: string[]) => {
    if (resolutionIds.length === 0) return;
    let restored = 0;
    for (const id of resolutionIds) {
      try {
        await deleteResolution.mutateAsync({ id });
        restored += 1;
      } catch {
        // Counted below; the rest still restore.
      }
    }
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    invalidateForecastFamily(queryClient);
    toast({
      title:
        restored === resolutionIds.length
          ? `Back in Review: ${restored}`
          : `Back in Review: ${restored} · ${resolutionIds.length - restored} failed`,
      ...(restored === resolutionIds.length
        ? {}
        : { variant: "destructive" as const }),
    });
  };

  const bulkSetForecast = async (next: boolean) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(filtered.map((t) => [t.id, t] as const));
    const selectedTxns = ids
      .map((id) => byId.get(id))
      .filter((t): t is Transaction => !!t);
    // A posted checking row is already in the forecast and can't leave the
    // cash it moved (`inForecast`). Sending skips it. Removing records "not a
    // planned payment" for the posted rows still awaiting review; posted rows
    // already matched or marked not planned are left exactly as they are.
    const notPlannedTargets = next
      ? []
      : selectedTxns.filter(
          (t) => isPostedCheckingRow(t) && !resolutionByTxnId.has(t.id),
        );
    const candidates = selectedTxns.filter(
      (t) => !isPostedCheckingRow(t) && t.forecastFlag !== next,
    );
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
    if (!targets.length && !notPlannedTargets.length) {
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
      const res =
        targetIds.length > 0
          ? await bulkSetForecastFlag.mutateAsync({
              data: { ids: targetIds, forecastFlag: next },
            })
          : { updated: 0, affectedIds: [] as string[] };
      // "Not a planned payment" for the posted rows, six at a time — the same
      // resolution the Review page writes.
      const createdResolutionIds: string[] = [];
      let notPlannedFailed = 0;
      let cursor = 0;
      const worker = async () => {
        while (cursor < notPlannedTargets.length) {
          const t = notPlannedTargets[cursor++]!;
          try {
            const row = await upsertResolution.mutateAsync({
              data: { status: "ignored_unforecasted", matchedTxnId: t.id },
            });
            createdResolutionIds.push(row.id);
          } catch {
            notPlannedFailed += 1;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(6, notPlannedTargets.length) }, worker),
      );
      queryClient.invalidateQueries({
        queryKey: getListTransactionsQueryKey(),
      });
      invalidateForecastFamily(queryClient);
      clearSelection();
      const parts: string[] = [];
      if (skippedUncat > 0) parts.push(`${skippedUncat} uncategorized`);
      if (skippedNonBank > 0) parts.push(`${skippedNonBank} non-checking`);
      const suffix = parts.length ? ` · skipped ${parts.join(", ")}` : "";
      const okCount = res.updated;
      const undoIds = res.affectedIds;
      const titleParts: string[] = [];
      if (next) {
        titleParts.push(`Sent ${okCount} to Forecast${suffix}`);
      } else {
        if (targetIds.length > 0) titleParts.push(`Removed ${okCount} from Forecast`);
        if (notPlannedTargets.length > 0) {
          titleParts.push(`${createdResolutionIds.length} not a planned payment`);
        }
        if (notPlannedFailed > 0) titleParts.push(`${notPlannedFailed} failed`);
      }
      const canUndo = undoIds.length > 0 || createdResolutionIds.length > 0;
      toast({
        title: titleParts.join(" · "),
        ...(notPlannedFailed > 0 ? { variant: "destructive" as const } : {}),
        ...(canUndo
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
                  onClick={() => {
                    undoBulkForecast(undoIds, next);
                    void undoNotPlanned(createdResolutionIds);
                  }}
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
      invalidateForecastFamily(queryClient);
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
  // (PR14 review H1) Only a cold first load shows the skeleton. A failed load renders
  // the whole page, header and account picker included, with the error and Retry
  // in the list: one account's error can never dead-end the page.
  if (register.enabled && !registerPage && !register.isLoadingError) {
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
    const data: Record<string, boolean | string | null> = {};
    if (bucket === "reimbursable") {
      // Reimbursable is an orthogonal flag — leave the spend bucket alone.
      data.reimbursable = next;
    } else {
      // Weekly / Monthly / Unplanned are mutually exclusive: marking one clears
      // the others so a charge lives in exactly one bucket (or none).
      data.weeklyAllowance = bucket === "weekly" ? next : false;
      data.monthlyAllowance = bucket === "monthly" ? next : false;
      data.unplannedAllowance = bucket === "unplanned" ? next : false;
      data.weeklyBucket =
        bucket === "weekly" && next ? (tx.weeklyBucket ?? "misc") : null;
    }
    updateTx.mutate(
      { id: tx.id, data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListTransactionsQueryKey(),
          });
          // Refresh every surface that sums the buckets so the dashboard,
          // Allowances and Budget totals move the instant you re-file a charge.
          queryClient.invalidateQueries({
            predicate: (q) => {
              const k = q.queryKey?.[0];
              return (
                typeof k === "string" &&
                (k.includes("/dashboard") ||
                  k.includes("/budget") ||
                  k.includes("/amex") ||
                  k.includes("/allowance") ||
                  k.includes("/banking") ||
                  k.includes("/reports"))
              );
            },
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
  const hasLinkedChecking = !!effectiveSnapshot || balanceUnavailable;
  // The end of the range, through today, on the server's register. Null without
  // a snapshot time: a null shows "—", never a `?? 0` dressed as $0.00.
  const checkingEnd = rangeBalances.endBal;
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
      {register.isRefetchError && <div role="alert" className={errorBanner}>Chase refresh failed. Showing the last loaded transactions. <button className={btnLink} onClick={() => void register.refetch()}>Retry transactions</button></div>}
      <div
        ref={paneRef}
        className="sticky top-0 z-30 -mx-4 -mt-4 space-y-3 border-b border-brand-line bg-platinum-1 px-4 pt-3 pb-3 md:-mx-8 md:-mt-8 md:px-8 md:pt-4"
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
              onImportReady={() => void invalidateBankLedger(queryClient)}
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
          <div className="stagger-children grid items-start gap-3 lg:grid-cols-2">
            {/* Money in vs out + net */}
            <div className={card} data-testid="chase-stats-in-out">
              <div className={cardHead}>
                <span className="text-title font-semibold text-brand-navy">
                  Money in vs out
                </span>
                <Help className="ml-auto">
                  Deposits against withdrawals in this range, through today, on
                  the ledger's amounts. Rows dated after today are not counted.
                </Help>
              </div>
              <div className="p-4">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <span className={fieldLabel}>Change</span>
                  {/* No start balance, or a start of $0 to the cent (the roll-back
                      sums decimals, so a true $0 can land a hair off zero): there
                      is no percentage to state, so no pill. Never a "0%", nor an
                      absurd figure divided by a rounding error. A display gate,
                      not money maths. */}
                  {rangeTotals && rangeBalances.startBal != null && Math.abs(rangeBalances.startBal) >= 0.005 ? (
                    <DeltaPill
                      value={(rangeTotals.net / Math.abs(rangeBalances.startBal)) * 100}
                    />
                  ) : (
                    <span className="font-mono text-label tabular-nums text-neutral-400">—</span>
                  )}
                </div>
                {rangeTotals ? (
                  <StackBar
                    segments={[
                      { label: "In", value: rangeTotals.moneyIn, color: "hsl(var(--positive))" },
                      { label: "Out", value: rangeTotals.moneyOut, color: "hsl(var(--negative))" },
                    ]}
                    legendMax={2}
                  />
                ) : (
                  <div className="grid h-10 place-items-center text-micro text-neutral-400">
                    {/* (PR14 review LOW-3) Say which: no day through today, a failed
                        load, or a new range still loading. */}
                    {register.isLoadingError
                      ? "Couldn't load"
                      : !register.enabled
                        ? "No rows through today"
                        : "—"}
                  </div>
                )}
                <div className="mt-3 flex items-baseline gap-2">
                  <span className={fieldLabel}>Net</span>
                  {rangeTotals ? (
                    <MoneyText
                      amount={rangeTotals.net}
                      colored
                      signed
                      className="font-mono text-title font-semibold tabular-nums"
                    />
                  ) : (
                    <span className="font-mono text-title font-semibold tabular-nums text-neutral-400">
                      —
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Checking balance trend across the range */}
            <div className={card} data-testid="chase-stats-balance">
              <div className={cardHead}>
                <span className="text-title font-semibold text-brand-navy">
                  Checking balance
                </span>
                {balanceUnavailable ? (
                  <span
                    className="ml-auto text-label font-semibold text-neutral-500"
                    title="Only the account the bank balance reads has a balance here."
                    data-testid="chase-balance-unavailable"
                  >
                    Balance unavailable
                  </span>
                ) : checkingEnd != null ? (
                  <MoneyText
                    amount={checkingEnd}
                    className="ml-auto font-mono text-title font-semibold tabular-nums text-brand-navy"
                  />
                ) : (
                  <span className="ml-auto font-mono text-title font-semibold tabular-nums text-neutral-400">
                    —
                  </span>
                )}
              </div>
              <div className="p-4">
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
                  <div className="grid h-10 place-items-center text-micro text-neutral-400">
                    No trend yet
                  </div>
                )}
                <div className="mt-2 flex justify-between text-micro text-neutral-500">
                  <span className={fieldLabel}>
                    Start{" "}
                    {rangeBalances.startBal != null ? (
                      <MoneyText
                        amount={rangeBalances.startBal}
                        className="font-mono tabular-nums text-brand-navy"
                      />
                    ) : (
                      <span className="font-mono tabular-nums text-neutral-400">—</span>
                    )}
                  </span>
                  <span className={fieldLabel}>
                    End{" "}
                    {rangeBalances.endBal != null ? (
                      <MoneyText
                        amount={rangeBalances.endBal}
                        className="font-mono tabular-nums text-brand-navy"
                      />
                    ) : (
                      <span className="font-mono tabular-nums text-neutral-400">—</span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className={card} data-testid="chase-stats-no-account">
            {/* "No checking account linked" is a claim: only once the forecast
                bundle, which names the linked accounts, has answered. */}
            <div className={emptyNote}>
              {forecastData === undefined
                ? forecastDataError
                  ? "Couldn't load checking account."
                  : "Loading checking account…"
                : "No checking account linked."}
            </div>
          </div>
        )}
      </div>

      {/* (cleanup) The verbose "Plaid · Chase ··5526 · Current balance …
          Last auto-updated" snapshot line was removed — the balance already
          shows in the stat tiles, and the single "Last synced" note next to
          the Sync button is the one source of truth for freshness now that
          background auto-updates are disabled. */}
      {!usingSnapshotAccount && isManualAccount && (
        <div
          className="flex items-center gap-1.5 text-micro text-neutral-500"
          data-testid="text-snapshot-meta"
        >
          <span className={fieldLabel}>Manual entries</span>
          <Help>
            Hand-entered rows carry no bank balance, so no snapshot anchors
            this view.
          </Help>
        </div>
      )}
      {/* (#422) Header pending-count chip — at-a-glance signal of how
          many "sent" rows for this account/period are still sitting in
          the Forecast Review Bucket awaiting a match. Clickable so the
          user can jump straight to the bucket and resolve them. */}
      <div className="flex items-center gap-2 flex-wrap" data-testid="chase-bucket-summary">
        {/* An unknown count (the spine is loading or failed) shows nothing:
            "All reconciled" is a claim, and a null count cannot make it. */}
        {awaitingMatchCount != null && awaitingMatchCount > 0 ? (
          <Link
            href="/forecast#bucket"
            data-testid="link-bucket-pending-count"
            className="chip warn press inline-flex items-center gap-1.5 hover:bg-platinum-5 hover:text-brand-navy"
            title="Open the Forecast Review Bucket to match these"
          >
            <Inbox className="h-3 w-3" />
            {/* Wording is asserted by e2e/transactions-bucket-badge.spec.ts and
                is already a label, not a sentence — restyled, not reworded. */}
            <span>
              Match{" "}
              <span className="font-mono tabular-nums">{awaitingMatchCount}</span>{" "}
              {awaitingMatchCount === 1 ? "item" : "items"} in Review
            </span>
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : awaitingMatchCount === 0 ? (
          <span className="chip gray" data-testid="text-bucket-empty">
            All reconciled
          </span>
        ) : null}
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
          <span className={fieldLabel}>Account</span>
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

      {/* Week-over-week spend + category mix. */}
      <ChaseInsightStrip range={range} />

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

      <ChaseReviewControls
        toReview={toReviewCount}
        hideReviewed={hideReviewed}
        onToggleHide={() => {
          setHideReviewed(!hideReviewed);
          clearSelection();
        }}
        onSelectPage={selectPage}
        canSelectPage={pageIds.length > 0}
        freshness={<FreshnessLine bank={spine.data?.bank} />}
      />
      {register.isLoadingError &&
        register.errorCode !== "account_not_ledger" &&
        register.errorCode !== "invalid_account" && (
          <div role="alert" className={errorBanner} data-testid="chase-ledger-error">
            Chase transactions could not load.{" "}
            <button className={btnLink} onClick={() => void register.refetch()}>
              Retry transactions
            </button>
          </div>
        )}
      {selectAllBannerShown && (
          <ChaseSelectAllBanner
            pageSelected={pageIds.length}
            postedCount={postedCount}
            allMatchingCount={allMatching?.count ?? null}
            canSelectAll={!register.isPlaceholderData && postedCount != null}
            onSelectAll={selectAllMatching}
            onClear={clearSelection}
          />
        )}
      {(selected.size > 0 || allMatching) && (
        <div
          className="surface sticky z-20 flex flex-wrap items-center gap-3 rounded-control px-4 py-2 ring-1 ring-brand-navy/25"
          style={{ top: "var(--pinned-pane-h, 0px)" }}
          data-testid="bulk-bar"
        >
          <span className="font-mono text-label font-semibold tabular-nums text-brand-navy">
            {allMatching ? allMatching.count.toLocaleString("en-US") : selected.size} selected
          </span>
          {/* Forecast actions need row ids; "all matching" reviews by filter only. */}
          {!allMatching && (
          <>
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
          </>
          )}
          <Button size="sm" variant="outline" disabled={reviewWrites.isPending} onClick={() => void (allMatching ? reviewAllMatching(true) : reviewSelection())} data-testid="bulk-mark-reviewed">Mark reviewed</Button>
          <Button size="sm" variant="outline" disabled={reviewWrites.isPending} onClick={() => void (allMatching ? reviewAllMatching(false) : setReviewed(filtered.filter(t => selected.has(t.id)), false))} data-testid="bulk-mark-unreviewed">Mark unreviewed</Button>
          {/* Single-flow restore: "Send to Forecast" IS "in Review" now.
              The separate bulk Send-to-Review button (#762 Phase B) is
              gone — a forecast-flagged row shows up in the Review tab
              and on the curve immediately. */}
          <Button variant="ghost" size="sm" onClick={clearSelection} className="ml-auto">
            Clear selection
          </Button>
        </div>
      )}

      {(registerPage || !register.enabled) &&
        !register.isLoadingError &&
        groups.length === 0 &&
        visiblePending.length === 0 && (
          <div className={card}>
            <div className={emptyNote} data-testid="chase-empty">
              {hideReviewed && reviewedCount > 0
                ? "Review complete. Reviewed transactions are hidden."
                : "No transactions in this range."}
            </div>
          </div>
        )}

      {/* (#728) Pinned "Pending" section above the dated day-groups.
          Renders the same row markup as the day-groups (reusing
          DayGroup) so quick-categorize, the matched-rule chip, and
          row selection work identically — only the header and
          ordering change. dayKey is "pending" so the existing
          selection / day-net handlers can address it the same way
          as any other day-group. Hidden when no pending rows exist
          so we don't render an empty header. */}
      {visiblePending.length > 0 && (() => {
        const items = visiblePending;
        const ids = items.map((t) => t.id);
        const allSelected = ids.every((id) => selected.has(id));
        const someSelected =
          !allSelected && ids.some((id) => selected.has(id));
        // (PR14 review M1) Counted rows only, and never a row dated after today.
        const dayNet = sumCounted(items.filter((t) => !t.afterToday));
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
            columnHeader={<LedgerColumns />}
          >
            <div
              className="divide-y divide-brand-line/70"
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
                      dimmed={isInForecastRow(tx) || isIgnored}
                      hideDate
                      cardLabel={formatTransactionSource(tx.source)}
                      testId={`row-tx-${tx.id}`}
                      rowData={{ "data-pending": "true" }}
                      metaNode={renderForecastChip(tx)}
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
                      chipsNode={<LedgerRowLabels row={tx} />}
                      actionsNode={<>{renderSendForecastAction(tx)}<Button variant="ghost" size="sm" disabled={reviewWrites.isPending} onClick={() => void setReviewed([tx], !tx.reviewed)}>{tx.reviewed ? "Reviewed" : "Mark reviewed"}</Button></>}
                    />
                  );
                })}
                {pendingLedger.hasNextPage && (
                  <div className="flex justify-center py-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={pendingLedger.fetchNextPage}
                      disabled={pendingLedger.isFetchingNextPage}
                      data-testid="chase-load-more-pending"
                    >
                      More pending
                    </Button>
                  </div>
                )}
            </div>
          </DayGroup>
        );
      })()}

      {afterLedger.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={afterLedger.fetchNextPage}
            disabled={afterLedger.isFetchingNextPage}
            data-testid="chase-load-more-after-today"
          >
            More after today
          </Button>
        </div>
      )}
      {groups.map(([dayKey, items], groupIndex) => {
        const ids = items.map((t) => t.id);
        const allSelected = ids.every((id) => selected.has(id));
        const someSelected = !allSelected && ids.some((id) => selected.has(id));
        const isToday = dayKey === todayKey;
        // (PR14 review M1) What the ledger counts: a mask-twin, duplicate or replaced
        // row adds 0, so the day reconciles with the card.
        const dayNet = sumCounted(items);
        // (PR14 second review NIT) A day after today is listed, never totalled, as in
        // the Pending group and the card.
        const afterTodayDay = items.every((t) => t.afterToday);
        const dayNetNode = afterTodayDay ? (
          <span
            className="tabular-nums text-neutral-400"
            title="Days after today are not totalled"
            data-testid={`day-net-${dayKey}`}
          >
            —
          </span>
        ) : dayKey === partialDayKey ? (
            <span
              className="tabular-nums text-neutral-400"
              title="More rows for this day on the next page"
              data-testid={`day-net-${dayKey}`}
            >
              —
            </span>
          ) : (
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
            // Once per ledger. The pinned Pending group above already carries
            // the column heads when it is present.
            columnHeader={
              groupIndex === 0 && pendingItems.length === 0 ? (
                <LedgerColumns />
              ) : undefined
            }
          >
            <div className="divide-y divide-brand-line/70">
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
                      dimmed={isInForecastRow(tx) || isIgnored}
                      cardLabel={formatTransactionSource(tx.source)}
                      testId={`row-tx-${tx.id}`}
                      rowData={{
                        "data-sent": isInForecastRow(tx) ? "true" : "false",
                        "data-ignored": isIgnored ? "true" : "false",
                      }}
                      chipsNode={<LedgerRowLabels row={tx} />}
                      metaNode={renderForecastChip(tx)}
                      amountNode={
                        <div className="flex flex-col items-end">
                          <InlineAmountEditor
                            tx={tx}
                            onSave={(raw) => handleQuickAmount(tx, raw)}
                            onFlipKind={() => handleQuickFlipKind(tx)}
                            disabled={updateTx.isPending}
                          />
                          {tx.runningBalance != null && (
                            <span
                              className="font-mono text-micro tabular-nums text-neutral-400"
                              data-testid={`text-running-balance-${tx.id}`}
                            >
                              bal {formatCurrency(Number(tx.runningBalance))}
                            </span>
                          )}
                        </div>
                      }
                      actionsNode={
                        <>
                          {renderSendForecastAction(tx)}
                          <Button variant="ghost" size="sm" disabled={reviewWrites.isPending} onClick={() => void setReviewed([tx], !tx.reviewed)}>{tx.reviewed ? "Reviewed" : "Mark reviewed"}</Button>
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
      {registerPage && !statsStale && (
        <ChaseLedgerPager
          showing={registerRows.length}
          matching={registerPage.matchingCount}
          toReview={toReviewCount}
          hasMore={register.hasNextPage}
          loading={register.isFetchingNextPage}
          onLoadMore={register.fetchNextPage}
        />
      )}
    </div>
  );
}
