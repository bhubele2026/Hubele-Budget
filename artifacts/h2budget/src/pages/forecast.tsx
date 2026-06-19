import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetForecast,
  useGetForecastCashSignal,
  useUpsertForecastResolution,
  useDeleteForecastResolution,
  useCloseForecastMonth,
  useReopenForecastMonth,
  useUpdateForecastSettings,
  useUpdateTransaction,
  useListCategories,
  useListDebts,
  useListRecurringItems,
  useCreateRecurringItem,
  useGetAvalancheSettings,
  useGetAvalancheExtra,
  useSetForecastBankSnapshot,
  useRefreshForecastBank,
  getGetForecastQueryKey,
  getGetForecastCashSignalQueryKey,
  getListTransactionsQueryKey,
  getListRecurringItemsQueryKey,
  getGetBillsSummaryQueryKey,
  getGetDashboardQueryKey,
  type RecurringItemInput,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { AvalancheScheduleCard } from "@/components/avalanche-schedule-card";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Line,
  Legend,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ReferenceDot,
  Label as RechartsLabel,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { PlaidReauthBanner } from "@/components/plaid-reauth-banner";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  buildLineRegister,
  filterForecastTxns,
  buildBucket,
  type BucketEntry,
  monthKey,
  isBankTxn,
  suggestPlanMatchesForBank,
  filterDropdownPlans,
  rankPlansForBank,
  pickConfidentBankMatches,
  pickOneClickBankMatches,
  shouldCelebrateClear,
  type LineRow,
  type PlanLine,
  type BankLine,
  type Resolution,
  type Transaction as MatchTxn,
  type PlanSuggestion,
} from "@/lib/forecastMatch";
import type { CashEvent } from "@/lib/forecast";
import { computeBankReconcile, EMPTY_RECONCILE } from "@/lib/forecastReconcile";
import {
  linkRecurringToDebts,
  computePayoffsByDebt,
  filterEventsByPayoff,
  payoffByRecurringItem,
  computePayoffTransitions,
  type DebtLite,
  type RecurringLite,
} from "@/lib/forecastDebts";
import { simulate, type SimDebt, type Strategy } from "@/lib/avalanche";
import {
  Lock,
  Unlock,
  Settings as SettingsIcon,
  X,
  GripVertical,
  PartyPopper,
  Inbox as InboxIcon,
  Sparkles,
  RefreshCw,
  Landmark,
  TrendingDown,
  CheckCircle2,
  AlertCircle,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import {
  InboxCardView,
  type InboxCard,
} from "./forecast/InboxCardView";
import { SuggestionStrip } from "./forecast/SuggestionStrip";
import {
  PlannedItemsList,
  type PlannedItem,
} from "./forecast/PlannedItemsList";
import { statusBadge, isPlanRowMatchEligible } from "./forecast/statusBadge";

// Re-exported here so existing imports (and the Task #285 test) keep
// working after the component moved to a shared location for use on the
// Dashboard and Transactions pages too (Task #333).
export { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";

const RECONCILED_STORAGE_KEY = "h2budget:forecastReconciled";

function readReconciledMap(): Record<string, boolean> {
  try {
    const raw = sessionStorage.getItem(RECONCILED_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeReconciledMap(map: Record<string, boolean>) {
  try {
    sessionStorage.setItem(RECONCILED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* no-op */
  }
}

function fireConfetti() {
  // Confetti celebration removed by request — the clear/reconcile gating
  // logic stays so behavior is otherwise unchanged.
}

type HorizonOpt = { label: string; days: number };
const HORIZON_OPTS: HorizonOpt[] = [
  { label: "30 DAYS", days: 30 },
  { label: "90 DAYS", days: 90 },
  { label: "120 DAYS", days: 120 },
  { label: "6 MONTHS", days: 183 },
  { label: "1 YEAR", days: 365 },
];

const FORECAST_FROM_KEY = "h2budget:forecastFromDate";
const FORECAST_HORIZON_KEY = "h2budget:forecastHorizonDays";
const FORECAST_LOOKBACK_OPEN_KEY = "h2budget:forecastLookbackOpen";
const FORECAST_MIN_FROM_DATE = "2026-05-01";

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function clampForecastFrom(value: string): string {
  if (!value) return FORECAST_MIN_FROM_DATE;
  return value < FORECAST_MIN_FROM_DATE ? FORECAST_MIN_FROM_DATE : value;
}

function shortDate(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${m}-${d}`;
}

export default function ForecastPage({
  mode = "overall",
}: { mode?: "review" | "overall" } = {}) {
  // Auto Plaid refresh on mount is DISABLED to avoid per-pull Plaid
  // charges — banks sync only on the manual Sync button now.
  const [horizonDays, setHorizonDays] = useState<number>(() => {
    try {
      const v = sessionStorage.getItem(FORECAST_HORIZON_KEY);
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) && HORIZON_OPTS.some((h) => h.days === n)
        ? n
        : 30;
    } catch {
      return 30;
    }
  });
  // (#650 follow-up) Default the chart to start at TODAY so the
  // projected line keeps moving forward as the calendar advances —
  // pre-today bills (which have either already posted or are stale
  // pending plans) no longer pile onto the first day. Past dates are
  // available behind a "Look back" toggle alongside the horizon tabs.
  const [lookbackOpen, setLookbackOpen] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(FORECAST_LOOKBACK_OPEN_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [forecastFromDate, setForecastFromDate] = useState<string>(() => {
    try {
      const stored = sessionStorage.getItem(FORECAST_FROM_KEY);
      const wasOpen = sessionStorage.getItem(FORECAST_LOOKBACK_OPEN_KEY) === "true";
      // Honor a stored past date only if the user previously opened
      // the look-back panel; otherwise snap to today on every fresh
      // visit so the forecast keeps moving forward.
      if (wasOpen && stored) return clampForecastFrom(stored);
      return todayISO();
    } catch {
      return todayISO();
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(
        FORECAST_LOOKBACK_OPEN_KEY,
        lookbackOpen ? "true" : "false",
      );
    } catch {
      /* no-op */
    }
  }, [lookbackOpen]);
  useEffect(() => {
    try {
      sessionStorage.setItem(FORECAST_HORIZON_KEY, String(horizonDays));
    } catch {
      /* no-op */
    }
  }, [horizonDays]);
  // (#618) Defer the horizon value used for the (expensive) data fetch
  // and downstream recomputation so a tab click can flip the active button
  // synchronously while React schedules the heavy re-render at lower
  // priority. Combined with React Query's global `keepPreviousData`, this
  // keeps the previous register on screen during the refetch instead of
  // blanking the page or freezing the main thread on long horizons.
  const deferredHorizonDays = useDeferredValue(horizonDays);
  const horizonSwitchPending = deferredHorizonDays !== horizonDays;
  // (#621) Same trick for the "Forecast from" date picker — typing/picking
  // a new date should flip the input immediately, but the heavy register
  // recompute (and the cash-signal refetch) stays at lower priority so the
  // previous register stays on screen with a subtle pending spinner.
  const deferredForecastFromDate = useDeferredValue(forecastFromDate);
  const fromDateSwitchPending = deferredForecastFromDate !== forecastFromDate;
  useEffect(() => {
    try {
      sessionStorage.setItem(FORECAST_FROM_KEY, forecastFromDate);
    } catch {
      /* no-op */
    }
  }, [forecastFromDate]);

  // Active tab is controlled so deep-links from other pages (e.g. the
  // Chase page's "N awaiting match in Review Bucket" chip) can land
  // directly on the Review Bucket via `/forecast#bucket`.
  const [activeTab, setActiveTab] = useState<string>(() => {
    if (typeof window !== "undefined" && window.location.hash === "#bucket") {
      return "bucket";
    }
    return "register";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      if (window.location.hash === "#bucket") setActiveTab("bucket");
      else if (window.location.hash === "" || window.location.hash === "#register")
        setActiveTab("register");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const { data, isLoading } = useGetForecast({ days: deferredHorizonDays });
  const { data: cashProjection, isLoading: cashProjectionLoading } =
    useGetForecastCashSignal({
      horizonDays: deferredHorizonDays,
      fromDate: deferredForecastFromDate,
    });
  const { data: categories } = useListCategories();
  const { data: debts } = useListDebts();
  const { data: recurringItems } = useListRecurringItems();
  const { data: avaSettings } = useGetAvalancheSettings();
  const { data: resolvedExtra } = useGetAvalancheExtra();
  const qc = useQueryClient();
  const { toast } = useToast();

  const upsertResolution = useUpsertForecastResolution();
  const deleteResolution = useDeleteForecastResolution();
  const closeMonth = useCloseForecastMonth();
  const reopenMonth = useReopenForecastMonth();
  const updateSettings = useUpdateForecastSettings();
  const updateTxn = useUpdateTransaction();
  const setBankSnapshot = useSetForecastBankSnapshot();
  const refreshBank = useRefreshForecastBank();
  const createRecurring = useCreateRecurringItem();

  // (#522) "Add as bill" flow: when the user wants to promote an inbox
  // bank txn into a recurring item without leaving Review. We seed the
  // dialog from the txn's description, amount, and date.
  type AddBillSeed = {
    txnId: string;
    name: string;
    amount: string;
    kind: "bill" | "income";
    frequency: "monthly" | "biweekly" | "weekly" | "semimonthly" | "onetime";
    dayOfMonth: string;
    anchorDate: string;
  };
  const [addBillSeed, setAddBillSeed] = useState<AddBillSeed | null>(null);

  const openAddAsBill = (card: InboxCard) => {
    const amt = card.bank.amount;
    const isIncome = amt > 0;
    const dateStr = card.bank.date;
    const dom = dateStr ? Number(dateStr.slice(8, 10)) : NaN;
    setAddBillSeed({
      txnId: card.bank.txn.id,
      name: (card.bank.txn.description ?? "").trim() || "Untitled",
      amount: Math.abs(amt).toFixed(2),
      kind: isIncome ? "income" : "bill",
      frequency: "monthly",
      dayOfMonth: Number.isFinite(dom) && dom >= 1 && dom <= 31 ? String(dom) : "1",
      anchorDate: dateStr || "",
    });
  };

  const submitAddAsBill = () => {
    if (!addBillSeed) return;
    const name = addBillSeed.name.trim();
    if (!name) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const amt = parseFloat(addBillSeed.amount);
    if (!Number.isFinite(amt) || amt < 0) {
      toast({ title: "Amount must be a positive number", variant: "destructive" });
      return;
    }
    if (addBillSeed.frequency === "onetime" && !addBillSeed.anchorDate) {
      toast({
        title: "Pick a date for the one-time item",
        variant: "destructive",
      });
      return;
    }
    const payload: RecurringItemInput = {
      name,
      kind: addBillSeed.kind,
      amount: amt.toFixed(2),
      frequency: addBillSeed.frequency,
      active: "true",
      dayOfMonth: null,
      anchorDate: null,
    };
    if (
      addBillSeed.frequency === "monthly" ||
      addBillSeed.frequency === "semimonthly"
    ) {
      const day = parseInt(addBillSeed.dayOfMonth, 10);
      payload.dayOfMonth =
        Number.isFinite(day) && day >= 1 && day <= 31 ? day : 1;
      payload.anchorDate = addBillSeed.anchorDate || null;
    } else if (addBillSeed.frequency === "onetime") {
      payload.anchorDate = addBillSeed.anchorDate || null;
    } else {
      payload.anchorDate = addBillSeed.anchorDate || null;
    }
    createRecurring.mutate(
      { data: payload },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          qc.invalidateQueries({ queryKey: getGetForecastCashSignalQueryKey() });
          qc.invalidateQueries({ queryKey: getListRecurringItemsQueryKey() });
          qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
          qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
          setAddBillSeed(null);
          toast({
            title: `Added "${name}" as a recurring ${addBillSeed.kind}`,
            description:
              "It now shows up in Planned forecast items so you can match this transaction to it.",
          });
        },
        onError: (err) => {
          toast({
            title: "Couldn't add bill",
            description: (err as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftDays, setDraftDays] = useState("90");
  const [draftBalance, setDraftBalance] = useState("0");
  const [draftBuffer, setDraftBuffer] = useState("500");
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [draftSnapshot, setDraftSnapshot] = useState("");
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // (#456) First-time hint above the bank inbox explaining the
  // drag-to-match gesture. Persisted dismissal in localStorage so it never
  // comes back once the user closes it.
  const [dragHintDismissed, setDragHintDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("h2budget:forecastDragHintDismissed") === "1";
    } catch {
      return false;
    }
  });
  const dismissDragHint = () => {
    setDragHintDismissed(true);
    try {
      localStorage.setItem("h2budget:forecastDragHintDismissed", "1");
    } catch {
      /* no-op */
    }
  };
  // (#26) Tracks which inbox card is currently hovered/focused so the
  // matching plan row can light up before the user picks the card up.
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  // (#478) When matching the bank inbox to the forecast on the Active
  // Register, show one pending row at a time so the forecast underneath stays
  // visible. The index is clamped to the current `bankInbox` length below.
  const [activeInboxIndex, setActiveInboxIndex] = useState(0);
  // (#519) Allow users to collapse the pinned inbox card down to a compact
  // one-line strip on shorter viewports. Persisted in localStorage so the
  // choice survives navigation/reloads.
  const [pinnedInboxCollapsed, setPinnedInboxCollapsed] = useState<boolean>(
    () => {
      try {
        return (
          localStorage.getItem("h2budget:pinnedInboxCollapsed") === "1"
        );
      } catch {
        return false;
      }
    },
  );
  const togglePinnedInboxCollapsed = () => {
    setPinnedInboxCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(
          "h2budget:pinnedInboxCollapsed",
          next ? "1" : "0",
        );
      } catch {
        /* no-op */
      }
      return next;
    });
  };
  // (#335) Active highlight for a plan row that the user just deep-linked to
  // by clicking a big-bill marker (or a bill inside its tooltip). Cleared
  // automatically after a short pulse so the row settles back to normal.
  const [highlightedPlanKey, setHighlightedPlanKey] = useState<string | null>(
    null,
  );
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );
  // (#517) Pin the unmatched inbox area so the planned-items list scrolls
  // underneath it. We measure the existing page sticky header so the pinned
  // region's `top` lands flush below it even as the header height changes.
  const pageStickyHeaderRef = useRef<HTMLDivElement>(null);
  const [pageStickyHeaderHeight, setPageStickyHeaderHeight] = useState(0);
  useEffect(() => {
    const el = pageStickyHeaderRef.current;
    if (!el) return;
    const update = () =>
      setPageStickyHeaderHeight(Math.ceil(el.getBoundingClientRect().height));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // (#517) On short or narrow viewports, pinning would eat most of the screen
  // and leave no room to scroll the planned list, so we fall back to the
  // existing non-pinned behavior there.
  const [canPinInbox, setCanPinInbox] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-height: 720px) and (min-width: 768px)");
    const update = () => setCanPinInbox(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const jumpToPlan = (itemId: string, date: string) => {
    const key = `${itemId}|${date}`;
    setHighlightedPlanKey(key);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(
      () => setHighlightedPlanKey(null),
      2000,
    );
    // Defer to next frame so the row is mounted/visible before scrolling.
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-plan-key="${key.replace(/"/g, '\\"')}"]`,
      );
      if (el && "scrollIntoView" in el) {
        (el as HTMLElement).scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    });
  };
  const [reconciledNow, setReconciledNow] = useState(false);
  const [moveTarget, setMoveTarget] = useState<PlanLine | null>(null);
  const [moveDateDraft, setMoveDateDraft] = useState<string>("");
  const [moveError, setMoveError] = useState<string | null>(null);
  // (#27) Per-row selection on the bank inbox so the user can bulk-resolve
  // an arbitrary subset (not just "all").
  const [selectedBankIds, setSelectedBankIds] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleBankSelected = (txnId: string) =>
    setSelectedBankIds((prev) => {
      const next = new Set(prev);
      if (next.has(txnId)) next.delete(txnId);
      else next.add(txnId);
      return next;
    });
  const clearBankSelection = () => setSelectedBankIds(new Set());

  const today = useMemo(() => new Date(), []);
  const currentMonth = useMemo(
    () => `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`,
    [today],
  );
  const [monthFilter, setMonthFilter] = useState(currentMonth);
  // (#621) Defer the month-bucket filter the same way we defer the
  // horizon and from-date — switching the active month should flip the
  // picker immediately while the heavy bucket/inbox/reconcile recompute
  // happens at lower priority. Combined with React Query's
  // `keepPreviousData`, this keeps the prior bucket on screen with a
  // subtle pending spinner instead of blocking the click.
  const deferredMonthFilter = useDeferredValue(monthFilter);
  const monthSwitchPending = deferredMonthFilter !== monthFilter;

  const closedMonths = useMemo(
    () => new Set(data?.closedMonths ?? []),
    [data?.closedMonths],
  );

  const monthSnapshotsMap = useMemo(
    () => data?.monthSnapshots ?? {},
    [data?.monthSnapshots],
  );

  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const strategy: Strategy = (avaSettings?.strategy as Strategy) ?? "avalanche";
  const extraPerMonth = useMemo(() => {
    const r = Number(resolvedExtra?.amount);
    if (Number.isFinite(r)) return r;
    return Number(avaSettings?.manualExtra ?? 0) || 0;
  }, [resolvedExtra?.amount, avaSettings?.manualExtra]);

  const sim = useMemo(() => {
    const simDebts: SimDebt[] = (debts ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      apr: Number(d.apr),
      balance: Number(d.balance),
      minPayment: Number(d.minPayment),
      status: d.status,
    }));
    return simulate({ debts: simDebts, extraPerMonth, strategy });
  }, [debts, extraPerMonth, strategy]);

  const debtLinks = useMemo(
    () =>
      linkRecurringToDebts(
        (debts ?? []) as DebtLite[],
        (recurringItems ?? []) as RecurringLite[],
      ),
    [debts, recurringItems],
  );

  const payoffsByDebt = useMemo(() => computePayoffsByDebt(sim), [sim]);
  const payoffsByItem = useMemo(
    () => payoffByRecurringItem(debtLinks, payoffsByDebt),
    [debtLinks, payoffsByDebt],
  );
  const payoffTransitionsByMonth = useMemo(
    () =>
      computePayoffTransitions(
        debtLinks,
        payoffsByDebt,
        (recurringItems ?? []) as RecurringLite[],
      ),
    [debtLinks, payoffsByDebt, recurringItems],
  );

  // Set containing only the configured Chase checking account's external
  // Plaid `account_id` (if any). Used as a defensive client-side filter so
  // only that one account's transactions can ever appear on Forecast —
  // even if other depository accounts were linked, and even if a legacy
  // row still has `forecastFlag = true`. The server already filters the
  // same way; this is a belt-and-braces guard.
  const checkingPlaidAccountIds = useMemo(() => {
    const s = new Set<string>();
    const snapshotRowId = data?.bankSnapshot?.accountId ?? null;
    if (snapshotRowId) {
      const acct = (data?.plaidCheckingAccounts ?? []).find(
        (a) => a.id === snapshotRowId,
      );
      if (acct?.accountId) s.add(acct.accountId);
    }
    return s;
  }, [data?.bankSnapshot?.accountId, data?.plaidCheckingAccounts]);

  const register = useMemo(() => {
    if (!data) return null;
    const rawEvents = (data.events ?? []) as CashEvent[];
    const events = filterEventsByPayoff(rawEvents, debtLinks, payoffsByDebt);
    const txns = filterForecastTxns(
      (data.transactions ?? []) as unknown as MatchTxn[],
      checkingPlaidAccountIds,
    );
    const resolutions = (data.resolutions ?? []) as Resolution[];
    const snapshot = data.bankSnapshot ?? null;
    const startBalance = snapshot
      ? Number(snapshot.balance) || 0
      : Number(data.settings.startingBalance) || 0;
    const snapshotISO = snapshot?.at ? snapshot.at.slice(0, 10) : null;
    return buildLineRegister({
      events,
      txns,
      resolutions,
      closedMonths,
      startBalance,
      fromISO: data.fromDate,
      toISO: data.toDate,
      today,
      snapshotISO,
      // Hide stale prior-month plan/bank rows from the active register.
      // The API still returns events back to the first of last month so
      // the month-close + rescheduled-bucket flows (which read from
      // `register.allPlan`/`allBank`) keep working; we only narrow what
      // the user sees in the default view.
      visibleFromISO: deferredForecastFromDate,
      // Review page only: keep overdue unresolved plans on the list until
      // the user matches/skips/marks-missed them, instead of letting them
      // drop off the moment today passes their date. The forward-looking
      // /forecast (overall) view leaves this off.
      lingerPastDuePlans: mode === "review",
    });
  }, [data, closedMonths, today, debtLinks, payoffsByDebt, deferredForecastFromDate, mode]);

  const bucket = useMemo(() => {
    if (!register || !data) return [];
    return buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions: (data.resolutions ?? []) as Resolution[],
      closedMonths,
      monthFilter: deferredMonthFilter,
    });
  }, [register, data, closedMonths, deferredMonthFilter]);

  const monthsAvailable = useMemo(() => {
    const set = new Set<string>([currentMonth]);
    // Always include the last 6 calendar months so historical closed
    // periods stay reachable from the picker even after the forecast
    // window scrolls past them.
    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      set.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    if (register) {
      for (const p of register.allPlan) set.add(monthKey(p.date));
      for (const b of register.allBank) set.add(monthKey(b.date));
    }
    // Surface every closed month and every month with a frozen reconcile
    // snapshot, regardless of the current forecast window.
    for (const m of closedMonths) set.add(m);
    for (const m of Object.keys(monthSnapshotsMap)) set.add(m);
    return Array.from(set).sort();
  }, [register, currentMonth, today, closedMonths, monthSnapshotsMap]);

  // Build inbox: bank rows still pending (not matched, not unplanned)
  const inbox: InboxCard[] = useMemo(() => {
    if (!register) return [];
    return register.allBank
      .filter((b) => b.status === "pending_bank")
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((b) => ({ id: `inbox:${b.txn.id}`, bank: b }));
  }, [register]);

  // Bank inbox is scoped to the currently-selected month so counts and
  // visible rows stay consistent. (All `inbox` rows are already
  // bank-checking — non-bank txns are filtered out at register build time.)
  const bankInbox = useMemo(
    () =>
      inbox.filter((c) => monthKey(c.bank.date) === deferredMonthFilter),
    [inbox, deferredMonthFilter],
  );

  // (#27) Keep `selectedBankIds` honest: drop any txn ids that are no
  // longer present in the visible inbox (post-resolve refetch, month
  // change, fresh data). Otherwise the bulk bar can show "N selected"
  // while the bulk action silently no-ops against a stale Set.
  const bankInboxIdSet = useMemo(
    () => new Set(bankInbox.map((c) => c.bank.txn.id)),
    [bankInbox],
  );
  useEffect(() => {
    setSelectedBankIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (bankInboxIdSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [bankInboxIdSet]);

  // (#478) Keep `activeInboxIndex` valid as `bankInbox` shrinks (rows being
  // matched, marked unplanned, or removed) or grows. We don't advance the
  // index when the visible row resolves — the next pending row naturally
  // takes that slot — but we clamp it so it never falls off the end.
  useEffect(() => {
    setActiveInboxIndex((idx) => {
      if (bankInbox.length === 0) return 0;
      if (idx > bankInbox.length - 1) return bankInbox.length - 1;
      if (idx < 0) return 0;
      return idx;
    });
  }, [bankInbox.length]);

  // Bank rows already resolved (matched or marked unplanned) in the current
  // month — used for an undo affordance directly on the bank card.
  const bankResolvedThisMonth = useMemo(() => {
    if (!register || !data) return [] as Array<{
      bank: BankLine;
      resolutionId: string;
      kind: "matched" | "unplanned";
    }>;
    const byMatchedTxn = new Map<string, Resolution>();
    for (const r of (data.resolutions ?? []) as Resolution[]) {
      if (r.matchedTxnId) byMatchedTxn.set(r.matchedTxnId, r);
    }
    const out: Array<{
      bank: BankLine;
      resolutionId: string;
      kind: "matched" | "unplanned";
    }> = [];
    for (const b of register.allBank) {
      if (!isBankTxn(b.txn, checkingPlaidAccountIds)) continue;
      if (monthKey(b.date) !== deferredMonthFilter) continue;
      if (b.status !== "matched" && b.status !== "ignored_unforecasted")
        continue;
      const res = byMatchedTxn.get(b.txn.id);
      if (!res) continue;
      out.push({
        bank: b,
        resolutionId: res.id,
        kind: b.status === "matched" ? "matched" : "unplanned",
      });
    }
    out.sort((a, b) => (a.bank.date < b.bank.date ? 1 : -1));
    return out;
  }, [register, data, deferredMonthFilter, checkingPlaidAccountIds]);

  // Bank reconciliation stats scoped to the selected month.
  //
  // forecastEnd = bank snapshot balance + Σ planned items in (snapshot.at, end-of-month].
  //   Bank movements that already happened (matched / unplanned / pending bank
  //   rows) are NOT added — the bank snapshot already includes everything that
  //   actually cleared. This is purely an end-of-period TARGET balance; it is
  //   *expected* to differ from today's bank balance by the planned future
  //   net flow and must NOT be used as the reconciliation gap.
  //
  // bankEnd = bank snapshot balance — the actual current/known bank balance.
  //   For prior closed months we don't surface a gap (we don't store a
  //   per-month historical snapshot), only counts.
  //
  // gap = like-for-like comparison of the forecast's projected balance AS OF
  //   the bank snapshot date vs the bank snapshot balance itself (NOT
  //   forecastEnd − bankEnd). Reconciled when |gap| < $0.01 AND no pending.
  const bankReconcile = useMemo(() => {
    if (!register || !data) return EMPTY_RECONCILE;
    return computeBankReconcile({
      allBank: register.allBank,
      allPlan: register.allPlan,
      bankSnapshot: data.bankSnapshot ?? null,
      settingsStartingBalance: data.settings.startingBalance,
      fromDate: data.fromDate,
      monthFilter: deferredMonthFilter,
      checkingPlaidAccountIds,
    });
  }, [register, data, deferredMonthFilter, checkingPlaidAccountIds]);

  // A clean reconciliation means no pending bank rows AND no
  // contributor of $0.01 or more. We deliberately use a strict 1¢
  // threshold (matching the badge gate) instead of the historical
  // $0.50 tolerance — float noise is now excluded by construction
  // because `gap` only sums *named* contributors.
  const isReconciledToBank =
    bankReconcile.hasBank &&
    !bankReconcile.isPriorMonth &&
    bankReconcile.pending === 0 &&
    bankReconcile.gap < 0.01;

  // Plan rows used as drop targets (active register, plan-only)
  const planRows: PlanLine[] = useMemo(() => {
    if (!register) return [];
    return register.rows.filter((r): r is PlanLine => r.kind === "plan");
  }, [register]);

  // (#618) Pre-flatten plan rows + interleaved cash-freed banners once
  // per register so the virtualized renderer doesn't have to re-walk the
  // month-transition rules on every scroll. Recomputes only when its
  // small set of inputs actually changes.
  const plannedItems: PlannedItem[] = useMemo(() => {
    const out: PlannedItem[] = [];
    const shownTransitions = new Set<string>();
    for (let i = 0; i < planRows.length; i++) {
      const row = planRows[i];
      out.push({
        kind: "plan",
        key: `plan:${row.itemId}-${row.date}-${i}`,
        row,
      });
      const currentYM = row.date.slice(0, 7);
      const nextYM = planRows[i + 1]?.date.slice(0, 7);
      if (nextYM !== currentYM) {
        const transitions = payoffTransitionsByMonth.get(currentYM) ?? [];
        for (const t of transitions) {
          if (shownTransitions.has(t.debtId)) continue;
          shownTransitions.add(t.debtId);
          out.push({
            kind: "banner",
            key: `freed-${t.debtId}`,
            transition: t,
          });
        }
      }
    }
    return out;
  }, [planRows, payoffTransitionsByMonth]);

  // Per-bank-card top suggestions (uses pure scorer; never auto-applies).
  // Source from `register.allPlan` (not the visible `planRows`) so that bank
  // rows in a selected month or near a window edge can still match planned
  // occurrences that fall just outside the active register view.
  const bankSuggestions = useMemo(() => {
    const m = new Map<string, PlanSuggestion[]>();
    if (!register) return m;
    const candidatePlans = register.allPlan.filter(
      (r) => r.status === "pending_plan" || r.status === "future",
    );
    for (const c of bankInbox) {
      m.set(c.bank.txn.id, suggestPlanMatchesForBank(c.bank, candidatePlans));
    }
    return m;
  }, [bankInbox, register]);

  // Greedy uniqueness pass: how many of the pending bank rows have a `high`
  // confidence top suggestion that wouldn't collide with another. This drives
  // the "Match all confident" bulk action label & enabled state.
  const confidentMatches = useMemo(
    () => pickConfidentBankMatches(bankSuggestions),
    [bankSuggestions],
  );

  // (#28) Per-card "one-click match" picks: a card qualifies only when it
  // has exactly one high-confidence suggestion AND that plan isn't also
  // high-confidence for some other card. Lets the obvious cards confirm
  // with a single button while keeping ties/contests on the dropdown.
  const oneClickByTxnId = useMemo(
    () => pickOneClickBankMatches(bankSuggestions),
    [bankSuggestions],
  );

  // (#26) When an inbox card is being dragged OR hovered/focused, derive the
  // plan key (`itemId|date`) of its best suggestion so the matching plan row
  // can render with a tinted ring even before the cursor enters it. Drag wins
  // over hover so the highlight stays anchored to whatever's actively moving.
  const bestSuggestionPlanKey: string | null = useMemo(() => {
    const cardId = activeDragId ?? hoveredCardId;
    if (!cardId) return null;
    const card = bankInbox.find((c) => c.id === cardId);
    if (!card) return null;
    const sugs = bankSuggestions.get(card.bank.txn.id) ?? [];
    const top = sugs.find(
      (s) => s.confidence === "high" || s.confidence === "medium",
    );
    if (!top) return null;
    return `${top.plan.itemId}|${top.plan.date}`;
  }, [activeDragId, hoveredCardId, bankInbox, bankSuggestions]);

  // (#26) Per-bank-card pre-sorted plan options for the "Match to…" dropdown.
  // We rank ALL pending plans by best match (amount → date → label nudge) so
  // the obvious choice is always at the top of the list. Falls back to the
  // empty list shape `Map.get` returns when a card isn't keyed.
  const sortedPlansByCard = useMemo(() => {
    const m = new Map<string, PlanLine[]>();
    if (!register) return m;
    // (#457) Narrow the dropdown source list before ranking: keep only
    // pending/future plans, dropping anything outside the current-month
    // / today+3w window or already matched to another bank txn. `today`
    // is computed once per render so all cards share the same window.
    const pendingPlans = filterDropdownPlans(
      register.allPlan.filter(
        (r) => r.status === "pending_plan" || r.status === "future",
      ),
      today,
    );
    for (const c of bankInbox) {
      m.set(c.bank.txn.id, rankPlansForBank(c.bank, pendingPlans));
    }
    return m;
  }, [bankInbox, register, today]);

  // Window key for confetti persistence: YYYY-MM (current calendar month).
  // One-shot per session per month per task spec.
  const windowKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const inboxCount = inbox.length;
  const cleared = shouldCelebrateClear({ inboxCount, isReconciledToBank });
  const prevClearedRef = useRef<boolean | null>(null);

  // Single effect handles both hydration and transition so ordering is
  // deterministic regardless of cache timing. Confetti is one-shot per
  // session per YYYY-MM (sessionStorage), only fires on overall mode, and
  // is also fired on first overall observation of a cleared state — so a
  // user who finishes triage on /review and lands on /forecast still sees
  // it. Once the session key is set it is never cleared (true one-shot).
  useEffect(() => {
    if (!windowKey) return;
    const prev = prevClearedRef.current;
    const map = readReconciledMap();
    const alreadyFired = !!map[windowKey];
    const firstObservation = prev === null;

    if (cleared) {
      const shouldFire =
        mode === "overall" &&
        !alreadyFired &&
        (firstObservation || prev === false);
      if (shouldFire) {
        fireConfetti();
        map[windowKey] = true;
        writeReconciledMap(map);
      }
      setReconciledNow(true);
    } else {
      setReconciledNow(false);
    }
    prevClearedRef.current = cleared;
  }, [cleared, windowKey, mode]);

  const invalidate = () => {
    // (#823) Broadly invalidate the ENTIRE forecast namespace (the
    // forecast bundle for every daysAhead/horizon variant, the
    // cash-signal projection, settings, resolutions, closed months,
    // etc.) via a predicate match on the query-key prefix rather than
    // listing precise keys. This guarantees that after any forecast
    // mutation — recurring-item create/update/delete, resolution
    // upsert/delete/mark-missed/skip/match, bank-snapshot set/refresh,
    // or a debt change — every cached horizon refreshes, so switching
    // 30/90/120-day views never shows a stale balance.
    qc.invalidateQueries({
      predicate: (q) => {
        const key = q.queryKey[0];
        return typeof key === "string" && key.startsWith("/api/forecast");
      },
    });
    qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
  );

  const matchInboxToPlan = (txnId: string, planRow: PlanLine) => {
    upsertResolution.mutate(
      {
        data: {
          status: "matched",
          recurringItemId: planRow.itemId,
          occurrenceDate: planRow.originalDate ?? planRow.date,
          matchedTxnId: txnId,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Matched to ${planRow.label}` });
        },
      },
    );
  };

  const onDragStart = (e: DragStartEvent) => {
    setActiveDragId(String(e.active.id));
  };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveDragId(null);
    const overData = e.over?.data?.current as
      | { kind?: string; planRow?: PlanLine }
      | undefined;
    const activeData = e.active.data.current as
      | { txnId?: string }
      | undefined;
    if (overData?.kind === "plan" && overData.planRow && activeData?.txnId) {
      const planRow = overData.planRow;
      // (#456) Plan rows that aren't pending/future stay registered as
      // droppable so this branch can surface a clear rejection toast
      // instead of silently dropping the user's gesture on the floor.
      // Mirrors the `isEligible` predicate in `PlanDropRow` so the visual
      // "blocked" state and the actual drop handler can never disagree.
      if (!isPlanRowMatchEligible(planRow)) {
        const reason =
          planRow.status === "matched"
            ? "already matched"
            : planRow.status === "missed"
              ? "marked missed"
              : `not available (${planRow.status})`;
        toast({
          title: `Can't match here`,
          description: `${planRow.label} on ${formatDate(planRow.date)} is ${reason}.`,
          variant: "destructive",
        });
        return;
      }
      matchInboxToPlan(activeData.txnId, planRow);
    }
  };

  const onMarkUnplannedTxn = (txnId: string) => {
    upsertResolution.mutate(
      { data: { status: "ignored_unforecasted", matchedTxnId: txnId } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Marked unplanned" });
        },
      },
    );
  };

  const bulkMarkBankUnplanned = async () => {
    const ids = bankInbox.map((c) => c.bank.txn.id);
    if (!ids.length) return;
    const CONCURRENCY = 6;
    let cursor = 0;
    let ok = 0;
    const failures: string[] = [];
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const txnId = ids[i];
        try {
          await upsertResolution.mutateAsync({
            data: { status: "ignored_unforecasted", matchedTxnId: txnId },
          });
          ok += 1;
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
    );
    invalidate();
    if (!failures.length) {
      toast({ title: `Marked ${ok} as unplanned` });
    } else {
      toast({
        title: `${ok} updated, ${failures.length} failed`,
        description: failures[0],
        variant: "destructive",
      });
    }
  };

  // (#27) Bulk-mark just the selected inbox cards as unplanned.
  const bulkMarkBankUnplannedSelected = async () => {
    const ids = Array.from(selectedBankIds).filter((id) =>
      bankInbox.some((c) => c.bank.txn.id === id),
    );
    if (!ids.length) return;
    const CONCURRENCY = 6;
    let cursor = 0;
    let ok = 0;
    const failures: string[] = [];
    const worker = async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const txnId = ids[i];
        try {
          await upsertResolution.mutateAsync({
            data: { status: "ignored_unforecasted", matchedTxnId: txnId },
          });
          ok += 1;
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
    );
    invalidate();
    clearBankSelection();
    if (!failures.length) {
      toast({ title: `Marked ${ok} as unplanned` });
    } else {
      toast({
        title: `${ok} updated, ${failures.length} failed`,
        description: failures[0],
        variant: "destructive",
      });
    }
  };

  // (#27) Bulk-match the confident-pickable subset of selected inbox cards.
  const bulkMatchConfidentSelected = async () => {
    const items = confidentMatches.filter((m) => selectedBankIds.has(m.txnId));
    if (!items.length) return;
    const CONCURRENCY = 6;
    let cursor = 0;
    let ok = 0;
    const failures: string[] = [];
    const worker = async () => {
      while (cursor < items.length) {
        const i = cursor++;
        const it = items[i];
        try {
          await upsertResolution.mutateAsync({
            data: {
              status: "matched",
              recurringItemId: it.plan.itemId,
              occurrenceDate: it.plan.originalDate ?? it.plan.date,
              matchedTxnId: it.txnId,
            },
          });
          ok += 1;
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
    );
    invalidate();
    clearBankSelection();
    if (!failures.length) {
      toast({ title: `Matched ${ok} confident bank row${ok === 1 ? "" : "s"}` });
    } else {
      toast({
        title: `${ok} matched, ${failures.length} failed`,
        description: failures[0],
        variant: "destructive",
      });
    }
  };

  const bulkMatchConfident = async () => {
    const items = confidentMatches;
    if (!items.length) return;
    const CONCURRENCY = 6;
    let cursor = 0;
    let ok = 0;
    const failures: string[] = [];
    const worker = async () => {
      while (cursor < items.length) {
        const i = cursor++;
        const it = items[i];
        try {
          await upsertResolution.mutateAsync({
            data: {
              status: "matched",
              recurringItemId: it.plan.itemId,
              occurrenceDate: it.plan.originalDate ?? it.plan.date,
              matchedTxnId: it.txnId,
            },
          });
          ok += 1;
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
    );
    invalidate();
    if (!failures.length) {
      toast({ title: `Matched ${ok} confident bank row${ok === 1 ? "" : "s"}` });
    } else {
      toast({
        title: `${ok} matched, ${failures.length} failed`,
        description: failures[0],
        variant: "destructive",
      });
    }
  };

  // (#480) Mark a pending plan occurrence as missed. The previous
  // implementation used a blocking `window.confirm()`; we now mutate
  // immediately and surface a toast with an Undo action so the flow
  // matches the rest of the app (toast-driven, non-blocking) while
  // still being recoverable from a misclick.
  const onMarkMissed = (row: PlanLine) => {
    if (row.status === "matched" || row.status === "missed") return;
    upsertResolution.mutate(
      {
        data: {
          status: "missed",
          recurringItemId: row.itemId,
          occurrenceDate: row.originalDate ?? row.date,
        },
      },
      {
        onSuccess: (created: { id?: string } | undefined) => {
          invalidate();
          const newId = created?.id;
          toast({
            title: "Marked missed",
            description: `${row.label || "Occurrence"} · ${formatDate(row.date)}`,
            action: newId ? (
              <ToastAction
                altText="Undo mark missed"
                onClick={() => onUndo(newId)}
                data-testid="toast-undo-mark-missed"
              >
                Undo
              </ToastAction>
            ) : undefined,
          });
        },
      },
    );
  };
  // Row click on a pending plan occurrence routes through the same
  // mark-missed handler so the previously-buried gesture is preserved
  // for muscle-memory users while the explicit button is the
  // discoverable path.
  const onSelectPlan = (row: PlanLine) => {
    if (row.status === "matched" || row.status === "missed") return;
    onMarkMissed(row);
  };

  const onMoveStart = (row: PlanLine) => {
    setMoveTarget(row);
    setMoveDateDraft(row.date);
    setMoveError(null);
  };
  const onMoveSave = () => {
    if (!moveTarget) return;
    if (!moveDateDraft) {
      setMoveError("Pick a date.");
      return;
    }
    // (#888) Window guard: the picked day must fall within the forecast
    // window — from today (inclusive) through today+30 days (inclusive) —
    // and not equal the day it's currently on (that would be a no-op).
    // Earlier-than-original is now allowed inside the window.
    const isoOf = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const todayIso = isoOf(new Date());
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 30);
    const maxIso = isoOf(maxDate);
    if (moveDateDraft < todayIso || moveDateDraft > maxIso) {
      setMoveError("Pick a day within the next 30 days.");
      return;
    }
    if (moveDateDraft === moveTarget.date) {
      setMoveError("That's already its current day.");
      return;
    }
    const occurrenceDate = moveTarget.originalDate ?? moveTarget.date;
    upsertResolution.mutate(
      {
        data: {
          status: "rescheduled",
          recurringItemId: moveTarget.itemId,
          occurrenceDate,
          rescheduledTo: moveDateDraft,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: `Moved to ${formatDate(moveDateDraft)}`,
          });
          setMoveTarget(null);
          setMoveDateDraft("");
          setMoveError(null);
        },
        onError: (e: unknown) => {
          const message =
            (e as Error).message ?? "Failed to move occurrence";
          setMoveError(message);
          toast({ title: message, variant: "destructive" });
        },
      },
    );
  };

  // (#480) From the Missed bucket: open the existing Move-to date
  // picker pre-filled for that occurrence. Saving routes through the
  // existing `onMoveSave` path which upserts a `rescheduled` resolution
  // for `(recurringItemId, occurrenceDate)`. The backend POST endpoint
  // deletes the prior `missed` resolution at that key before inserting,
  // so the row leaves the Missed bucket and reappears at the new date
  // automatically.
  const onSetNewDateFromBucket = (b: BucketEntry) => {
    if (!b.recurringItemId || !b.occurrenceDate) return;
    setMoveTarget({
      kind: "plan",
      date: b.date,
      itemId: b.recurringItemId,
      label: b.label,
      amount: b.amount,
      status: "missed",
      originalDate: b.occurrenceDate,
    });
    setMoveDateDraft("");
    setMoveError(null);
  };
  // (#480) Skip a Missed-bucket occurrence: persist a `skipped`
  // resolution that hides the row from the register, the bucket, and
  // the projection (server `cashSignal` and client `forecastMatch`
  // both filter on this status). The backend upsert replaces the
  // prior `missed` resolution at the same key so we don't accumulate
  // dead rows. Toast carries an Undo action that deletes the new
  // resolution — leaving no resolution at all, which restores the
  // row to its natural pending/missed state on the next render.
  const onSkipFromBucket = (b: BucketEntry) => {
    if (!b.recurringItemId || !b.occurrenceDate) return;
    upsertResolution.mutate(
      {
        data: {
          status: "skipped",
          recurringItemId: b.recurringItemId,
          occurrenceDate: b.occurrenceDate,
        },
      },
      {
        onSuccess: (created: { id?: string } | undefined) => {
          invalidate();
          const newId = created?.id;
          toast({
            title: "Skipped",
            description: `${b.label || "Occurrence"} · ${formatDate(b.date)}`,
            action: newId ? (
              <ToastAction
                altText="Undo skip"
                onClick={() => onUndo(newId)}
                data-testid="toast-undo-skip"
              >
                Undo
              </ToastAction>
            ) : undefined,
          });
        },
      },
    );
  };

  // (#685) Skip a past-due dragging plan straight from the summary card.
  // Mirrors `onSkipFromBucket` but takes the lightweight row shape used by
  // the dragging-plans summary so we don't have to synthesize a full
  // BucketEntry. Server filters `skipped` resolutions out of the cash
  // signal, so the card hides itself once no plans are dragging anymore.
  const onSkipDraggingPlan = (row: {
    itemId: string;
    label: string;
    originalDate: string;
    effectiveDate: string;
  }) => {
    if (!row.itemId || !row.originalDate) return;
    upsertResolution.mutate(
      {
        data: {
          status: "skipped",
          recurringItemId: row.itemId,
          occurrenceDate: row.originalDate,
        },
      },
      {
        onSuccess: (created: { id?: string } | undefined) => {
          invalidate();
          const newId = created?.id;
          toast({
            title: "Skipped",
            description: `${row.label || "Occurrence"} · ${formatDate(row.originalDate)}`,
            action: newId ? (
              <ToastAction
                altText="Undo skip"
                onClick={() => onUndo(newId)}
                data-testid="toast-undo-skip-dragging"
              >
                Undo
              </ToastAction>
            ) : undefined,
          });
        },
      },
    );
  };

  const onUndo = (resolutionId: string) => {
    deleteResolution.mutate(
      { id: resolutionId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Undone" });
        },
      },
    );
  };

  const onRemoveFromForecast = (txnId: string) => {
    updateTxn.mutate(
      { id: txnId, data: { forecastFlag: false } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Removed from Forecast" });
        },
      },
    );
  };

  const onCloseMonth = () => {
    // Only attach a reconcile result when the live evaluation is
    // meaningful — i.e. the snapshot still falls within (or after) the
    // month being closed. For prior periods the bank snapshot has moved
    // on and bankReconcile can't represent that month, so we omit the
    // reconciled/gap fields rather than stamping a false negative.
    const evaluable = bankReconcile.hasBank && !bankReconcile.isPriorMonth;
    closeMonth.mutate(
      {
        data: {
          monthKey: monthFilter,
          gap: evaluable ? bankReconcile.gap.toFixed(2) : null,
          forecastEnd: evaluable ? bankReconcile.forecastEnd.toFixed(2) : null,
          bankEnd: evaluable ? bankReconcile.bankEnd.toFixed(2) : null,
          pending: evaluable ? bankReconcile.pending : null,
          reconciled: evaluable ? isReconciledToBank : null,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Closed ${monthFilter}` });
        },
      },
    );
  };
  const onReopenMonth = () => {
    reopenMonth.mutate(
      { monthKey: monthFilter },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Reopened ${monthFilter}` });
        },
      },
    );
  };

  // (#527) When the user lands in Settings via the off-from-bank badge's
  // "starting balance" contributor, we want the starting-balance input to
  // get focus so the fix is one keystroke away. A normal Settings open
  // shouldn't steal focus from anywhere else, so this is opt-in.
  const [focusStartingBalance, setFocusStartingBalance] = useState(false);
  const startingBalanceInputRef = useRef<HTMLInputElement>(null);
  const openSettings = (opts?: { focusStartingBalance?: boolean }) => {
    setDraftDays(String(data?.settings.daysAhead ?? 90));
    setDraftBalance(String(data?.settings.startingBalance ?? "0"));
    setDraftBuffer(String(data?.settings.cashBuffer ?? "500"));
    setFocusStartingBalance(!!opts?.focusStartingBalance);
    setSettingsOpen(true);
  };
  const saveSettings = () => {
    updateSettings.mutate(
      {
        data: {
          daysAhead: Number(draftDays) || 90,
          startingBalance: draftBalance,
          cashBuffer: draftBuffer,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Settings saved" });
          setSettingsOpen(false);
        },
      },
    );
  };

  const openSnapshot = () => {
    setDraftSnapshot(String(data?.bankSnapshot?.balance ?? ""));
    setSnapshotOpen(true);
  };
  const saveSnapshot = () => {
    setBankSnapshot.mutate(
      { data: { balance: draftSnapshot } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Bank snapshot saved" });
          setSnapshotOpen(false);
        },
      },
    );
  };
  // Task #546 — share the same account-aware "doesn't have a refreshable
  // balance" toast that the Chase / Transactions page uses (Task #385) so
  // users hitting Plaid-no-balance from the Forecast refresh or
  // link-checking flow see the friendly next step (set the balance
  // manually) instead of the raw "Plaid did not return a balance" string.
  const showNoBalanceOrGenericToast = (
    e: unknown,
    fallbackTitle: string,
  ): boolean => {
    const data = (e as { data?: unknown }).data as
      | {
          code?: string;
          error?: string;
          account?: { name?: string | null; mask?: string | null };
        }
      | undefined;
    const acct = data?.account ?? null;
    const acctLabel = acct
      ? [acct.name ?? "this account", acct.mask ? `••${acct.mask}` : null]
          .filter(Boolean)
          .join(" ")
      : "this account";
    if (data?.code === "no_balance") {
      toast({
        title: `${acctLabel} doesn't have a refreshable balance`,
        description:
          "Plaid didn't return a current balance for this account (often the case with brokerage or sub-accounts). Set the balance manually below, or relink the bank.",
        variant: "destructive",
        action: (
          <ToastAction
            altText="Set bank balance manually"
            data-testid="action-forecast-refresh-bank-set-manual"
            onClick={openSnapshot}
          >
            Set manually
          </ToastAction>
        ),
      });
      return true;
    }
    toast({
      title: fallbackTitle,
      description: (e as Error).message,
      variant: "destructive",
    });
    return false;
  };
  const onLinkChecking = (plaidAccountId: string) => {
    setBankSnapshot.mutate(
      { data: { plaidAccountId } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Linked checking account · pulled live balance" });
        },
        onError: (e) => {
          showNoBalanceOrGenericToast(e, "Couldn't link account");
        },
      },
    );
  };
  const onRefreshBank = () => {
    refreshBank.mutate({ data: {} }, {
      onSuccess: () => {
        invalidate();
        toast({ title: "Bank balance refreshed" });
      },
      onError: (e) => {
        showNoBalanceOrGenericToast(e, "Refresh failed");
      },
    });
  };

  // (#804 — Phase F) Flatten locked-week actual points into a
  // date→balance map so we can overlay an "actual" series on the
  // forecast chart for any week the user has locked. Forecast curve
  // itself is already frozen server-side for these dates (cashSignal
  // substitutes varianceSnapshot.plans for live recurring expansion),
  // so the two lines together honestly show "what we planned" vs.
  // "what really happened" without retroactively shifting when
  // recurring items get edited later.
  // NOTE: must be declared BEFORE the loading early-return below so
  // the hook count is stable across the !data render and the loaded
  // render — otherwise React throws "Rendered more hooks than during
  // the previous render" once `data` arrives.
  const lockedActualByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const lw of data?.lockedWeeks ?? []) {
      for (const p of lw.actualPoints ?? []) {
        const n = Number(p.balance);
        if (Number.isFinite(n)) m.set(p.date, n);
      }
    }
    return m;
  }, [data?.lockedWeeks]);

  // Gate on data only — global keepPreviousData keeps the previous
  // month's forecast visible during refetches so we never flash a
  // skeleton after the first load.
  if (!data || !register) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const isClosed = closedMonths.has(monthFilter);
  const activeCard = activeDragId
    ? inbox.find((c) => c.id === activeDragId) ?? null
    : null;

  const proj = cashProjection;
  const endingNum = proj?.endingBalance ? Number(proj.endingBalance) : NaN;
  const lowestNum = proj?.lowestProjected ? Number(proj.lowestProjected) : NaN;
  const hasLockedActual = lockedActualByDate.size > 0;
  const dailySeries = (proj?.daily ?? [])
    .map((d: { date: string; balance: string | number }) => {
      const rawDate = d.date;
      const actual = lockedActualByDate.get(rawDate);
      return {
        date: shortDate(rawDate),
        rawDate,
        balance: Number(d.balance),
        actual: actual != null && Number.isFinite(actual) ? actual : null,
      };
    })
    .filter((d) => Number.isFinite(d.balance));
  const cashBufferNum = proj?.cashBuffer ? Number(proj.cashBuffer) : NaN;
  const lowestPoint = (() => {
    if (!proj?.lowestDate || !Number.isFinite(lowestNum)) return null;
    const match = dailySeries.find((d) => d.rawDate === proj.lowestDate);
    if (!match) return null;
    return { x: match.rawDate, y: lowestNum, rawDate: match.rawDate };
  })();

  // Big-bill markers: group expense events by day, then call out the days
  // whose total outflow is large enough to actually move the chart — at
  // least half the cash buffer (or $100 when no buffer is set), capped to
  // the top 5 by amount so a long horizon doesn't get peppered with dots.
  const bigBillMarkers = (() => {
    const evs = proj?.events ?? [];
    if (evs.length === 0 || dailySeries.length === 0) return [];
    const dailyByDate = new Map(dailySeries.map((d) => [d.rawDate, d.balance]));
    const byDate = new Map<
      string,
      {
        total: number;
        bills: Array<{ label: string; amount: number; itemId?: string }>;
      }
    >();
    for (const e of evs) {
      const amt = Number(e.amount);
      if (!Number.isFinite(amt) || amt >= 0) continue;
      if (!dailyByDate.has(e.date)) continue;
      const slot = byDate.get(e.date) ?? { total: 0, bills: [] };
      slot.total += amt;
      slot.bills.push({ label: e.label, amount: amt, itemId: e.itemId });
      byDate.set(e.date, slot);
    }
    const bufferThreshold =
      Number.isFinite(cashBufferNum) && cashBufferNum > 0
        ? cashBufferNum * 0.5
        : 100;
    const candidates = Array.from(byDate.entries())
      .map(([date, slot]) => ({
        date,
        total: slot.total,
        bills: slot.bills.sort((a, b) => a.amount - b.amount),
        balance: dailyByDate.get(date) ?? 0,
      }))
      .filter((c) => Math.abs(c.total) >= bufferThreshold)
      .sort((a, b) => a.total - b.total)
      .slice(0, 5);
    return candidates;
  })();
  const bigBillByDate = new Map(bigBillMarkers.map((m) => [m.date, m]));

  // Per-day index of EVERY expense event the cash signal returned (not
  // just "big bill" days). Used by the chart tooltip so hovering on any
  // point clearly surfaces which pending plans are dragging that day's
  // projected balance — addresses the "are pending transactions actually
  // affecting the line?" confusion.
  const eventsByDate = (() => {
    const evs = proj?.events ?? [];
    const map = new Map<
      string,
      Array<{
        label: string;
        amount: number;
        itemId?: string;
        // (#650) True iff the cash signal pulled this event forward
        // onto `date` from a pre-snapshot pending plan. The chart
        // tooltip uses this flag to keep the "Pending plans dragging
        // this day" list focused on the actual drag — bills naturally
        // due today do NOT belong in that section.
        dragged: boolean;
        originalDate?: string;
      }>
    >();
    for (const e of evs) {
      const amt = Number(e.amount);
      if (!Number.isFinite(amt) || amt >= 0) continue;
      const slot = map.get(e.date) ?? [];
      const orig = (e as { originalDate?: string }).originalDate;
      slot.push({
        label: e.label,
        amount: amt,
        itemId: e.itemId,
        dragged: !!orig && orig !== e.date,
        originalDate: orig,
      });
      map.set(e.date, slot);
    }
    for (const [, list] of map) list.sort((a, b) => a.amount - b.amount);
    return map;
  })();

  // (#683) Past-due plans dragging tomorrow's projection. The cash signal
  // collapses every still-pending pre-snapshot/today expense onto
  // today+1; expose those plans as a discoverable summary card so users
  // understand why tomorrow looks lower than the calendar would suggest.
  // All dragged events share the same `date` (today+1) and carry their
  // original scheduled date in `originalDate`.
  const draggingPlans = (() => {
    const evs = proj?.events ?? [];
    type Row = {
      itemId: string;
      label: string;
      amount: number;
      originalDate: string;
      effectiveDate: string;
    };
    const rows: Row[] = [];
    for (const e of evs) {
      const orig = (e as { originalDate?: string }).originalDate;
      if (!orig || orig === e.date) continue;
      const amt = Number(e.amount);
      if (!Number.isFinite(amt) || amt >= 0) continue;
      rows.push({
        itemId: e.itemId ?? "",
        label: e.label,
        amount: amt,
        originalDate: orig,
        effectiveDate: e.date,
      });
    }
    rows.sort((a, b) =>
      a.originalDate < b.originalDate
        ? -1
        : a.originalDate > b.originalDate
          ? 1
          : a.amount - b.amount,
    );
    return rows;
  })();
  const draggingTotal = draggingPlans.reduce((s, r) => s + r.amount, 0);
  const draggingTargetDate = draggingPlans[0]?.effectiveDate ?? null;

  return (
    <div className="space-y-6">
      <PlaidReauthBanner />
      <div ref={pageStickyHeaderRef} className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-2 md:pt-3 pb-2 bg-background border-b shadow-sm space-y-2">
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium leading-none">
            Section IV — Forecast
          </div>
          <h1 className="text-lg font-serif font-bold text-foreground tracking-tight mt-0.5 leading-tight">
            Plan register — you decide every match.
          </h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" asChild className="h-8">
            <Link href="/bills" data-testid="link-manage-bills">
              Manage in Bills
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => openSettings()} className="h-8">
            <SettingsIcon className="w-3.5 h-3.5 mr-1.5" /> Settings
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap" data-testid="horizon-tabs">
        {HORIZON_OPTS.map((h) => {
          const active = horizonDays === h.days;
          // (#618) The active button shows a subtle spinner while the new
          // horizon's data + register are still being computed in the
          // background — the previous register stays on screen meanwhile
          // (global `keepPreviousData`), so the page never goes blank.
          const showPending = active && horizonSwitchPending;
          return (
            <Button
              key={h.label}
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => setHorizonDays(h.days)}
              className="text-xs tracking-wider h-7 px-2.5"
              data-testid={`horizon-${h.days}`}
              data-pending={showPending ? "true" : undefined}
              aria-busy={showPending || undefined}
            >
              {h.label}
              {showPending && (
                <RefreshCw
                  className="w-3 h-3 ml-1.5 animate-spin"
                  data-testid={`horizon-${h.days}-pending`}
                  aria-hidden="true"
                />
              )}
            </Button>
          );
        })}
        {/* (#650 follow-up) Look-back toggle. Default chart starts at
            today; clicking this reveals a date picker so the user can
            rewind the chart to a historical start date when needed. */}
        <Button
          variant={lookbackOpen ? "default" : "outline"}
          size="sm"
          onClick={() => {
            const next = !lookbackOpen;
            setLookbackOpen(next);
            // Closing the panel snaps the chart back to today so the
            // forecast keeps moving forward.
            if (!next) setForecastFromDate(todayISO());
          }}
          className="text-xs tracking-wider h-7 px-2.5"
          data-testid="toggle-forecast-lookback"
          aria-expanded={lookbackOpen}
          aria-controls="forecast-lookback-panel"
        >
          <CalendarDays className="w-3 h-3 mr-1.5" aria-hidden="true" />
          LOOK BACK
        </Button>
        {lookbackOpen && (
          <div
            id="forecast-lookback-panel"
            className="flex items-center gap-2"
            data-testid="forecast-lookback-panel"
          >
            <Label htmlFor="forecast-from" className="text-xs text-muted-foreground">
              Start
            </Label>
            <Input
              id="forecast-from"
              type="date"
              value={forecastFromDate}
              min={FORECAST_MIN_FROM_DATE}
              max={todayISO()}
              onChange={(e) => setForecastFromDate(clampForecastFrom(e.target.value))}
              className="h-7 w-[150px] text-xs"
              data-testid="input-forecast-from"
              data-pending={fromDateSwitchPending ? "true" : undefined}
              aria-busy={fromDateSwitchPending || undefined}
            />
            {fromDateSwitchPending && (
              <RefreshCw
                className="w-3 h-3 animate-spin text-muted-foreground"
                data-testid="forecast-from-pending"
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </div>

      {mode === "overall" && (
      /* Hero: Current Forecast Balance */
      <Card data-testid="card-forecast-hero" className="border-2">
        <CardContent className="p-3">
          <div className="flex justify-between items-center gap-4 flex-wrap">
            <div className="space-y-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium leading-none">
                Current Forecast Balance
              </div>
              <div
                className={`text-3xl font-bold tabular-nums leading-tight ${
                  Number.isFinite(endingNum) && endingNum < 0
                    ? "text-destructive"
                    : "text-foreground"
                }`}
                data-testid="hero-forecast-balance"
              >
                {Number.isFinite(endingNum)
                  ? formatCurrency(endingNum)
                  : formatCurrency(0)}
              </div>
              <div className="text-xs text-muted-foreground leading-snug">
                <div>
                  Bank balance before {formatDate(forecastFromDate)}:{" "}
                  <span className="tabular-nums font-medium text-foreground">
                    {formatCurrency(proj?.startingBalance ?? "0")}
                  </span>
                </div>
                <div>
                  Accepted / matched impact:{" "}
                  <span className="tabular-nums font-medium text-foreground">
                    {formatCurrency(proj?.acceptedImpact ?? "0")}
                  </span>
                </div>
                <div>
                  Target bank balance through{" "}
                  {formatDate(proj?.endingDate ?? proj?.toDate ?? forecastFromDate)}:{" "}
                  <span className="tabular-nums font-medium text-foreground">
                    {formatCurrency(proj?.endingBalance ?? "0")}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2 text-xs">
              {inboxCount === 0 && reconciledNow && (
                <Badge
                  className="bg-primary/15 text-primary border-primary/30"
                  data-testid="badge-inbox-cleared"
                >
                  <PartyPopper className="w-3.5 h-3.5 mr-1" /> Inbox cleared
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      )}
      </div>

      {mode === "overall" && (<>
      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card data-testid="kpi-lowest-point">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Lowest Point
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold tabular-nums ${
                Number.isFinite(lowestNum) &&
                lowestNum < Number(proj?.cashBuffer ?? 0)
                  ? "text-destructive"
                  : ""
              }`}
            >
              {Number.isFinite(lowestNum)
                ? formatCurrency(lowestNum)
                : formatCurrency(0)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {proj?.lowestDate ? `on ${formatDate(proj.lowestDate)}` : "—"}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-ending-balance">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Ending Balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatCurrency(proj?.endingBalance ?? "0")}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {proj?.endingDate
                ? `on ${formatDate(proj.endingDate)}`
                : `${horizonDays}-day horizon`}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-projected-income">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Projected Income
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums text-[hsl(var(--positive))]">
              {formatCurrency(proj?.projectedIncome ?? "0")}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              over {horizonDays} days
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-projected-expenses">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
              Projected Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatCurrency(proj?.projectedExpenses ?? "0")}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              over {horizonDays} days
            </div>
          </CardContent>
        </Card>
      </div>

      {/* (#683) Past-due plans dragging tomorrow — discoverable summary */}
      {draggingPlans.length > 0 && draggingTargetDate && (
        <Card
          data-testid="card-dragging-plans-summary"
          className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-900"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-900 dark:text-amber-100">
              <AlertCircle className="w-4 h-4" />
              <span>
                {draggingPlans.length === 1
                  ? "1 past-due plan is weighing on"
                  : `${draggingPlans.length} past-due plans are weighing on`}{" "}
                {formatDate(draggingTargetDate)}
              </span>
              <span
                className="ml-auto tabular-nums text-amber-900 dark:text-amber-100"
                data-testid="dragging-plans-total"
              >
                {formatCurrency(draggingTotal)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-amber-900/80 dark:text-amber-100/80 mb-2">
              These plans were due earlier but haven't been matched, missed,
              or skipped yet — so the projection keeps them on{" "}
              {formatDate(draggingTargetDate)} until you resolve them.
            </p>
            <ul
              className="divide-y divide-amber-200 dark:divide-amber-900 rounded-md border border-amber-200 dark:border-amber-900 bg-background"
              data-testid="dragging-plans-list"
            >
              {draggingPlans.map((row) => {
                const planLine: PlanLine = {
                  kind: "plan",
                  date: row.effectiveDate,
                  itemId: row.itemId,
                  label: row.label,
                  amount: row.amount,
                  status: "pending_plan",
                  originalDate: row.originalDate,
                };
                return (
                  <li
                    key={`${row.itemId}|${row.originalDate}`}
                    data-testid={`dragging-plan-${row.itemId}-${row.originalDate}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 flex-wrap"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        jumpToPlan(row.itemId, row.originalDate)
                      }
                      className="flex items-center justify-between gap-3 flex-1 min-w-0 text-left hover:bg-amber-50 dark:hover:bg-amber-950/30 focus-visible:bg-amber-50 dark:focus-visible:bg-amber-950/30 rounded-sm -mx-1 px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                      title={`Jump to ${row.label} in the planned-items register`}
                      data-testid={`dragging-plan-jump-${row.itemId}-${row.originalDate}`}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {row.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Originally due {formatDate(row.originalDate)}
                        </div>
                      </div>
                      <span className="text-sm font-medium tabular-nums text-destructive">
                        {formatCurrency(row.amount)}
                      </span>
                    </button>
                    <div
                      className="flex items-center gap-1.5 flex-wrap"
                      data-testid={`dragging-plan-actions-${row.itemId}-${row.originalDate}`}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={upsertResolution.isPending}
                        onClick={() => onMarkMissed(planLine)}
                        data-testid={`dragging-plan-mark-missed-${row.itemId}-${row.originalDate}`}
                        title="Mark this past-due plan as missed"
                      >
                        Mark missed
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={upsertResolution.isPending}
                        onClick={() => onSkipDraggingPlan(row)}
                        data-testid={`dragging-plan-skip-${row.itemId}-${row.originalDate}`}
                        title="Skip this occurrence — it won't drag the projection"
                      >
                        Skip
                      </Button>
                      <Select
                        onValueChange={(v) => {
                          const card = bankInbox.find(
                            (c) => c.bank.txn.id === v,
                          );
                          if (card)
                            matchInboxToPlan(card.bank.txn.id, planLine);
                        }}
                        disabled={
                          upsertResolution.isPending || bankInbox.length === 0
                        }
                      >
                        <SelectTrigger
                          className="h-7 w-[170px] text-xs"
                          data-testid={`dragging-plan-match-trigger-${row.itemId}-${row.originalDate}`}
                          title={
                            bankInbox.length === 0
                              ? "No pending bank transactions to match"
                              : "Match this plan to a pending bank transaction"
                          }
                        >
                          <SelectValue placeholder="Mark matched to…" />
                        </SelectTrigger>
                        <SelectContent>
                          {bankInbox.length === 0 && (
                            <div className="px-2 py-1 text-xs text-muted-foreground">
                              No pending bank txns
                            </div>
                          )}
                          {bankInbox.map((c) => (
                            <SelectItem
                              key={c.bank.txn.id}
                              value={c.bank.txn.id}
                              data-testid={`dragging-plan-match-option-${row.itemId}-${row.originalDate}-${c.bank.txn.id}`}
                            >
                              {c.bank.txn.description} ·{" "}
                              {formatDate(c.bank.date)} ·{" "}
                              {formatCurrency(c.bank.amount)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Projected Balance area chart */}
      <Card data-testid="card-projected-balance-chart">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Projected Balance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[280px] w-full">
            {cashProjectionLoading && dailySeries.length === 0 ? (
              <Skeleton className="h-full w-full" />
            ) : dailySeries.length === 0 || proj?.status === "no_data" ? (
              <div
                className="h-full w-full flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground text-center px-4"
                data-testid="empty-projected-balance"
              >
                <p>
                  All clear — set a bank snapshot or add planned items to
                  draw your projected balance.
                </p>
                <Button
                  size="sm"
                  onClick={openSnapshot}
                  data-testid="button-empty-set-bank-snapshot"
                >
                  Set bank snapshot
                </Button>
              </div>
            ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={dailySeries}
                margin={{ top: 10, right: 16, bottom: 16, left: 0 }}
              >
                <defs>
                  <linearGradient id="projectedBalanceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                <XAxis
                  dataKey="rawDate"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: string) => shortDate(v)}
                  interval="preserveStartEnd"
                  minTickGap={32}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => `$${Math.round(v)}`}
                  width={60}
                />
                <RechartsTooltip
                  // Allow the user to click bill names inside the tooltip
                  // to deep-link into the register below (#335).
                  wrapperStyle={{ pointerEvents: "auto" }}
                  content={({ active, payload }: { active?: boolean; payload?: any[] }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const p = payload[0]?.payload as
                      | {
                          rawDate?: string;
                          balance?: number;
                          actual?: number | null;
                        }
                      | undefined;
                    const rawDate = p?.rawDate;
                    const balance = Number(p?.balance);
                    // (#804 — Phase F) When this day falls inside a
                    // locked week the bundle ships an `actual` balance
                    // — show forecast / actual / Δ side-by-side so the
                    // user can see how reality came in relative to the
                    // frozen plan.
                    const actualRaw = p?.actual;
                    const hasActual =
                      actualRaw != null && Number.isFinite(Number(actualRaw));
                    const actualNum = hasActual ? Number(actualRaw) : NaN;
                    const deltaNum = hasActual ? actualNum - balance : NaN;
                    const marker = rawDate ? bigBillByDate.get(rawDate) : undefined;
                    const dayEvents = rawDate ? eventsByDate.get(rawDate) : undefined;
                    const dayTotal = dayEvents
                      ? dayEvents.reduce((s, b) => s + b.amount, 0)
                      : 0;
                    return (
                      <div
                        style={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--card-border))",
                          color: "hsl(var(--card-foreground))",
                          borderRadius: 6,
                          fontSize: 12,
                          padding: "8px 10px",
                          minWidth: 160,
                          boxShadow: "var(--shadow-md)",
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>
                          {rawDate ? formatDate(rawDate) : ""}
                        </div>
                        <div style={{ marginTop: 2 }}>
                          {hasActual ? "Forecast:" : "Balance:"}{" "}
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            {Number.isFinite(balance)
                              ? formatCurrency(balance)
                              : "—"}
                          </span>
                        </div>
                        {hasActual && (
                          <>
                            <div
                              style={{ marginTop: 2 }}
                              data-testid={`tooltip-actual-${rawDate}`}
                            >
                              Actual:{" "}
                              <span
                                style={{
                                  fontVariantNumeric: "tabular-nums",
                                  color: "hsl(var(--chart-3))",
                                  fontWeight: 600,
                                }}
                              >
                                {formatCurrency(actualNum)}
                              </span>
                            </div>
                            <div
                              style={{ marginTop: 2 }}
                              data-testid={`tooltip-delta-${rawDate}`}
                            >
                              Δ:{" "}
                              <span
                                style={{
                                  fontVariantNumeric: "tabular-nums",
                                  color:
                                    deltaNum >= 0
                                      ? "hsl(var(--chart-3))"
                                      : "hsl(var(--destructive))",
                                  fontWeight: 600,
                                }}
                              >
                                {deltaNum >= 0 ? "+" : ""}
                                {formatCurrency(deltaNum)}
                              </span>
                            </div>
                          </>
                        )}
                        {dayEvents && dayEvents.length > 0 && rawDate && (() => {
                          // (#650) Split this day's events into two
                          // groups so the "dragging" section only lists
                          // items that were actually pulled forward
                          // from a pre-snapshot pending plan. Bills
                          // naturally due on this calendar day go
                          // under "Bills due this day" instead.
                          const dragged = dayEvents.filter((b) => b.dragged);
                          const dueToday = dayEvents.filter((b) => !b.dragged);
                          const sections: Array<{
                            title: string;
                            bills: typeof dayEvents;
                          }> = [];
                          if (dragged.length > 0) {
                            sections.push({
                              title: "Pending plans dragging this day",
                              bills: dragged,
                            });
                          }
                          if (dueToday.length > 0) {
                            sections.push({
                              title: "Bills due this day",
                              bills: dueToday,
                            });
                          }
                          return sections.map((section, sIdx) => (
                          <div
                            key={section.title}
                            style={{ marginTop: sIdx === 0 ? 6 : 8 }}
                          >
                            <div
                              style={{
                                fontSize: 10,
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                                color: "hsl(var(--muted-foreground))",
                                marginBottom: 4,
                              }}
                            >
                              {section.title}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 2,
                              }}
                            >
                              {section.bills.map((b, idx) => {
                                const canJump = !!b.itemId;
                                // (#682) Per-plan "Mark missed" is only
                                // surfaced for dragged rows — that's the
                                // recurring source of the day-1 dip the
                                // tooltip exists to explain. Bills
                                // naturally due today are handled by the
                                // planned-items register below.
                                const canMarkMissed =
                                  !!b.itemId && !!b.originalDate && b.dragged;
                                return (
                                  <div
                                    key={`${b.itemId ?? "_"}-${idx}`}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 6,
                                      padding: "2px 4px",
                                      borderRadius: 4,
                                    }}
                                    onMouseEnter={(e) => {
                                      (e.currentTarget as HTMLElement).style.background =
                                        "hsl(var(--muted))";
                                    }}
                                    onMouseLeave={(e) => {
                                      (e.currentTarget as HTMLElement).style.background =
                                        "transparent";
                                    }}
                                  >
                                    <button
                                      type="button"
                                      disabled={!canJump}
                                      onClick={() => {
                                        if (b.itemId)
                                          jumpToPlan(b.itemId, rawDate);
                                      }}
                                      data-testid={`tooltip-bill-${rawDate}-${b.itemId ?? idx}`}
                                      style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        gap: 12,
                                        flex: 1,
                                        minWidth: 0,
                                        border: "none",
                                        background: "transparent",
                                        cursor: canJump ? "pointer" : "default",
                                        textAlign: "left",
                                        color: "inherit",
                                        font: "inherit",
                                        padding: 0,
                                      }}
                                    >
                                      <span style={{ minWidth: 0 }}>{b.label}</span>
                                      <span style={{ fontVariantNumeric: "tabular-nums" }}>
                                        {formatCurrency(b.amount)}
                                      </span>
                                    </button>
                                    {canMarkMissed && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          // Construct a real PlanLine
                                          // (no type cast) — onMarkMissed
                                          // consumes status, itemId,
                                          // originalDate/date, and label.
                                          onMarkMissed({
                                            kind: "plan",
                                            itemId: b.itemId!,
                                            label: b.label,
                                            amount: b.amount,
                                            date: rawDate,
                                            originalDate: b.originalDate!,
                                            status: "pending_plan",
                                          });
                                        }}
                                        data-testid={`tooltip-mark-missed-${b.itemId}-${b.originalDate}`}
                                        title="Mark this past-due plan as missed so it stops dragging the projection"
                                        style={{
                                          fontSize: 10,
                                          textTransform: "uppercase",
                                          letterSpacing: "0.04em",
                                          color: "hsl(var(--destructive))",
                                          border: "1px solid hsl(var(--destructive) / 0.4)",
                                          background: "transparent",
                                          borderRadius: 3,
                                          padding: "1px 6px",
                                          cursor: "pointer",
                                          whiteSpace: "nowrap",
                                          font: "inherit",
                                          fontWeight: 600,
                                        }}
                                      >
                                        Mark missed
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                          ));
                        })()}
                      </div>
                    );
                  }}
                />
                {hasLockedActual && (
                  <Legend
                    verticalAlign="top"
                    height={24}
                    iconType="plainline"
                    wrapperStyle={{ fontSize: 11 }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke="hsl(var(--chart-1))"
                  strokeWidth={2}
                  fill="url(#projectedBalanceGrad)"
                  name="Forecast"
                  isAnimationActive={false}
                />
                {/* (#804 — Phase F) Actual checking balance overlay for
                    weeks the user has locked. `connectNulls=false` so
                    the line only draws across locked-week dates and
                    doesn't visually imply data we don't have for
                    unlocked windows. */}
                {hasLockedActual && (
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="hsl(var(--chart-3))"
                    strokeWidth={2.5}
                    dot={false}
                    connectNulls={false}
                    name="Actual (locked)"
                    isAnimationActive={false}
                    data-testid="line-actual-locked"
                  />
                )}
                {Number.isFinite(cashBufferNum) && (
                  <ReferenceLine
                    y={cashBufferNum}
                    stroke="hsl(var(--destructive))"
                    strokeDasharray="4 4"
                    strokeWidth={1.5}
                    ifOverflow="extendDomain"
                    data-testid="ref-cash-buffer"
                  >
                    <RechartsLabel
                      value={`Cash buffer ${formatCurrency(cashBufferNum)}`}
                      position="insideTopRight"
                      fill="hsl(var(--destructive))"
                      fontSize={10}
                    />
                  </ReferenceLine>
                )}
                {bigBillMarkers.map((m) => {
                  const top = m.bills.find((b) => !!b.itemId) ?? m.bills[0];
                  return (
                    <ReferenceDot
                      key={`big-bill-${m.date}`}
                      x={m.date}
                      y={m.balance}
                      r={6}
                      fill="hsl(var(--chart-1))"
                      stroke="hsl(var(--background))"
                      strokeWidth={1.5}
                      ifOverflow="extendDomain"
                      isFront
                      data-testid={`big-bill-marker-${m.date}`}
                      cursor={top?.itemId ? "pointer" : undefined}
                      onClick={() => {
                        if (top?.itemId) jumpToPlan(top.itemId, m.date);
                      }}
                    />
                  );
                })}
                {lowestPoint && (
                  <ReferenceDot
                    x={lowestPoint.x}
                    y={lowestPoint.y}
                    r={5}
                    fill="hsl(var(--destructive))"
                    stroke="hsl(var(--background))"
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                    isFront
                    data-testid="ref-lowest-point"
                  >
                    <RechartsLabel
                      value={`Lowest ${formatCurrency(lowestPoint.y)} · ${formatDate(lowestPoint.rawDate)}`}
                      position="top"
                      fill="hsl(var(--destructive))"
                      fontSize={11}
                      fontWeight={600}
                    />
                  </ReferenceDot>
                )}
              </AreaChart>
            </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Bank snapshot + Avalanche cards (kept below the new summary) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card data-testid="card-bank-snapshot">
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
              <Landmark className="w-4 h-4" /> Bank balance
            </CardTitle>
            {data.bankSnapshot && data.bankSnapshot.source === "plaid" && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={onRefreshBank}
                disabled={refreshBank.isPending}
                title="Refresh from Plaid"
              >
                <RefreshCw
                  className={`w-4 h-4 ${refreshBank.isPending ? "animate-spin" : ""}`}
                />
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            <div
              className="text-2xl font-bold tabular-nums"
              data-testid="text-bank-balance"
            >
              {data.bankSnapshot
                ? formatCurrency(data.bankSnapshot.balance)
                : formatCurrency(data.settings.startingBalance)}
            </div>
            <div
              className="text-xs text-muted-foreground"
              data-testid="text-bank-snapshot-meta"
            >
              {data.bankSnapshot ? (
                <>
                  {data.bankSnapshot.source === "plaid" ? "Plaid" : "Manual"} ·{" "}
                  {data.bankSnapshot.name ?? "Checking"}
                  {data.bankSnapshot.mask ? ` ••${data.bankSnapshot.mask}` : ""} ·{" "}
                  {formatDate(data.bankSnapshot.at.slice(0, 10))}
                  <BankSnapshotFreshness
                    source={data.bankSnapshot.source}
                    at={data.bankSnapshot.at}
                  />
                </>
              ) : (
                <>No snapshot — using starting balance</>
              )}
            </div>
            <div className="flex gap-2 pt-1 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={openSnapshot}
                data-testid="button-set-bank-snapshot"
              >
                Set manually
              </Button>
              {data.plaidCheckingAccounts.length > 0 && (
                <Select onValueChange={onLinkChecking}>
                  <SelectTrigger className="h-8 w-44 text-xs">
                    <SelectValue placeholder="Link a checking account" />
                  </SelectTrigger>
                  <SelectContent>
                    {data.plaidCheckingAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.institutionName ?? a.name ?? "Bank"}
                        {a.mask ? ` ••${a.mask}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </CardContent>
        </Card>
        <AvalancheScheduleCard />
      </div>
      </>)}

      {mode === "review" && bankInbox.length === 0 && (
        // Single-flow restore: a forecast-flagged checking txn IS in
        // Review, so an empty Review just means nothing's flagged /
        // everything's matched. One honest empty state, pointing back
        // to Chase to send more to Forecast.
        <Card
          className="border-primary/30 bg-primary/5"
          data-testid="review-empty-state"
        >
          <CardContent className="p-6 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 text-primary" />
              <span className="font-medium">All caught up — Review is empty.</span>
              <span className="text-muted-foreground">
                Send a Chase transaction to Forecast to start reviewing.
              </span>
            </div>
            <Button asChild size="sm" variant="outline" className="h-8">
              <Link href="/transactions" data-testid="link-open-chase">
                Open Chase →
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {mode === "overall" && bankInbox.length > 0 && (
        <Card
          className="border-amber-200 bg-amber-50/60 dark:bg-amber-950/30"
          data-testid="banner-review-waiting"
        >
          <CardContent className="p-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm min-w-0">
              <InboxIcon className="w-4 h-4 text-amber-700 dark:text-amber-300 flex-none" />
              <span className="font-medium text-amber-900 dark:text-amber-100">
                {bankInbox.length} waiting in Review
              </span>
              <span className="text-xs text-amber-800/80 dark:text-amber-200/80 truncate">
                Match Chase activity against your planned items.
              </span>
            </div>
            <Button asChild size="sm" variant="outline" className="h-8">
              <Link href="/review" data-testid="link-go-to-review">
                Go to Review →
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveDragId(null)}
      >
        {mode === "review" && (
          <Card data-testid="card-from-bank">
              <CardHeader className="pb-3 flex-row items-center justify-between flex-wrap gap-2">
                <CardTitle className="flex items-center gap-2 flex-wrap">
                  <Landmark className="w-4 h-4" />
                  Inbox from Chase · {monthFilter}
                  <Badge variant="outline" className="text-[10px] ml-1">
                    {bankReconcile.pending} pending
                  </Badge>
                  <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/20">
                    {bankReconcile.matched} matched
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {bankReconcile.unplanned} unplanned
                  </Badge>
                </CardTitle>
                <div className="flex items-center gap-2">
                  {bankReconcile.hasBank && !bankReconcile.isPriorMonth && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      Forecast end {formatCurrency(bankReconcile.forecastEnd)} ·
                      Bank now {formatCurrency(bankReconcile.bankEnd)}
                    </span>
                  )}
                  {bankReconcile.isPriorMonth && (
                    <span className="text-xs text-muted-foreground">
                      Prior period — counts only
                    </span>
                  )}
                  {confidentMatches.length > 0 && (
                    <Button
                      size="sm"
                      onClick={bulkMatchConfident}
                      disabled={upsertResolution.isPending}
                      data-testid="bulk-match-confident"
                    >
                      <Sparkles className="w-3.5 h-3.5 mr-1" />
                      Match all confident ({confidentMatches.length})
                    </Button>
                  )}
                  {bankInbox.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={bulkMarkBankUnplanned}
                      disabled={upsertResolution.isPending}
                      data-testid="bulk-mark-unplanned"
                    >
                      Mark all unplanned
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {/* (#456) First-time drag-to-match callout. Only shown when
                    the user has at least one unresolved inbox row to act on
                    AND hasn't dismissed the hint yet. */}
                {!dragHintDismissed && bankInbox.length > 0 && (
                  <div
                    className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100"
                    data-testid="drag-to-match-hint"
                    role="note"
                  >
                    <GripVertical className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <span className="font-medium">Tip:</span> drag any inbox
                      row onto a planned item to match it — even when there's
                      no suggestion.
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs -my-1"
                      onClick={dismissDragHint}
                      data-testid="drag-to-match-hint-dismiss"
                      aria-label="Dismiss drag-to-match tip"
                    >
                      Got it
                    </Button>
                  </div>
                )}
                {/* (#27) Selection-scoped bulk bar */}
                {selectedBankIds.size > 0 && (
                  <div
                    className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
                    data-testid="bank-inbox-selection-bar"
                  >
                    <span className="text-xs font-medium">
                      {selectedBankIds.size} selected
                    </span>
                    {(() => {
                      const matchableCount = confidentMatches.filter((m) =>
                        selectedBankIds.has(m.txnId),
                      ).length;
                      return matchableCount > 0 ? (
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={bulkMatchConfidentSelected}
                          disabled={upsertResolution.isPending}
                          data-testid="bulk-match-confident-selected"
                        >
                          <Sparkles className="w-3 h-3 mr-1" />
                          Match {matchableCount} confident
                        </Button>
                      ) : null;
                    })()}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={bulkMarkBankUnplannedSelected}
                      disabled={upsertResolution.isPending}
                      data-testid="bulk-mark-unplanned-selected"
                    >
                      Mark {selectedBankIds.size} unplanned
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs ml-auto"
                      onClick={clearBankSelection}
                      data-testid="bank-inbox-clear-selection"
                    >
                      Clear
                    </Button>
                  </div>
                )}
                {bankInbox.length === 0 && (
                  <div className="py-2.5 text-center text-xs text-muted-foreground">
                    {isReconciledToBank ? (
                      <span className="inline-flex items-center gap-1.5 text-primary">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Reconciled to bank
                        for {monthFilter}.
                      </span>
                    ) : (
                      <>Send a bank transaction from the Transactions page to start reconciling.</>
                    )}
                  </div>
                )}
                {bankResolvedThisMonth.length > 0 && (
                  <div
                    className="mt-3 pt-3 border-t"
                    data-testid="bank-resolved-list"
                  >
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                      Resolved this month — undo if needed
                    </div>
                    <div
                      className="space-y-1 max-h-[7.5rem] overflow-y-auto pr-1"
                      data-testid="bank-resolved-list-scroll"
                    >
                    {bankResolvedThisMonth.map((r) => (
                      <div
                        key={r.resolutionId}
                        className="flex items-center gap-2 text-xs rounded-md border bg-muted/30 px-2 py-1"
                      >
                        <Badge
                          variant="outline"
                          className={
                            r.kind === "matched"
                              ? "text-[10px] bg-primary/10 text-primary border-primary/20"
                              : "text-[10px]"
                          }
                        >
                          {r.kind === "matched" ? "matched" : "unplanned"}
                        </Badge>
                        <span className="truncate flex-1">
                          {r.bank.txn.description}
                        </span>
                        <span className="text-muted-foreground">
                          {formatDate(r.bank.date)}
                        </span>
                        <span
                          className={`tabular-nums ${
                            r.bank.amount < 0
                              ? "text-destructive"
                              : "text-primary"
                          }`}
                        >
                          {formatCurrency(r.bank.amount)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => onUndo(r.resolutionId)}
                          data-testid={`undo-resolution-${r.resolutionId}`}
                        >
                          Undo
                        </Button>
                      </div>
                    ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
        )}

        {mode === "review" && bankInbox.length > 0 && (() => {
              // (#517) Pinned active inbox row: pager + InboxCardView +
              // SuggestionStrip stay visible just below the page sticky
              // header while the planned-items list scrolls underneath.
              // (#478) Show one pending row at a time so the forecast
              // underneath stays visible. The pager lets users skip
              // around manually; resolving the visible row naturally
              // advances because the next pending row takes its slot.
              const safeIndex = Math.min(
                Math.max(activeInboxIndex, 0),
                bankInbox.length - 1,
              );
              const card = bankInbox[safeIndex];
              const sugs = bankSuggestions.get(card.bank.txn.id) ?? [];
              const txnId = card.bank.txn.id;
              const isSelected = selectedBankIds.has(txnId);
              const stickyStyle = canPinInbox
                ? { top: pageStickyHeaderHeight }
                : undefined;
              return (
                <div
                  className={
                    canPinInbox
                      ? "sticky z-20 -mx-4 md:-mx-8 px-4 md:px-8 py-2 bg-background/95 supports-[backdrop-filter]:bg-background/80 backdrop-blur border-b shadow-sm"
                      : ""
                  }
                  style={stickyStyle}
                  data-testid="pinned-inbox-area"
                  data-pinned={canPinInbox ? "true" : "false"}
                  data-collapsed={pinnedInboxCollapsed ? "true" : "false"}
                >
                  <div className="rounded-md border bg-card p-2 space-y-2">
                    <div
                      className="flex items-center justify-between gap-2 px-1"
                      data-testid="bank-inbox-pager"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          setActiveInboxIndex((i) => Math.max(0, i - 1))
                        }
                        disabled={safeIndex === 0}
                        data-testid="bank-inbox-pager-prev"
                        aria-label="Previous pending inbox row"
                      >
                        <ChevronLeft className="w-3.5 h-3.5 mr-1" />
                        Prev
                      </Button>
                      <span
                        className="text-xs text-muted-foreground tabular-nums"
                        data-testid="bank-inbox-pager-indicator"
                      >
                        {safeIndex + 1} of {bankInbox.length}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() =>
                            setActiveInboxIndex((i) =>
                              Math.min(bankInbox.length - 1, i + 1),
                            )
                          }
                          disabled={safeIndex >= bankInbox.length - 1}
                          data-testid="bank-inbox-pager-next"
                          aria-label="Next pending inbox row"
                        >
                          Next
                          <ChevronRight className="w-3.5 h-3.5 ml-1" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={togglePinnedInboxCollapsed}
                          data-testid="pinned-inbox-collapse-toggle"
                          aria-label={
                            pinnedInboxCollapsed
                              ? "Expand pinned inbox card"
                              : "Collapse pinned inbox card"
                          }
                          aria-expanded={!pinnedInboxCollapsed}
                          title={
                            pinnedInboxCollapsed
                              ? "Expand pinned inbox card"
                              : "Collapse pinned inbox card"
                          }
                        >
                          {pinnedInboxCollapsed ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronUp className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                    {pinnedInboxCollapsed ? (
                      <div
                        key={card.id}
                        className="flex items-center gap-2 px-1 py-1"
                        data-testid="pinned-inbox-collapsed-row"
                      >
                        <span
                          className="flex-1 truncate text-sm"
                          title={card.bank.txn.description}
                        >
                          {card.bank.txn.description}
                        </span>
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {formatCurrency(card.bank.amount)}
                        </span>
                        {(() => {
                          const oneClick = oneClickByTxnId.get(
                            card.bank.txn.id,
                          );
                          return (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={!oneClick}
                              onClick={() => {
                                if (oneClick) {
                                  matchInboxToPlan(
                                    card.bank.txn.id,
                                    oneClick.plan,
                                  );
                                }
                              }}
                              data-testid="pinned-inbox-collapsed-match"
                              title={
                                oneClick
                                  ? "Match to the suggested plan row"
                                  : "Expand to match this row"
                              }
                            >
                              Match
                            </Button>
                          );
                        })()}
                      </div>
                    ) : (
                    <div key={card.id} className="space-y-1">
                      <div className="flex items-stretch gap-2">
                        <div className="flex items-start pt-3 pl-1">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleBankSelected(txnId)}
                            aria-label={
                              isSelected
                                ? `Unselect ${card.bank.txn.description}`
                                : `Select ${card.bank.txn.description}`
                            }
                            data-testid={`select-bank-${txnId}`}
                          />
                        </div>
                        <div className="flex-1">
                          <InboxCardView
                            card={card}
                            categoryName={
                              card.bank.txn.categoryId
                                ? categoryById.get(card.bank.txn.categoryId) ??
                                  null
                                : null
                            }
                            onUnplanned={() =>
                              onMarkUnplannedTxn(card.bank.txn.id)
                            }
                            onMatchPick={(p) =>
                              matchInboxToPlan(card.bank.txn.id, p)
                            }
                            onAddAsBill={() => openAddAsBill(card)}
                            onHoverChange={(hovered) =>
                              setHoveredCardId((cur) =>
                                hovered ? card.id : cur === card.id ? null : cur,
                              )
                            }
                            planRows={
                              sortedPlansByCard.get(card.bank.txn.id) ??
                              planRows.filter(
                                (r) =>
                                  r.status === "pending_plan" ||
                                  r.status === "future",
                              )
                            }
                            oneClickSuggestion={
                              oneClickByTxnId.get(card.bank.txn.id)?.plan ??
                              null
                            }
                          />
                          <SuggestionStrip
                            suggestions={sugs}
                            txnId={card.bank.txn.id}
                            onPick={(p) =>
                              matchInboxToPlan(card.bank.txn.id, p)
                            }
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            onRemoveFromForecast(card.bank.txn.id)
                          }
                          title="Un-send back to Bank list"
                        >
                          <X className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                    )}
                  </div>
                </div>
              );
            })()}

            <Card>
              <CardHeader className="pb-3 flex-row items-center justify-between flex-wrap gap-2">
                <CardTitle>Planned forecast items</CardTitle>
                {bankReconcile.hasBank && !bankReconcile.isPriorMonth && (
                  <span
                    className="text-xs text-muted-foreground tabular-nums"
                    data-testid="planned-projected-end"
                  >
                    Projected end {formatCurrency(bankReconcile.forecastEnd)}
                  </span>
                )}
              </CardHeader>
              <CardContent className="p-0">
                {planRows.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground">
                    All clear — nothing planned in this window.
                  </div>
                ) : (
                  <PlannedItemsList
                    items={plannedItems}
                    payoffsByItem={payoffsByItem}
                    bestSuggestionPlanKey={bestSuggestionPlanKey}
                    highlightedPlanKey={highlightedPlanKey}
                    activeDragId={activeDragId}
                    onSelectPlan={onSelectPlan}
                    onMoveStart={onMoveStart}
                    onMarkMissed={onMarkMissed}
                  />
                )}
              </CardContent>
            </Card>

            {(() => {
              const missed = bucket.filter((b) => b.status === "missed");
              if (missed.length === 0) return null;
              const missedTotal = missed.reduce((s, b) => s + b.amount, 0);
              return (
                <Card data-testid="missed-bucket-panel">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-600" />
                      Missed in {monthFilter}
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {missed.length}
                      </Badge>
                      <span
                        className={`ml-auto font-medium tabular-nums text-sm ${
                          missedTotal < 0 ? "text-destructive" : "text-primary"
                        }`}
                        data-testid="missed-bucket-total"
                      >
                        {formatCurrency(missedTotal)}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div
                      className="divide-y divide-border max-h-[20rem] overflow-y-auto"
                      data-testid="missed-bucket-scroll"
                    >
                      {missed.map((b) => (
                        <div
                          key={b.id}
                          className="p-4 flex items-center justify-between gap-3"
                          data-testid={`missed-row-${b.id}`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {statusBadge(b.status)}
                            <div className="min-w-0">
                              <div className="font-medium text-sm truncate">
                                {b.label || "—"}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {formatDate(b.date)}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap justify-end">
                            <span
                              className={`font-medium tabular-nums mr-2 ${
                                b.amount < 0 ? "text-destructive" : "text-primary"
                              }`}
                            >
                              {formatCurrency(b.amount)}
                            </span>
                            {b.recurringItemId && b.occurrenceDate && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => onSetNewDateFromBucket(b)}
                                data-testid={`missed-set-new-date-${b.id}`}
                                title="Reschedule this occurrence to another day (next 30 days)"
                              >
                                Set new date
                              </Button>
                            )}
                            {b.recurringItemId && b.occurrenceDate && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                                onClick={() => onSkipFromBucket(b)}
                                data-testid={`missed-skip-${b.id}`}
                                title="Clear this occurrence — won't return or affect the projection"
                              >
                                Skip
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => onUndo(b.id)}
                              data-testid={`missed-undo-${b.id}`}
                            >
                              Undo
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            {(() => {
              const moved = bucket.filter((b) => b.status === "rescheduled");
              if (moved.length === 0) return null;
              const movedTotal = moved.reduce((s, b) => s + b.amount, 0);
              return (
                <Card data-testid="rescheduled-bucket-panel">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <CalendarDays className="w-4 h-4 text-violet-600" />
                      Moved from {monthFilter}
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {moved.length}
                      </Badge>
                      <span
                        className={`ml-auto font-medium tabular-nums text-sm ${
                          movedTotal < 0 ? "text-destructive" : "text-primary"
                        }`}
                        data-testid="rescheduled-bucket-total"
                      >
                        {formatCurrency(movedTotal)}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div
                      className="divide-y divide-border max-h-[20rem] overflow-y-auto"
                      data-testid="rescheduled-bucket-scroll"
                    >
                      {moved.map((b) => (
                        <div
                          key={b.id}
                          className="p-4 flex items-center justify-between gap-3"
                          data-testid={`rescheduled-row-${b.id}`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {statusBadge("rescheduled")}
                            <div className="min-w-0">
                              <div className="font-medium text-sm truncate">
                                {b.label || "—"}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {formatDate(b.date)} → {formatDate(b.rescheduledTo!)}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <span
                              className={`font-medium tabular-nums ${
                                b.amount < 0 ? "text-destructive" : "text-primary"
                              }`}
                            >
                              {formatCurrency(b.amount)}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onUndo(b.id)}
                              data-testid={`rescheduled-undo-${b.id}`}
                            >
                              Undo
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            <DragOverlay>
              {activeCard && (
                <InboxCardView
                  card={activeCard}
                  categoryName={
                    activeCard.bank.txn.categoryId
                      ? categoryById.get(activeCard.bank.txn.categoryId) ?? null
                      : null
                  }
                  onUnplanned={() => undefined}
                  onMatchPick={() => undefined}
                  planRows={[]}
                  isOverlay
                />
              )}
            </DragOverlay>
      </DndContext>

      {mode === "overall" && (
        <div className="space-y-4 mt-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Label className="text-sm">Month</Label>
              {monthSwitchPending && (
                <RefreshCw
                  className="w-3 h-3 animate-spin text-muted-foreground"
                  data-testid="month-filter-pending"
                  aria-hidden="true"
                />
              )}
              <Select value={monthFilter} onValueChange={setMonthFilter}>
                <SelectTrigger
                  className="w-56"
                  data-testid="select-month-filter"
                  data-pending={monthSwitchPending ? "true" : undefined}
                  aria-busy={monthSwitchPending || undefined}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {monthsAvailable.map((m) => {
                    const snap = monthSnapshotsMap[m];
                    const isMClosed = closedMonths.has(m);
                    let suffix = "";
                    if (isMClosed) {
                      if (snap?.reconciled) {
                        suffix = " ✓";
                      } else if (snap?.gap != null) {
                        const g = Number(snap.gap);
                        suffix = Number.isFinite(g)
                          ? ` · ${formatCurrency(g)} off`
                          : " (closed)";
                      } else {
                        suffix = " (closed)";
                      }
                    }
                    return (
                      <SelectItem key={m} value={m}>
                        {m}
                        {suffix}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {isClosed && (
                <Badge className="bg-muted text-muted-foreground border">
                  <Lock className="w-3 h-3 mr-1" /> Closed
                </Badge>
              )}
              {isClosed && monthSnapshotsMap[monthFilter]?.reconciled && (
                <Badge
                  className="bg-primary/15 text-primary border-primary/30"
                  data-testid="month-reconciled-at-close"
                >
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Reconciled at close
                </Badge>
              )}
              {isClosed &&
                monthSnapshotsMap[monthFilter] &&
                !monthSnapshotsMap[monthFilter]?.reconciled &&
                monthSnapshotsMap[monthFilter]?.gap != null && (
                  <Badge
                    variant="outline"
                    className="bg-amber-50 text-amber-900 border-amber-200"
                    data-testid="month-gap-at-close"
                  >
                    <AlertCircle className="w-3 h-3 mr-1" />
                    Closed {formatCurrency(
                      Number(monthSnapshotsMap[monthFilter]!.gap),
                    )}{" "}
                    off bank
                  </Badge>
                )}
            </div>
            {isClosed ? (
              <Button variant="outline" onClick={onReopenMonth}>
                <Unlock className="w-4 h-4 mr-2" /> Reopen month
              </Button>
            ) : (
              <Button onClick={onCloseMonth} variant="outline">
                <Lock className="w-4 h-4 mr-2" /> Close month
              </Button>
            )}
          </div>

          <Card data-testid="review-bucket-panel">
            {(() => {
              const bucketTotal = bucket.reduce((s, b) => s + b.amount, 0);
              return (
                <div
                  className="flex items-center justify-between gap-3 px-4 py-3 border-b"
                  data-testid="review-bucket-header"
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>Review Bucket</span>
                    <Badge
                      variant="outline"
                      className="text-[10px]"
                      data-testid="review-bucket-count"
                    >
                      {bucket.length}
                    </Badge>
                  </div>
                  <span
                    className={`font-medium tabular-nums ${
                      bucketTotal < 0 ? "text-destructive" : "text-primary"
                    }`}
                    data-testid="review-bucket-total"
                  >
                    {formatCurrency(bucketTotal)}
                  </span>
                </div>
              );
            })()}
            <CardContent className="p-0">
              <div
                className="divide-y divide-border max-h-[360px] overflow-y-auto"
                data-testid="review-bucket-list"
              >
                {bucket.length === 0 && (
                  <div className="p-12 text-center text-muted-foreground">
                    {isClosed ? "Month is closed — bucket hidden." : "Nothing triaged for this month yet."}
                  </div>
                )}
                {bucket.map((b) => {
                  // (#527) Bucket rows for resolved plan occurrences carry
                  // the same `<itemId>|<date>` identity the off-from-bank
                  // badge's contributor uses. Surfacing that as
                  // `data-plan-key` lets the badge's matched-pair jump
                  // scroll/highlight the bucket row that's actually wrong
                  // — matched rows aren't in the visible plan register,
                  // they live here in the bucket. Non-plan resolutions
                  // (e.g. bank-only "Unplanned") don't get a key.
                  const planKey =
                    b.recurringItemId && b.occurrenceDate
                      ? `${b.recurringItemId}|${b.occurrenceDate}`
                      : undefined;
                  const isHighlightedBucket =
                    !!planKey && highlightedPlanKey === planKey;
                  return (
                  <div
                    key={b.id}
                    data-plan-key={planKey}
                    className={`p-4 flex items-center justify-between gap-3 transition-colors ${
                      isHighlightedBucket
                        ? "bg-sky-50 ring-2 ring-sky-400 ring-inset dark:bg-sky-950/30"
                        : ""
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {statusBadge(b.status)}
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{b.label || "—"}</div>
                        <div className="text-xs text-muted-foreground">{formatDate(b.date)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className={`font-medium tabular-nums ${b.amount < 0 ? "text-destructive" : "text-primary"}`}>
                        {formatCurrency(b.amount)}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => onUndo(b.id)}>
                        Undo
                      </Button>
                    </div>
                  </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Settings dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forecast Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="days">Horizon (days)</Label>
              <Input
                id="days"
                type="number"
                value={draftDays}
                onChange={(e) => setDraftDays(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="bal">Starting balance (fallback when no bank snapshot)</Label>
              <Input
                id="bal"
                ref={startingBalanceInputRef}
                type="number"
                step="0.01"
                value={draftBalance}
                onChange={(e) => setDraftBalance(e.target.value)}
                data-testid="input-starting-balance"
                autoFocus={focusStartingBalance}
              />
            </div>
            <div>
              <Label htmlFor="buf">Cash buffer</Label>
              <Input
                id="buf"
                type="number"
                step="0.01"
                value={draftBuffer}
                onChange={(e) => setDraftBuffer(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Floor under which "Avalanche Ready" turns red.
              </p>
            </div>
            <div className="flex justify-end pt-2">
              <Button onClick={saveSettings} disabled={updateSettings.isPending}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={snapshotOpen} onOpenChange={setSnapshotOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set bank balance manually</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="snap">Current checking balance</Label>
              <Input
                id="snap"
                type="number"
                step="0.01"
                value={draftSnapshot}
                onChange={(e) => setDraftSnapshot(e.target.value)}
                data-testid="input-snapshot"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Anchors the running balance to today. Past items won't shift it.
              </p>
            </div>
            <div className="flex justify-end pt-2">
              <Button
                onClick={saveSnapshot}
                disabled={setBankSnapshot.isPending}
                data-testid="button-save-snapshot"
              >
                Save snapshot
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={moveTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setMoveTarget(null);
            setMoveDateDraft("");
            setMoveError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move occurrence to another day</DialogTitle>
          </DialogHeader>
          {moveTarget && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                <div className="font-medium text-foreground truncate">
                  {moveTarget.label || "—"}
                </div>
                <div>
                  Currently planned for {formatDate(moveTarget.date)} ·{" "}
                  <span
                    className={`tabular-nums ${
                      moveTarget.amount < 0 ? "text-destructive" : "text-primary"
                    }`}
                  >
                    {formatCurrency(moveTarget.amount)}
                  </span>
                </div>
              </div>
              <div>
                <Label htmlFor="move-date">New date</Label>
                <Input
                  id="move-date"
                  type="date"
                  value={moveDateDraft}
                  min={(() => {
                    const t = new Date();
                    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
                  })()}
                  max={(() => {
                    const t = new Date();
                    t.setDate(t.getDate() + 30);
                    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
                  })()}
                  onChange={(e) => {
                    setMoveDateDraft(e.target.value);
                    setMoveError(null);
                  }}
                  data-testid="input-move-date"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Pick any day within the next 30 days. Creates a one-off
                  override for this occurrence only.
                </p>
                {moveError && (
                  <p
                    className="text-xs text-destructive mt-1"
                    data-testid="move-error"
                  >
                    {moveError}
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setMoveTarget(null);
                    setMoveDateDraft("");
                    setMoveError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={onMoveSave}
                  disabled={upsertResolution.isPending}
                  data-testid="button-save-move"
                >
                  Move occurrence
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={addBillSeed !== null}
        onOpenChange={(o) => {
          if (!o) setAddBillSeed(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          data-testid="dialog-add-as-bill"
        >
          <DialogHeader>
            <DialogTitle>Add as recurring bill</DialogTitle>
          </DialogHeader>
          {addBillSeed && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Name</Label>
                <Input
                  value={addBillSeed.name}
                  onChange={(e) =>
                    setAddBillSeed({ ...addBillSeed, name: e.target.value })
                  }
                  data-testid="input-add-bill-name"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={addBillSeed.amount}
                    onChange={(e) =>
                      setAddBillSeed({ ...addBillSeed, amount: e.target.value })
                    }
                    data-testid="input-add-bill-amount"
                  />
                </div>
                <div>
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={addBillSeed.kind}
                    onValueChange={(v) =>
                      setAddBillSeed({
                        ...addBillSeed,
                        kind: v as "bill" | "income",
                      })
                    }
                  >
                    <SelectTrigger data-testid="select-add-bill-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bill">Bill (expense)</SelectItem>
                      <SelectItem value="income">Income</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Frequency</Label>
                  <Select
                    value={addBillSeed.frequency}
                    onValueChange={(v) =>
                      setAddBillSeed({
                        ...addBillSeed,
                        frequency: v as AddBillSeed["frequency"],
                      })
                    }
                  >
                    <SelectTrigger data-testid="select-add-bill-frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="semimonthly">Semi-monthly</SelectItem>
                      <SelectItem value="biweekly">Biweekly</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="onetime">One-time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(addBillSeed.frequency === "monthly" ||
                  addBillSeed.frequency === "semimonthly") && (
                  <div>
                    <Label className="text-xs">Day of month</Label>
                    <Input
                      type="number"
                      min="1"
                      max="31"
                      value={addBillSeed.dayOfMonth}
                      onChange={(e) =>
                        setAddBillSeed({
                          ...addBillSeed,
                          dayOfMonth: e.target.value,
                        })
                      }
                      data-testid="input-add-bill-day"
                    />
                  </div>
                )}
                {(addBillSeed.frequency === "biweekly" ||
                  addBillSeed.frequency === "weekly" ||
                  addBillSeed.frequency === "onetime") && (
                  <div>
                    <Label className="text-xs">
                      {addBillSeed.frequency === "onetime"
                        ? "Date"
                        : "Anchor date"}
                    </Label>
                    <Input
                      type="date"
                      value={addBillSeed.anchorDate}
                      onChange={(e) =>
                        setAddBillSeed({
                          ...addBillSeed,
                          anchorDate: e.target.value,
                        })
                      }
                      data-testid="input-add-bill-anchor"
                    />
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                After adding, the new {addBillSeed.kind === "income" ? "income" : "bill"}{" "}
                appears in Planned forecast items so you can match this transaction to it.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddBillSeed(null)}
              disabled={createRecurring.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={submitAddAsBill}
              disabled={createRecurring.isPending}
              data-testid="button-add-bill-save"
            >
              {createRecurring.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
