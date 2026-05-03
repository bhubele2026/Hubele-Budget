import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useListTransactions,
  useUpdateTransaction,
  useListCategories,
  useListDebts,
  getListTransactionsQueryKey,
  getGetBudgetMonthQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
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
import { CreditCard } from "lucide-react";
import { CategoryPicker } from "@/components/category-picker";
import { TransactionWeeklyBucket } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { useWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { PlaidLinkButton } from "@/components/plaid-link-button";
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

const AMEX_SOURCE = "amex";

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

export default function AmexPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Filters
  const [sourceFilter, setSourceFilter] = useState<string>(AMEX_SOURCE);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [memberFilter, setMemberFilter] = useState<string>("all");

  const currentMonth = useMemo<MonthKey>(() => monthKeyOf(new Date()), []);
  const [selectedMonth, setSelectedMonth] = useState<MonthKey>(currentMonth);

  // Server query: fetch the union of [selected month] ∪ [selected month →
  // current month] so we have everything needed for the month's rows AND
  // for rolling the ending balance between the anchor and the selected
  // month. Per-row From/To narrows further client-side.
  const queryParams = useMemo(() => {
    // Widen window to cover the trailing-12-month trend chart, which
    // anchors at currentMonth and rolls back to (selectedMonth - 11).
    const trendStart = shiftMonth(selectedMonth, -11);
    const candidates = [selectedMonth, currentMonth, trendStart];
    let earlier = candidates[0];
    let later = candidates[0];
    for (const c of candidates) {
      if (compareMonth(c, earlier) < 0) earlier = c;
      if (compareMonth(c, later) > 0) later = c;
    }
    const p: { source?: string; limit?: number; from?: string; to?: string } = {
      limit: 5000,
      from: monthFirstISO(earlier),
      to: monthLastISO(later),
    };
    if (sourceFilter && sourceFilter !== "all") p.source = sourceFilter;
    return p;
  }, [sourceFilter, selectedMonth, currentMonth]);

  const { data: txns, isLoading } = useListTransactions(queryParams);
  const { data: categories } = useListCategories();
  const { data: debts } = useListDebts();
  // Server-provided Amex anchor: fallback used when the Amex debt row is
  // missing or renamed.
  const { data: amexAnchorResp, isLoading: amexAnchorLoading } = useQuery<{
    amexEndingBalance: number | null;
    asOf: string;
    source: "debt" | "anchor" | "computed" | "missing";
  }>({
    queryKey: ["/api/amex/anchor"],
    queryFn: () => customFetch("/api/amex/anchor", { method: "GET" }),
    staleTime: 60_000,
  });
  const updateTx = useUpdateTransaction();
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

  // All visible Amex/source-filtered txns (server-filtered).
  const all = txns ?? [];

  // Members from server-returned set so the dropdown reflects current source.
  const members = useMemo(() => {
    const s = new Set<string>();
    for (const t of all) if (t.member) s.add(t.member);
    return Array.from(s).sort();
  }, [all]);

  // Restrict to the selected calendar month before any other client-side
  // filtering. The From/To inputs further narrow within the month.
  const monthScoped = useMemo(() => {
    return all.filter((t) => {
      const mk = monthKeyFromISO(t.occurredOn);
      return compareMonth(mk, selectedMonth) === 0;
    });
  }, [all, selectedMonth]);

  // Apply client-side filters.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return monthScoped.filter((t) => {
      const k = t.occurredOn.slice(0, 10);
      if (from && k < from) return false;
      if (to && k > to) return false;
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
  }, [monthScoped, search, memberFilter, categoryFilter, categoryById, from, to]);

  // Group by day (descending). Within each day, sort by a stable key
  // (occurredOn desc, then id asc) so refetches can't swap row order.
  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of filtered) {
      const k = t.occurredOn.slice(0, 10);
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        if (a.occurredOn !== b.occurredOn)
          return a.occurredOn < b.occurredOn ? 1 : -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }
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

  // Net change per month for the entire visible (source-filtered) set —
  // used to roll the latest known account balance backward/forward to give
  // each month a consistent ending balance.
  const netChangeByMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of all) {
      const mk = monthKeyFromISO(t.occurredOn);
      const k = `${mk.year}-${mk.month}`;
      m.set(k, (m.get(k) ?? 0) + parseSigned(t.amount));
    }
    return m;
  }, [all]);

  // Distinct Plaid account IDs present on the Amex-source transactions.
  // These identify the actual Amex card account(s) feeding this page.
  const amexPlaidAccountIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of all) {
      if (t.plaidAccountId) s.add(t.plaidAccountId);
    }
    return s;
  }, [all]);

  // Find the linked Amex debt (if any) for the anchor balance. Prefer
  // matching by the Plaid account that actually feeds this page's
  // transactions so renaming the debt doesn't break the link. Fall back
  // to the legacy name regex when no Plaid link exists on either side.
  const amexDebt = useMemo(() => {
    if (!debts) return null;
    if (amexPlaidAccountIds.size > 0) {
      const byAccount = debts.find(
        (d) => d.plaidAccountId && amexPlaidAccountIds.has(d.plaidAccountId),
      );
      if (byAccount) return byAccount;
    }
    return (
      debts.find((d) => /amex|american\s*express/i.test(d.name)) ?? null
    );
  }, [debts, amexPlaidAccountIds]);

  const endingBalance = useMemo(() => {
    // Prefer the linked Amex debt; otherwise fall back to the server-
    // provided anchor. Only declare "missing" when neither source has a
    // usable balance AND the server fallback has finished loading — this
    // avoids a flicker of "Unavailable" between debt/transaction load and
    // anchor resolution.
    let anchor: number | null = null;
    let resolvedSource: "debt" | "anchor" | "computed" = "debt";
    let asOf: string | null = null;
    if (amexDebt) {
      anchor = parseSigned(amexDebt.balance);
      resolvedSource = "debt";
      asOf = amexDebt.lastBalanceUpdate ?? amexDebt.plaidLastSyncedAt ?? null;
    } else if (
      amexAnchorResp &&
      amexAnchorResp.amexEndingBalance !== null &&
      amexAnchorResp.source !== "missing"
    ) {
      anchor = amexAnchorResp.amexEndingBalance;
      resolvedSource =
        amexAnchorResp.source === "debt" ? "anchor" : amexAnchorResp.source;
      asOf = amexAnchorResp.asOf ?? null;
    }
    if (anchor === null) {
      const loading = amexAnchorLoading || amexAnchorResp === undefined;
      return {
        value: null as number | null,
        source: (loading ? "loading" : "missing") as "loading" | "missing",
        asOf: null as string | null,
      };
    }
    const cmp = compareMonth(selectedMonth, currentMonth);
    if (cmp === 0) return { value: anchor, source: resolvedSource, asOf };
    let bal = anchor;
    if (cmp < 0) {
      // Past month: undo every month after selectedMonth, up to and
      // including currentMonth (those net changes happened after the end
      // of the selected month).
      let cursor = currentMonth;
      while (compareMonth(cursor, selectedMonth) > 0) {
        const k = `${cursor.year}-${cursor.month}`;
        bal -= netChangeByMonth.get(k) ?? 0;
        cursor = shiftMonth(cursor, -1);
      }
    } else {
      // Future month: add net change for every month strictly after
      // currentMonth, up to and including selectedMonth.
      let cursor = shiftMonth(currentMonth, 1);
      while (compareMonth(cursor, selectedMonth) <= 0) {
        const k = `${cursor.year}-${cursor.month}`;
        bal += netChangeByMonth.get(k) ?? 0;
        cursor = shiftMonth(cursor, 1);
      }
    }
    return { value: bal, source: resolvedSource, asOf };
  }, [amexDebt, amexAnchorResp, amexAnchorLoading, netChangeByMonth, selectedMonth, currentMonth]);

  const endingBalanceMeta = useMemo(() => {
    if (
      endingBalance.source !== "debt" &&
      endingBalance.source !== "anchor" &&
      endingBalance.source !== "computed"
    ) {
      return null;
    }
    const sourceLabel =
      endingBalance.source === "debt"
        ? "From debt row"
        : endingBalance.source === "anchor"
          ? "From saved anchor"
          : "Computed from transactions";
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
    const footer = asOfLabel
      ? `${sourceLabel} · as of ${asOfLabel}`
      : sourceLabel;
    const tooltip =
      endingBalance.source === "computed"
        ? `${footer}\nNo linked Amex debt or saved anchor — this is the running sum of imported transactions and may drift from the real card balance.`
        : footer;
    return { sourceLabel, asOfLabel, footer, tooltip };
  }, [endingBalance]);

  // Trailing 12-month ending-balance series, anchored at the current
  // month's known Amex debt balance and rolled month-by-month using the
  // same net-change math as `endingBalance` above.
  const balanceTrend = useMemo<TrendPoint[]>(() => {
    let anchor: number | null = null;
    if (amexDebt) anchor = parseSigned(amexDebt.balance);
    else if (
      amexAnchorResp &&
      amexAnchorResp.amexEndingBalance !== null &&
      amexAnchorResp.source !== "missing"
    ) {
      anchor = amexAnchorResp.amexEndingBalance;
    }
    if (anchor === null) return [];
    // Compute the ending balance for any given month by rolling from the
    // currentMonth anchor.
    const balanceAt = (mk: MonthKey): number => {
      const cmp = compareMonth(mk, currentMonth);
      if (cmp === 0) return anchor;
      let bal = anchor;
      if (cmp < 0) {
        let cursor = currentMonth;
        while (compareMonth(cursor, mk) > 0) {
          const k = `${cursor.year}-${cursor.month}`;
          bal -= netChangeByMonth.get(k) ?? 0;
          cursor = shiftMonth(cursor, -1);
        }
      } else {
        let cursor = shiftMonth(currentMonth, 1);
        while (compareMonth(cursor, mk) <= 0) {
          const k = `${cursor.year}-${cursor.month}`;
          bal += netChangeByMonth.get(k) ?? 0;
          cursor = shiftMonth(cursor, 1);
        }
      }
      return bal;
    };
    const points: TrendPoint[] = [];
    for (let i = 11; i >= 0; i--) {
      const mk = shiftMonth(selectedMonth, -i);
      const d = new Date(mk.year, mk.month, 1);
      points.push({
        key: `${mk.year}-${mk.month}`,
        label: d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        shortLabel: d.toLocaleDateString("en-US", { month: "short" }),
        balance: balanceAt(mk),
        isSelected: compareMonth(mk, selectedMonth) === 0,
      });
    }
    return points;
  }, [amexDebt, amexAnchorResp, netChangeByMonth, selectedMonth, currentMonth]);

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
    const tx = all.find((t) => t.id === id);
    try {
      await updateTx.mutateAsync({
        id,
        data: {
          categoryId,
          ...(rememberPattern ? { rememberPattern } : {}),
        },
      });
      invalidateTxns();
      if (tx) invalidateBudgetMonths([monthStartOf(tx.occurredOn)]);
      if (rememberPattern && categoryId) {
        toast({
          title: "Categorized & remembered",
          description: `Future "${rememberPattern}" will auto-categorize.`,
        });
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
    const patch: Partial<Transaction> = {
      weeklyAllowance: bucket === "weekly",
      monthlyAllowance: bucket === "monthly",
      unplannedAllowance: bucket === "unplanned",
      weeklyBucket: wb ?? null,
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
    const patch: Partial<Transaction> = {
      reimbursable: next,
      ...(next ? {} : { reimbursed: false }),
    };
    await qc.cancelQueries({ queryKey: [`/api/transactions`] });
    const prev = patchTransactionInCache(t.id, patch);
    queueBubbleMutation(t.id, async () => {
      try {
        const updated = await updateTx.mutateAsync({
          id: t.id,
          data: { reimbursable: next, ...(next ? {} : { reimbursed: false }) },
        });
        patchTransactionIfMatching(t.id, patch, {
          reimbursable: updated.reimbursable,
          reimbursed: updated.reimbursed,
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

  const setRowOwedBy = async (t: Transaction, raw: string) => {
    const trimmed = raw.trim();
    const next: string | null = trimmed.length === 0 ? null : trimmed;
    if ((t.owedBy ?? null) === next) return;
    try {
      await updateTx.mutateAsync({ id: t.id, data: { owedBy: next } });
      invalidateTxns();
    } catch (e) {
      toast({
        title: "Couldn't update owed by",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
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

  const setRowSource = async (id: string, source: string) => {
    try {
      await updateTx.mutateAsync({ id, data: { source } });
      invalidateTxns();
    } catch (e) {
      toast({
        title: "Couldn't update source",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  const bulkSetBucket = async (
    bucket: "" | "weekly" | "monthly" | "unplanned",
    weeklyBucket?: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket],
  ) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(filtered.map((t) => [t.id, t] as const));
    const CONCURRENCY = 6;
    const results: { id: string; ok: boolean; err?: string }[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i];
        const t = byId.get(id);
        if (!t) {
          results.push({ id, ok: false, err: "missing" });
          continue;
        }
        let wb: typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket] | null = null;
        if (bucket === "weekly") {
          wb =
            weeklyBucket ??
            t.weeklyBucket ??
            defaultWeeklyBucketFor(categoryById.get(t.categoryId ?? "") ?? "");
        }
        try {
          await updateTx.mutateAsync({
            id,
            data: {
              weeklyAllowance: bucket === "weekly",
              monthlyAllowance: bucket === "monthly",
              unplannedAllowance: bucket === "unplanned",
              weeklyBucket: wb,
            },
          });
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, err: (e as Error).message });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
    );
    invalidateTxns();
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      toast({ title: `Tagged ${okCount} transaction${okCount === 1 ? "" : "s"}` });
    } else {
      toast({
        title: `Tagged ${okCount}, ${failed.length} failed`,
        description: failed[0].err,
        variant: "destructive",
      });
    }
  };

  const bulkSetCategory = async (categoryId: string | null) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const byId = new Map(all.map((t) => [t.id, t] as const));
    const CONCURRENCY = 6;
    const results: { id: string; ok: boolean; err?: string }[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i];
        try {
          await updateTx.mutateAsync({ id, data: { categoryId } });
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, err: (e as Error).message });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
    );
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
    const failed = results.filter((r) => !r.ok);
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
    if (failed.length === 0) {
      toast({
        title: `Updated ${okIds.size} transaction${okIds.size === 1 ? "" : "s"}`,
      });
    } else {
      toast({
        title: `Updated ${okIds.size}, ${failed.length} failed`,
        description: failed[0].err,
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
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const todayKey = ymd(new Date());

  return (
    <div
      className="space-y-6"
      style={{ ["--pinned-pane-h" as string]: `${paneH}px` } as React.CSSProperties}
    >
      <div
        ref={paneRef}
        className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-4 md:pt-8 pb-4 bg-background border-b shadow-sm space-y-4"
      >
        <AccountPageHeader
          title="American Express"
          subtitle="Day-by-day card spending — categorized into your budget."
          icon={<CreditCard className="h-7 w-7 text-blue-600" />}
          actions={<PlaidLinkButton label="Connect a card" />}
        />

      <div className="flex items-stretch gap-4 flex-wrap">
        <MonthNavigator value={selectedMonth} onChange={setSelectedMonth} />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1 min-w-[280px]">
          {endingBalance.source === "missing" ? (
            <div
              className="rounded-md border border-dashed border-blue-300 bg-blue-50/60 px-3 py-2 text-blue-900"
              data-testid="stat-ending-balance"
            >
              <div className="text-[10px] uppercase tracking-widest text-blue-700">
                Ending balance
              </div>
              <div className="font-mono tabular-nums font-semibold text-base text-blue-900/70">
                Not set
              </div>
              <div className="mt-1 flex flex-col gap-1">
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
            <Skeleton className="h-[88px] w-full" data-testid="stat-ending-balance-loading" />
          ) : (
            <StatChip
              label="Ending balance"
              value={endingBalance.value ?? 0}
              accent={
                endingBalance.source === "computed"
                  ? "bg-amber-50 text-amber-900 border-amber-300"
                  : "bg-blue-50 text-blue-900 border-blue-200"
              }
              footer={endingBalanceMeta?.footer}
              tooltip={endingBalanceMeta?.tooltip}
              testId="stat-ending-balance"
              action={
                endingBalance.source === "computed" ||
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
                        className={
                          endingBalance.source === "anchor"
                            ? "h-6 px-2 text-[11px] border-blue-300 text-blue-900 bg-white/60 hover:bg-white"
                            : "h-6 px-2 text-[11px] border-amber-400 text-amber-900 bg-white/60 hover:bg-white"
                        }
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
          <StatChip
            label="Charges"
            value={monthTotals.charges}
            testId="stat-charges"
          />
          <StatChip
            label="Payments & credits"
            value={Math.abs(monthTotals.paymentsAndCredits)}
            valueClassName="text-emerald-700"
            testId="stat-payments-credits"
          />
          <StatChip
            label="Net change"
            value={monthTotals.netChange}
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
            { value: AMEX_SOURCE, label: "amex" },
            { value: "manual", label: "manual" },
            { value: "import", label: "import" },
            { value: "all", label: "All sources" },
          ]}
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
        caption="Ending balance · trailing 12 months"
        data={balanceTrend}
        color="#2563eb"
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
          <Button variant="ghost" size="sm" onClick={clearSelection} className="ml-auto">
            Clear
          </Button>
        </div>
      )}
      {/* Day groups */}
      {groups.length === 0 && (
        <Card><CardContent className="p-8 text-center text-muted-foreground">
          No transactions match these filters.
        </CardContent></Card>
      )}
      {groups.map(([dayKey, items]) => {
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
                <table className="w-full text-sm">
                  <tbody>
                    {items.map((t) => (
                      <tr key={t.id} className="border-t hover:bg-muted/30 transition-colors">
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
                        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                          {t.member ?? "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Input
                            key={t.owedBy ?? ""}
                            defaultValue={t.owedBy ?? ""}
                            placeholder="Owed by…"
                            aria-label={`Owed by for ${t.description}`}
                            className="h-7 w-32 text-xs"
                            onBlur={(e) => {
                              if ((e.currentTarget.value.trim() || null) !== (t.owedBy ?? null)) {
                                setRowOwedBy(t, e.currentTarget.value);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                (e.currentTarget as HTMLInputElement).blur();
                              } else if (e.key === "Escape") {
                                (e.currentTarget as HTMLInputElement).value = t.owedBy ?? "";
                                (e.currentTarget as HTMLInputElement).blur();
                              }
                            }}
                          />
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
                          {t.isTransfer && (
                            <Badge
                              variant="outline"
                              className="mt-1 text-[10px] border-slate-300 text-slate-700 bg-slate-50"
                              title="Excluded from budget actuals"
                              data-testid={`badge-transfer-${t.id}`}
                            >
                              Transfer
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Select
                            value={t.source}
                            onValueChange={(v) => setRowSource(t.id, v)}
                          >
                            <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value={AMEX_SOURCE}>amex</SelectItem>
                              <SelectItem value="manual">manual</SelectItem>
                              <SelectItem value="import">import</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <BucketBubbles
                              flags={{
                                weekly: t.weeklyAllowance,
                                monthly: t.monthlyAllowance,
                                unplanned: t.unplannedAllowance,
                                reimbursable: t.reimbursable,
                              }}
                              onToggle={(b, next) => onBubbleToggle(t, b, next)}
                            />
                            {t.weeklyAllowance && (
                              <Select
                                value={t.weeklyBucket ?? TransactionWeeklyBucket.misc}
                                onValueChange={(v) =>
                                  setRowBucket(t, "weekly", v as typeof TransactionWeeklyBucket[keyof typeof TransactionWeeklyBucket])
                                }
                              >
                                <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={TransactionWeeklyBucket.groceries}>{weeklyLabels.groceries}</SelectItem>
                                  <SelectItem value={TransactionWeeklyBucket.dining}>{weeklyLabels.dining}</SelectItem>
                                  <SelectItem value={TransactionWeeklyBucket.entertainment}>{weeklyLabels.entertainment}</SelectItem>
                                  <SelectItem value={TransactionWeeklyBucket.misc}>{weeklyLabels.misc}</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatCurrency(parseAbs(t.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
          </DayGroup>
        );
      })}
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
