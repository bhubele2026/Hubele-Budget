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
  getListTransactionsQueryKey,
  getGetForecastQueryKey,
  getGetBudgetMonthQueryKey,
  useListPlaidItems,
  type Transaction,
  type RepointedRule,
  type MappingRule,
  type CreateTransactionInput,
} from "@workspace/api-client-react";
import { MatchedRuleChip } from "@/components/matched-rule-chip";
import { useOpportunisticPlaidSync } from "@/hooks/use-opportunistic-plaid-sync";
import {
  useBulkRecategorizePrompt,
  bulkRuleFromRepointed,
  bulkRuleFromRuleAction,
} from "@/hooks/use-bulk-recategorize-prompt";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate, cn, moneyColorClass } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  Wand2,
  Landmark,
  RefreshCw,
  CalendarDays,
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { isBankTxn } from "@/lib/forecastMatch";
import { ruleActionMessage } from "@/lib/ruleActionMessage";
import { useRuleActionUndo } from "@/lib/useRuleActionUndo";
import { BucketBubbles, type BucketFlags, type BucketKey } from "@/components/bucket-bubbles";
import { chaseMonthTotals } from "@/lib/chaseScope";
import { shouldShowManualPickerOption } from "@/lib/chasePickerOptions";
import {
  makeChaseBalanceAtEndOf,
  scopeChaseTransactions,
} from "@/lib/chaseEndingBalance";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import {
  compareNewestFirst,
  computeRunningBalances,
  sortNewestFirst,
} from "@/lib/runningBalance";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
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
  StatChip,
  StatChipUnavailable,
  monthKeyOf,
  monthKeyFromISO,
  compareMonth,
  shiftMonth,
  type MonthKey,
  type TrendPoint,
} from "@/components/account-page";

const formSchema = z.object({
  occurredOn: z.string().min(1, "Date is required"),
  description: z.string().min(1, "Description is required"),
  amount: z.string().min(1, "Amount is required"),
  kind: z.enum(["expense", "income"]).default("expense"),
  categoryId: z.string().nullable().optional(),
  weeklyAllowance: z.boolean().default(false),
  monthlyAllowance: z.boolean().default(false),
  unplannedAllowance: z.boolean().default(false),
  reimbursable: z.boolean().default(false),
  reimbursed: z.boolean().default(false),
  // (#479) Edit-dialog toggle that mirrors the row-level "Transfer" pill.
  // Sent on PATCH only when the value differs from the row's existing
  // `isTransfer`, so opening the dialog on a non-transfer row and saving
  // unrelated fields doesn't silently set `isTransferUserOverridden`.
  isTransfer: z.boolean().default(false),
});

/**
 * Mirrors the server-side `matchRule` (autoCategorize.ts) for the
 * Add-Transaction dialog's live "as you type" auto-pick. Walks the user's
 * mapping rules in priority-descending order and returns the rule whose
 * pattern matches the description (only rules with a non-null categoryId
 * count, matching server semantics). Returns null when nothing fires.
 *
 * Kept inline rather than imported from `@workspace/api-server` because
 * the client artifact doesn't depend on the api-server package and the
 * pure matching logic is small enough to duplicate.
 */
function matchRuleClient(
  description: string,
  rules: readonly MappingRule[] | undefined,
): MappingRule | null {
  if (!description || !rules?.length) return null;
  const hay = description.toLowerCase();
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const r of sorted) {
    if (!r.categoryId) continue;
    const needle = r.pattern.toLowerCase();
    if (!needle) continue;
    let hit = false;
    if (r.matchType === "exact") hit = hay === needle;
    else if (r.matchType === "starts_with") hit = hay.startsWith(needle);
    else hit = hay.includes(needle);
    if (hit) return r;
  }
  return null;
}

type FormValues = z.infer<typeof formSchema>;

function normalizeAmount(raw: string, kind: "expense" | "income"): string {
  const num = Math.abs(parseFloat(raw));
  if (Number.isNaN(num)) return raw;
  return (kind === "income" ? num : -num).toFixed(2);
}

