import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBillsSummary,
  useCreateRecurringItem,
  useUpdateRecurringItem,
  useDeleteRecurringItem,
  useListDebts,
  useListTransactions,
  useListCategories,
  useGetAvalancheSettings,
  useGetAvalancheExtra,
  getListRecurringItemsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetForecastQueryKey,
  getGetDashboardQueryKey,
  type RecurringItem,
  type RecurringItemInput,
  type BillsSummaryRow,
  type BillsDebtMinRow,
  type Category,
  type Debt,
} from "@workspace/api-client-react";
import { simulate, type SimDebt, type Strategy } from "@/lib/avalanche";
import { debtToSim, effectiveDebtBalance } from "@/lib/debtBalance";
import { BillsHealthCheck } from "@/components/bills-health-check";
import { formatBillRowAmount } from "@/lib/billsRowAmount";
import { computePayoffsByDebt, filterDebtMinRowsByPayoff } from "@/lib/forecastDebts";
import { Lock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeRangeToggle } from "@/components/time-range-toggle";
import { rangeForMode, type RangeMode } from "@/lib/timeRange";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import {
  btn,
  btnDanger,
  btnLink,
  btnLinkDanger,
  card,
  cardHead,
  emptyNote,
  Field,
  fieldLabel,
  Foot,
  Help,
  input,
  Stat,
  td,
  tdNum,
  th,
} from "@/ui";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { invalidateForecastFamily } from "@/lib/invalidateForecast";

type Frequency =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "onetime";

type ItemKind = "income" | "bill";

type FormState = {
  name: string;
  kind: ItemKind;
  amount: string;
  frequency: Frequency;
  dayOfMonth: string;
  anchorDate: string;
  oneTimeDate: string;
  active: boolean;
  // (#690) Optional link to a Budget category. Persisted as
  // `recurring_items.category_id` and consumed by the Budget page's
  // bill-rollup so manually entered bills feed their planned amount
  // into the right envelope. Empty string = "— None —" (unlinked).
  categoryId: string;
};

// (#690) Sentinel used in the Select since shadcn/ui's <Select> forbids
// an empty-string item value. We round-trip through this token in the
// dropdown and convert back to "" / null at the form/payload boundary.
const NO_CATEGORY = "__none__";

