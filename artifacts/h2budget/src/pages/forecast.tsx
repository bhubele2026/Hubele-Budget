import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  useGetAvalancheSettings,
  useGetAvalancheExtra,
  useSetForecastBankSnapshot,
  useRefreshForecastBank,
  getGetForecastQueryKey,
  getGetForecastCashSignalQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { AvalancheReadyCard } from "@/components/avalanche-ready-card";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
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
} from "@/components/ui/dialog";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import confetti from "canvas-confetti";
import { useToast } from "@/hooks/use-toast";
import { PlaidReauthBanner } from "@/components/plaid-reauth-banner";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  buildLineRegister,
  filterForecastTxns,
  buildBucket,
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
import {
  linkRecurringToDebts,
  computePayoffsByDebt,
  filterEventsByPayoff,
  payoffByRecurringItem,
  computePayoffTransitions,
  type PayoffInfo,
  type PayoffTransition,
  type DebtLite,
  type RecurringLite,
} from "@/lib/forecastDebts";
import { simulate, fmtMonth, type SimDebt, type Strategy } from "@/lib/avalanche";
import {
  Lock,
  Unlock,
  Settings as SettingsIcon,
  X,
  GripVertical,
  PartyPopper,
  Inbox as InboxIcon,
  Flame,
  Sparkles,
  RefreshCw,
  Landmark,
  TrendingDown,
  CheckCircle2,
  AlertCircle,
  History,
  CalendarDays,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Re-exported here so existing imports (and the Task #285 test) keep
// working after the component moved to a shared location for use on the
// Dashboard and Transactions pages too (Task #333).
export { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";

function statusBadge(s: string) {
  const map: Record<string, { label: string; cls: string }> = {
    pending_plan: { label: "Pending plan", cls: "bg-amber-100 text-amber-900 border-amber-200" },
    pending_bank: { label: "Pending bank", cls: "bg-sky-100 text-sky-900 border-sky-200" },
    future: { label: "Upcoming", cls: "bg-muted text-muted-foreground" },
    matched: { label: "Matched", cls: "bg-primary/15 text-primary border-primary/30" },
    missed: { label: "Missed", cls: "bg-destructive/10 text-destructive border-destructive/30" },
    rescheduled: { label: "Rescheduled", cls: "bg-violet-100 text-violet-900 border-violet-200" },
    ignored_unforecasted: { label: "Unplanned", cls: "bg-muted text-muted-foreground" },
    unplanned: { label: "Unplanned", cls: "bg-muted text-muted-foreground" },
  };
  const v = map[s] ?? { label: s, cls: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={v.cls}>{v.label}</Badge>;
}

const RECONCILED_STORAGE_KEY = "h2budget:forecastReconciled";

function readReconciledMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(RECONCILED_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeReconciledMap(map: Record<string, boolean>) {
  try {
    localStorage.setItem(RECONCILED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* no-op */
  }
}

function fireConfetti() {
  const defaults = { startVelocity: 32, spread: 360, ticks: 70, zIndex: 9999 };
  confetti({ ...defaults, particleCount: 90, origin: { x: 0.2, y: 0.3 } });
  confetti({ ...defaults, particleCount: 90, origin: { x: 0.8, y: 0.3 } });
  setTimeout(
    () =>
      confetti({
        ...defaults,
        particleCount: 120,
        origin: { x: 0.5, y: 0.4 },
      }),
    150,
  );
}

type InboxCard = {
  id: string;
  bank: BankLine;
};

function InboxCardView({
  card,
  categoryName,
  onUnplanned,
  onMatchPick,
  onHoverChange,
  planRows,
  oneClickSuggestion,
  isOverlay,
}: {
  card: InboxCard;
  categoryName?: string | null;
  onUnplanned: () => void;
  onMatchPick: (planRow: PlanLine) => void;
  onHoverChange?: (hovered: boolean) => void;
  planRows: PlanLine[];
  /** When set, the card has a single high-confidence top suggestion that
   *  isn't contested by any other inbox card. We render a primary "Match"
   *  button that confirms it in one click via `onMatchPick`. */
  oneClickSuggestion?: PlanLine | null;
  isOverlay?: boolean;
}) {
  const draggable = useDraggable({
    id: card.id,
    data: { txnId: card.bank.txn.id },
    disabled: isOverlay,
  });
  const { attributes, listeners, setNodeRef, transform, isDragging } = draggable;
  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const canOneClick = !isOverlay && !!oneClickSuggestion;
  return (
    <div
      ref={setNodeRef}
      style={style}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
      onFocus={onHoverChange ? () => onHoverChange(true) : undefined}
      onBlur={onHoverChange ? () => onHoverChange(false) : undefined}
      tabIndex={canOneClick ? 0 : undefined}
      data-testid={canOneClick ? `inbox-card-${card.bank.txn.id}` : undefined}
      aria-keyshortcuts={canOneClick ? "Enter" : undefined}
      aria-label={
        canOneClick && oneClickSuggestion
          ? `Inbox card for ${card.bank.txn.description}. Press Enter to match to ${oneClickSuggestion.label} on ${oneClickSuggestion.date}.`
          : undefined
      }
      onKeyDown={(e) => {
        if (
          canOneClick &&
          oneClickSuggestion &&
          e.key === "Enter" &&
          !e.shiftKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          e.target === e.currentTarget
        ) {
          e.preventDefault();
          onMatchPick(oneClickSuggestion);
        }
      }}
      className={`rounded-md border bg-card p-3 flex items-center gap-3 shadow-sm transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        isDragging ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-2 ring-primary/40 cursor-grabbing" : ""}`}
    >
      <button
        {...listeners}
        {...attributes}
        className="touch-none cursor-grab text-muted-foreground hover:text-foreground"
        aria-label="Drag to match"
        type="button"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm truncate">
          {card.bank.txn.description}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          <span>{formatDate(card.bank.date)}</span>
          {categoryName && (
            <Badge
              variant="outline"
              className="text-[10px] border-violet-200 text-violet-700 bg-violet-50"
            >
              {categoryName}
            </Badge>
          )}
          {!categoryName && (
            <Badge variant="outline" className="text-[10px] border-muted text-muted-foreground">
              Uncategorized
            </Badge>
          )}
        </div>
      </div>
      <span
        className={`text-sm font-medium tabular-nums ${
          card.bank.amount < 0 ? "text-destructive" : "text-primary"
        }`}
      >
        {formatCurrency(card.bank.amount)}
      </span>
      {!isOverlay && (
        <div className="flex items-center gap-1">
          {oneClickSuggestion && (
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => onMatchPick(oneClickSuggestion)}
              data-testid={`one-click-match-${card.bank.txn.id}`}
              title={`Match to ${oneClickSuggestion.label} on ${oneClickSuggestion.date} (press Enter)`}
              aria-label={`Match to ${oneClickSuggestion.label} on ${oneClickSuggestion.date}. Shortcut: Enter.`}
              aria-keyshortcuts="Enter"
            >
              Match
            </Button>
          )}
          <Select
            onValueChange={(v) => {
              const p = planRows.find(
                (r) => `${r.itemId}|${r.date}` === v,
              );
              if (p) onMatchPick(p);
            }}
          >
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue placeholder="Choose a planned item" />
            </SelectTrigger>
            <SelectContent>
              {planRows.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  No planned items this month
                </div>
              )}
              {planRows.map((p) => (
                <SelectItem
                  key={`${p.itemId}|${p.date}`}
                  value={`${p.itemId}|${p.date}`}
                >
                  {p.label} · {formatDate(p.date)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={onUnplanned}>
            Unplanned
          </Button>
        </div>
      )}
    </div>
  );
}

function SuggestionStrip({
  suggestions,
  onPick,
  txnId,
}: {
  suggestions: PlanSuggestion[];
  onPick: (p: PlanLine) => void;
  txnId: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1 px-3 pb-2 pt-1"
      data-testid={`bank-suggestions-${txnId}`}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">
        Suggested:
      </span>
      {suggestions.map((s) => {
        const cls =
          s.confidence === "high"
            ? "bg-primary/15 text-primary border-primary/30"
            : s.confidence === "medium"
              ? "bg-amber-50 text-amber-900 border-amber-200"
              : "bg-muted text-muted-foreground";
        return (
          <Button
            key={`${s.plan.itemId}|${s.plan.date}`}
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5 px-2"
            onClick={() => onPick(s.plan)}
            data-testid={`suggest-match-${txnId}-${s.plan.itemId}-${s.plan.date}`}
            title={`${s.daysAway}d away · Δ ${formatCurrency(s.amountDelta)}${s.labelMatch ? " · label match" : ""}`}
            aria-label={`Match to ${s.plan.label} on ${s.plan.date}, ${s.confidence} confidence`}
          >
            <span className="font-semibold">Match:</span>
            <span className="truncate max-w-[140px]">{s.plan.label}</span>
            <span className="text-muted-foreground tabular-nums">
              {formatDate(s.plan.date)}
            </span>
            <Badge variant="outline" className={`${cls} text-[9px] px-1 py-0`}>
              {s.confidence}
            </Badge>
          </Button>
        );
      })}
    </div>
  );
}

function nextMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return "";
  const d = new Date(y, m, 1);
  return fmtMonth(d);
}

function CashFreedBanner({ transition }: { transition: PayoffTransition }) {
  return (
    <div
      data-testid={`cash-freed-${transition.debtId}`}
      className="p-4 flex items-center justify-between gap-3 bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/30 border-l-4 border-orange-400 dark:border-orange-700"
    >
      <div className="flex items-center gap-3 min-w-0">
        <Badge
          variant="outline"
          className="bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-900/40 dark:text-orange-100 dark:border-orange-800 gap-1"
        >
          <Sparkles className="h-3 w-3" />
          Cash Freed
        </Badge>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate text-orange-950 dark:text-orange-100">
            {transition.debtName} is gone
          </div>
          <div className="text-xs text-orange-800/80 dark:text-orange-200/80">
            starting {nextMonthLabel(transition.payoffYM)}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="font-semibold tabular-nums text-orange-900 dark:text-orange-100">
          +{formatCurrency(transition.freedAmount)}/mo
        </div>
        <div className="text-[10px] uppercase tracking-wide text-orange-800/70 dark:text-orange-200/70">
          freed up
        </div>
      </div>
    </div>
  );
}

function PlanDropRow({
  row,
  onSelect,
  onMove,
  activeDragId,
  payoff,
  isBestSuggestion = false,
  isHighlighted = false,
}: {
  row: PlanLine;
  onSelect: (row: PlanLine) => void;
  onMove?: (row: PlanLine) => void;
  activeDragId: string | null;
  payoff?: PayoffInfo;
  /**
   * (#26) When a bank inbox card is being dragged or hovered, the row whose
   * plan key matches that card's top suggestion gets a tinted ring so the
   * user can see exactly where to drop. Parent owns the "is this the best
   * suggestion right now" decision so we don't recompute scoring per row.
   */
  isBestSuggestion?: boolean;
  /**
   * (#335) When the user clicks a big-bill marker (or a bill inside its
   * tooltip), the matching plan row briefly pulses so they can see exactly
   * which bill the dot was pointing at.
   */
  isHighlighted?: boolean;
}) {
  const droppable = useDroppable({
    id: `plan:${row.itemId}|${row.date}`,
    data: { kind: "plan", planRow: row },
    disabled: row.status === "matched" || row.status === "missed",
  });
  const isOver = droppable.isOver && activeDragId !== null;
  const showSuggestion = !isOver && isBestSuggestion;
  const canMove =
    !!onMove && (row.status === "pending_plan" || row.status === "future");
  return (
    <div
      ref={droppable.setNodeRef}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(row)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(row);
        }
      }}
      data-suggested-drop={showSuggestion ? "true" : undefined}
      data-plan-key={`${row.itemId}|${row.date}`}
      data-testid={`plan-row-${row.itemId}-${row.date}`}
      className={`w-full text-left p-4 flex items-center justify-between transition-colors cursor-pointer ${
        isOver
          ? "bg-primary/10 ring-2 ring-primary ring-inset"
          : isHighlighted
            ? "bg-sky-50 ring-2 ring-sky-400 ring-inset dark:bg-sky-950/30"
            : showSuggestion
              ? "bg-amber-50 ring-2 ring-amber-400/70 ring-inset dark:bg-amber-950/20"
              : "hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Badge
          variant="outline"
          className="bg-amber-50 text-amber-900 border-amber-200"
        >
          Plan
        </Badge>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate flex items-center gap-2">
            <span className="truncate">{row.label}</span>
            {payoff && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="bg-orange-50 text-orange-900 border-orange-200 dark:bg-orange-950/30 dark:text-orange-200 dark:border-orange-900 text-[10px] gap-1 px-1.5 py-0"
                    >
                      <Flame className="h-3 w-3" />
                      ends {fmtMonth(payoff.payoffDate)}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    Avalanche projects {payoff.debtName} paid off in {fmtMonth(payoff.payoffDate)}.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatDate(row.date)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4">
        {statusBadge(row.status)}
        <span
          className={`font-medium tabular-nums ${
            row.amount < 0 ? "text-destructive" : "text-primary"
          }`}
        >
          {formatCurrency(row.amount)}
        </span>
        {canMove && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              onMove?.(row);
            }}
            data-testid={`move-plan-${row.itemId}-${row.date}`}
            title="Move this occurrence to a future date"
          >
            Move to…
          </Button>
        )}
      </div>
    </div>
  );
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

export default function ForecastPage() {
  const [horizonDays, setHorizonDays] = useState<number>(() => {
    try {
      const v = sessionStorage.getItem(FORECAST_HORIZON_KEY);
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) && HORIZON_OPTS.some((h) => h.days === n)
        ? n
        : 90;
    } catch {
      return 90;
    }
  });
  const [forecastFromDate, setForecastFromDate] = useState<string>(() => {
    try {
      const stored = sessionStorage.getItem(FORECAST_FROM_KEY);
      return clampForecastFrom(stored || FORECAST_MIN_FROM_DATE);
    } catch {
      return FORECAST_MIN_FROM_DATE;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(FORECAST_HORIZON_KEY, String(horizonDays));
    } catch {
      /* no-op */
    }
  }, [horizonDays]);
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

  const { data, isLoading } = useGetForecast({ days: horizonDays });
  const { data: cashProjection, isLoading: cashProjectionLoading } =
    useGetForecastCashSignal({
      horizonDays,
      fromDate: forecastFromDate,
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftDays, setDraftDays] = useState("90");
  const [draftBalance, setDraftBalance] = useState("0");
  const [draftBuffer, setDraftBuffer] = useState("500");
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [draftSnapshot, setDraftSnapshot] = useState("");
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // (#26) Tracks which inbox card is currently hovered/focused so the
  // matching plan row can light up before the user picks the card up.
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
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
      visibleFromISO: forecastFromDate,
    });
  }, [data, closedMonths, today, debtLinks, payoffsByDebt, forecastFromDate]);

  const bucket = useMemo(() => {
    if (!register || !data) return [];
    return buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions: (data.resolutions ?? []) as Resolution[],
      closedMonths,
      monthFilter,
    });
  }, [register, data, closedMonths, monthFilter]);

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
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .map((b) => ({ id: `inbox:${b.txn.id}`, bank: b }));
  }, [register]);

  // Bank inbox is scoped to the currently-selected month so counts and
  // visible rows stay consistent. (All `inbox` rows are already
  // bank-checking — non-bank txns are filtered out at register build time.)
  const bankInbox = useMemo(
    () =>
      inbox.filter((c) => monthKey(c.bank.date) === monthFilter),
    [inbox, monthFilter],
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
      if (monthKey(b.date) !== monthFilter) continue;
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
  }, [register, data, monthFilter, checkingPlaidAccountIds]);

  // Bank reconciliation stats scoped to the selected month.
  //
  // forecastEnd = bank snapshot balance + Σ planned items in (snapshot.at, end-of-month].
  //   Bank movements that already happened (matched / unplanned / pending bank
  //   rows) are NOT added — the bank snapshot already includes everything that
  //   actually cleared, and pending bank rows represent activity the forecast
  //   hasn't yet absorbed (that's the gap).
  //
  // bankEnd = bank snapshot balance — the actual current/known bank balance.
  //   For prior closed months we don't surface a gap (we don't store a
  //   per-month historical snapshot), only counts.
  //
  // gap = forecastEnd − bankEnd. Reconciled when |gap| < $0.01 AND no pending.
  const bankReconcile = useMemo(() => {
    const empty = {
      pending: 0,
      matched: 0,
      unplanned: 0,
      gap: 0,
      total: 0,
      forecastEnd: 0,
      bankEnd: 0,
      hasBank: false,
      isPriorMonth: false,
    };
    if (!register || !data) return empty;
    let pending = 0;
    let matched = 0;
    let unplanned = 0;
    for (const b of register.allBank) {
      if (!isBankTxn(b.txn, checkingPlaidAccountIds)) continue;
      if (monthKey(b.date) !== monthFilter) continue;
      if (b.status === "pending_bank") pending += 1;
      else if (b.status === "matched") matched += 1;
      else if (b.status === "ignored_unforecasted") unplanned += 1;
    }

    const snapshotAtISO = data.bankSnapshot?.at
      ? data.bankSnapshot.at.slice(0, 10)
      : null;
    const startBal = data.bankSnapshot
      ? Number(data.bankSnapshot.balance) || 0
      : Number(data.settings.startingBalance) || 0;

    // End-of-month ISO (use month string + day 31; ISO comparison handles
    // shorter months because lex order is fine here).
    const endOfMonthISO = `${monthFilter}-31`;
    const isPriorMonth = !!snapshotAtISO && endOfMonthISO < snapshotAtISO;

    let forecastEnd = startBal;
    if (!isPriorMonth) {
      // Add planned items between snapshot date (exclusive) and end of month
      // that haven't been resolved (matched/missed) — those are what the
      // forecast still expects to flow through the bank.
      for (const p of register.allPlan) {
        if (snapshotAtISO && p.date <= snapshotAtISO) continue;
        if (p.date > endOfMonthISO) continue;
        if (p.status === "matched" || p.status === "missed") continue;
        forecastEnd += p.amount;
      }
      forecastEnd = Math.round(forecastEnd * 100) / 100;
    }

    const bankEnd = data.bankSnapshot
      ? Number(data.bankSnapshot.balance) || 0
      : forecastEnd;
    const gap = Math.round((forecastEnd - bankEnd) * 100) / 100;

    return {
      pending,
      matched,
      unplanned,
      gap,
      total: pending + matched + unplanned,
      forecastEnd,
      bankEnd,
      hasBank: !!data.bankSnapshot,
      isPriorMonth,
    };
  }, [register, data, monthFilter, checkingPlaidAccountIds]);

  const isReconciledToBank =
    bankReconcile.hasBank &&
    !bankReconcile.isPriorMonth &&
    bankReconcile.pending === 0 &&
    Math.abs(bankReconcile.gap) < 0.01;

  // Plan rows used as drop targets (active register, plan-only)
  const planRows: PlanLine[] = useMemo(() => {
    if (!register) return [];
    return register.rows.filter((r): r is PlanLine => r.kind === "plan");
  }, [register]);

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

  // Window key for confetti persistence: from→to
  const windowKey = data ? `${data.fromDate}_${data.toDate}` : null;
  const inboxCount = inbox.length;
  const cleared = shouldCelebrateClear({ inboxCount, isReconciledToBank });
  const prevClearedRef = useRef<boolean | null>(null);

  // Hydrate "reconciled" state from local storage when window changes
  useEffect(() => {
    if (!windowKey) return;
    const map = readReconciledMap();
    setReconciledNow(!!map[windowKey] && cleared);
    prevClearedRef.current = cleared;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey]);

  // Watch transitions
  useEffect(() => {
    if (!windowKey) return;
    const prev = prevClearedRef.current;
    if (prev === null) {
      prevClearedRef.current = cleared;
      return;
    }
    const map = readReconciledMap();
    if (!prev && cleared) {
      // transitioned to fully cleared — celebrate (only if not already celebrated)
      if (!map[windowKey]) {
        fireConfetti();
        map[windowKey] = true;
        writeReconciledMap(map);
      }
      setReconciledNow(true);
    } else if (!cleared && map[windowKey]) {
      // re-opened (inbox grew or balance fell out of sync): clear the
      // celebrated flag for this window so the next clear celebrates again.
      delete map[windowKey];
      writeReconciledMap(map);
      setReconciledNow(false);
    } else if (!cleared) {
      setReconciledNow(false);
    } else {
      setReconciledNow(true);
    }
    prevClearedRef.current = cleared;
  }, [cleared, windowKey]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastCashSignalQueryKey() });
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
      matchInboxToPlan(activeData.txnId, overData.planRow);
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

  const onSelectPlan = (row: PlanLine) => {
    if (row.status === "matched" || row.status === "missed") return;
    if (
      confirm(
        `Mark "${row.label}" as missed for ${formatDate(row.date)}? You can drag a Chase checking transaction here to match instead.`,
      )
    ) {
      upsertResolution.mutate(
        {
          data: {
            status: "missed",
            recurringItemId: row.itemId,
            occurrenceDate: row.originalDate ?? row.date,
          },
        },
        {
          onSuccess: () => {
            invalidate();
            toast({ title: "Marked missed" });
          },
        },
      );
    }
  };

  const onMoveStart = (row: PlanLine) => {
    setMoveTarget(row);
    setMoveDateDraft("");
    setMoveError(null);
  };
  const onMoveSave = () => {
    if (!moveTarget) return;
    if (!moveDateDraft) {
      setMoveError("Pick a date.");
      return;
    }
    const t = new Date();
    const todayIso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    if (moveDateDraft <= todayIso) {
      setMoveError("Pick a date after today.");
      return;
    }
    const occurrenceDate = moveTarget.originalDate ?? moveTarget.date;
    if (moveDateDraft <= occurrenceDate) {
      setMoveError("Pick a date after the original occurrence.");
      return;
    }
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

  const openSettings = () => {
    setDraftDays(String(data?.settings.daysAhead ?? 90));
    setDraftBalance(String(data?.settings.startingBalance ?? "0"));
    setDraftBuffer(String(data?.settings.cashBuffer ?? "500"));
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
  const onLinkChecking = (plaidAccountId: string) => {
    setBankSnapshot.mutate(
      { data: { plaidAccountId } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Linked checking account · pulled live balance" });
        },
        onError: (e) =>
          toast({
            title: "Couldn't link account",
            description: (e as Error).message,
            variant: "destructive",
          }),
      },
    );
  };
  const onRefreshBank = () => {
    refreshBank.mutate({ data: {} }, {
      onSuccess: () => {
        invalidate();
        toast({ title: "Bank balance refreshed" });
      },
      onError: (e) =>
        toast({
          title: "Refresh failed",
          description: (e as Error).message,
          variant: "destructive",
        }),
    });
  };

  if (isLoading || !data || !register) {
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

  // Status counters for hero — filtered to the active forecast window so they
  // stay consistent with the chart and KPIs above the register.
  const headerCounts = (() => {
    let flagged = 0;
    let plan = 0;
    let matched = 0;
    let unplanned = 0;
    let toMatch = 0;
    const fromISO = forecastFromDate;
    const toDateObj = new Date(`${forecastFromDate}T00:00:00`);
    toDateObj.setDate(toDateObj.getDate() + horizonDays);
    const y = toDateObj.getFullYear();
    const m = String(toDateObj.getMonth() + 1).padStart(2, "0");
    const dd = String(toDateObj.getDate()).padStart(2, "0");
    const toISO = `${y}-${m}-${dd}`;
    const inWindow = (d: string) => d >= fromISO && d <= toISO;
    if (register) {
      for (const p of register.allPlan) {
        if (!inWindow(p.date)) continue;
        if (p.status === "pending_plan" || p.status === "future") plan++;
        else if (p.status === "matched") matched++;
      }
      for (const b of register.allBank) {
        if (!inWindow(b.date)) continue;
        flagged++;
        if (b.status === "pending_bank") toMatch++;
        else if (b.status === "matched") matched++;
        else if (b.status === "ignored_unforecasted") unplanned++;
      }
    }
    return { flagged, plan, toMatch, matched, unplanned };
  })();

  const proj = cashProjection;
  const endingNum = proj?.endingBalance ? Number(proj.endingBalance) : NaN;
  const lowestNum = proj?.lowestProjected ? Number(proj.lowestProjected) : NaN;
  const dailySeries = (proj?.daily ?? [])
    .map((d: { date: string; balance: string | number }) => ({
      date: shortDate(d.date),
      rawDate: d.date,
      balance: Number(d.balance),
    }))
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

  return (
    <div className="space-y-6">
      <PlaidReauthBanner />
      <div className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 -mt-4 md:-mt-8 pt-4 md:pt-8 pb-4 bg-background border-b shadow-sm space-y-6">
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
            Section IV — Forecast
          </div>
          <h1 className="text-2xl font-serif font-bold text-foreground tracking-tight mt-1">
            Plan register — you decide every match.
          </h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Label htmlFor="forecast-from" className="text-xs text-muted-foreground">
              Forecast from
            </Label>
            <Input
              id="forecast-from"
              type="date"
              value={forecastFromDate}
              min={FORECAST_MIN_FROM_DATE}
              onChange={(e) => setForecastFromDate(clampForecastFrom(e.target.value))}
              className="h-9 w-[160px]"
              data-testid="input-forecast-from"
            />
          </div>
          <Button variant="outline" asChild>
            <Link href="/bills" data-testid="link-manage-bills">
              Manage in Bills
            </Link>
          </Button>
          <Button variant="outline" onClick={openSettings}>
            <SettingsIcon className="w-4 h-4 mr-2" /> Settings
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap" data-testid="horizon-tabs">
        {HORIZON_OPTS.map((h) => {
          const active = horizonDays === h.days;
          return (
            <Button
              key={h.label}
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => setHorizonDays(h.days)}
              className="text-xs tracking-wider"
              data-testid={`horizon-${h.days}`}
            >
              {h.label}
            </Button>
          );
        })}
      </div>

      {/* Hero: Current Forecast Balance */}
      <Card data-testid="card-forecast-hero" className="border-2">
        <CardContent className="p-6">
          <div className="flex justify-between items-start gap-6 flex-wrap">
            <div className="space-y-2 min-w-0">
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
                Current Forecast Balance
              </div>
              <div
                className={`text-5xl font-bold tabular-nums ${
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
              <div className="text-sm text-muted-foreground space-y-0.5 pt-1">
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
              <div className="flex items-center gap-1.5 flex-wrap justify-end" data-testid="hero-counters">
                <Badge variant="outline" className="bg-amber-50 text-amber-900 border-amber-200">
                  {headerCounts.flagged} flagged
                </Badge>
                <span className="text-muted-foreground">·</span>
                <Badge variant="outline">{headerCounts.plan} plan</Badge>
                <span className="text-muted-foreground">·</span>
                <Badge variant="outline" className="bg-sky-50 text-sky-900 border-sky-200">
                  {headerCounts.toMatch} to match
                </Badge>
                <span className="text-muted-foreground">·</span>
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
                  {headerCounts.matched} matched
                </Badge>
                <span className="text-muted-foreground">·</span>
                <Badge variant="outline" className="bg-muted text-muted-foreground">
                  {headerCounts.unplanned} unplanned
                </Badge>
              </div>
              {inboxCount === 0 && reconciledNow && (
                <Badge
                  className="bg-primary/15 text-primary border-primary/30"
                  data-testid="badge-inbox-cleared"
                >
                  <PartyPopper className="w-3.5 h-3.5 mr-1" /> Inbox cleared
                </Badge>
              )}
              {inboxCount === 0 &&
                !reconciledNow &&
                bankReconcile.hasBank &&
                !bankReconcile.isPriorMonth &&
                Math.abs(bankReconcile.gap) >= 0.01 && (
                  <Badge
                    variant="outline"
                    className="bg-amber-50 text-amber-900 border-amber-200 max-w-[260px] whitespace-normal text-right"
                    data-testid="badge-balance-mismatch"
                  >
                    <AlertCircle className="w-3.5 h-3.5 mr-1 flex-none" />
                    Inbox clear, but forecast end balance is off by{" "}
                    {formatCurrency(bankReconcile.gap)} from the bank — match
                    the rest or mark them unplanned.
                  </Badge>
                )}
            </div>
          </div>
        </CardContent>
      </Card>
      </div>

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
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const p = payload[0]?.payload as
                      | { rawDate?: string; balance?: number }
                      | undefined;
                    const rawDate = p?.rawDate;
                    const balance = Number(p?.balance);
                    const marker = rawDate ? bigBillByDate.get(rawDate) : undefined;
                    return (
                      <div
                        style={{
                          background: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 6,
                          fontSize: 12,
                          padding: "8px 10px",
                          minWidth: 160,
                          boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>
                          {rawDate ? formatDate(rawDate) : ""}
                        </div>
                        <div style={{ marginTop: 2 }}>
                          Balance:{" "}
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            {Number.isFinite(balance)
                              ? formatCurrency(balance)
                              : "—"}
                          </span>
                        </div>
                        {marker && (
                          <div style={{ marginTop: 6 }}>
                            <div
                              style={{
                                fontSize: 10,
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                                color: "hsl(var(--muted-foreground))",
                                marginBottom: 4,
                              }}
                            >
                              Big bills today
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 2,
                              }}
                            >
                              {marker.bills.map((b, idx) => {
                                const canJump = !!b.itemId;
                                return (
                                  <button
                                    key={`${b.itemId ?? "_"}-${idx}`}
                                    type="button"
                                    disabled={!canJump}
                                    onClick={() => {
                                      if (b.itemId)
                                        jumpToPlan(b.itemId, marker.date);
                                    }}
                                    data-testid={`tooltip-bill-${marker.date}-${b.itemId ?? idx}`}
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      gap: 12,
                                      padding: "2px 4px",
                                      borderRadius: 4,
                                      border: "none",
                                      background: "transparent",
                                      cursor: canJump ? "pointer" : "default",
                                      textAlign: "left",
                                      color: "inherit",
                                      font: "inherit",
                                    }}
                                    onMouseEnter={(e) => {
                                      if (canJump)
                                        (e.currentTarget as HTMLElement).style.background =
                                          "hsl(var(--muted))";
                                    }}
                                    onMouseLeave={(e) => {
                                      (e.currentTarget as HTMLElement).style.background =
                                        "transparent";
                                    }}
                                  >
                                    <span style={{ minWidth: 0 }}>{b.label}</span>
                                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                                      {formatCurrency(b.amount)}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke="hsl(var(--chart-1))"
                  strokeWidth={2}
                  fill="url(#projectedBalanceGrad)"
                  name="Projected balance"
                  isAnimationActive={false}
                />
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
        <AvalancheReadyCard />
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v);
          if (typeof window !== "undefined") {
            const hash = v === "bucket" ? "#bucket" : "";
            const next = `${window.location.pathname}${window.location.search}${hash}`;
            window.history.replaceState(null, "", next);
          }
        }}
        className="w-full"
      >
        <TabsList>
          <TabsTrigger value="register">Active Register</TabsTrigger>
          <TabsTrigger value="bucket">Review Bucket</TabsTrigger>
        </TabsList>

        <TabsContent value="register" className="mt-4 space-y-4">
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setActiveDragId(null)}
          >
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
                      Bank {formatCurrency(bankReconcile.bankEnd)} ·
                      Gap {formatCurrency(bankReconcile.gap)}
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
                {bankInbox.length === 0 ? (
                  <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                    {isReconciledToBank ? (
                      <span className="inline-flex items-center gap-2 text-primary">
                        <CheckCircle2 className="w-4 h-4" /> Reconciled to bank for {monthFilter}.
                      </span>
                    ) : (
                      <>Send a bank transaction from the Transactions page to start reconciling.</>
                    )}
                  </div>
                ) : (
                  bankInbox.map((card) => {
                    const sugs = bankSuggestions.get(card.bank.txn.id) ?? [];
                    const txnId = card.bank.txn.id;
                    const isSelected = selectedBankIds.has(txnId);
                    return (
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
                    );
                  })
                )}
                {bankResolvedThisMonth.length > 0 && (
                  <div
                    className="mt-3 pt-3 border-t space-y-1"
                    data-testid="bank-resolved-list"
                  >
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                      Resolved this month — undo if needed
                    </div>
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
                )}
              </CardContent>
            </Card>

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
                <div className="divide-y divide-border">
                  {planRows.length === 0 && (
                    <div className="p-12 text-center text-muted-foreground">
                      All clear — nothing planned in this window.
                    </div>
                  )}
                  {(() => {
                    const out: ReactNode[] = [];
                    const shownTransitions = new Set<string>();
                    for (let i = 0; i < planRows.length; i++) {
                      const row = planRows[i];
                      out.push(
                        <PlanDropRow
                          key={`${row.itemId}-${row.date}-${i}`}
                          row={row}
                          onSelect={onSelectPlan}
                          onMove={onMoveStart}
                          activeDragId={activeDragId}
                          payoff={payoffsByItem.get(row.itemId)}
                          isBestSuggestion={
                            bestSuggestionPlanKey ===
                            `${row.itemId}|${row.date}`
                          }
                          isHighlighted={
                            highlightedPlanKey ===
                            `${row.itemId}|${row.date}`
                          }
                        />,
                      );
                      const currentYM = row.date.slice(0, 7);
                      const nextYM = planRows[i + 1]?.date.slice(0, 7);
                      if (nextYM !== currentYM) {
                        const transitions =
                          payoffTransitionsByMonth.get(currentYM) ?? [];
                        for (const t of transitions) {
                          if (shownTransitions.has(t.debtId)) continue;
                          shownTransitions.add(t.debtId);
                          out.push(
                            <CashFreedBanner
                              key={`freed-${t.debtId}`}
                              transition={t}
                            />,
                          );
                        }
                      }
                    }
                    return out;
                  })()}
                </div>
              </CardContent>
            </Card>

            {(() => {
              const missed = bucket.filter((b) => b.status === "missed");
              if (missed.length === 0) return null;
              return (
                <Card data-testid="missed-bucket-panel">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-600" />
                      Missed in {monthFilter}
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {missed.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y divide-border">
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
              return (
                <Card data-testid="rescheduled-bucket-panel">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <CalendarDays className="w-4 h-4 text-violet-600" />
                      Moved from {monthFilter}
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {moved.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y divide-border">
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
        </TabsContent>

        <TabsContent value="bucket" className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Label className="text-sm">Month</Label>
              <Select value={monthFilter} onValueChange={setMonthFilter}>
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
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

          <Card data-testid="reconcile-history">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                <History className="w-4 h-4" /> Reconcile history
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {(() => {
                  const months = monthsAvailable
                    .filter((m) => m <= currentMonth)
                    .slice(-6)
                    .reverse();
                  if (months.length === 0) {
                    return (
                      <div className="p-4 text-sm text-muted-foreground text-center">
                        No history yet.
                      </div>
                    );
                  }
                  return months.map((m) => {
                    const isMClosed = closedMonths.has(m);
                    const snap = monthSnapshotsMap[m];
                    const isCurrent = m === currentMonth;
                    // For an open current month, evaluate live; for closed
                    // months use the frozen snapshot; otherwise show "—".
                    let reconciled: boolean | null = null;
                    let gap: number | null = null;
                    if (isMClosed && snap) {
                      reconciled = !!snap.reconciled;
                      gap = snap.gap != null ? Number(snap.gap) : null;
                    } else if (isCurrent && !isMClosed) {
                      // Live: only meaningful when the user is currently
                      // looking at this month (bankReconcile is scoped to
                      // monthFilter). Approximate by showing live values
                      // when monthFilter === currentMonth.
                      if (monthFilter === currentMonth && bankReconcile.hasBank) {
                        reconciled = isReconciledToBank;
                        gap = bankReconcile.gap;
                      }
                    }
                    return (
                      <div
                        key={m}
                        className="p-3 flex items-center justify-between gap-3 text-sm"
                        data-testid={`reconcile-history-row-${m}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium tabular-nums">{m}</span>
                          {isMClosed ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] gap-1"
                            >
                              <Lock className="w-3 h-3" /> closed
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-muted text-muted-foreground"
                            >
                              open
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {reconciled === true ? (
                            <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px] gap-1">
                              <CheckCircle2 className="w-3 h-3" /> reconciled
                            </Badge>
                          ) : reconciled === false ? (
                            <Badge
                              variant="outline"
                              className="bg-amber-50 text-amber-900 border-amber-200 text-[10px] gap-1"
                            >
                              <AlertCircle className="w-3 h-3" /> gap
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                          <span
                            className={`text-xs tabular-nums w-24 text-right ${
                              gap != null && Math.abs(gap) >= 0.01
                                ? "text-amber-700 dark:text-amber-400"
                                : "text-muted-foreground"
                            }`}
                          >
                            {gap != null ? formatCurrency(gap) : "—"}
                          </span>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {bucket.length === 0 && (
                  <div className="p-12 text-center text-muted-foreground">
                    {isClosed ? "Month is closed — bucket hidden." : "Nothing triaged for this month yet."}
                  </div>
                )}
                {bucket.map((b) => (
                  <div key={b.id} className="p-4 flex items-center justify-between gap-3">
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
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

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
                type="number"
                step="0.01"
                value={draftBalance}
                onChange={(e) => setDraftBalance(e.target.value)}
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
            <DialogTitle>Move occurrence to a future date</DialogTitle>
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
                    t.setDate(t.getDate() + 1);
                    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
                  })()}
                  onChange={(e) => {
                    setMoveDateDraft(e.target.value);
                    setMoveError(null);
                  }}
                  data-testid="input-move-date"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Must be after today. Creates a one-off override for this
                  occurrence only.
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
    </div>
  );
}