function parseSigned(amount: string | number): number {
  return Number(amount) || 0;
}

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
  // (#671) Layer 4 — opportunistic Plaid refresh on Transactions mount.
  // The most common "where's my pending charge?" entry point — fire a
  // silent forceRefresh so newly authorized rows land without a click.
  useOpportunisticPlaidSync();
  const { data: transactions, isLoading } = useListTransactions({ limit: 5000 });
  const { data: categories } = useListCategories();
  const { data: mappingRules } = useListMappingRules();
  const { data: forecastData } = useGetForecast();
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
      plaidCheckingAccounts: forecastData?.plaidCheckingAccounts ?? [],
    });
  }, [
    bankSnapshot,
    effectiveAccountInternalId,
    accountSnapshots,
    forecastData?.plaidCheckingAccounts,
  ]);
  const chasePlaidAccountId = useMemo(() => {
    if (!effectiveAccountInternalId) return null;
    const acct = (forecastData?.plaidCheckingAccounts ?? []).find(
      (a) => a.id === effectiveAccountInternalId,
    );
    return acct?.accountId ?? null;
  }, [effectiveAccountInternalId, forecastData?.plaidCheckingAccounts]);
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
    const accounts = forecastData?.plaidCheckingAccounts ?? [];
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
    forecastData?.plaidCheckingAccounts,
  ]);
  // The currently selected account row (if it's a Plaid account) — used
  // by the meta line under the header so the user always sees the
  // institution / mask of the account they're viewing, not just the
  // snapshot account.
  const selectedPlaidAccount = useMemo(() => {
    if (!effectiveAccountInternalId) return null;
    return (
      (forecastData?.plaidCheckingAccounts ?? []).find(
        (a) => a.id === effectiveAccountInternalId,
      ) ?? null
    );
  }, [effectiveAccountInternalId, forecastData?.plaidCheckingAccounts]);

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
    if (!selectedAccountKey || selectedAccountKey === "manual") return;
    const accounts = forecastData?.plaidCheckingAccounts;
    if (!accounts) return;
    if (!accounts.some((a) => a.id === selectedAccountKey)) {
      setSelectedAccountKey(null);
    }
  }, [selectedAccountKey, forecastData?.plaidCheckingAccounts]);

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

  // ---- Per-month money in/out & balance math ----
  // (#443) `chaseMonthTotals` is the single source of truth for the bubble
  // math — it re-applies the month filter at compute time so we cannot
  // accidentally regress to counting cross-month rows here.
  const monthTotals = useMemo(
    () => chaseMonthTotals(filtered, selectedMonth),
    [filtered, selectedMonth],
  );

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
  const startingBalance = useMemo(
    () => balanceAtEndOf(shiftMonth(selectedMonth, -1)),
    [balanceAtEndOf, selectedMonth],
  );

  const balanceTrend = useMemo<TrendPoint[]>(() => {
    if (!effectiveSnapshot) return [];
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
  }, [effectiveSnapshot, balanceAtEndOf, selectedMonth]);

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

  // ---- Mutations & dialog ----
  const createTx = useCreateTransaction();
  const updateTx = useUpdateTransaction();
  const clearTransferOverride = useClearTransferOverride();
  const deleteTx = useDeleteTransaction();
  const bulkSetForecastFlag = useBulkSetForecastFlag();
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

  // Count of this account's "sent" rows in the currently-viewed month
  // that are still sitting in the Review Bucket (no matched / unplanned
  // resolution yet). Powers the clickable header chip.
  const awaitingMatchCount = useMemo(() => {
    let n = 0;
    for (const tx of monthScoped) {
      if (!tx.forecastFlag) continue;
      const r = resolutionByTxnId.get(tx.id);
      if (!r) {
        n += 1;
        continue;
      }
      if (r.status !== "matched" && r.status !== "ignored_unforecasted" && r.status !== "unplanned") {
        n += 1;
      }
    }
    return n;
  }, [monthScoped, resolutionByTxnId]);

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

  const handleQuickCategorize = async (tx: Transaction, categoryId: string) => {
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
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

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
      className="space-y-6"
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
        className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-4 md:pt-8 pb-4 bg-background border-b shadow-sm space-y-4"
      >
      <AccountPageHeader
        title="Chase"
        subtitle="Your checking activity, day by day."
        icon={<Landmark className="h-7 w-7 text-primary" />}
        accentBorderClass="border-primary"
        actions={
          <>
            {isPlaidLinked && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshBank}
                disabled={refreshBank.isPending}
                data-testid="button-refresh-bank"
              >
                <RefreshCw
                  className={cn(
                    "w-4 h-4 mr-1.5",
                    refreshBank.isPending && "animate-spin",
                  )}
                />
                Refresh from Plaid
              </Button>
            )}
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

      <div className="flex items-stretch gap-4 flex-wrap">
        <MonthNavigator value={selectedMonth} onChange={setSelectedMonth} />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 flex-1 min-w-[280px]">
          {hasLinkedChecking ? (
            <StatChip
              label="Starting balance"
              value={startingBalance}
              loading={!transactions}
              unavailableHint="No snapshot for this month yet."
              testId="stat-starting-balance"
            />
          ) : (
            <StatChipUnavailable
              label="Starting balance"
              hint="Connect a checking account to see the balance."
              testId="stat-starting-balance"
            />
          )}
          {/* (#464) Pass `loading={!transactions}` so these tiles render
              an explicit "Loading…" affordance instead of a misleading
              $0.00 if the underlying transactions query hasn't resolved
              yet — matches the hardened Amex Ending balance tile from
              #455. */}
          <StatChip
            label="Money in"
            value={transactions ? monthTotals.moneyIn : null}
            loading={!transactions}
            valueClassName="text-[hsl(var(--positive))]"
            testId="stat-money-in"
          />
          <StatChip
            label="Money out"
            value={transactions ? monthTotals.moneyOut : null}
            loading={!transactions}
            valueClassName="text-[hsl(var(--negative))]"
            testId="stat-money-out"
          />
          {hasLinkedChecking ? (
            <StatChip
              label="Ending balance"
              value={endingBalance}
              loading={!transactions}
              unavailableHint="No snapshot for this month yet."
              accent="bg-emerald-50 text-emerald-900 border-emerald-200"
              testId="stat-ending-balance"
            />
          ) : (
            <StatChipUnavailable
              label="Ending balance"
              hint="Connect a checking account to see the balance."
              testId="stat-ending-balance"
            />
          )}
          <StatChip
            label="Net change"
            value={transactions ? monthTotals.netChange : null}
            loading={!transactions}
            valueClassName={moneyColorClass(monthTotals.netChange)}
            signed
            testId="stat-net-change"
          />
        </div>
      </div>

      {effectiveSnapshot && (
        <div
          className="text-xs text-muted-foreground"
          data-testid="text-snapshot-meta"
        >
          {effectiveSnapshot.source === "plaid" ? "Plaid" : "Manual"} ·{" "}
          {selectedPlaidAccount?.institutionName ??
            effectiveSnapshot.name ??
            selectedPlaidAccount?.name ??
            "Checking"}
          {effectiveSnapshot.mask ? ` ••${effectiveSnapshot.mask}` : ""} ·
          Current balance {formatCurrency(effectiveSnapshot.balance)}
          {usingSnapshotAccount ? " · snapshot" : ""}
          <BankSnapshotFreshness
            source={effectiveSnapshot.source}
            at={effectiveSnapshot.at}
          />
        </div>
      )}
      {!effectiveSnapshot && selectedPlaidAccount && (
        <div
          className="text-xs text-muted-foreground"
          data-testid="text-snapshot-meta"
        >
          Plaid ·{" "}
          {selectedPlaidAccount.institutionName ??
            selectedPlaidAccount.name ??
            "Checking"}
          {selectedPlaidAccount.mask ? ` ••${selectedPlaidAccount.mask}` : ""} ·
          Press Refresh from Plaid to see Starting and Ending balances.
        </div>
      )}
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
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 text-amber-900 px-2.5 py-0.5 text-xs hover-elevate active-elevate-2"
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
        // (#360) Show the picker whenever there are 2+ effective views —
        // either multiple Plaid checking accounts, or one Plaid checking
        // account paired with a manual-entries pseudo-account. Without
        // counting the manual option here, a single-Plaid-account user
        // with manual rows could never switch to the Manual view.
        const plaidCount = forecastData?.plaidCheckingAccounts?.length ?? 0;
        const showsManual =
          plaidCount >= 1 &&
          shouldShowManualPickerOption({
            transactions: transactions ?? [],
            currentlySelected: isManualAccount,
          });
        const totalOptions = plaidCount + (showsManual ? 1 : 0);
        return totalOptions > 1;
      })() && (
        <div className="flex items-center gap-2" data-testid="chase-account-picker">
          <span className="text-xs text-muted-foreground">View account:</span>
          <Select
            value={effectiveAccountKey}
            onValueChange={(v) => setSelectedAccountKey(v)}
          >
            <SelectTrigger className="h-7 text-xs w-64" data-testid="select-chase-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-testid="chase-account-options">
              {(forecastData?.plaidCheckingAccounts ?? []).map((a) => {
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
              {/* (#412) Only render the "Manual entries" pseudo-account
                  when the user actually has manual rows (no plaidAccountId)
                  — otherwise it's pure clutter next to the real Chase row.
                  Always keep it visible if it's the current selection so
                  the trigger never goes blank. */}
              {shouldShowManualPickerOption({
                transactions: transactions ?? [],
                currentlySelected: isManualAccount,
              }) && (
                <SelectItem
                  value="manual"
                  data-testid="option-chase-account-manual"
                >
                  Manual entries
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      )}

      <AccountFilterBar
        search={search}
        onSearchChange={setSearch}
        from={from}
        onFromChange={setFrom}
        to={to}
        onToChange={setTo}
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
        sourceOptions={sourceOptions}
        categoryFilter={categoryFilter}
        onCategoryFilterChange={setCategoryFilter}
        categories={categories ?? []}
        members={members}
        memberFilter={memberFilter}
        onMemberFilterChange={setMemberFilter}
        rightSlot={
          <div className="text-xs text-muted-foreground ml-auto" data-testid="text-row-count">
            {filtered.length} of {monthScoped.length} txns
          </div>
        }
      />
      </div>

      <BalanceTrendChart
        caption="Checking balance · trailing 12 months"
        data={balanceTrend}
        color="hsl(var(--chart-1))"
        valueLabel="Ending balance"
      />

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{editingTx ? "Edit Transaction" : "New Transaction"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="occurredOn" render={({ field }) => (
                <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Input placeholder="Trader Joe's" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField
                control={form.control}
                name="categoryId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <NewTransactionCategoryPicker
                        value={field.value ?? null}
                        onChange={(next) => {
                          categoryManuallyPickedRef.current = true;
                          field.onChange(next);
                        }}
                        categories={categories ?? []}
                        autoMatchedRule={
                          editingTx ? editingMatchedRule : dialogAutoMatchedRule
                        }
                        mappingRules={mappingRules}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-3 gap-3">
                <FormField control={form.control} name="kind" render={({ field }) => (
                  <FormItem className="col-span-1"><FormLabel>Kind</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="expense">Expense</SelectItem>
                        <SelectItem value="income">Income</SelectItem>
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Amount</FormLabel><FormControl><Input type="number" step="0.01" min="0" placeholder="42.50" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              {(() => {
                // (#607) When the picked category is the system-managed
                // Transfer row, hide Weekly/Monthly/Unplanned/Transfer
                // toggles — the server flips isTransfer=true and clears
                // all three allowance flags on save, so showing them
                // would be misleading. The Transfer toggle is also
                // implied true in that case and would just be a no-op.
                const watchedCategoryId = form.watch("categoryId");
                const transferCat = (categories ?? []).find(
                  (c) => c.name === "Transfer",
                );
                const isPickedTransfer =
                  !!transferCat && watchedCategoryId === transferCat.id;
                return (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="reimbursable" render={({ field }) => (
                      <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Reimbursable</FormLabel></FormItem>
                    )} />
                    <FormField control={form.control} name="reimbursed" render={({ field }) => (
                      <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Reimbursed</FormLabel></FormItem>
                    )} />
                    {!isPickedTransfer && (
                      <>
                        <FormField control={form.control} name="weeklyAllowance" render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Weekly Allow</FormLabel></FormItem>
                        )} />
                        <FormField control={form.control} name="monthlyAllowance" render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Monthly Allow</FormLabel></FormItem>
                        )} />
                        <FormField control={form.control} name="unplannedAllowance" render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Unplanned Allow</FormLabel></FormItem>
                        )} />
                        <FormField control={form.control} name="isTransfer" render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0">
                            <FormControl>
                              <Checkbox
                                checked={field.value}
                                onCheckedChange={field.onChange}
                                data-testid="checkbox-is-transfer"
                              />
                            </FormControl>
                            <FormLabel>Transfer</FormLabel>
                          </FormItem>
                        )} />
                      </>
                    )}
                  </div>
                );
              })()}
              {editingTx?.isTransferUserOverridden && (
                <div
                  className="flex items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
                  data-testid="transfer-override-hint"
                >
                  <div>
                    <div className="font-medium text-slate-700">
                      Transfer status manually set
                    </div>
                    <div className="mt-0.5 text-slate-500">
                      Future bank syncs won't re-flag this row from the description
                      heuristic. Reset to let auto-detection take over again.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    data-testid="button-reset-transfer-override"
                    disabled={clearTransferOverride.isPending}
                    onClick={() => {
                      const id = editingTx.id;
                      clearTransferOverride.mutate(
                        { id },
                        {
                          onSuccess: () => {
                            queryClient.invalidateQueries({
                              queryKey: getListTransactionsQueryKey(),
                            });
                            setEditingTx((prev) =>
                              prev && prev.id === id
                                ? { ...prev, isTransferUserOverridden: false }
                                : prev,
                            );
                            toast({ title: "Reset to auto" });
                          },
                        },
                      );
                    }}
                  >
                    Reset to auto
                  </Button>
                </div>
              )}
              <div className="flex justify-end pt-4">
                <Button type="submit" disabled={createTx.isPending || updateTx.isPending}>Save</Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {previewDialog}

      {selected.size > 0 && (
        <div
          className="sticky z-20 flex items-center gap-3 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 shadow-sm"
          style={{ top: "var(--pinned-pane-h, 0px)" }}
          data-testid="bulk-bar"
        >
          <span className="text-sm font-medium text-emerald-900">
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
          <Button variant="ghost" size="sm" onClick={clearSelection} className="ml-auto">
            Clear
          </Button>
        </div>
      )}

      {groups.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No transactions match these filters.
          </CardContent>
        </Card>
      )}

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
          <DayGroup
            key={dayKey}
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
                // line look "active". Purely visual — no pointer-events
                // change, picker/bubbles/checkbox stay clickable.
                const isIgnored =
                  !!ignoreCatId && tx.categoryId === ignoreCatId;
                return (
                <div
                  key={tx.id}
                  className={cn(
                    "p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-muted/30 transition-colors",
                    (tx.forecastFlag || isIgnored) && "opacity-60 bg-muted/20",
                    focusTxId === tx.id &&
                      "ring-2 ring-amber-500 bg-amber-50 dark:bg-amber-950/30",
                  )}
                  data-testid={`row-tx-${tx.id}`}
                  data-sent={tx.forecastFlag ? "true" : "false"}
                  data-ignored={isIgnored ? "true" : "false"}
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <Checkbox
                      checked={selected.has(tx.id)}
                      onCheckedChange={() => toggleOne(tx.id)}
                      aria-label="Select"
                      className="mt-1"
                      data-testid={`select-${tx.id}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                        <span className="font-medium text-foreground truncate">
                          {tx.description}
                        </span>
                        <span
                          className="text-[11px] text-muted-foreground/80"
                          data-testid={`text-source-${tx.id}`}
                        >
                          {formatTransactionSource(tx.source)}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 items-center">
                        {tx.categoryId && categoryById.get(tx.categoryId) && (
                          <InlineCategoryPicker
                            tx={tx}
                            currentName={categoryById.get(tx.categoryId)!}
                            categories={categories ?? []}
                            onPick={(catId) => handleQuickCategorize(tx, catId)}
                          />
                        )}
                        <MatchedRuleChip
                          categoryId={tx.categoryId}
                          matchedRuleId={tx.matchedRuleId}
                          rules={mappingRules}
                          testIdSuffix={tx.id}
                        />
                        {!tx.categoryId && (
                          <CategorizeChip
                            tx={tx}
                            categories={categories ?? []}
                            onPick={(catId) => handleQuickCategorize(tx, catId)}
                          />
                        )}
                        {!tx.isTransfer && tx.isTransferUserOverridden && (
                          <Badge
                            variant="outline"
                            className="inline-flex items-center text-[11px] font-normal border-slate-200 text-slate-500 bg-slate-50/60"
                            data-testid={`badge-transfer-overridden-cleared-${tx.id}`}
                            title="You cleared the auto-Transfer flag on this row. Future syncs won't re-add it."
                          >
                            Manually set
                          </Badge>
                        )}
                        {tx.isTransfer && (
                          <Badge
                            variant="outline"
                            className="inline-flex items-center gap-1 text-xs border-slate-300 text-slate-700 bg-slate-50"
                            data-testid={`badge-transfer-${tx.id}`}
                            title={
                              tx.isTransferUserOverridden
                                ? "Manually set — won't be re-flagged on the next sync"
                                : undefined
                            }
                          >
                            Transfer
                            {tx.isTransferUserOverridden && (
                              <span
                                aria-hidden="true"
                                data-testid={`badge-transfer-overridden-${tx.id}`}
                                className="text-slate-500 -ml-0.5"
                              >
                                *
                              </span>
                            )}
                            <button
                              type="button"
                              aria-label="Clear Transfer flag"
                              data-testid={`button-clear-transfer-${tx.id}`}
                              className="ml-0.5 inline-flex items-center justify-center rounded hover:bg-slate-200/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-400"
                              onClick={(e) => {
                                e.stopPropagation();
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
                              }}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </Badge>
                        )}
                        {tx.forecastFlag && (() => {
                          const r = resolutionByTxnId.get(tx.id);
                          if (r?.status === "matched") {
                            return (
                              <Badge
                                variant="outline"
                                className="text-xs border-primary/30 text-primary bg-primary/15"
                                data-testid={`badge-forecast-state-${tx.id}`}
                                data-forecast-state="matched"
                              >
                                <Inbox className="w-3 h-3 mr-1" /> Matched
                              </Badge>
                            );
                          }
                          if (
                            r?.status === "ignored_unforecasted" ||
                            r?.status === "unplanned"
                          ) {
                            return (
                              <Badge
                                variant="outline"
                                className="text-xs border-slate-300 text-slate-700 bg-slate-50"
                                data-testid={`badge-forecast-state-${tx.id}`}
                                data-forecast-state="unplanned"
                              >
                                <Inbox className="w-3 h-3 mr-1" /> Unplanned
                              </Badge>
                            );
                          }
                          return (
                            <Badge
                              variant="outline"
                              className="text-xs border-amber-200 text-amber-800 bg-amber-50"
                              data-testid={`badge-forecast-state-${tx.id}`}
                              data-forecast-state="in-review-bucket"
                            >
                              <Inbox className="w-3 h-3 mr-1" /> In Review Bucket
                            </Badge>
                          );
                        })()}
                        <BucketBubbles
                          flags={{
                            weekly: !!tx.weeklyAllowance,
                            monthly: !!tx.monthlyAllowance,
                            unplanned: !!tx.unplannedAllowance,
                            reimbursable: !!tx.reimbursable,
                          }}
                          onToggle={(bucket: BucketKey, next: boolean) => {
                            const data: Record<string, boolean> = {};
                            if (bucket === "weekly") data.weeklyAllowance = next;
                            else if (bucket === "monthly") data.monthlyAllowance = next;
                            else if (bucket === "unplanned") data.unplannedAllowance = next;
                            else if (bucket === "reimbursable") data.reimbursable = next;
                            updateTx.mutate(
                              { id: tx.id, data },
                              {
                                onSuccess: () => {
                                  queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
                                },
                                // (#642) Surface the server-side
                                // "transfer can't be tagged Unplanned"
                                // rejection as a short toast so the
                                // user understands why nothing happened
                                // when they click the UN bubble on a
                                // transfer-looking row. Same toast for
                                // any other rejection (e.g. transient
                                // network error) so we don't silently
                                // swallow failures.
                                onError: (e: unknown) => {
                                  toast({
                                    title: "Couldn't update bucket",
                                    description:
                                      (e as Error)?.message ??
                                      "Please try again.",
                                    variant: "destructive",
                                  });
                                },
                              },
                            );
                          }}
                          disabled={updateTx.isPending}
                        />
                        {tx.reimbursed && <Badge variant="outline" className="text-xs border-green-200 text-green-700 bg-green-50">Reimbursed</Badge>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
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
                    <div className="flex gap-1 items-center">
                      <InlineDateMover
                        tx={tx}
                        onSave={(raw) => handleQuickDate(tx, raw)}
                        disabled={updateTx.isPending}
                      />
                      {tx.forecastFlag ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleToggleForecast(tx)}
                          disabled={updateTx.isPending}
                          title="Remove from Forecast"
                          data-testid={`button-remove-forecast-${tx.id}`}
                        >
                          <Send className="w-3.5 h-3.5 mr-1.5" />
                          Remove
                        </Button>
                      ) : !canSendToForecast(tx) ? null : tx.categoryId ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleToggleForecast(tx)}
                          disabled={updateTx.isPending}
                          title="Send to Forecast"
                          data-testid={`button-send-forecast-${tx.id}`}
                        >
                          <Send className="w-3.5 h-3.5 mr-1.5" />
                          Send
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled
                          title="Categorize this transaction first"
                          data-testid={`button-send-forecast-${tx.id}`}
                        >
                          <Send className="w-3.5 h-3.5 mr-1.5" />
                          Categorize first
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleOpenEdit(tx)}
                        data-testid={`button-edit-tx-${tx.id}`}
                      >
                        <Edit2 className="w-4 h-4 text-muted-foreground" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(tx.id)}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          </DayGroup>
        );
      })}
    </div>
  );
}

// Keyword → list of category-name substrings to surface as suggestions when a
// transaction is uncategorized. The first existing category whose name matches
// any of the substrings (case-insensitive) wins. Designed to cover the
// debt-bearing April Chase rows (Synchrony, Chase autopay, Upstart, Dept of
// Education) plus a handful of common merchants.
const SUGGESTION_RULES: { match: string[]; targets: string[] }[] = [
  { match: ["synchrony"], targets: ["Synchrony", "Ashley", "Mattress", "PayPal Credit", "Misc / Buffer"] },
  { match: ["upstart"], targets: ["Upstart", "Misc / Buffer"] },
  { match: ["chase credit", "chase autopay"], targets: ["Chase Sapphire", "Chase Freedom", "Chase", "Misc / Buffer"] },
  { match: ["dept education", "dept of ed", "nelnet"], targets: ["Student Loan", "Nelnet", "Dept of Ed", "Misc / Buffer"] },
  { match: ["intuit"], targets: ["Intuit", "Misc / Buffer"] },
  { match: ["affirm"], targets: ["Affirm", "Misc / Buffer"] },
  { match: ["american express", "amex"], targets: ["American Express", "Amex", "Misc / Buffer"] },
  { match: ["discover"], targets: ["Discover", "Misc / Buffer"] },
  { match: ["capital one"], targets: ["Capital One", "Misc / Buffer"] },
  { match: ["paymthly", "pypl paymthly", "paypal credit"], targets: ["PayPal Credit", "Synchrony", "Misc / Buffer"] },
  { match: ["applecard", "apple card"], targets: ["Apple Card", "Misc / Buffer"] },
  { match: ["credit one"], targets: ["Credit One", "Misc / Buffer"] },
  { match: ["figure"], targets: ["Figure", "HELOC", "Misc / Buffer"] },
  { match: ["uw credit union"], targets: ["Hannah", "Car Payments", "Misc / Buffer"] },
  { match: ["toyota"], targets: ["Toyota", "Car Payments"] },
  { match: ["lakeview"], targets: ["Mortgage", "Lakeview"] },
  { match: ["madison gas", "city of madison"], targets: ["Utilities", "MGE"] },
  { match: ["verizon"], targets: ["Phone", "Utilities", "Verizon"] },
  { match: ["state farm"], targets: ["Insurance", "State Farm"] },
  { match: ["trustage"], targets: ["Insurance", "TruStage"] },
  { match: ["metro market", "costco", "walmart"], targets: ["Groceries", "Shopping"] },
  { match: ["kwik trip"], targets: ["Gas", "Transportation"] },
  { match: ["starbucks", "dunkin", "doordash", "mooyah"], targets: ["Dining", "Coffee", "Restaurants"] },
  { match: ["paypal purchase", "stitchfix", "aldo", "shen zhen", "brghtwhl"], targets: ["Shopping"] },
  { match: ["paramount", "adobe", "ancestry", "playstation", "nintendo"], targets: ["Subscriptions"] },
];

function suggestCategories(
  description: string,
  categories: { id: string; name: string }[],
): { id: string; name: string }[] {
  const hay = (description ?? "").toLowerCase();
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const rule of SUGGESTION_RULES) {
    if (!rule.match.some((m) => hay.includes(m))) continue;
    for (const target of rule.targets) {
      const needle = target.toLowerCase();
      const hit = categories.find(
        (c) => c.name.toLowerCase().includes(needle) && !seen.has(c.id),
      );
      if (hit) {
        out.push(hit);
        seen.add(hit.id);
        if (out.length >= 3) return out;
      }
    }
  }
  return out;
}

/**
 * Task #451 — Inline category override surfaced on rows that already
 * have a category (whether assigned by a mapping rule or set manually).
 * The category badge itself acts as the picker trigger so changing the
 * category is one click instead of opening the pencil/edit dialog.
 * Picking a new category routes through the same `onPick` handler the
 * uncategorized-row `CategorizeChip` uses (`handleQuickCategorize`),
 * so the same PATCH flow, "Categorized" toast, ruleAction-aware undo,
 * and bulk-recategorize prompts all fire identically.
 */
function InlineCategoryPicker({
  tx,
  currentName,
  categories,
  onPick,
}: {
  tx: Transaction;
  currentName: string;
  categories: { id: string; name: string }[];
  onPick: (categoryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge
          variant="outline"
          role="button"
          tabIndex={0}
          className="cursor-pointer text-xs font-medium border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100 transition-colors"
          data-testid={`badge-category-${tx.id}`}
          title="Change category"
        >
          {currentName}
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search category…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
              {categories.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  onSelect={() => {
                    setOpen(false);
                    // Skip the no-op PATCH when the user picks the
                    // category the row already has — avoids surfacing
                    // a misleading "Categorized" toast and prevents
                    // the server's mapping-rule auto-learn / repoint
                    // side effects from firing on a same-category
                    // selection.
                    if (c.id === tx.categoryId) return;
                    onPick(c.id);
                  }}
                  data-testid={`option-inline-category-${tx.id}-${c.id}`}
                >
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
            Picking a category will remember this merchant.
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Task #454 — Inline amount editor surfaced as the row's amount label.
 * Clicking the amount opens a small popover with a numeric input that
 * routes through `handleQuickAmount` (same `updateTx` PATCH path as
 * the Edit dialog). Sign / currency formatting is preserved by
 * `normalizeAmount` so an expense stays an expense and an income
 * stays an income — only the magnitude changes. Submitting an
 * unchanged value is a no-op (no toast, no PATCH).
 */
function InlineAmountEditor({
  tx,
  onSave,
  onFlipKind,
  disabled,
}: {
  tx: Transaction;
  onSave: (raw: string) => Promise<boolean>;
  onFlipKind?: () => Promise<boolean>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const initial = Math.abs(parseSigned(tx.amount)).toFixed(2);
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    if (open) setDraft(Math.abs(parseSigned(tx.amount)).toFixed(2));
  }, [open, tx.amount]);
  const submit = async () => {
    const ok = await onSave(draft);
    if (ok) setOpen(false);
  };
  const isCurrentlyIncome = parseSigned(tx.amount) >= 0;
  const flip = async () => {
    if (!onFlipKind) return;
    const ok = await onFlipKind();
    if (ok) setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "font-medium tabular-nums whitespace-nowrap cursor-pointer rounded px-1 -mx-1 hover:bg-muted/40 transition-colors",
            parseSigned(tx.amount) > 0
              ? "text-[hsl(var(--positive))]"
              : "text-foreground",
          )}
          title="Edit amount"
          data-testid={`amount-${tx.id}`}
        >
          {formatCurrency(tx.amount)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="end">
        <div className="space-y-2">
          <label
            htmlFor={`inline-amount-input-${tx.id}`}
            className="text-xs text-muted-foreground"
          >
            New amount
          </label>
          <Input
            id={`inline-amount-input-${tx.id}`}
            data-testid={`input-inline-amount-${tx.id}`}
            type="number"
            step="0.01"
            min="0"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
            autoFocus
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              data-testid={`button-cancel-inline-amount-${tx.id}`}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={disabled}
              data-testid={`button-save-inline-amount-${tx.id}`}
            >
              Save
            </Button>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {isCurrentlyIncome
              ? "Positive (income) — sign preserved."
              : "Negative (expense) — sign preserved."}
          </div>
          {onFlipKind && (
            <div className="border-t pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void flip()}
                disabled={disabled}
                data-testid={`button-flip-kind-${tx.id}`}
                title={
                  isCurrentlyIncome
                    ? "Flip to expense"
                    : "Flip to income"
                }
              >
                {isCurrentlyIncome ? "Mark as expense" : "Mark as income"}
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Task #454 — Inline date mover. Lives next to the per-row action
 * buttons as a small calendar icon. Clicking opens a date input that
 * PATCHes `occurredOn` through the same `updateTx` flow as the Edit
 * dialog so the row visibly hops to its new day group without forcing
 * a full dialog round trip. Submitting the same date is a no-op.
 */
function InlineDateMover({
  tx,
  onSave,
  disabled,
}: {
  tx: Transaction;
  onSave: (raw: string) => Promise<boolean>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const initial = tx.occurredOn.slice(0, 10);
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    if (open) setDraft(tx.occurredOn.slice(0, 10));
  }, [open, tx.occurredOn]);
  const submit = async () => {
    const ok = await onSave(draft);
    if (ok) setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          title="Move to a different day"
          data-testid={`button-inline-date-${tx.id}`}
        >
          <CalendarDays className="w-4 h-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-3" align="end">
        <div className="space-y-2">
          <label
            htmlFor={`inline-date-input-${tx.id}`}
            className="text-xs text-muted-foreground"
          >
            Move to
          </label>
          <Input
            id={`inline-date-input-${tx.id}`}
            data-testid={`input-inline-date-${tx.id}`}
            type="date"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
            autoFocus
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              data-testid={`button-cancel-inline-date-${tx.id}`}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={disabled}
              data-testid={`button-save-inline-date-${tx.id}`}
            >
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CategorizeChip({
  tx,
  categories,
  onPick,
}: {
  tx: Transaction;
  categories: { id: string; name: string }[];
  onPick: (categoryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(
    () => suggestCategories(tx.description, categories),
    [tx.description, categories],
  );
  const top = suggestions[0];
  if (top) {
    return (
      <span className="inline-flex items-center gap-1">
        <Badge
          variant="outline"
          className="cursor-pointer text-xs border-violet-300 text-violet-700 bg-violet-50 hover:bg-violet-100"
          onClick={() => onPick(top.id)}
          title="Categorize and remember this merchant"
          data-testid={`badge-suggest-${tx.id}`}
        >
          <Wand2 className="w-3 h-3 mr-1" /> Categorize as {top.name}
        </Badge>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Badge
              variant="outline"
              className="cursor-pointer text-xs border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"
              data-testid={`badge-uncategorized-${tx.id}`}
            >
              Other…
            </Badge>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search category…" />
              <CommandList>
                <CommandEmpty>No category</CommandEmpty>
                {suggestions.length > 1 && (
                  <CommandGroup heading="Suggested">
                    {suggestions.slice(1).map((c) => (
                      <CommandItem
                        key={`s-${c.id}`}
                        onSelect={() => {
                          onPick(c.id);
                          setOpen(false);
                        }}
                      >
                        {c.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandGroup heading="All categories">
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
              <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
                Picking a category will remember this merchant.
              </div>
            </Command>
          </PopoverContent>
        </Popover>
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge
          variant="outline"
          className="cursor-pointer text-xs border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"
          data-testid={`badge-uncategorized-${tx.id}`}
        >
          <Wand2 className="w-3 h-3 mr-1" /> Categorize
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search category…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
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
          <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
            Picking a category will remember this merchant.
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Category combobox surfaced inside the Add-Transaction dialog (Task #230).
 * Shows the live auto-pick under the trigger as a `MatchedRuleChip` so the
 * user can see *why* a category was suggested (and click straight to the
 * Mapping Rules page to inspect the rule). Picking from the list flips the
 * parent's "manually picked" flag so subsequent description edits stop
 * overwriting the explicit choice. A "Clear" affordance lets the user
 * deliberately submit the row uncategorized — POST /transactions treats an
 * explicit `categoryId: null` as authoritative and skips the auto-pick.
 */
function NewTransactionCategoryPicker({
  value,
  onChange,
  categories,
  autoMatchedRule,
  mappingRules,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  categories: { id: string; name: string }[];
  autoMatchedRule: MappingRule | null;
  mappingRules: readonly MappingRule[] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => categories.find((c) => c.id === value) ?? null,
    [categories, value],
  );
  // Surface the chip whenever the live auto-pick attributes the current
  // value to a rule — same semantics as the Transactions / Amex row chip.
  const matchedRuleId =
    autoMatchedRule && autoMatchedRule.categoryId === value
      ? autoMatchedRule.id
      : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="flex-1 justify-between font-normal"
              data-testid="combobox-new-tx-category"
            >
              {selected ? (
                <span className="truncate">{selected.name}</span>
              ) : (
                <span className="text-muted-foreground">Uncategorized</span>
              )}
              <Wand2 className="w-3.5 h-3.5 ml-2 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search category…" />
              <CommandList>
                <CommandEmpty>No category</CommandEmpty>
                <CommandGroup>
                  {categories.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={c.name}
                      onSelect={() => {
                        onChange(c.id);
                        setOpen(false);
                      }}
                      data-testid={`option-new-tx-category-${c.id}`}
                    >
                      {c.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-xs text-muted-foreground"
            onClick={() => onChange(null)}
            data-testid="button-new-tx-category-clear"
            title="Leave uncategorized"
          >
            Clear
          </Button>
        )}
      </div>
      <div className="min-h-[18px]">
        <MatchedRuleChip
          categoryId={value}
          matchedRuleId={matchedRuleId}
          rules={mappingRules}
          testIdSuffix="new-tx-dialog"
          variant="compact"
        />
      </div>
    </div>
  );
}
