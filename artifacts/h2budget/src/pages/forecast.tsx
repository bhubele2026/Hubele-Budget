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
  card as kitCard,
  cardHead,
  btnLink,
  emptyNote,
  Foot,
  Help,
  Stat,
} from "@/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Inbox as InboxIcon,
  Sparkles,
  RefreshCw,
  Landmark,
  CheckCircle2,
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
import { ProjectedBalanceChart } from "./forecast/ProjectedBalanceChart";
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

type HorizonOpt = { label: string; days: number };
const HORIZON_OPTS: HorizonOpt[] = [
  // Opens on a 30-day horizon; longer horizons stay one click away. (The old
  // 7-day "THIS WEEK" tab was removed at the owner's request.)
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

  // Window key for reconciled-state persistence: YYYY-MM (current calendar
  // month). One-shot per session per month per task spec.
  const windowKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const inboxCount = inbox.length;
  const cleared = shouldCelebrateClear({ inboxCount, isReconciledToBank });
  const prevClearedRef = useRef<boolean | null>(null);

  // Single effect handles both hydration and transition so ordering is
  // deterministic regardless of cache timing. The month is marked reconciled
  // once per YYYY-MM (sessionStorage), only on overall mode, and also on the
  // first overall observation of a cleared state — so a user who finishes
  // triage on /review and lands on /forecast still records it. Once the
  // session key is set it is never cleared (true one-shot).
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
  const dailySeries = (proj?.daily ?? [])
    .map((d: { date: string; balance: string | number }) => {
      const rawDate = d.date;
      return {
        date: shortDate(rawDate),
        rawDate,
        balance: Number(d.balance),
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
      {/* ⭐ The title used to be a sentence explaining the page's philosophy
          ("Plan register — you decide every match."). The register below says
          that by existing; the head just names the screen. */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-title font-semibold text-brand-navy">
          {mode === "review" ? "Review" : "Forecast"}
        </h1>
        <Help>
          Plans are matched to bank activity by you — nothing is auto-accepted.
          A matched plan leaves the register and lands in the month's bucket.
        </Help>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link href="/bills" data-testid="link-manage-bills" className={btnLink}>
            Bills
          </Link>
          <button type="button" onClick={() => openSettings()} className={btnLink}>
            <SettingsIcon className="h-3 w-3" aria-hidden="true" /> Settings
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap" data-testid="horizon-tabs">
        {/* ⭐ The horizon segmented control. One hairline track, the active
            segment navy-filled — the same shape the tab ribbon uses, so the
            page has one language for "pick one of these". */}
        <div className="inline-flex flex-wrap items-center gap-0.5 rounded-control bg-neutral-50 p-0.5 ring-1 ring-brand-line">
        {HORIZON_OPTS.map((h) => {
          const active = horizonDays === h.days;
          // (#618) The active button shows a subtle spinner while the new
          // horizon's data + register are still being computed in the
          // background — the previous register stays on screen meanwhile
          // (global `keepPreviousData`), so the page never goes blank.
          const showPending = active && horizonSwitchPending;
          return (
            <button
              key={h.label}
              type="button"
              onClick={() => setHorizonDays(h.days)}
              className={`press inline-flex items-center rounded-control px-2.5 py-1 text-micro font-semibold tracking-wide ${
                active
                  ? "bg-brand-navy text-white"
                  : "text-neutral-500 hover:bg-white hover:text-brand-navy"
              }`}
              data-testid={`horizon-${h.days}`}
              data-pending={showPending ? "true" : undefined}
              aria-pressed={active}
              aria-busy={showPending || undefined}
            >
              {h.label}
              {showPending && (
                <RefreshCw
                  className="ml-1.5 h-3 w-3 animate-spin"
                  data-testid={`horizon-${h.days}-pending`}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
        </div>
        {/* (#650 follow-up) Look-back toggle. Default chart starts at
            today; clicking this reveals a date picker so the user can
            rewind the chart to a historical start date when needed. */}
        <button
          type="button"
          onClick={() => {
            const next = !lookbackOpen;
            setLookbackOpen(next);
            // Closing the panel snaps the chart back to today so the
            // forecast keeps moving forward.
            if (!next) setForecastFromDate(todayISO());
          }}
          className={`press inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-micro font-semibold tracking-wide ring-1 ${
            lookbackOpen
              ? "bg-brand-navy text-white ring-brand-navy"
              : "bg-white text-neutral-500 ring-brand-line hover:text-brand-navy"
          }`}
          data-testid="toggle-forecast-lookback"
          aria-expanded={lookbackOpen}
          aria-controls="forecast-lookback-panel"
        >
          <CalendarDays className="h-3 w-3" aria-hidden="true" />
          LOOK BACK
        </button>
        {lookbackOpen && (
          <div
            id="forecast-lookback-panel"
            className="flex items-center gap-2"
            data-testid="forecast-lookback-panel"
          >
            <Label
              htmlFor="forecast-from"
              className="text-micro font-semibold uppercase tracking-wide text-neutral-500"
            >
              Start
            </Label>
            <Input
              id="forecast-from"
              type="date"
              value={forecastFromDate}
              min={FORECAST_MIN_FROM_DATE}
              max={todayISO()}
              onChange={(e) => setForecastFromDate(clampForecastFrom(e.target.value))}
              className="h-7 w-[150px] font-mono text-micro tabular-nums"
              data-testid="input-forecast-from"
              data-pending={fromDateSwitchPending ? "true" : undefined}
              aria-busy={fromDateSwitchPending || undefined}
            />
            {fromDateSwitchPending && (
              <RefreshCw
                className="h-3 w-3 animate-spin text-neutral-400"
                data-testid="forecast-from-pending"
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </div>

      {mode === "overall" && (
      /* ⭐ The headline. One big number, and the three figures it is built
         from demoted to a footnote — they used to be three sentences. */
      <section className={kitCard} data-testid="card-forecast-hero">
        <div className={cardHead}>
          <h2 className="text-title font-semibold text-brand-navy">
            Forecast balance
          </h2>
          <Help>
            Where checking lands at the end of the horizon: the bank balance
            before the start date, plus every matched and still-planned item
            between then and the end date.
          </Help>
          {inboxCount === 0 && reconciledNow && (
            <span className="chip ok ml-auto" data-testid="badge-inbox-cleared">
              Inbox cleared
            </span>
          )}
        </div>
        <div
          className={`px-4 py-3 font-mono text-display font-semibold tabular-nums ${
            Number.isFinite(endingNum) && endingNum < 0
              ? "text-bad"
              : "text-brand-navy"
          }`}
          data-testid="hero-forecast-balance"
        >
          {Number.isFinite(endingNum)
            ? formatCurrency(endingNum)
            : formatCurrency(0)}
        </div>
        <Foot>
          <span className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span>
              Bank before {formatDate(forecastFromDate)}{" "}
              <span className="font-mono tabular-nums text-neutral-600">
                {formatCurrency(proj?.startingBalance ?? "0")}
              </span>
            </span>
            <span>
              Matched impact{" "}
              <span className="font-mono tabular-nums text-neutral-600">
                {formatCurrency(proj?.acceptedImpact ?? "0")}
              </span>
            </span>
            <span>
              Through{" "}
              {formatDate(proj?.endingDate ?? proj?.toDate ?? forecastFromDate)}{" "}
              <span className="font-mono tabular-nums text-neutral-600">
                {formatCurrency(proj?.endingBalance ?? "0")}
              </span>
            </span>
          </span>
        </Foot>
      </section>
      )}
      </div>

      {mode === "overall" && (<>
      {/* ⭐ Four figures, mono, on one baseline. Each tile used to carry its
          own little graphic — a sparkline of the curve drawn full-size
          directly below it, a ring restating a ratio the two neighbouring
          numbers already give, a stripe repeating in-vs-out. The numbers are
          the content; the chart below is the picture. */}
      {(() => {
        const inc = Number(proj?.projectedIncome) || 0;
        const exp = Number(proj?.projectedExpenses) || 0;
        const dipsBelowBuffer =
          Number.isFinite(lowestNum) && lowestNum < Number(proj?.cashBuffer ?? 0);
        return (
          <div
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
            data-testid="forecast-kpis"
          >
            <Stat
              index={0}
              data-testid="kpi-lowest-point"
              label="Lowest point"
              value={formatCurrency(Number.isFinite(lowestNum) ? lowestNum : 0)}
              tone={dipsBelowBuffer ? "bad" : "navy"}
              hint={`${dipsBelowBuffer ? "under buffer" : "above buffer"}${
                proj?.lowestDate ? ` · ${formatDate(proj.lowestDate)}` : ""
              }`}
            />
            <Stat
              index={1}
              data-testid="kpi-ending-balance"
              label="Ending balance"
              value={formatCurrency(proj?.endingBalance ?? 0)}
              hint={
                proj?.endingDate
                  ? formatDate(proj.endingDate)
                  : `${horizonDays}-day horizon`
              }
            />
            <Stat
              index={2}
              data-testid="kpi-projected-income"
              label="Money in"
              value={formatCurrency(inc)}
              hint={`over ${horizonDays}d`}
            />
            <Stat
              index={3}
              data-testid="kpi-projected-expenses"
              label="Money out"
              value={formatCurrency(exp)}
              hint={`over ${horizonDays}d`}
            />
          </div>
        );
      })()}

      {/* (#683) Past-due plans dragging tomorrow — discoverable summary */}
      {draggingPlans.length > 0 && draggingTargetDate && (
        <section className={kitCard} data-testid="card-dragging-plans-summary">
          <div className={cardHead}>
            <h2 className="text-title font-semibold text-brand-navy">Past due</h2>
            <span className="chip bad">
              {draggingPlans.length} on {formatDate(draggingTargetDate)}
            </span>
            <Help>
              {`These occurrences were due earlier and have not been matched, missed or skipped, so the projection carries them forward onto ${formatDate(draggingTargetDate)} until you resolve them. That is why the next day dips.`}
            </Help>
            <span
              className="ml-auto font-mono text-label tabular-nums text-bad"
              data-testid="dragging-plans-total"
            >
              {formatCurrency(draggingTotal)}
            </span>
          </div>
          <div>
            <ul data-testid="dragging-plans-list">
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
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-line/70 px-4 py-2.5 last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        jumpToPlan(row.itemId, row.originalDate)
                      }
                      className="press -mx-1 flex min-w-0 flex-1 items-center justify-between gap-3 rounded-control px-1 py-1 text-left outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-brand-navy/40"
                      title={`Jump to ${row.label} in the planned-items register`}
                      data-testid={`dragging-plan-jump-${row.itemId}-${row.originalDate}`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-body font-medium text-neutral-700">
                          {row.label}
                        </div>
                        <div className="text-micro text-neutral-400">
                          Due {formatDate(row.originalDate)}
                        </div>
                      </div>
                      <span className="font-mono text-label tabular-nums text-bad">
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
                            <div className="px-2 py-1 text-micro text-neutral-400">
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
          </div>
          <Foot>
            Resolving a row here removes it from the projection for that day.
          </Foot>
        </section>
      )}

      {/* ── The cash curve ─────────────────────────────────────────────────
             The one chart on this page. Drawing, annotation and tooltip live
             in ./forecast/ProjectedBalanceChart so `useXTicks` can be called
             above the page's loading early-return. ─────────────────────── */}
      <section className={kitCard} data-testid="card-projected-balance-chart">
        <div className={cardHead}>
          <h2 className="text-title font-semibold text-brand-navy">
            Projected balance
          </h2>
          <Help>
            Bank balance rolled forward through every planned bill and income
            event over the selected horizon. The dashed line is your cash
            buffer; the orange dot is the projected low point.
          </Help>
          <span className="ml-auto text-micro uppercase tracking-wider text-neutral-400">
            {horizonDays} days
          </span>
        </div>
        <div className="h-[280px] w-full px-1 pb-1 pt-3">
          {cashProjectionLoading && dailySeries.length === 0 ? (
            <Skeleton className="h-full w-full" />
          ) : dailySeries.length === 0 || proj?.status === "no_data" ? (
            <div
              className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center"
              data-testid="empty-projected-balance"
            >
              <p className="text-body text-neutral-500">
                Set a bank snapshot or add planned items to draw the curve.
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
            <ProjectedBalanceChart
              data={dailySeries}
              cashBuffer={cashBufferNum}
              lowestPoint={lowestPoint}
              bigBillMarkers={bigBillMarkers}
              eventsByDate={eventsByDate}
              onJumpToPlan={jumpToPlan}
              onMarkMissed={onMarkMissed}
            />
          )}
        </div>
      </section>

      {/* Bank snapshot + Avalanche cards (kept below the new summary) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className={kitCard} data-testid="card-bank-snapshot">
          <div className={cardHead}>
            <Landmark className="h-4 w-4 text-neutral-400" aria-hidden="true" />
            <h2 className="text-title font-semibold text-brand-navy">
              Bank balance
            </h2>
            <Help>
              The anchor the whole projection is rolled forward from. A Plaid
              snapshot refreshes on sync; a manual one holds until you change
              it.
            </Help>
            {data.bankSnapshot && data.bankSnapshot.source === "plaid" && (
              <button
                type="button"
                className="press ml-auto grid h-6 w-6 place-items-center rounded-control text-neutral-500 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy disabled:pointer-events-none disabled:opacity-40"
                onClick={onRefreshBank}
                disabled={refreshBank.isPending}
                title="Refresh from Plaid"
                aria-label="Refresh bank balance from Plaid"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${refreshBank.isPending ? "animate-spin" : ""}`}
                />
              </button>
            )}
          </div>
          <div className="space-y-2 px-4 py-3">
            <div
              className="font-mono text-title font-semibold tabular-nums text-brand-navy"
              data-testid="text-bank-balance"
            >
              {data.bankSnapshot
                ? formatCurrency(data.bankSnapshot.balance)
                : formatCurrency(data.settings.startingBalance)}
            </div>
            <div
              className="text-micro text-neutral-400"
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
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                className={btnLink}
                onClick={openSnapshot}
                data-testid="button-set-bank-snapshot"
              >
                Set manually
              </button>
              {data.plaidCheckingAccounts.length > 0 && (
                <Select onValueChange={onLinkChecking}>
                  <SelectTrigger className="h-7 w-44 text-micro">
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
          </div>
        </section>
        <AvalancheScheduleCard />
      </div>
      </>)}

      {mode === "review" && bankInbox.length === 0 && (
        // Single-flow restore: a forecast-flagged checking txn IS in
        // Review, so an empty Review just means nothing's flagged /
        // everything's matched. One honest empty state, pointing back
        // to Chase to send more to Forecast.
        <section className={kitCard} data-testid="review-empty-state">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
            <span className="flex items-center gap-2">
              <CheckCircle2
                className="h-4 w-4 text-brand-navy"
                aria-hidden="true"
              />
              <span className="text-body font-medium text-neutral-700">
                Review is empty
              </span>
              <Help>
                A Chase transaction sent to Forecast lands here straight away —
                sending it IS putting it in Review. Nothing is waiting, so
                either nothing is flagged or everything is matched.
              </Help>
            </span>
            <Link
              href="/transactions"
              data-testid="link-open-chase"
              className={btnLink}
            >
              Open Chase
            </Link>
          </div>
        </section>
      )}

      {mode === "overall" && bankInbox.length > 0 && (
        <section className={kitCard} data-testid="banner-review-waiting">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex min-w-0 items-center gap-2">
              <InboxIcon
                className="h-4 w-4 flex-none text-neutral-400"
                aria-hidden="true"
              />
              <span className="chip info">{bankInbox.length} waiting</span>
              <span className="truncate text-body text-neutral-600">
                Match Chase activity to planned items
              </span>
            </span>
            <Link
              href="/review"
              data-testid="link-go-to-review"
              className={btnLink}
            >
              Go to Review
            </Link>
          </div>
        </section>
      )}

      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveDragId(null)}
      >
        {mode === "review" && (
          <section className={kitCard} data-testid="card-from-bank">
              <div className={`${cardHead} flex-wrap`}>
                <Landmark
                  className="h-4 w-4 text-neutral-400"
                  aria-hidden="true"
                />
                <h2 className="text-title font-semibold text-brand-navy">
                  From Chase · {monthFilter}
                </h2>
                <span className="chip warn">{bankReconcile.pending} pending</span>
                <span className="chip ok">{bankReconcile.matched} matched</span>
                <span className="chip gray">
                  {bankReconcile.unplanned} unplanned
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {bankReconcile.hasBank && !bankReconcile.isPriorMonth && (
                    <span className="font-mono text-micro tabular-nums text-neutral-500">
                      Forecast {formatCurrency(bankReconcile.forecastEnd)} · Bank{" "}
                      {formatCurrency(bankReconcile.bankEnd)}
                    </span>
                  )}
                  {bankReconcile.isPriorMonth && (
                    <span className="chip gray">Prior period</span>
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
                    <button
                      type="button"
                      className={btnLink}
                      onClick={bulkMarkBankUnplanned}
                      disabled={upsertResolution.isPending}
                      data-testid="bulk-mark-unplanned"
                    >
                      Mark all unplanned
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-2 px-4 py-3">
                {/* (#456) First-time drag-to-match callout. Only shown when
                    the user has at least one unresolved inbox row to act on
                    AND hasn't dismissed the hint yet. */}
                {!dragHintDismissed && bankInbox.length > 0 && (
                  <div
                    className="flex items-center gap-2 rounded-control bg-neutral-50 px-3 py-1.5 ring-1 ring-brand-line"
                    data-testid="drag-to-match-hint"
                    role="note"
                  >
                    <GripVertical
                      className="h-3.5 w-3.5 shrink-0 text-neutral-400"
                      aria-hidden="true"
                    />
                    <span className="flex-1 text-micro text-neutral-500">
                      Drag a row onto any planned item to match it
                    </span>
                    <button
                      type="button"
                      className={btnLink}
                      onClick={dismissDragHint}
                      data-testid="drag-to-match-hint-dismiss"
                      aria-label="Dismiss drag-to-match tip"
                    >
                      Got it
                    </button>
                  </div>
                )}
                {/* (#27) Selection-scoped bulk bar */}
                {selectedBankIds.size > 0 && (
                  <div
                    className="flex flex-wrap items-center gap-2 rounded-control bg-white px-3 py-2 ring-1 ring-brand-navy/25"
                    data-testid="bank-inbox-selection-bar"
                  >
                    <span className="chip info">
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
                    <button
                      type="button"
                      className={btnLink}
                      onClick={bulkMarkBankUnplannedSelected}
                      disabled={upsertResolution.isPending}
                      data-testid="bulk-mark-unplanned-selected"
                    >
                      Mark {selectedBankIds.size} unplanned
                    </button>
                    <button
                      type="button"
                      className={`${btnLink} ml-auto`}
                      onClick={clearBankSelection}
                      data-testid="bank-inbox-clear-selection"
                    >
                      Clear
                    </button>
                  </div>
                )}
                {bankInbox.length === 0 && (
                  <div className="py-2.5 text-center text-micro text-neutral-400">
                    {isReconciledToBank ? (
                      <span className="chip ok">
                        Reconciled to bank · {monthFilter}
                      </span>
                    ) : (
                      <>Send a Chase transaction to Forecast to start</>
                    )}
                  </div>
                )}
                {bankResolvedThisMonth.length > 0 && (
                  <div
                    className="mt-3 border-t border-brand-line pt-3"
                    data-testid="bank-resolved-list"
                  >
                    <div className="mb-1 text-micro font-semibold uppercase tracking-wide text-neutral-400">
                      Resolved this month
                    </div>
                    <div
                      className="max-h-[7.5rem] space-y-1 overflow-y-auto pr-1"
                      data-testid="bank-resolved-list-scroll"
                    >
                    {bankResolvedThisMonth.map((r) => (
                      <div
                        key={r.resolutionId}
                        className="flex items-center gap-2 rounded-control bg-white px-2 py-1 text-micro ring-1 ring-brand-line"
                      >
                        <span
                          className={`chip ${r.kind === "matched" ? "ok" : "gray"}`}
                        >
                          {r.kind === "matched" ? "matched" : "unplanned"}
                        </span>
                        <span className="flex-1 truncate text-neutral-600">
                          {r.bank.txn.description}
                        </span>
                        <span className="text-neutral-400">
                          {formatDate(r.bank.date)}
                        </span>
                        <span
                          className={`font-mono tabular-nums ${
                            r.bank.amount < 0 ? "text-bad" : "text-brand-navy"
                          }`}
                        >
                          {formatCurrency(r.bank.amount)}
                        </span>
                        <button
                          type="button"
                          className={btnLink}
                          onClick={() => onUndo(r.resolutionId)}
                          data-testid={`undo-resolution-${r.resolutionId}`}
                        >
                          Undo
                        </button>
                      </div>
                    ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
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
                  <div className="surface space-y-2 rounded-card p-2 ring-1 ring-brand-line">
                    <div
                      className="flex items-center justify-between gap-2 px-1"
                      data-testid="bank-inbox-pager"
                    >
                      <button
                        type="button"
                        className={btnLink}
                        onClick={() =>
                          setActiveInboxIndex((i) => Math.max(0, i - 1))
                        }
                        disabled={safeIndex === 0}
                        data-testid="bank-inbox-pager-prev"
                        aria-label="Previous pending inbox row"
                      >
                        <ChevronLeft className="h-3 w-3" aria-hidden="true" />
                        Prev
                      </button>
                      <span
                        className="font-mono text-micro tabular-nums text-neutral-500"
                        data-testid="bank-inbox-pager-indicator"
                      >
                        {safeIndex + 1} of {bankInbox.length}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className={btnLink}
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
                          <ChevronRight className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="press grid h-6 w-6 place-items-center rounded-control text-neutral-500 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy"
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
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronUp className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                    {pinnedInboxCollapsed ? (
                      <div
                        key={card.id}
                        className="flex items-center gap-2 px-1 py-1"
                        data-testid="pinned-inbox-collapsed-row"
                      >
                        <span
                          className="flex-1 truncate text-body text-neutral-700"
                          title={card.bank.txn.description}
                        >
                          {card.bank.txn.description}
                        </span>
                        <span className="font-mono text-label tabular-nums text-neutral-500">
                          {formatCurrency(card.bank.amount)}
                        </span>
                        {(() => {
                          const oneClick = oneClickByTxnId.get(
                            card.bank.txn.id,
                          );
                          return (
                            <button
                              type="button"
                              className={btnLink}
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
                            </button>
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
                        {/* The single flow, in reverse. Send-to-Forecast puts a
                            Chase row straight into Review; this puts it back.
                            There is no gate in either direction. */}
                        <button
                          type="button"
                          className="press grid h-7 w-7 shrink-0 place-items-center self-start rounded-control text-neutral-400 hover:bg-neutral-50 hover:text-brand-navy"
                          onClick={() =>
                            onRemoveFromForecast(card.bank.txn.id)
                          }
                          title="Un-send back to Bank list"
                          aria-label="Un-send back to Bank list"
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    )}
                  </div>
                </div>
              );
            })()}

            <section className={kitCard}>
              <div className={`${cardHead} flex-wrap`}>
                <h2 className="text-title font-semibold text-brand-navy">
                  Planned items
                </h2>
                <Help>
                  Every bill and income occurrence scheduled inside the visible
                  window. A row leaves this register once you match, miss, skip
                  or move it.
                </Help>
                {bankReconcile.hasBank && !bankReconcile.isPriorMonth && (
                  <span
                    className="ml-auto font-mono text-micro tabular-nums text-neutral-500"
                    data-testid="planned-projected-end"
                  >
                    Projected end {formatCurrency(bankReconcile.forecastEnd)}
                  </span>
                )}
              </div>
              <div>
                {planRows.length === 0 ? (
                  <div className={emptyNote}>
                    Nothing planned in this window.
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
              </div>
            </section>

            {(() => {
              const missed = bucket.filter((b) => b.status === "missed");
              if (missed.length === 0) return null;
              const missedTotal = missed.reduce((s, b) => s + b.amount, 0);
              return (
                <section className={kitCard} data-testid="missed-bucket-panel">
                  <div className={cardHead}>
                    <h2 className="text-title font-semibold text-brand-navy">
                      Missed · {monthFilter}
                    </h2>
                    <span className="chip bad">{missed.length}</span>
                    <Help>
                      Occurrences you marked as not happening. They no longer
                      affect the projection; undo puts one back in the register.
                    </Help>
                    <span
                      className={`ml-auto font-mono text-label tabular-nums ${
                        missedTotal < 0 ? "text-bad" : "text-brand-navy"
                      }`}
                      data-testid="missed-bucket-total"
                    >
                      {formatCurrency(missedTotal)}
                    </span>
                  </div>
                  <div
                    className="max-h-[20rem] overflow-y-auto"
                    data-testid="missed-bucket-scroll"
                  >
                    {missed.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between gap-3 border-b border-brand-line/70 px-4 py-2.5 last:border-b-0"
                        data-testid={`missed-row-${b.id}`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          {statusBadge(b.status)}
                          <div className="min-w-0">
                            <div className="truncate text-body font-medium text-neutral-700">
                              {b.label || "—"}
                            </div>
                            <div className="text-micro text-neutral-400">
                              {formatDate(b.date)}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <span
                            className={`mr-2 font-mono text-label tabular-nums ${
                              b.amount < 0 ? "text-bad" : "text-brand-navy"
                            }`}
                          >
                            {formatCurrency(b.amount)}
                          </span>
                          {b.recurringItemId && b.occurrenceDate && (
                            <button
                              type="button"
                              className={btnLink}
                              onClick={() => onSetNewDateFromBucket(b)}
                              data-testid={`missed-set-new-date-${b.id}`}
                              title="Reschedule this occurrence to another day (next 30 days)"
                            >
                              Set new date
                            </button>
                          )}
                          {b.recurringItemId && b.occurrenceDate && (
                            <button
                              type="button"
                              className={btnLink}
                              onClick={() => onSkipFromBucket(b)}
                              data-testid={`missed-skip-${b.id}`}
                              title="Clear this occurrence — won't return or affect the projection"
                            >
                              Skip
                            </button>
                          )}
                          <button
                            type="button"
                            className={btnLink}
                            onClick={() => onUndo(b.id)}
                            data-testid={`missed-undo-${b.id}`}
                          >
                            Undo
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })()}

            {(() => {
              const moved = bucket.filter((b) => b.status === "rescheduled");
              if (moved.length === 0) return null;
              const movedTotal = moved.reduce((s, b) => s + b.amount, 0);
              return (
                <section className={kitCard} data-testid="rescheduled-bucket-panel">
                  <div className={cardHead}>
                    <CalendarDays
                      className="h-4 w-4 text-neutral-400"
                      aria-hidden="true"
                    />
                    <h2 className="text-title font-semibold text-brand-navy">
                      Moved · {monthFilter}
                    </h2>
                    <span className="chip info">{moved.length}</span>
                    <Help>
                      Occurrences you pushed to another day. The projection
                      counts them on the new date, not the original one.
                    </Help>
                    <span
                      className={`ml-auto font-mono text-label tabular-nums ${
                        movedTotal < 0 ? "text-bad" : "text-brand-navy"
                      }`}
                      data-testid="rescheduled-bucket-total"
                    >
                      {formatCurrency(movedTotal)}
                    </span>
                  </div>
                  <div
                    className="max-h-[20rem] overflow-y-auto"
                    data-testid="rescheduled-bucket-scroll"
                  >
                    {moved.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between gap-3 border-b border-brand-line/70 px-4 py-2.5 last:border-b-0"
                        data-testid={`rescheduled-row-${b.id}`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          {statusBadge("rescheduled")}
                          <div className="min-w-0">
                            <div className="truncate text-body font-medium text-neutral-700">
                              {b.label || "—"}
                            </div>
                            <div className="font-mono text-micro tabular-nums text-neutral-400">
                              {formatDate(b.date)} → {formatDate(b.rescheduledTo!)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span
                            className={`font-mono text-label tabular-nums ${
                              b.amount < 0 ? "text-bad" : "text-brand-navy"
                            }`}
                          >
                            {formatCurrency(b.amount)}
                          </span>
                          <button
                            type="button"
                            className={btnLink}
                            onClick={() => onUndo(b.id)}
                            data-testid={`rescheduled-undo-${b.id}`}
                          >
                            Undo
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
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
            <div className="flex flex-wrap items-center gap-3">
              <Label className="text-micro font-semibold uppercase tracking-wide text-neutral-500">
                Month
              </Label>
              {monthSwitchPending && (
                <RefreshCw
                  className="h-3 w-3 animate-spin text-neutral-400"
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
              {isClosed && <span className="chip gray">Closed</span>}
              {isClosed && monthSnapshotsMap[monthFilter]?.reconciled && (
                <span className="chip ok" data-testid="month-reconciled-at-close">
                  Reconciled at close
                </span>
              )}
              {isClosed &&
                monthSnapshotsMap[monthFilter] &&
                !monthSnapshotsMap[monthFilter]?.reconciled &&
                monthSnapshotsMap[monthFilter]?.gap != null && (
                  <span className="chip bad" data-testid="month-gap-at-close">
                    {formatCurrency(
                      Number(monthSnapshotsMap[monthFilter]!.gap),
                    )}{" "}
                    off bank
                  </span>
                )}
            </div>
            {isClosed ? (
              <button type="button" className={btnLink} onClick={onReopenMonth}>
                <Unlock className="h-3 w-3" aria-hidden="true" /> Reopen month
              </button>
            ) : (
              <button type="button" className={btnLink} onClick={onCloseMonth}>
                <Lock className="h-3 w-3" aria-hidden="true" /> Close month
              </button>
            )}
          </div>

          <section className={kitCard} data-testid="review-bucket-panel">
            {(() => {
              const bucketTotal = bucket.reduce((s, b) => s + b.amount, 0);
              return (
                <div className={cardHead} data-testid="review-bucket-header">
                  <h2 className="text-title font-semibold text-brand-navy">
                    Review bucket
                  </h2>
                  <span className="chip gray" data-testid="review-bucket-count">
                    {bucket.length}
                  </span>
                  <Help>
                    Everything triaged in this month — matched, missed, moved
                    and unplanned. The total is the net effect on the month, so
                    it does not tie to any single register above.
                  </Help>
                  <span
                    className={`ml-auto font-mono text-label tabular-nums ${
                      bucketTotal < 0 ? "text-bad" : "text-brand-navy"
                    }`}
                    data-testid="review-bucket-total"
                  >
                    {formatCurrency(bucketTotal)}
                  </span>
                </div>
              );
            })()}
            <div>
              <div
                className="max-h-[360px] overflow-y-auto"
                data-testid="review-bucket-list"
              >
                {bucket.length === 0 && (
                  <div className={emptyNote}>
                    {isClosed ? "Month is closed — bucket hidden." : "Nothing triaged this month yet."}
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
                    className={`flex items-center justify-between gap-3 border-b border-brand-line/70 px-4 py-2.5 transition-colors last:border-b-0 ${
                      isHighlightedBucket
                        ? "bg-primary/10 ring-2 ring-primary ring-inset"
                        : ""
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {statusBadge(b.status)}
                      <div className="min-w-0">
                        <div className="truncate text-body font-medium text-neutral-700">
                          {b.label || "—"}
                        </div>
                        <div className="text-micro text-neutral-400">
                          {formatDate(b.date)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span
                        className={`font-mono text-label tabular-nums ${
                          b.amount < 0 ? "text-bad" : "text-brand-navy"
                        }`}
                      >
                        {formatCurrency(b.amount)}
                      </span>
                      <button
                        type="button"
                        className={btnLink}
                        onClick={() => onUndo(b.id)}
                      >
                        Undo
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          </section>
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
              <p className="mt-1 text-micro text-neutral-400">
                The floor the projection is measured against. Dipping under it
                flags the low point as at risk.
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
              <p className="mt-1 text-micro text-neutral-400">
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
              <div className="text-body text-neutral-500">
                <div className="truncate font-medium text-neutral-700">
                  {moveTarget.label || "—"}
                </div>
                <div>
                  Planned for {formatDate(moveTarget.date)} ·{" "}
                  <span
                    className={`font-mono tabular-nums ${
                      moveTarget.amount < 0 ? "text-bad" : "text-brand-navy"
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
                <p className="mt-1 text-micro text-neutral-400">
                  Any day in the next 30. Overrides this occurrence only.
                </p>
                {moveError && (
                  <p
                    className="mt-1 text-micro text-bad"
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
              <p className="text-micro text-neutral-400">
                Appears in Planned items, ready to match this transaction to.
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
