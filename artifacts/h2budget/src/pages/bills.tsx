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
import { BillsHealthCheck } from "@/components/bills-health-check";
import { formatBillRowAmount } from "@/lib/billsRowAmount";
import { computePayoffsByDebt, filterDebtMinRowsByPayoff } from "@/lib/forecastDebts";
import { Lock, PartyPopper } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
  ArrowDownCircle,
  ArrowUpCircle,
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
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";

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

function metaLine(item: RecurringItem): string {
  const left = frequencyLabel(item);
  const right = item.kind === "income" ? "Income" : "Bill";
  return `${left} · ${right}`;
}

const isActive = (item: RecurringItem): boolean => item.active === "true";

// Task #690 — name of the dedicated manual bucket on /budget. Bills must
// never auto-link into "My budget" (it's the home for personal envelopes
// that are explicitly NOT tied to a bill), so the Bills modal filters
// these categories out of the picker entirely. Keep this in lockstep
// with `MY_BUDGET_GROUP` on the server (api-server/src/routes/budget.ts)
// and the frontend Budget page.
const MY_BUDGET_GROUP = "My budget";


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
    setLocation(`/bills?${params.toString()}`, { replace: true });
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
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
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
    const simDebts: SimDebt[] = (debts ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      apr: Number(d.apr),
      balance: Number(d.balance),
      minPayment: Number(d.minPayment),
      status: d.status,
    }));
    const sim = simulate({ debts: simDebts, extraPerMonth, strategy });
    return computePayoffsByDebt(sim);
  }, [debts, extraPerMonth, strategy]);

  const archivedDebtsList = useMemo(
    () => (debts ?? []).filter((d) => d.status === "archived"),
    [debts],
  );

  // #70 — pull all transactions to compute actual income/spend this month.
  const { data: allTxns } = useListTransactions({ limit: 5000 });

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
        <Skeleton className="h-10 w-48" />
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div>
          <h1 className="text-[1.75rem] font-semibold tracking-tight text-foreground tracking-tight">
            Bills
          </h1>
          <p className="text-muted-foreground mt-1">
            Every recurring dollar in and out. Edits here flow into the Forecast.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-4 bg-card px-4 py-2 rounded-md shadow-sm border border-border">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => changeMonth(-1)}
              disabled={atFloor}
              aria-disabled={atFloor}
              title={atFloor ? "April 2026 is the earliest month" : undefined}
              data-testid="button-prev-month"
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <span
              className="font-medium text-lg w-32 text-center"
              data-testid="text-current-month"
            >
              {monthName}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => changeMonth(1)}
              data-testid="button-next-month"
            >
              <ChevronRight className="w-5 h-5" />
            </Button>
          </div>
          <Button onClick={openNew} data-testid="button-add-bill">
            <Plus className="w-4 h-4 mr-2" /> Add income or bill
          </Button>
        </div>
      </div>

      <BillsHealthCheck summary={summary} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
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
            <Card data-testid="card-archived-debts">
              <CardContent className="p-0">
                <div className="px-5 py-4 flex items-center justify-between border-b border-border">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                      <Lock className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="text-base font-serif font-semibold text-muted-foreground">
                        Archived debts
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {archivedDebtsList.length} paid off · manage on Avalanche
                      </div>
                    </div>
                  </div>
                </div>
                <ul className="divide-y divide-border">
                  {archivedDebtsList.map((d) => (
                    <li
                      key={d.id}
                      className="px-5 py-3 flex items-center gap-4 opacity-60 cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => setLocation(`/avalanche?focus=${d.id}`)}
                      data-testid={`row-archived-debt-${d.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate text-muted-foreground line-through">
                          {d.name}
                        </div>
                      </div>
                      <div className="text-sm tabular-nums text-muted-foreground">
                        {formatCurrency(d.balance)}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                Per month
              </div>
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
              <div className="border-t pt-3 space-y-3">
                <SummaryRow label="Total outflow" amount={-totalOutflow} tone="bill" />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">Net</span>
                  <span
                    className={`text-lg font-serif font-bold tabular-nums ${net >= 0 ? "text-emerald-700" : "text-destructive"}`}
                    data-testid="text-net-monthly"
                  >
                    {net >= 0 ? "+" : ""}
                    {formatCurrency(net)}
                  </span>
                </div>
              </div>
              <div className="text-xs text-muted-foreground border-t pt-3">
                {activeCount} active item{activeCount === 1 ? "" : "s"}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-actual-this-month">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                  Actual this month
                </div>
                <div
                  className="text-[10px] text-muted-foreground"
                  data-testid="text-actual-month-label"
                >
                  {new Date(currentMonth + "T00:00:00").toLocaleDateString(
                    "en-US",
                    { month: "long" },
                  )}{" "}
                  so far
                </div>
              </div>
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
              <div className="border-t pt-3 flex items-center justify-between">
                <span className="text-sm font-semibold">Net</span>
                <span
                  className={`text-lg font-serif font-bold tabular-nums ${actualThisMonth.net >= 0 ? "text-emerald-700" : "text-destructive"}`}
                  data-testid="text-actual-net"
                >
                  {actualThisMonth.net >= 0 ? "+" : ""}
                  {formatCurrency(actualThisMonth.net)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground border-t pt-3">
                Real transactions, transfers excluded.
              </div>
            </CardContent>
          </Card>

          <Link href="/forecast" className="block group">
            <Card className="hover:border-primary/50 transition-colors cursor-pointer">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                    Next
                  </div>
                  <div className="text-sm font-semibold text-foreground">
                    See cash forecast
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
              </CardContent>
            </Card>
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
            <DialogTitle>
              {editing ? "Edit item" : "Add income or bill"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
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
                className={`px-3 py-2 rounded-md border text-sm font-medium flex items-center justify-center gap-2 transition-colors ${form.kind === "income" ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-border text-muted-foreground hover:bg-muted"}`}
                data-testid="toggle-income"
              >
                <ArrowUpCircle className="w-4 h-4" /> Income
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
                className={`px-3 py-2 rounded-md border text-sm font-medium flex items-center justify-center gap-2 transition-colors ${form.kind === "bill" ? "border-rose-600 bg-rose-50 text-rose-800" : "border-border text-muted-foreground hover:bg-muted"}`}
                data-testid="toggle-bill"
              >
                <ArrowDownCircle className="w-4 h-4" /> Bill
              </button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bill-name">Name</Label>
              <Input
                id="bill-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={form.kind === "income" ? "Paycheck" : "Electric bill"}
                data-testid="input-name"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="bill-amount">Amount</Label>
                <Input
                  id="bill-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-amount"
                />
              </div>
              <div className="space-y-2">
                <Label>Frequency</Label>
                <Select
                  value={form.frequency}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, frequency: v as Frequency }))
                  }
                >
                  <SelectTrigger data-testid="select-frequency">
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
              </div>
            </div>

            {form.frequency === "monthly" || form.frequency === "semimonthly" ? (
              <div className="space-y-2">
                <Label htmlFor="bill-day">Day of month</Label>
                <Input
                  id="bill-day"
                  type="number"
                  min="1"
                  max="31"
                  value={form.dayOfMonth}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dayOfMonth: e.target.value }))
                  }
                  data-testid="input-day-of-month"
                />
              </div>
            ) : form.frequency === "onetime" ? (
              <div className="space-y-2">
                <Label htmlFor="bill-onetime-date">Date</Label>
                <Input
                  id="bill-onetime-date"
                  type="date"
                  value={form.oneTimeDate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, oneTimeDate: e.target.value }))
                  }
                  data-testid="input-onetime-date"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="bill-anchor">Anchor date (first occurrence)</Label>
                <Input
                  id="bill-anchor"
                  type="date"
                  value={form.anchorDate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, anchorDate: e.target.value }))
                  }
                  data-testid="input-anchor-date"
                />
              </div>
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
                <div className="space-y-2">
                  <Label htmlFor="bill-category">Category</Label>
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
                      data-testid="select-category"
                    >
                      <SelectValue placeholder="— None —" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem
                        value={NO_CATEGORY}
                        data-testid="select-category-none"
                      >
                        — None —
                      </SelectItem>
                      {Array.from(grouped.entries()).map(([groupName, cats]) => (
                        <SelectGroup key={groupName}>
                          <SelectLabel className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
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
                  {debtLinked ? (
                    <p className="text-xs text-muted-foreground">
                      Linked to a debt — its category comes from the
                      matching Debt — Minimum Payments row on the Budget
                      page.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Optional. Pick an envelope to roll this item into
                      on the Budget page.
                    </p>
                  )}
                </div>
              );
            })()}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) =>
                  setForm((f) => ({ ...f, active: e.target.checked }))
                }
                data-testid="checkbox-active"
              />
              Active
            </label>

            <DialogFooter className="!justify-between gap-2">
              {editing ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onDelete}
                  className="text-destructive"
                  data-testid="button-delete"
                >
                  <Trash2 className="w-4 h-4 mr-1" /> Delete
                </Button>
              ) : (
                <span />
              )}
              <Button
                type="submit"
                disabled={createItem.isPending || updateItem.isPending}
                data-testid="button-save"
              >
                {editing ? "Save changes" : "Add item"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
  const colorClass = tone === "income" ? "text-emerald-700" : "text-destructive";
  const sign = positive && tone === "income" ? "+" : "";
  return (
    <div className="flex items-center justify-between text-sm gap-3">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-2 min-w-0">
        <span
          className={`tabular-nums font-medium ${colorClass}`}
          data-testid={valueTestId}
        >
          {sign}
          {formatCurrency(amount)}
        </span>
        {actual !== undefined ? (
          <span
            className="text-[11px] tabular-nums text-muted-foreground"
            data-testid={actualTestId}
            title={`${formatCurrency(actual)} actual so far this month`}
          >
            / {formatCurrency(actual)} so far
          </span>
        ) : null}
      </div>
    </div>
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
  const Icon = tone === "income" ? ArrowUpCircle : ArrowDownCircle;
  const tint = tone === "income" ? "text-emerald-700" : "text-destructive";
  const tintBg = tone === "income" ? "bg-emerald-50" : "bg-rose-50";
  const sign = tone === "income" ? "+" : "−";

  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 py-4 flex items-center justify-between border-b border-border">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-full ${tintBg} flex items-center justify-center`}>
              <Icon className={`w-5 h-5 ${tint}`} />
            </div>
            <div>
              <div className="text-base font-serif font-semibold text-foreground">
                {title}
              </div>
              <div className="text-xs text-muted-foreground">
                {rows.length} item{rows.length === 1 ? "" : "s"} · per month
              </div>
            </div>
          </div>
          <div
            className={`text-base font-serif font-semibold tabular-nums ${tint}`}
            data-testid={`text-group-total-${tone}`}
          >
            {sign}
            {formatCurrency(total)}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No {title.toLowerCase()} yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ item, nextOccurrence, monthlyAmount, actualAmount }) => {
              const pill = formatDatePill(nextOccurrence);
              const active = isActive(item);
              // (#691) Resolve the chip shown under the row name so users
              // can see at a glance which Budget envelope this item feeds.
              // Debt-linked bills are driven by the Debt Tracker (their
              // category comes from the matching Debt — Minimum Payments
              // row), so we mark them with a lock + the debt's name.
              // Plain categorized bills show "Group · Name". Uncategorized
              // bills surface a muted "No category" hint that opens the
              // edit modal so the wiring is one click away.
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
                <li
                  key={item.id}
                  className={`px-5 py-3 flex items-center gap-4 hover:bg-muted/40 cursor-pointer transition-colors ${active ? "" : "opacity-60"}`}
                  onClick={() => onEdit(item)}
                  data-testid={`row-bill-${item.id}`}
                >
                  <div className="w-12 shrink-0 text-center">
                    {pill ? (
                      <>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                          {pill.month}
                        </div>
                        <div className="text-lg font-serif font-semibold text-foreground leading-tight">
                          {pill.day}
                        </div>
                      </>
                    ) : (
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        —
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${active ? "text-foreground" : "line-through"}`}>
                      {item.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {metaLine(item)}
                      {!active ? " · paused" : ""}
                    </div>
                    {/* (#691) Category chip — exposes the bill's Budget
                        wiring on the list itself so users don't have to
                        open the edit modal to see (or fix) it. */}
                    <div className="mt-1">
                      {linkedDebt ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                          title="Managed by the Debt Tracker — category comes from the matching Debt — Minimum Payments row."
                          data-testid={`chip-category-${item.id}`}
                        >
                          <Lock className="w-3 h-3" aria-hidden />
                          Debt · {linkedDebt.name}
                        </span>
                      ) : linkedCategory ? (
                        <span
                          className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                          data-testid={`chip-category-${item.id}`}
                        >
                          {linkedCategory.groupName} · {linkedCategory.name}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/40"
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
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <div className={`text-sm font-semibold tabular-nums ${tint}`}>
                      {display.amountText}
                    </div>
                    {display.monthlyHint ? (
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {display.monthlyHint}
                      </div>
                    ) : null}
                    {active && status !== "none" ? (
                      <div
                        className={`text-[11px] tabular-nums flex items-center gap-1 ${
                          status === "paid"
                            ? "text-emerald-700"
                            : "text-amber-600"
                        }`}
                        data-testid={`text-actual-${item.id}`}
                        title={
                          status === "paid"
                            ? `Paid ${formatCurrency(actual)} of ${formatCurrency(planned)} planned`
                            : `Partial — ${formatCurrency(actual)} of ${formatCurrency(planned)} planned`
                        }
                      >
                        {status === "paid" ? (
                          <Check className="w-3 h-3" aria-hidden />
                        ) : null}
                        {status === "paid"
                          ? `${formatCurrency(actual)} paid`
                          : `${formatCurrency(actual)} so far`}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="p-1.5 rounded hover:bg-background disabled:opacity-50"
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
                      <Pause className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <Play className="w-4 h-4 text-muted-foreground" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="p-1.5 rounded hover:bg-background"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(item);
                    }}
                    aria-label={`Edit ${item.name}`}
                  >
                    <Pencil className="w-4 h-4 text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 rounded hover:bg-background"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteRow(item);
                    }}
                    aria-label={`Delete ${item.name}`}
                    title="Delete"
                    data-testid={`button-delete-row-${item.id}`}
                  >
                    <Trash2 className="w-4 h-4 text-muted-foreground" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
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
    <Card data-testid="card-debt-minimums">
      <CardContent className="p-0">
        <div className="px-5 py-4 flex items-center justify-between border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
              <Lock className="w-4 h-4 text-muted-foreground" />
            </div>
            <div>
              <div className="text-base font-serif font-semibold text-foreground">
                Debt minimums
              </div>
              <div className="text-xs text-muted-foreground">
                {rows.length} item{rows.length === 1 ? "" : "s"} · synced from Debts ·
                edit on Avalanche
              </div>
            </div>
          </div>
          <div className="text-base font-serif font-semibold tabular-nums text-destructive">
            −{formatCurrency(total)}
          </div>
        </div>
        <ul className="divide-y divide-border">
          {rows.map((r) => {
            const pill = formatDatePill(r.nextOccurrence ?? null);
            const min = Number(r.minPayment) || 0;
            const amt = Math.abs(Number(r.amount) || 0);
            const endsThisCycle = r.endsThisCycle === true;
            if (endsThisCycle) {
              return (
                <li
                  key={r.debtId}
                  className="px-5 py-3 flex items-center gap-4 opacity-70 hover:opacity-100 hover:bg-muted/40 cursor-pointer transition-all"
                  onClick={() => onOpen(r.debtId)}
                  data-testid={`row-debt-min-paid-${r.debtId}`}
                >
                  <div className="w-12 shrink-0 text-center">
                    <PartyPopper
                      className="w-5 h-5 mx-auto text-emerald-500"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate text-muted-foreground line-through">
                      {r.debtName} minimum
                    </div>
                    <div className="text-xs text-emerald-600 dark:text-emerald-400 truncate font-medium">
                      Stops at payoff · was {formatCurrency(min)}/mo
                    </div>
                  </div>
                  <div className="text-sm font-semibold tabular-nums text-muted-foreground line-through">
                    −{formatCurrency(min)}
                  </div>
                  <Lock
                    className="w-4 h-4 text-muted-foreground"
                    aria-label="Locked — managed by Debts"
                  />
                </li>
              );
            }
            return (
              <li
                key={r.debtId}
                className="px-5 py-3 flex items-center gap-4 hover:bg-muted/40 cursor-pointer transition-colors"
                onClick={() => onOpen(r.debtId)}
                data-testid={`row-debt-min-${r.debtId}`}
              >
                <div className="w-12 shrink-0 text-center">
                  {pill ? (
                    <>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        {pill.month}
                      </div>
                      <div className="text-lg font-serif font-semibold text-foreground leading-tight">
                        {pill.day}
                      </div>
                    </>
                  ) : (
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      —
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate text-foreground">
                    {r.debtName} minimum
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    linked to {r.debtName} · min {formatCurrency(min)}/mo · stops at
                    payoff
                    {r.source === "plaid" ? " · synced from Plaid" : ""}
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums text-destructive">
                  −{formatCurrency(amt)}
                </div>
                <Lock
                  className="w-4 h-4 text-muted-foreground"
                  aria-label="Locked — managed by Debts"
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