function parseISODate(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatDatePill(iso: string | null): { month: string; day: string } | null {
  if (!iso) return null;
  const d = parseISODate(iso);
  if (!d) return null;
  return {
    month: d.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
    day: String(d.getDate()),
  };
}

function frequencyLabel(item: RecurringItem): string {
  const f = item.frequency;
  switch (f) {
    case "weekly":
      return "weekly";
    case "biweekly":
      return "biweekly";
    case "semimonthly":
      return "semi-monthly";
    case "monthly":
      return item.dayOfMonth ? `monthly · day ${item.dayOfMonth}` : "monthly";
    case "onetime": {
      const d = item.anchorDate ? parseISODate(item.anchorDate) : null;
      if (d) {
        return `one-time · ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
      }
      return "one-time";
    }
    case "quarterly":
      return "quarterly";
    case "annual":
      return "annual";
    default:
      return f;
  }
}

const isActive = (item: RecurringItem): boolean => item.active === "true";

// Task #690 — name of the dedicated manual bucket on /budget. Bills must
// never auto-link into "My budget" (it's the home for personal envelopes
// that are explicitly NOT tied to a bill), so the Bills modal filters
// these categories out of the picker entirely. Keep this in lockstep
// with `MY_BUDGET_GROUP` on the server (api-server/src/routes/budget.ts)
// and the frontend Budget page.
const MY_BUDGET_GROUP = "My budget";

/**
 * ⚠️ ROW TABLES SCROLL THEMSELVES, THEY DO NOT COMPRESS.
 *
 * Squeezed into a 390px phone these tables re-wrap every cell — the amount
 * breaks across three lines, the date column detaches from its row and the
 * action buttons clip off the card. A min-width inside an `overflow-x-auto`
 * keeps each row at its designed proportions and lets the narrow screen pan,
 * which is the one thing that stays readable. The PAGE never scrolls sideways;
 * only the box does.
 */
const scrollX = "overflow-x-auto";

/** The due-date cell shared by every row table on this page. */
function DueCell({ iso }: { iso: string | null }) {
  const pill = formatDatePill(iso);
  if (!pill) return <span className="text-neutral-300">—</span>;
  return (
    <span className="whitespace-nowrap font-mono text-label tabular-nums text-brand-navy">
      {pill.month} {pill.day}
    </span>
  );
}

const DEFAULT_FORM: FormState = {
  name: "",
  kind: "bill",
  amount: "",
  frequency: "monthly",
  dayOfMonth: "1",
  anchorDate: "",
  oneTimeDate: "",
  active: true,
  categoryId: "",
};

function buildPayload(form: FormState): RecurringItemInput {
  const base: RecurringItemInput = {
    name: form.name.trim(),
    kind: form.kind,
    amount: form.amount || "0",
    frequency: form.frequency,
    active: form.active ? "true" : "false",
    dayOfMonth: null,
    anchorDate: null,
    categoryId: form.categoryId ? form.categoryId : null,
  };
  if (form.frequency === "monthly" || form.frequency === "semimonthly") {
    const day = parseInt(form.dayOfMonth, 10);
    base.dayOfMonth = Number.isFinite(day) && day >= 1 && day <= 31 ? day : 1;
    base.anchorDate = form.anchorDate || null;
  } else if (form.frequency === "onetime") {
    base.anchorDate = form.oneTimeDate || null;
  } else {
    base.anchorDate = form.anchorDate || null;
  }
  return base;
}

function toFormState(item: RecurringItem): FormState {
  const freq = (["weekly", "biweekly", "semimonthly", "monthly", "onetime"].includes(item.frequency)
    ? item.frequency
    : "monthly") as Frequency;
  return {
    name: item.name,
    kind: item.kind === "income" ? "income" : "bill",
    amount: item.amount,
    frequency: freq,
    dayOfMonth: item.dayOfMonth ? String(item.dayOfMonth) : "1",
    anchorDate: freq === "onetime" ? "" : item.anchorDate ?? "",
    oneTimeDate: freq === "onetime" ? item.anchorDate ?? "" : "",
    active: isActive(item),
    categoryId: item.categoryId ?? "",
  };
}

const MIN_BILLS_MONTH = "2026-04-01";

function thisMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function BillsPage() {
  const search = useSearch();
  const [, setLocation] = useLocation();

  // (#500) Month picker state mirrors the Budget page: prev/next chevrons +
  // ?month=YYYY-MM-01 URL param. Defaults to the current calendar month.
  const [currentMonth, setCurrentMonth] = useState(() => {
    const params = new URLSearchParams(search);
    const m = params.get("month");
    if (m && /^\d{4}-\d{2}-01$/.test(m)) {
      return m < MIN_BILLS_MONTH ? MIN_BILLS_MONTH : m;
    }
    const tm = thisMonthStart();
    return tm < MIN_BILLS_MONTH ? MIN_BILLS_MONTH : tm;
  });

  // Weekly-first: the "Due ___" lead window. Opens on this week; Mo/Yr opt-in.
  const [dueMode, setDueMode] = useState<RangeMode>("wk");

  useEffect(() => {
    const params = new URLSearchParams(search);
    const m = params.get("month");
    if (m && /^\d{4}-\d{2}-01$/.test(m) && m !== currentMonth) {
      setCurrentMonth(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const changeMonth = (offset: number) => {
    const [yStr, mStr] = currentMonth.split("-");
    const y = Number(yStr);
    const m0 = Number(mStr) - 1;
    const targetY = y + Math.floor((m0 + offset) / 12);
    const targetM = ((m0 + offset) % 12 + 12) % 12;
    const raw = `${targetY}-${String(targetM + 1).padStart(2, "0")}-01`;
    const next = raw < MIN_BILLS_MONTH ? MIN_BILLS_MONTH : raw;
    if (next === currentMonth) return;
    setCurrentMonth(next);
    const params = new URLSearchParams(search);
    params.set("month", next);
    // This page (the Bills list) is mounted at /bills/all — plain /bills is the
    // separate Overview page. Route to /bills/all so stepping the month stays on
    // the list instead of bouncing back to Overview.
    setLocation(`/bills/all?${params.toString()}`, { replace: true });
  };

  const atFloor = currentMonth <= MIN_BILLS_MONTH;

  const monthName = useMemo(() => {
    const d = new Date(currentMonth + "T00:00:00");
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(d);
  }, [currentMonth]);

  const { data: summary, isLoading } = useGetBillsSummary({ month: currentMonth });
  const { data: debts } = useListDebts();
  const { data: avaSettings } = useGetAvalancheSettings();
  const { data: resolvedExtra } = useGetAvalancheExtra();
  const qc = useQueryClient();
  const { toast } = useToast();

  const createItem = useCreateRecurringItem();
  const updateItem = useUpdateRecurringItem();
  const deleteItem = useDeleteRecurringItem();
  // (#690) Budget categories drive the Category picker in the
  // Add/Edit dialog so users can link a new or existing bill to the
  // envelope it should roll up into on the Budget page.
  const { data: categories } = useListCategories();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringItem | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const invalidateAll = () => {
    // Invalidate all keyed variants of the summary so a save reflects on
    // every month a user has paged through, not just the current one.
    qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey().slice(0, 1) });
    qc.invalidateQueries({ queryKey: getListRecurringItemsQueryKey() });
    invalidateForecastFamily(qc);
    qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    // Bill edits feed Budget auto-pulled lines (bills/debts → planned
    // amounts on /budget). With the global 30s staleTime we now use,
    // returning to /budget within that window would otherwise show
    // stale cached month data; invalidate every cached budget month.
    qc.invalidateQueries({
      predicate: (q) => {
        const k = q.queryKey?.[0];
        return typeof k === "string" && k.startsWith("/api/budget/months/");
      },
    });
  };

  // (#691) When the user clicks the "No category" chip on a bill row,
  // we open the edit modal and want to drop them right at the Category
  // picker (scroll it into view + focus its trigger). A simple flag
  // consumed by a post-mount effect inside the dialog is enough — we
  // clear it as soon as it's been applied so subsequent opens don't
  // re-focus the picker unexpectedly.
  const [focusCategoryOnOpen, setFocusCategoryOnOpen] = useState(false);

  // (#691) After the edit dialog mounts with focusCategoryOnOpen set
  // (i.e. the user clicked the "No category" chip), wait a tick for
  // the dialog's enter animation to commit so the trigger is actually
  // in the DOM, then scroll the Category select into view and focus
  // it. Cleared via the `if (!open) setFocusCategoryOnOpen(false)`
  // branch on the Dialog's onOpenChange.
  useEffect(() => {
    if (!dialogOpen || !focusCategoryOnOpen) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById("bill-category");
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        (el as HTMLElement).focus();
      }
      setFocusCategoryOnOpen(false);
    }, 50);
    return () => window.clearTimeout(t);
  }, [dialogOpen, focusCategoryOnOpen]);

  const openNew = () => {
    setEditing(null);
    setForm({ ...DEFAULT_FORM });
    setDialogOpen(true);
  };
  const openEdit = (
    item: RecurringItem,
    opts?: { focus?: "category" },
  ) => {
    setEditing(item);
    setForm(toFormState(item));
    setFocusCategoryOnOpen(opts?.focus === "category");
    setDialogOpen(true);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const amt = parseFloat(form.amount);
    if (!Number.isFinite(amt) || amt < 0) {
      toast({ title: "Amount must be a positive number", variant: "destructive" });
      return;
    }
    if (form.frequency === "onetime" && !form.oneTimeDate) {
      toast({ title: "Pick a date for the one-time item", variant: "destructive" });
      return;
    }
    const payload = buildPayload(form);
    if (editing) {
      updateItem.mutate(
        { id: editing.id, data: payload },
        {
          onSuccess: () => {
            invalidateAll();
            setDialogOpen(false);
            toast({ title: "Saved" });
          },
        },
      );
    } else {
      createItem.mutate(
        { data: payload },
        {
          onSuccess: () => {
            invalidateAll();
            setDialogOpen(false);
            toast({ title: "Added" });
          },
        },
      );
    }
  };

  const onToggleActive = (item: RecurringItem) => {
    const nextActive = !isActive(item);
    setTogglingId(item.id);
    const payload: RecurringItemInput = {
      name: item.name,
      kind: item.kind,
      amount: item.amount,
      frequency: item.frequency,
      active: nextActive ? "true" : "false",
      dayOfMonth: item.dayOfMonth ?? null,
      anchorDate: item.anchorDate ?? null,
      // (#690) Preserve the Budget-category and debt linkage when
      // pausing/resuming an item — otherwise toggling would silently
      // unlink the bill from its envelope (and from any backing debt).
      categoryId: item.categoryId ?? null,
      debtId: item.debtId ?? null,
    };
    updateItem.mutate(
      { id: item.id, data: payload },
      {
        onSuccess: () => {
          invalidateAll();
          toast({ title: nextActive ? "Resumed" : "Paused" });
        },
        onSettled: () => {
          setTogglingId((cur) => (cur === item.id ? null : cur));
        },
      },
    );
  };

  const deleteRecurring = (item: RecurringItem, opts?: { closeDialog?: boolean }) => {
    if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    deleteItem.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          invalidateAll();
          if (opts?.closeDialog) setDialogOpen(false);
          toast({ title: "Deleted" });
        },
      },
    );
  };

  const onDelete = () => {
    if (!editing) return;
    deleteRecurring(editing, { closeDialog: true });
  };

  const onDeleteRow = (item: RecurringItem) => {
    deleteRecurring(item);
  };

  // Run the same avalanche simulation the Forecast uses so Bills hides debt
  // minimum rows whose next due date is past the avalanche-predicted payoff
  // month. Keeps Bills and Forecast in agreement on which debts are still alive.
  const strategy: Strategy = (avaSettings?.strategy as Strategy) ?? "avalanche";
  const extraPerMonth = useMemo(() => {
    const r = Number(resolvedExtra?.amount);
    if (Number.isFinite(r)) return r;
    return Number(avaSettings?.manualExtra ?? 0) || 0;
  }, [resolvedExtra?.amount, avaSettings?.manualExtra]);

  const payoffsByDebt = useMemo(() => {
    // (C10) `debtToSim` nets tagged-unposted payments. Inline and raw, this
    // sim disagreed with the Avalanche page about when each debt dies, so a
    // debt-minimum row could keep showing here for months after /avalanche had
    // already called it paid off — the opposite of the "Bills and Forecast
    // agree on which debts are still alive" promise above.
    const simDebts: SimDebt[] = (debts ?? []).map(debtToSim);
    const sim = simulate({ debts: simDebts, extraPerMonth, strategy });
    return computePayoffsByDebt(sim);
  }, [debts, extraPerMonth, strategy]);

  const archivedDebtsList = useMemo(
    () => (debts ?? []).filter((d) => d.status === "archived"),
    [debts],
  );

  // #70 — pull all transactions to compute actual income/spend this month.
  // (Final wrapper · perf) Scope the actuals pull to the SELECTED month instead
  // of the banned unbounded limit:5000 all-history fetch — actualThisMonth only
  // sums this month. Bounded window + small limit; same computed result.
  const _actualsFrom = currentMonth;
  const _actualsTo = (() => {
    const [y, mo] = currentMonth.split("-").map(Number);
    const last = new Date(y, mo, 0); // day 0 of next month = last day of this one
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
  })();
  const { data: allTxns } = useListTransactions({
    from: _actualsFrom,
    to: _actualsTo,
    limit: 500,
  });

  // #70 — real spend amounts. Compare planned ("Per month") against what
  // actually happened so far this calendar month: sum positive amounts as
  // income and the absolute value of negatives as spend, skipping
  // transfers (already excluded from budget actuals server-side). Computed
  // here so the hook always runs before the loading-state early return
  // below — moving it after that return broke the rules of hooks.
  const actualThisMonth = useMemo(() => {
    const [yStr, mStr] = currentMonth.split("-");
    const y = Number(yStr);
    const m = Number(mStr) - 1;
    const monthStart = currentMonth;
    const next = new Date(y, m + 1, 1);
    const monthEnd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
    let income = 0;
    let spend = 0;
    for (const t of allTxns ?? []) {
      if (t.occurredOn < monthStart || t.occurredOn >= monthEnd) continue;
      if (t.isTransfer) continue;
      const a = Number(t.amount);
      if (!Number.isFinite(a)) continue;
      if (a > 0) income += a;
      else spend += -a;
    }
    return { income, spend, net: income - spend };
  }, [allTxns, currentMonth]);

  const allDebtMinRows = summary?.debtMins ?? [];
  const debtMinRows = useMemo(
    () => filterDebtMinRowsByPayoff(allDebtMinRows, payoffsByDebt),
    [allDebtMinRows, payoffsByDebt],
  );

  // Gate on data only — global keepPreviousData keeps the previous
  // month's summary visible during refetches so we never flash a
  // skeleton after the first load.
  if (!summary) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const incomeRows = summary.income;
  // Sort Bills & Expenses by next-occurrence date so the list reads
  // chronologically (earliest upcoming first) instead of alphabetically.
  // Rows without a nextOccurrence (e.g. paused items) sort to the end,
  // tiebreaking by name to keep the order stable.
  const billRows = [...summary.bills].sort((a, b) => {
    const ad = a.nextOccurrence ?? "";
    const bd = b.nextOccurrence ?? "";
    if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : a.item.name.localeCompare(b.item.name);
    if (ad) return -1;
    if (bd) return 1;
    return a.item.name.localeCompare(b.item.name);
  });
  const incomeMonthly = Number(summary.monthly.income) || 0;
  const billsMonthly = Number(summary.monthly.bills) || 0;
  const activeCount = summary.monthly.active;

  const debtMin = debtMinRows.reduce(
    (s, r) => s + Math.abs(Number(r.amount) || 0),
    0,
  );
  const totalOutflow = billsMonthly + debtMin;
  const net = incomeMonthly - totalOutflow;
  const committedPct =
    incomeMonthly > 0 ? Math.round((totalOutflow / incomeMonthly) * 100) : 0;

  // #303 — actual-so-far totals per group, mirroring the per-row
  // "$X paid / $X so far" labels. Sum BillsSummaryRow.actualAmount across
  // active items only, matching how monthly planned totals exclude paused
  // items (see api-server bills route).
  const sumActiveActual = (rows: BillsSummaryRow[]) =>
    rows.reduce(
      (s, r) =>
        isActive(r.item) ? s + (Number(r.actualAmount) || 0) : s,
      0,
    );
  const incomeActual = sumActiveActual(incomeRows);
  const billsActual = sumActiveActual(billRows);

  // Weekly-first lead: exactly what's due in the selected window (this week by
  // default). Same expressions as before, hoisted out of the JSX so the
  // headline Stat can quote the total the list below sums to.
  const dueRange = rangeForMode(dueMode);
  const dueRows = billRows.filter(
    (r) =>
      r.nextOccurrence &&
      r.nextOccurrence >= dueRange.from &&
      r.nextOccurrence <= dueRange.to,
  );
  const dueTotal = dueRows.reduce(
    (s, r) => s + Math.abs(Number(r.item.amount) || 0),
    0,
  );
  const windowWord =
    dueMode === "wk" ? "this week" : dueMode === "mo" ? "this month" : "this year";

  return (
    <div className="space-y-5">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* ⚠️ EXACTLY "Bills". Five e2e specs gate on
            getByRole("heading", { name: /^bills$/i }), and four more on the
            loose /bills/i — which is also why no other heading on this page may
            contain the word. */}
        <h1 className="text-display font-semibold text-brand-navy">Bills</h1>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-control bg-white px-1 py-0.5 ring-1 ring-brand-line">
            <button
              type="button"
              className={btnLink}
              onClick={() => changeMonth(-1)}
              disabled={atFloor}
              aria-disabled={atFloor}
              aria-label="Previous month"
              title={atFloor ? "April 2026 is the earliest month" : undefined}
              data-testid="button-prev-month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span
              className="w-32 text-center text-label font-semibold text-brand-navy"
              data-testid="text-current-month"
            >
              {monthName}
            </span>
            <button
              type="button"
              className={btnLink}
              onClick={() => changeMonth(1)}
              aria-label="Next month"
              data-testid="button-next-month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            className={btn}
            onClick={openNew}
            data-testid="button-add-bill"
          >
            <Plus className="mr-1 inline h-4 w-4 align-[-2px]" />
            Add
          </button>
        </div>
      </div>

      {/* ── Headline ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3">
        <Stat
          index={0}
          label={`Due ${windowWord}`}
          value={formatCurrency(dueTotal)}
          hint={`${dueRows.length} item${dueRows.length === 1 ? "" : "s"} · ${dueRange.label}`}
        />
        <Stat
          index={1}
          label={net >= 0 ? "Net this month" : "Net · short"}
          value={formatCurrency(net)}
          tone={net >= 0 ? "ok" : "bad"}
          hint={`${committedPct}% of income committed`}
        />
        <Stat
          index={2}
          label="Active items"
          value={activeCount}
          hint="income + bills"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* ── Due window ───────────────────────────────────────────────── */}
          <div className={card} data-testid="bills-due-lead">
            <div className={cardHead}>
              <div className="text-label font-semibold text-brand-navy">
                Due {windowWord}
              </div>
              <Help>
                {`Recurring bills whose next occurrence lands inside ${dueRange.label}. Debt minimums are listed separately below.`}
              </Help>
              {/* ⚠️ `-my-1` is an optical correction, not a nudge: the
                  segmented control is taller than a line of head text, and
                  without it this card's head grows ~6px and its title stops
                  sharing a baseline with the sibling card beside it. */}
              <TimeRangeToggle
                value={dueMode}
                onChange={setDueMode}
                className="-my-1 ml-auto"
              />
            </div>
            {dueRows.length ? (
              <div className={scrollX}>
              <table className="w-full min-w-[22rem]">
                <thead>
                  <tr>
                    <th className={th}>Due</th>
                    <th className={th}>Item</th>
                    <th className={`${th} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {dueRows.map((r) => (
                    <tr key={r.item.id}>
                      <td className={`${td} w-px`}>
                        <DueCell iso={r.nextOccurrence} />
                      </td>
                      <td className={td}>
                        <span className="block max-w-[26rem] truncate">
                          {r.item.name}
                        </span>
                      </td>
                      <td className={`${tdNum} whitespace-nowrap`}>
                        −{formatCurrency(Math.abs(Number(r.item.amount) || 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <p className={emptyNote}>Nothing due {windowWord}</p>
            )}
          </div>

          <BillsHealthCheck summary={summary} />

          <BillGroupCard
            title="Income"
            total={incomeMonthly}
            tone="income"
            rows={incomeRows}
            onEdit={openEdit}
            onToggleActive={onToggleActive}
            onDeleteRow={onDeleteRow}
            togglingId={updateItem.isPending ? togglingId : null}
            categories={categories ?? []}
            debts={debts ?? []}
          />
          <BillGroupCard
            title="Bills & Expenses"
            total={billsMonthly}
            tone="bill"
            rows={billRows}
            onEdit={openEdit}
            onToggleActive={onToggleActive}
            onDeleteRow={onDeleteRow}
            togglingId={updateItem.isPending ? togglingId : null}
            categories={categories ?? []}
            debts={debts ?? []}
          />
          {debtMinRows.length > 0 ? (
            <DebtMinimumsCard
              rows={debtMinRows}
              total={debtMin}
              onOpen={(debtId) =>
                // The synthetic "Avalanche extra payment" row uses a
                // sentinel id (not a real debt) — deep-link to the
                // Avalanche page with no focus param.
                setLocation(
                  debtId === "avalanche-extra"
                    ? "/avalanche"
                    : `/avalanche?focus=${debtId}`,
                )
              }
            />
          ) : null}
          {archivedDebtsList.length > 0 && (
            <div className={card} data-testid="card-archived-debts">
              <div className={cardHead}>
                <Lock className="h-3.5 w-3.5 text-neutral-400" aria-hidden />
                <div className="text-label font-semibold text-neutral-500">
                  Archived debts
                </div>
                <span className="chip gray">Paid off</span>
                <span className="ml-auto text-micro text-neutral-400">
                  manage on Future Goal
                </span>
              </div>
              <div className={scrollX}>
              <table className="w-full min-w-[18rem]">
                <tbody>
                  {archivedDebtsList.map((d) => (
                    <tr
                      key={d.id}
                      className="cursor-pointer hover:bg-brand-tint"
                      onClick={() => setLocation(`/avalanche?focus=${d.id}`)}
                      data-testid={`row-archived-debt-${d.id}`}
                    >
                      <td className={`${td} text-neutral-500`}>
                        {d.name}
                      </td>
                      {/* (C10) Netted — this row deep-links to /avalanche, and
                          the two screens must not quote different numbers for
                          the debt the reader just clicked. */}
                      <td className={`${tdNum} text-neutral-500`}>
                        {formatCurrency(effectiveDebtBalance(d))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </div>

        {/* ── Side column ────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className={card}>
            <div className={cardHead}>
              <div className="text-label font-semibold text-brand-navy">Per month</div>
              <Help>
                Recurring items at their monthly rate. The smaller figure beside
                income and bills is what has actually been matched to those items
                so far this month.
              </Help>
            </div>
            <div className={scrollX}><table className="w-full min-w-[20rem]">
              <tbody>
                <SummaryRow
                  label="Income"
                  amount={incomeMonthly}
                  tone="income"
                  actual={incomeActual}
                  actualTestId="text-income-actual"
                  valueTestId="text-summary-income"
                />
                <SummaryRow
                  label="Bills"
                  amount={-billsMonthly}
                  tone="bill"
                  actual={billsActual}
                  actualTestId="text-bills-actual"
                  valueTestId="text-summary-bills"
                />
                <SummaryRow label="Debt minimums" amount={-debtMin} tone="bill" />
                <SummaryRow label="Total outflow" amount={-totalOutflow} tone="bill" />
                <tr>
                  <td className={`${td} border-b-0 font-semibold text-brand-navy`}>
                    Net
                  </td>
                  <td
                    className={`${tdNum} border-b-0 text-title font-semibold ${
                      net >= 0 ? "text-brand-navy" : "text-bad"
                    }`}
                    data-testid="text-net-monthly"
                  >
                    {net >= 0 ? "+" : ""}
                    {formatCurrency(net)}
                  </td>
                </tr>
              </tbody>
            </table></div>
          </div>

          <div className={card} data-testid="card-actual-this-month">
            <div className={cardHead}>
              <div className="text-label font-semibold text-brand-navy">Actual</div>
              <Help>
                Every real transaction in the month, not just the ones matched to
                a bill. Transfers are excluded.
              </Help>
              <span
                className="ml-auto text-micro text-neutral-400"
                data-testid="text-actual-month-label"
              >
                {new Date(currentMonth + "T00:00:00").toLocaleDateString("en-US", {
                  month: "long",
                })}{" "}
                so far
              </span>
            </div>
            <div className={scrollX}><table className="w-full min-w-[20rem]">
              <tbody>
                <SummaryRow
                  label="Income"
                  amount={actualThisMonth.income}
                  tone="income"
                  valueTestId="text-actual-income"
                />
                <SummaryRow
                  label="Spend"
                  amount={-actualThisMonth.spend}
                  tone="bill"
                  valueTestId="text-actual-spend"
                />
                <tr>
                  <td className={`${td} border-b-0 font-semibold text-brand-navy`}>
                    Net
                  </td>
                  <td
                    className={`${tdNum} border-b-0 text-title font-semibold ${
                      actualThisMonth.net >= 0 ? "text-brand-navy" : "text-bad"
                    }`}
                    data-testid="text-actual-net"
                  >
                    {actualThisMonth.net >= 0 ? "+" : ""}
                    {formatCurrency(actualThisMonth.net)}
                  </td>
                </tr>
              </tbody>
            </table></div>
            <Foot>Real transactions, transfers excluded.</Foot>
          </div>

          <Link href="/forecast" className={`${card} block`}>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <div className={fieldLabel}>Next</div>
                <div className="text-body font-semibold text-brand-navy">
                  Cash forecast
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-neutral-400" />
            </div>
          </Link>
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          // (#691) Clear the focus-on-open intent whenever the dialog
          // closes so the next plain "edit" doesn't auto-focus the
          // Category picker out of context.
          if (!open) setFocusCategoryOnOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit item" : "Add income or bill"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-1">
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    kind: "income",
                    // (#690) Clear any previously chosen expense category
                    // so we never persist a mismatched category_id when
                    // the user flips the bill kind after picking one.
                    categoryId: "",
                  }))
                }
                className={
                  form.kind === "income"
                    ? "press rounded-control bg-brand-navy px-3 py-2 text-body font-medium text-white"
                    : "press rounded-control bg-white px-3 py-2 text-body font-medium text-neutral-600 ring-1 ring-brand-line hover:bg-neutral-50"
                }
                aria-pressed={form.kind === "income"}
                data-testid="toggle-income"
              >
                Income
              </button>
              <button
                type="button"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    kind: "bill",
                    // (#690) Same guard as the Income button — drop any
                    // income-side category selection when flipping to a
                    // bill so buildPayload can't ship a mismatched id.
                    categoryId: "",
                  }))
                }
                className={
                  form.kind === "bill"
                    ? "press rounded-control bg-brand-navy px-3 py-2 text-body font-medium text-white"
                    : "press rounded-control bg-white px-3 py-2 text-body font-medium text-neutral-600 ring-1 ring-brand-line hover:bg-neutral-50"
                }
                aria-pressed={form.kind === "bill"}
                data-testid="toggle-bill"
              >
                Bill
              </button>
            </div>

            <Field label="Name">
              <input
                id="bill-name"
                className={input}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={form.kind === "income" ? "Paycheck" : "Electric bill"}
                data-testid="input-name"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount">
                <input
                  id="bill-amount"
                  className={input}
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-amount"
                />
              </Field>
              <Field label="Frequency">
                <Select
                  value={form.frequency}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, frequency: v as Frequency }))
                  }
                >
                  <SelectTrigger className={input} data-testid="select-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Bi-weekly</SelectItem>
                    <SelectItem value="semimonthly">Semi-monthly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="onetime">One time</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {form.frequency === "monthly" || form.frequency === "semimonthly" ? (
              <Field label="Day of month">
                <input
                  id="bill-day"
                  className={input}
                  type="number"
                  min="1"
                  max="31"
                  value={form.dayOfMonth}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dayOfMonth: e.target.value }))
                  }
                  data-testid="input-day-of-month"
                />
              </Field>
            ) : form.frequency === "onetime" ? (
              <Field label="Date">
                <input
                  id="bill-onetime-date"
                  className={input}
                  type="date"
                  value={form.oneTimeDate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, oneTimeDate: e.target.value }))
                  }
                  data-testid="input-onetime-date"
                />
              </Field>
            ) : (
              <Field label="First occurrence">
                <input
                  id="bill-anchor"
                  className={input}
                  type="date"
                  value={form.anchorDate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, anchorDate: e.target.value }))
                  }
                  data-testid="input-anchor-date"
                />
              </Field>
            )}

            {/* (#690) Category picker — links this bill/income item to a
                Budget envelope. The Budget page's bill-rollup sums every
                active recurring item linked to a category into that
                envelope's planned amount. Options are filtered by kind
                (income ↔ expense) and grouped by their Budget group so
                the list reads the same as on the Budget page. */}
            {(() => {
              const wantKind = form.kind === "income" ? "income" : "expense";
              const eligible = (categories ?? []).filter(
                // Task #690 — also exclude the "My budget" group: that bucket is
                // for personal envelopes explicitly NOT tied to a bill, so a bill
                // must never be able to link into it. Server-side guard in
                // /api/recurring-items enforces the same rule.
                (c) =>
                  c.kind === wantKind &&
                  !c.excludeFromBudget &&
                  c.groupName !== MY_BUDGET_GROUP,
              );
              const grouped = new Map<string, typeof eligible>();
              for (const c of eligible) {
                const arr = grouped.get(c.groupName) ?? [];
                arr.push(c);
                grouped.set(c.groupName, arr);
              }
              for (const arr of grouped.values()) {
                arr.sort(
                  (a, b) =>
                    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
                );
              }
              // Bills auto-linked to a debt take their Budget category
              // from the debt's matched "Debt — Minimum Payments" row,
              // not from this picker. Keep the dropdown visible (so the
              // user sees what's wired) but read-only with a hint.
              const debtLinked = !!editing?.debtId;
              return (
                <Field label="Category">
                  <Select
                    value={form.categoryId ? form.categoryId : NO_CATEGORY}
                    onValueChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        categoryId: v === NO_CATEGORY ? "" : v,
                      }))
                    }
                    disabled={debtLinked}
                  >
                    <SelectTrigger
                      id="bill-category"
                      className={input}
                      data-testid="select-category"
                    >
                      <SelectValue placeholder="— None —" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NO_CATEGORY} data-testid="select-category-none">
                        — None —
                      </SelectItem>
                      {Array.from(grouped.entries()).map(([groupName, cats]) => (
                        <SelectGroup key={groupName}>
                          <SelectLabel className={`px-2 pb-1 pt-2 ${fieldLabel}`}>
                            {groupName}
                          </SelectLabel>
                          {cats.map((c) => (
                            <SelectItem
                              key={c.id}
                              value={c.id}
                              data-testid={`select-category-option-${c.id}`}
                            >
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* ⚠️ These two captions are MUTUALLY EXCLUSIVE and an e2e spec
                      asserts it: when the item is debt-linked the envelope
                      sentence must have count 0 on the page. */}
                  {debtLinked ? (
                    <p className="text-micro text-neutral-500">
                      Linked to a debt — category comes from its Debt — Minimum
                      Payments row.
                    </p>
                  ) : (
                    <p className="text-micro text-neutral-500">
                      Pick an envelope to roll this item into on the Budget page.
                    </p>
                  )}
                </Field>
              );
            })()}

            <label className="mb-3 flex items-center gap-2 text-body text-neutral-700">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                data-testid="checkbox-active"
              />
              Active
            </label>

            <DialogFooter className="!justify-between gap-2">
              {editing ? (
                <button
                  type="button"
                  className={btnDanger}
                  onClick={onDelete}
                  data-testid="button-delete"
                >
                  Delete
                </button>
              ) : (
                <span />
              )}
              <button
                type="submit"
                className={btn}
                disabled={createItem.isPending || updateItem.isPending}
                data-testid="button-save"
              >
                {editing ? "Save changes" : "Add item"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One line of the Per month / Actual tables.
 *
 * ⚠️ THE SIGN LOGIC IS PINNED BY E2E. `text-summary-bills` reads "-$300.00"
 * (ASCII hyphen, from Intl) while the group-card totals read "−$300.00"
 * (U+2212, an explicit sign character). Both are asserted with exact-text
 * matchers, so neither may be "tidied" into the other.
 */
function SummaryRow({
  label,
  amount,
  tone,
  actual,
  actualTestId,
  valueTestId,
}: {
  label: string;
  amount: number;
  tone: "income" | "bill";
  actual?: number;
  actualTestId?: string;
  valueTestId?: string;
}) {
  const positive = amount >= 0;
  const sign = positive && tone === "income" ? "+" : "";
  return (
    <tr>
      <td className={`${td} whitespace-nowrap text-neutral-500`}>{label}</td>
      <td className={`${tdNum} whitespace-nowrap`}>
        <span data-testid={valueTestId}>
          {sign}
          {formatCurrency(amount)}
        </span>
        {actual !== undefined ? (
          <span
            className="ml-1.5 text-micro text-neutral-400"
            data-testid={actualTestId}
            title={`${formatCurrency(actual)} actual so far this month`}
          >
            / {formatCurrency(actual)} so far
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function BillGroupCard({
  title,
  total,
  tone,
  rows,
  onEdit,
  onToggleActive,
  onDeleteRow,
  togglingId,
  categories,
  debts,
}: {
  title: string;
  total: number;
  tone: "income" | "bill";
  rows: BillsSummaryRow[];
  onEdit: (item: RecurringItem, opts?: { focus?: "category" }) => void;
  onToggleActive: (item: RecurringItem) => void;
  onDeleteRow: (item: RecurringItem) => void;
  togglingId: string | null;
  categories: Category[];
  debts: Debt[];
}) {
  // (#691) Index categories/debts by id so each row can resolve its
  // chip in O(1) instead of scanning the list per render. Rows whose
  // categoryId points at a deleted category (stale link after the
  // category was removed) simply skip the chip — never crash.
  const categoryById = useMemo(() => {
    const m = new Map<string, Category>();
    for (const c of categories) m.set(c.id, c);
    return m;
  }, [categories]);
  const debtById = useMemo(() => {
    const m = new Map<string, Debt>();
    for (const d of debts) m.set(d.id, d);
    return m;
  }, [debts]);
  const sign = tone === "income" ? "+" : "−";

  return (
    <div className={card}>
      {/* ⚠️ The title is a <div>, not a heading: four e2e specs match
          getByRole("heading", { name: /bills/i }) and a second heading
          containing "Bills" would be a strict-mode violation. */}
      <div className={cardHead}>
        <div className="text-label font-semibold text-brand-navy">{title}</div>
        <span className="text-micro text-neutral-400">
          {rows.length} item{rows.length === 1 ? "" : "s"}
        </span>
        <span
          className="ml-auto font-mono text-label font-semibold tabular-nums text-brand-navy"
          data-testid={`text-group-total-${tone}`}
        >
          {sign}
          {formatCurrency(total)}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className={emptyNote}>No {title.toLowerCase()} yet</p>
      ) : (
        <div className={scrollX}>
          <table className="w-full min-w-[26rem]">
            <thead>
              <tr>
                <th className={th}>Due</th>
                <th className={th}>Item</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={`${th} text-right`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, nextOccurrence, monthlyAmount, actualAmount }) => {
                const active = isActive(item);
                // (#691) Resolve the chip shown under the row name so users
                // can see at a glance which Budget envelope this item feeds.
                // Debt-linked bills are driven by the Debt Tracker (their
                // category comes from the matching Debt — Minimum Payments
                // row), so we mark them with a lock + the debt's name.
                // Plain categorized bills show the envelope name.
                // Uncategorized bills surface a muted "No category" hint that
                // opens the edit modal so the wiring is one click away.
                const linkedDebt = item.debtId ? debtById.get(item.debtId) : null;
                const linkedCategory = item.categoryId
                  ? categoryById.get(item.categoryId)
                  : null;
                const amt = Number(monthlyAmount) || 0;
                const actual = Number(actualAmount) || 0;
                // (#413) Display the per-event amount the user entered (e.g.
                // "+$4,050.00 biweekly") instead of the smoothed monthly
                // projection. The badge below still compares actual vs.
                // monthlyAmount so paid/partial status is unchanged.
                const perEvent = Number(item.amount) || 0;
                // (#492) Use the API's calendar-expanded monthlyAmount for the
                // hint so it always equals the Budget page's "Budgeted" column
                // for the same line and same viewed month (e.g. a 3-paycheck
                // biweekly month shows the 3× total, not the smoothed 26/12).
                const display = formatBillRowAmount(perEvent, item.frequency, sign, amt);
                // (#70) Status of the actual vs. planned amount this month.
                // - "paid": actual covers ≥99% of planned (a small float fudge)
                // - "partial": some money has moved but not the full plan
                // - "none": nothing matched yet — keep the row neutral
                const planned = amt;
                const ratio = planned > 0 ? actual / planned : actual > 0 ? 1 : 0;
                const status: "paid" | "partial" | "none" =
                  actual <= 0
                    ? "none"
                    : ratio >= 0.99
                      ? "paid"
                      : "partial";
                return (
                  <tr
                    key={item.id}
                    className="cursor-pointer hover:bg-brand-tint"
                    onClick={() => onEdit(item)}
                    data-testid={`row-bill-${item.id}`}
                  >
                    <td className={`${td} w-px align-top`}>
                      <DueCell iso={nextOccurrence} />
                    </td>
                    {/* ⚠️ NOT `max-w-0`. The usual table truncation trick
                        collapses this cell's flex rows and chews the frequency
                        label down to "monthly · …"; the name gets a bounded
                        width of its own instead, and the meta line never
                        truncates. */}
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <span
                          className={`max-w-[26rem] truncate font-medium ${
                            active ? "text-brand-ink" : "text-neutral-400 line-through"
                          }`}
                        >
                          {item.name}
                        </span>
                        {!active && <span className="chip gray">Paused</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-micro text-neutral-400">
                        <span className="whitespace-nowrap">{frequencyLabel(item)}</span>
                        {linkedDebt ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-600"
                            title="Managed by the Debt Tracker — category comes from the matching Debt — Minimum Payments row."
                            data-testid={`chip-category-${item.id}`}
                          >
                            <Lock className="h-3 w-3" aria-hidden />
                            Debt · {linkedDebt.name}
                          </span>
                        ) : linkedCategory ? (
                          // ⚠️ EXACTLY ONE TEXT NODE. A unit test asserts
                          // textContent === the category name, so no icon, no
                          // group prefix, no separator may live in here.
                          <span
                            className="inline-flex shrink-0 items-center rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-600"
                            title={`${linkedCategory.groupName} · ${linkedCategory.name}`}
                            data-testid={`chip-category-${item.id}`}
                          >
                            {linkedCategory.name}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="press shrink-0 rounded-full border border-dashed border-brand-line px-2 py-0.5 text-neutral-500 hover:border-brand-navy/40 hover:text-brand-navy"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEdit(item, { focus: "category" });
                            }}
                            title="Link this bill to a Budget category"
                            data-testid={`chip-category-none-${item.id}`}
                          >
                            No category
                          </button>
                        )}
                      </div>
                    </td>
                    <td className={`${tdNum} whitespace-nowrap align-top`}>
                      <div className="font-semibold text-brand-navy">
                        {display.amountText}
                      </div>
                      {display.monthlyHint ? (
                        <div className="text-micro text-neutral-400">
                          {display.monthlyHint}
                        </div>
                      ) : null}
                      {/* ⚠️ E2E pins the trailing words ("paid" / "so far"), the
                          title sentences, AND the icon count: paid has exactly
                          one <svg>, partial has none. */}
                      {active && status !== "none" ? (
                        <div
                          className={`flex items-center justify-end gap-1 text-micro ${
                            status === "paid" ? "text-brand-navy" : "text-neutral-500"
                          }`}
                          data-testid={`text-actual-${item.id}`}
                          title={
                            status === "paid"
                              ? `Paid ${formatCurrency(actual)} of ${formatCurrency(planned)} planned`
                              : `Partial — ${formatCurrency(actual)} of ${formatCurrency(planned)} planned`
                          }
                        >
                          {status === "paid" ? (
                            <Check className="h-3 w-3" aria-hidden />
                          ) : null}
                          {status === "paid"
                            ? `${formatCurrency(actual)} paid`
                            : `${formatCurrency(actual)} so far`}
                        </div>
                      ) : null}
                    </td>
                    <td className={`${td} w-px whitespace-nowrap align-top text-right`}>
                      <span className="inline-flex gap-1">
                        <button
                          type="button"
                          className={btnLink}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleActive(item);
                          }}
                          disabled={togglingId === item.id}
                          aria-label={active ? `Pause ${item.name}` : `Resume ${item.name}`}
                          title={active ? "Pause" : "Resume"}
                          data-testid={`button-toggle-active-${item.id}`}
                        >
                          {active ? (
                            <Pause className="h-3.5 w-3.5" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          className={btnLink}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(item);
                          }}
                          aria-label={`Edit ${item.name}`}
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className={btnLinkDanger}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteRow(item);
                          }}
                          aria-label={`Delete ${item.name}`}
                          title="Delete"
                          data-testid={`button-delete-row-${item.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DebtMinimumsCard({
  rows,
  total,
  onOpen,
}: {
  rows: BillsDebtMinRow[];
  total: number;
  onOpen: (debtId: string) => void;
}) {
  return (
    <div className={card} data-testid="card-debt-minimums">
      <div className={cardHead}>
        <Lock className="h-3.5 w-3.5 text-neutral-400" aria-hidden />
        <div className="text-label font-semibold text-brand-navy">Debt minimums</div>
        <Help>
          Synced from Debts and edited on Future Goal, never here. Each minimum
          stops on the month the avalanche pays that debt off.
        </Help>
        <span className="ml-auto font-mono text-label font-semibold tabular-nums text-brand-navy">
          −{formatCurrency(total)}
        </span>
      </div>
      <div className={scrollX}>
      <table className="w-full min-w-[24rem]">
        <thead>
          <tr>
            <th className={th}>Due</th>
            <th className={th}>Debt</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={`${th} text-right`}>
              <span className="sr-only">Locked</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const min = Number(r.minPayment) || 0;
            const amt = Math.abs(Number(r.amount) || 0);
            const endsThisCycle = r.endsThisCycle === true;
            if (endsThisCycle) {
              return (
                <tr
                  key={r.debtId}
                  className="cursor-pointer hover:bg-brand-tint"
                  onClick={() => onOpen(r.debtId)}
                  data-testid={`row-debt-min-paid-${r.debtId}`}
                >
                  {/* ⚠️ The date column stays a date column. Putting the chip
                      here instead widened it for every row in the table and
                      knocked the Debt column out of line with the bill tables
                      above. */}
                  <td className={`${td} w-px`}>
                    <DueCell iso={r.nextOccurrence ?? null} />
                  </td>
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <span className="truncate text-neutral-500 line-through">
                        {r.debtName} minimum
                      </span>
                      <span className="chip ok">Paid off</span>
                    </div>
                    <div className="mt-0.5 truncate text-micro text-neutral-500">
                      Stops at payoff · was {formatCurrency(min)}/mo
                    </div>
                  </td>
                  <td className={`${tdNum} text-neutral-400 line-through`}>
                    −{formatCurrency(min)}
                  </td>
                  <td className={`${td} w-px text-right`}>
                    <Lock
                      className="inline h-3.5 w-3.5 text-neutral-400"
                      aria-label="Locked — managed by Debts"
                    />
                  </td>
                </tr>
              );
            }
            return (
              <tr
                key={r.debtId}
                className="cursor-pointer hover:bg-brand-tint"
                onClick={() => onOpen(r.debtId)}
                data-testid={`row-debt-min-${r.debtId}`}
              >
                <td className={`${td} w-px`}>
                  <DueCell iso={r.nextOccurrence ?? null} />
                </td>
                <td className={td}>
                  <div className="truncate text-brand-ink">{r.debtName} minimum</div>
                  <div className="mt-0.5 truncate text-micro text-neutral-400">
                    min {formatCurrency(min)}/mo · stops at payoff
                    {r.source === "plaid" ? " · synced from Plaid" : ""}
                  </div>
                </td>
                <td className={tdNum}>−{formatCurrency(amt)}</td>
                <td className={`${td} w-px text-right`}>
                  <Lock
                    className="inline h-3.5 w-3.5 text-neutral-400"
                    aria-label="Locked — managed by Debts"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
