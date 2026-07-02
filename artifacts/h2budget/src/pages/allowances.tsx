import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { ChevronLeft, ChevronRight, ChevronDown, Pencil, Ban, Split, Flame } from "lucide-react";
import { SplitTransactionDialog } from "@/components/split-transaction-dialog";
import { AiInsightBar } from "@/components/ai-insight-bar";
import {
  useListTransactions,
  useGetSettings,
  useListCategories,
  useGetWeeklyDebrief,
  useUpdateTransaction,
  useUpdateSettings,
  getListTransactionsQueryKey,
  getGetSettingsQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToCancelList, toCancelKey } from "@/hooks/useToCancelList";
import { KillStack } from "@/components/kill-stack";
import { MiniBars } from "@/components/viz";
import {
  RingMeter,
  StatusPill,
  FillMeter,
  WhyExpander,
  TrendSparkline,
  spendStatus,
  type TrendPoint,
} from "@/components/stat";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, cn } from "@/lib/utils";
import {
  SUB_BUCKETS,
  type SubBucket,
  useWeeklyBucketLabels,
  effectiveBucket,
} from "@/lib/weeklyBuckets";

// ----- date helpers ---------------------------------------------------

function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function sundayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function lastOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function daysInMonthOf(d: Date): number {
  return lastOfMonth(d).getDate();
}
function formatWeekRange(sun: Date): string {
  const sat = addDays(sun, 6);
  const sameMonth = sun.getMonth() === sat.getMonth();
  const left = sun.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const right = sat.toLocaleDateString("en-US", {
    month: sameMonth ? undefined : "short",
    day: "numeric",
  });
  return `${left} – ${right}, ${sat.getFullYear()}`;
}
function formatMonth(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function formatTxnDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// Spend magnitude, shared with the Banking dashboard via lib/bucketSpend so the
// two surfaces always agree. Source-aware: Amex charges are stored positive,
// bank/Chase charges negative — both count as spend.
import { expenseMagnitude as expenseAmount } from "@/lib/bucketSpend";

// How many COMPLETED weeks in a row, ending last week, did they blow the
// weekly allowance? Walks back week-by-week from the last finished Sun–Sat
// week and stops the first time a week came in at/under plan. This is the
// deterministic spine of the "you went over AGAIN" roast — no AI required.
function weeklyOverStreak(
  txns: Transaction[],
  weeklyAmt: number,
  overrides: Record<string, number>,
  today: Date,
): number {
  if (weeklyAmt <= 0) return 0;
  let weekSun = addDays(sundayOf(today), -7); // last fully-completed week
  let streak = 0;
  for (let i = 0; i < 26; i++) {
    const start = fmtISO(weekSun);
    const end = fmtISO(addDays(weekSun, 6));
    let spend = 0;
    let any = false;
    for (const t of txns) {
      if (effectiveBucket(t) !== "weekly") continue;
      if (t.occurredOn >= start && t.occurredOn <= end) {
        spend += expenseAmount(t);
        any = true;
      }
    }
    const planned = overrides[start] != null ? overrides[start] : weeklyAmt;
    if (any && planned > 0 && spend > planned) {
      streak++;
      weekSun = addDays(weekSun, -7);
    } else {
      break;
    }
  }
  return streak;
}

// Escalating, multi-country trash talk for an over-budget streak. Earned and
// true — only ever shown when the streak is real. Gets nastier the longer
// they keep blowing it.
function roastForStreak(n: number): string {
  if (n <= 1) return "";
  if (n === 2)
    return "Two weeks over your weekly allowance. Let's not make it a habit — tighten it up and that's days off the payoff date.";
  if (n === 3)
    return "Three weeks over in a row. The number's right there — rein it in and put the difference on the cards.";
  if (n <= 5)
    return `${n} weeks over, back to back. Time to make the budget mean something — small cuts now, big payoff later.`;
  if (n <= 9)
    return `${n} weeks over. You're better than this — trim the easy wins and you'll feel it on the debt.`;
  return `${n} weeks over budget in a row. Deep breath, reset the week — every dollar back is a dollar off the debt.`;
}

// The positive counterpart to roastForStreak — how many COMPLETED weeks in a
// row, ending last week, they came in AT or UNDER the weekly allowance. Same
// deterministic walk-back; drives the "look at you" hype banner.
function weeklyUnderStreak(
  txns: Transaction[],
  weeklyAmt: number,
  overrides: Record<string, number>,
  today: Date,
): number {
  if (weeklyAmt <= 0) return 0;
  let weekSun = addDays(sundayOf(today), -7);
  let streak = 0;
  for (let i = 0; i < 26; i++) {
    const start = fmtISO(weekSun);
    const end = fmtISO(addDays(weekSun, 6));
    let spend = 0;
    let any = false;
    for (const t of txns) {
      if (effectiveBucket(t) !== "weekly") continue;
      if (t.occurredOn >= start && t.occurredOn <= end) {
        spend += expenseAmount(t);
        any = true;
      }
    }
    const planned = overrides[start] != null ? overrides[start] : weeklyAmt;
    if (any && planned > 0 && spend <= planned) {
      streak++;
      weekSun = addDays(weekSun, -7);
    } else {
      break;
    }
  }
  return streak;
}

// Earned praise for an under-budget streak — same affectionate register as the
// roast, just pointed the other way. Only ever shown when the streak is real.
function praiseForStreak(n: number): string {
  if (n <= 1) return "";
  if (n === 2)
    return "Two weeks under budget. Look at you, fiscally responsible adults. 🟢";
  if (n <= 4)
    return `${n} weeks under, back to back. Genuinely brilliant — keep the receipts, you legends.`;
  return `${n} weeks under budget in a row. Frankly showing off now. Don't you dare slip.`;
}

// Last N completed Sun–Sat weeks' over/under variance (spend − planned) for
// the weekly allowance — the data behind the 8-week drill bars. Oldest first.
function weeklyVarianceSeries(
  txns: Transaction[],
  weeklyAmt: number,
  overrides: Record<string, number>,
  today: Date,
  weeks = 8,
): { weekSun: Date; weekISO: string; variance: number }[] {
  const last = addDays(sundayOf(today), -7);
  const out: { weekSun: Date; weekISO: string; variance: number }[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = addDays(last, -7 * i);
    const start = fmtISO(ws);
    const end = fmtISO(addDays(ws, 6));
    let spend = 0;
    for (const t of txns) {
      if (effectiveBucket(t) !== "weekly") continue;
      if (t.occurredOn >= start && t.occurredOn <= end) spend += expenseAmount(t);
    }
    const planned = overrides[start] != null ? overrides[start] : weeklyAmt;
    out.push({ weekSun: ws, weekISO: start, variance: spend - (planned || 0) });
  }
  return out;
}

// ----- bucket config --------------------------------------------------

type BucketKey = "weekly" | "monthly" | "unplanned";
type Mode = "week" | "month";

const BUCKETS: { key: BucketKey; name: string; noun: string }[] = [
  { key: "weekly", name: "Weekly allowance", noun: "weekly allowance" },
  { key: "monthly", name: "Monthly allowance", noun: "monthly allowance" },
  { key: "unplanned", name: "Unplanned allowance", noun: "unplanned allowance" },
];

function hasBucketFlag(t: Transaction, key: BucketKey): boolean {
  if (key === "weekly") return effectiveBucket(t) === "weekly";
  if (key === "monthly") return !!t.monthlyAllowance;
  return !!t.unplannedAllowance;
}

type Group = {
  key: string;
  label: string;
  amount: number;
  txns: Transaction[];
};

// ----- drill-down rows ------------------------------------------------

function TxnRow({
  t,
  subLabels,
  onChangeBucket,
  categories,
  onChangeCategory,
  onToCancel,
  isToCancel,
  onSplit,
}: {
  t: Transaction;
  subLabels?: Record<SubBucket, string>;
  onChangeBucket?: (t: Transaction, sub: SubBucket) => void;
  categories?: { id: string; name: string }[];
  onChangeCategory?: (t: Transaction, categoryId: string) => void;
  onToCancel?: (t: Transaction) => void;
  isToCancel?: boolean;
  onSplit?: (t: Transaction) => void;
}) {
  const current: SubBucket = SUB_BUCKETS.includes(t.weeklyBucket as SubBucket)
    ? (t.weeklyBucket as SubBucket)
    : "misc";
  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-1.5 pl-9 text-sm"
      data-testid={`allowance-txn-${t.id}`}
    >
      <div className="flex items-baseline gap-3 min-w-0">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground w-12 shrink-0 tabular-nums">
          {formatTxnDate(t.occurredOn)}
        </span>
        <span className="truncate">{t.description}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {onChangeBucket && subLabels && (
          <Select
            value={current}
            onValueChange={(v) => onChangeBucket(t, v as SubBucket)}
          >
            <SelectTrigger
              className="h-7 w-[120px] text-xs"
              aria-label="Allowance bucket"
              data-testid={`allowance-bucket-select-${t.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUB_BUCKETS.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">
                  {subLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {onChangeCategory && categories && (
          <Select
            value={t.categoryId ?? undefined}
            onValueChange={(v) => onChangeCategory(t, v)}
          >
            <SelectTrigger
              className="h-7 w-[160px] text-xs"
              aria-label="Category"
              data-testid={`allowance-category-select-${t.id}`}
            >
              <SelectValue placeholder="Uncategorized" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-xs">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {onSplit && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs w-[74px] justify-center shrink-0"
            onClick={() => onSplit(t)}
            data-testid={`allowance-split-${t.id}`}
            title="Split this purchase across weekly buckets"
          >
            <Split className="w-3.5 h-3.5 mr-1.5" />
            Split
          </Button>
        )}
        {onToCancel && (
          <Button
            type="button"
            variant={isToCancel ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs w-[96px] justify-center shrink-0"
            onClick={() => onToCancel(t)}
            data-testid={`allowance-to-cancel-${t.id}`}
            title={
              isToCancel
                ? "On your To-cancel list"
                : "Add to your To-cancel list"
            }
          >
            <Ban className="w-3.5 h-3.5 mr-1.5" />
            {isToCancel ? "On list" : "To cancel"}
          </Button>
        )}
        <span className="tabular-nums whitespace-nowrap font-mono w-24 text-right shrink-0">
          {formatCurrency(expenseAmount(t))}
        </span>
      </div>
    </div>
  );
}

function CategoryGroupRow({
  group,
  subLabels,
  onChangeBucket,
  categories,
  onChangeCategory,
  onToCancel,
  isToCancel,
  onSplit,
}: {
  group: Group;
  subLabels?: Record<SubBucket, string>;
  onChangeBucket?: (t: Transaction, sub: SubBucket) => void;
  categories?: { id: string; name: string }[];
  onChangeCategory?: (t: Transaction, categoryId: string) => void;
  onToCancel?: (t: Transaction) => void;
  isToCancel?: (t: Transaction) => boolean;
  onSplit?: (t: Transaction) => void;
}) {
  const [open, setOpen] = useState(false);
  const expandable = group.txns.length > 0;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild disabled={!expandable}>
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-sm focus:outline-none",
            expandable ? "hover:bg-muted/50 cursor-pointer" : "cursor-default",
          )}
          data-testid={`allowance-group-${group.key}`}
        >
          <span className="flex min-w-0 items-center gap-1 font-medium">
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform",
                open ? "" : "-rotate-90",
                !expandable && "opacity-0",
              )}
            />
            <span className="truncate">{group.label}</span>
            <span className="text-[11px] text-muted-foreground">
              ({group.txns.length})
            </span>
          </span>
          <span className="tabular-nums whitespace-nowrap">
            {formatCurrency(group.amount)}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {group.txns.map((t) => (
          <TxnRow
            key={t.id}
            t={t}
            subLabels={subLabels}
            onChangeBucket={onChangeBucket}
            categories={categories}
            onChangeCategory={onChangeCategory}
            onToCancel={onToCancel}
            isToCancel={isToCancel?.(t)}
            onSplit={onSplit}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ----- bucket summary card --------------------------------------------

// A little trash talk. Reacts to how much of the planned allowance is spent —
// fun, but also a real at-a-glance gut check. Keeps it light and just-for-us.
function funVerdict(actual: number, planned: number): string | null {
  if (planned <= 0) return null;
  const r = actual / planned;
  if (r <= 0.4) return "Barely made a dent. Look at you two 😎";
  if (r <= 0.75) return "Cruising — plenty left for fun 🟢";
  if (r < 0.95) return "Cutting it close. Eyes on it 👀";
  if (r <= 1.05) return "Riiight on the line. Hold steady 😅";
  if (r <= 1.2) return "Over it. Easy there, tiger 😬";
  return "Whoa. Date night's officially BYO 🙈";
}

function BucketCard({
  name,
  actual,
  planned,
  expanded,
  onToggle,
  onSavePlanned,
  trend,
}: {
  name: string;
  actual: number;
  planned: number;
  expanded: boolean;
  onToggle: () => void;
  onSavePlanned?: (amount: number) => void;
  /** Optional 8-week over/under variance strip (spend − planned per week). */
  trend?: TrendPoint[];
}) {
  const variance = actual - planned;
  const over = variance > 0;
  const ratio = planned > 0 ? actual / planned : 0;
  const status = planned > 0 ? spendStatus(ratio) : "neutral";
  const statusLabel =
    planned <= 0 ? "No target" : over ? "Over" : ratio >= 0.85 ? "On track" : "Under";
  const slug = name.split(" ")[0].toLowerCase();
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const save = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0) {
      onSavePlanned?.(Math.round(n * 100) / 100);
      setEditOpen(false);
    }
  };
  return (
    <Card className={cn("transition-colors", expanded && "ring-2 ring-primary/40")}>
      <CardContent className="p-5 space-y-3">
        {/* Header + actual are the expand toggle. The planned line below
            stays outside the button so the edit popover isn't nested in it. */}
        <button
          type="button"
          onClick={onToggle}
          className="w-full text-left focus:outline-none"
          data-testid={`allowance-card-${slug}`}
          aria-expanded={expanded}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              {name}
            </span>
            <div className="flex items-center gap-2">
              {planned > 0 && <StatusPill status={status}>{statusLabel}</StatusPill>}
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  expanded ? "" : "-rotate-90",
                )}
              />
            </div>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <RingMeter
              ratio={ratio}
              status={status}
              size={64}
              stroke={7}
              centerTop={`${Math.round(ratio * 100)}%`}
              centerBottom="used"
            />
            <div className="text-3xl font-bold tracking-tight tabular-nums">
              {formatCurrency(actual)}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <span>of {formatCurrency(planned)} planned</span>
          {onSavePlanned && (
            <Popover
              open={editOpen}
              onOpenChange={(o) => {
                setEditOpen(o);
                if (o) setDraft(planned > 0 ? planned.toFixed(2) : "");
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-foreground"
                  aria-label="Edit planned amount"
                  title="Edit planned amount"
                  data-testid={`allowance-edit-planned-${slug}`}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-3" align="start">
                <div className="space-y-2">
                  <div className="text-xs font-medium">
                    Planned {name.toLowerCase()}
                  </div>
                  <Input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        save();
                      }
                    }}
                    placeholder="450.00"
                    autoFocus
                    data-testid={`input-planned-${slug}`}
                  />
                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={save} disabled={!draft.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        {planned > 0 && (
          <FillMeter
            value={actual}
            ceiling={planned}
            status={status}
            floorLabel="$0"
            ceilingLabel={formatCurrency(planned)}
            format={(n) => formatCurrency(n)}
          />
        )}
        <div
          className={cn(
            "text-sm font-medium tabular-nums",
            over ? "text-destructive" : "text-positive",
          )}
          data-testid={`allowance-variance-${slug}`}
        >
          {planned <= 0
            ? "No allowance set"
            : over
              ? `${formatCurrency(variance)} over`
              : `${formatCurrency(Math.abs(variance))} under`}
        </div>
        {funVerdict(actual, planned) && (
          <div
            className="text-xs italic text-muted-foreground"
            data-testid={`allowance-verdict-${slug}`}
          >
            {funVerdict(actual, planned)}
          </div>
        )}
        <WhyExpander>
          <p className="leading-snug">
            You&apos;ve spent{" "}
            <span className="font-medium text-foreground">{formatCurrency(actual)}</span>{" "}
            of your {formatCurrency(planned)} {name.toLowerCase()} —{" "}
            {planned <= 0
              ? "set a target to start tracking."
              : over
                ? `${formatCurrency(variance)} over plan.`
                : `${formatCurrency(Math.abs(variance))} still in the tank.`}
          </p>
          {trend && trend.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-widest mb-1.5">
                Last {trend.length} weeks · over / under
              </div>
              <TrendSparkline data={trend} height={32} />
            </div>
          )}
        </WhyExpander>
      </CardContent>
    </Card>
  );
}

// ----- page -----------------------------------------------------------

export default function AllowancesPage() {
  const today = useMemo(() => new Date(), []);
  // Preselect Week/Month from the dashboard tile deep-link (?view=week|month|
  // unplanned). Unplanned is a card within the month scope, so it opens Month.
  const search = useSearch();
  const [mode, setMode] = useState<Mode>(() => {
    const view = new URLSearchParams(search).get("view");
    if (view === "month" || view === "unplanned") return "month";
    return "week";
  });
  const [weekStart, setWeekStart] = useState<Date>(() => sundayOf(new Date()));
  const [monthStart, setMonthStart] = useState<Date>(() =>
    firstOfMonth(new Date()),
  );

  const currentWeekStart = useMemo(() => sundayOf(today), [today]);
  const currentMonthStart = useMemo(() => firstOfMonth(today), [today]);

  // Window for the selected period.
  const { windowStart, windowEnd, windowDays, windowStartDate, isCurrent } =
    useMemo(() => {
      if (mode === "week") {
        return {
          windowStart: fmtISO(weekStart),
          windowEnd: fmtISO(addDays(weekStart, 6)),
          windowDays: 7,
          windowStartDate: weekStart,
          isCurrent: fmtISO(weekStart) === fmtISO(currentWeekStart),
        };
      }
      return {
        windowStart: fmtISO(firstOfMonth(monthStart)),
        windowEnd: fmtISO(lastOfMonth(monthStart)),
        windowDays: daysInMonthOf(monthStart),
        windowStartDate: firstOfMonth(monthStart),
        isCurrent: fmtISO(monthStart) === fmtISO(currentMonthStart),
      };
    }, [mode, weekStart, monthStart, currentWeekStart, currentMonthStart]);

  // (#monthly) The Monthly and Unplanned cards always reflect the whole MONTH,
  // never a week slice. In week mode we anchor to the month containing the week's
  // END (Saturday) so a week that straddles a month boundary (e.g. Jun 28–Jul 4)
  // resolves to the SAME calendar month the Banking dashboard uses (the current
  // month) — that's what makes the dashboard Month/Unplanned tie to Allowances.
  const monthScopeStartDate = useMemo(
    () =>
      mode === "week"
        ? firstOfMonth(addDays(weekStart, 6))
        : firstOfMonth(windowStartDate),
    [mode, weekStart, windowStartDate],
  );
  const monthScopeStart = fmtISO(monthScopeStartDate);
  const monthScopeEnd = fmtISO(lastOfMonth(monthScopeStartDate));

  const atOrAfterCurrent =
    mode === "week"
      ? weekStart >= currentWeekStart
      : monthStart >= currentMonthStart;

  const goPrev = () => {
    if (mode === "week") setWeekStart((w) => addDays(w, -7));
    else setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  };
  const goNext = () => {
    if (atOrAfterCurrent) return;
    if (mode === "week") setWeekStart((w) => addDays(w, 7));
    else setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
  };

  const { data: settings } = useGetSettings();
  const { data: categories } = useListCategories();
  const SUB_LABEL = useWeeklyBucketLabels();
  const updateTx = useUpdateTransaction();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateSettings = useUpdateSettings();

  // Per-week weekly-allowance overrides, keyed by the week's Sunday (ISO).
  // Stored HOUSEHOLD-SIDE in settings.preferences so an edit by one partner
  // shows up for the other (the old localStorage version only lived in the
  // editor's own browser — which is why "my wife changed it and mine didn't").
  const weeklyOverrides = useMemo<Record<string, number>>(() => {
    const raw = settings?.preferences?.weeklyAllowanceOverrides ?? {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  }, [settings]);

  // One-time lift of any legacy per-browser overrides up to the shared
  // household record, so values entered before this fix aren't lost. Server
  // values win on conflict; the local copy is cleared once pushed.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (!settings || migratedRef.current) return;
    migratedRef.current = true;
    let local: Record<string, string> = {};
    try {
      const raw = localStorage.getItem("h2:weekly-allowance-overrides");
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>;
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v);
          if (Number.isFinite(n)) local[k] = n.toFixed(2);
        }
      }
    } catch {
      /* ignore */
    }
    if (Object.keys(local).length === 0) return;
    const serverOv = settings.preferences?.weeklyAllowanceOverrides ?? {};
    const merged = { ...local, ...serverOv }; // server wins on conflict
    if (Object.keys(merged).length === Object.keys(serverOv).length) {
      try {
        localStorage.removeItem("h2:weekly-allowance-overrides");
      } catch {
        /* ignore */
      }
      return;
    }
    const nextPrefs = {
      ...(settings.preferences ?? {}),
      weeklyAllowanceOverrides: merged,
    };
    updateSettings
      .mutateAsync({ data: { preferences: nextPrefs } })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        try {
          localStorage.removeItem("h2:weekly-allowance-overrides");
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        migratedRef.current = false; // let it retry on a later render
      });
  }, [settings, updateSettings, queryClient]);

  // Edit a bucket's PLANNED allowance amount inline (the "of $X planned"
  // line). PATCHes the matching settings field.
  const savePlanned = async (key: BucketKey, amount: number) => {
    // Weekly edit while viewing a specific week → override THIS week only,
    // leaving the global weekly default (and every other week) untouched.
    // Persisted to the shared household settings so BOTH partners see it.
    if (key === "weekly" && mode === "week") {
      const wk = fmtISO(weekStart);
      const prevOverrides =
        settings?.preferences?.weeklyAllowanceOverrides ?? {};
      const nextPrefs = {
        ...(settings?.preferences ?? {}),
        weeklyAllowanceOverrides: { ...prevOverrides, [wk]: amount.toFixed(2) },
      };
      try {
        await updateSettings.mutateAsync({ data: { preferences: nextPrefs } });
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: "Weekly allowance set for this week" });
      } catch (e) {
        toast({
          title: "Couldn't update",
          description: (e as Error).message,
          variant: "destructive",
        });
      }
      return;
    }
    const val = amount.toFixed(2);
    const data =
      key === "weekly"
        ? { weeklyAllowanceAmount: val }
        : key === "monthly"
          ? { monthlyAllowanceAmount: val }
          : { unplannedAllowanceAmount: val };
    try {
      await updateSettings.mutateAsync({ data });
      queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      toast({ title: "Allowance updated" });
    } catch (e) {
      toast({
        title: "Couldn't update",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // Move a transaction between the weekly sub-buckets (Groceries / Dining /
  // Entertainment / Misc) straight from the breakdown.
  const changeWeeklyBucket = async (t: Transaction, sub: SubBucket) => {
    const current = SUB_BUCKETS.includes(t.weeklyBucket as SubBucket)
      ? (t.weeklyBucket as SubBucket)
      : "misc";
    if (current === sub) return;
    try {
      await updateTx.mutateAsync({ id: t.id, data: { weeklyBucket: sub } });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      toast({ title: `Moved to ${SUB_LABEL[sub]}` });
    } catch (e) {
      toast({
        title: "Couldn't move",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // (#to-cancel) Flag an unplanned charge onto the shared "To cancel" list
  // (the same bucket surfaced under Reports → Behavior → Subscriptions). We
  // treat it as a recurring monthly drain so the bucket's annual-savings
  // total is meaningful; the user can remove it if it was a one-off.
  const toCancel = useToCancelList();
  const toCancelKeyFor = (t: Transaction) =>
    toCancelKey(t.displayName || t.description);
  const handleToCancelTxn = (t: Transaction) => {
    const key = toCancelKeyFor(t);
    if (toCancel.has(key)) {
      toCancel.remove(key);
      return;
    }
    const monthly = Math.abs(expenseAmount(t));
    toCancel.add({
      key,
      name: t.displayName || t.description,
      monthly,
      annual: monthly * 12,
    });
  };

  // Change a transaction's CATEGORY from the Monthly / Unplanned breakdown
  // (those group by real category, unlike Weekly's sub-buckets).
  const changeCategory = async (t: Transaction, categoryId: string) => {
    if ((t.categoryId ?? "") === categoryId) return;
    try {
      await updateTx.mutateAsync({ id: t.id, data: { categoryId } });
      queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      toast({ title: "Category updated" });
    } catch (e) {
      toast({
        title: "Couldn't update category",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  };

  // Fetch the union of the (weekly) window and the month scope so both the
  // week-scoped Weekly card and the month-scoped Monthly/Unplanned cards
  // have all their rows in a single query.
  const fetchFrom =
    monthScopeStart < windowStart ? monthScopeStart : windowStart;
  const fetchTo = monthScopeEnd > windowEnd ? monthScopeEnd : windowEnd;
  const txnsQ = useListTransactions({
    from: fetchFrom,
    to: fetchTo,
    // (#perf-3) Scoped to the week+month window already; bound the cap so it
    // can never balloon. A single month won't approach this.
    limit: 500,
  });
  const txns = txnsQ.data ?? [];

  // (#spec) A locked weekly debrief freezes that week's transactions, so a
  // live recompute equals the locked snapshot's numbers. We surface a
  // "Locked" badge when the debrief for this week is locked. Only relevant
  // in WEEK mode.
  const weekStartISO = fmtISO(weekStart);
  const debriefQ = useGetWeeklyDebrief(weekStartISO, {
    query: { enabled: mode === "week" } as any,
  });
  const isLocked = mode === "week" && debriefQ.data?.status === "locked";

  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // Planned allowance for the window. Each allowance is held at its native
  // cadence (weekly vs monthly) and pro-rated by day count to the selected
  // window, so a weekly card in WEEK mode reads the raw weekly allowance and
  // a monthly card in MONTH mode reads the raw monthly allowance, while
  // cross-cadence views (e.g. monthly allowance scoped to one week) get a
  // fair, deterministic slice. Monthly-cadence allowances are summed per day
  // using each day's own month length, so a week straddling a month boundary
  // is prorated exactly across both months.
  const planned = useMemo<Record<BucketKey, number>>(() => {
    // A per-week override (set while viewing that week) wins over the global
    // weekly default; other weeks keep using the default.
    const weeklyOverride =
      mode === "week" ? weeklyOverrides[weekStartISO] : undefined;
    const weeklyAmt =
      weeklyOverride != null
        ? weeklyOverride
        : Number(settings?.weeklyAllowanceAmount) || 0;
    const monthlyAmt = Number(settings?.monthlyAllowanceAmount) || 0;
    const unplannedAmt = Number(settings?.unplannedAllowanceAmount) || 0;
    return {
      // Weekly is prorated to its window; monthly/unplanned are the FULL
      // month figure so the cards show whole-month progress.
      weekly: (weeklyAmt / 7) * windowDays,
      monthly: monthlyAmt,
      unplanned: unplannedAmt,
    };
  }, [settings, windowDays, mode, weeklyOverrides, weekStartISO]);

  // Window-scoped transactions (drives the week-scoped Weekly card).
  const windowTxns = useMemo(
    () =>
      txns.filter(
        (t) => t.occurredOn >= windowStart && t.occurredOn <= windowEnd,
      ),
    [txns, windowStart, windowEnd],
  );

  // Month-scoped transactions (drives the Monthly + Unplanned cards).
  const monthScopeTxns = useMemo(
    () =>
      txns.filter(
        (t) => t.occurredOn >= monthScopeStart && t.occurredOn <= monthScopeEnd,
      ),
    [txns, monthScopeStart, monthScopeEnd],
  );

  const actual = useMemo(() => {
    const out: Record<BucketKey, number> = {
      weekly: 0,
      monthly: 0,
      unplanned: 0,
    };
    // Weekly tracks the selected week…
    for (const t of windowTxns) {
      if (hasBucketFlag(t, "weekly")) out.weekly += expenseAmount(t);
    }
    // …monthly + unplanned track the whole month.
    for (const t of monthScopeTxns) {
      const amt = expenseAmount(t);
      if (hasBucketFlag(t, "monthly")) out.monthly += amt;
      if (hasBucketFlag(t, "unplanned")) out.unplanned += amt;
    }
    return out;
  }, [windowTxns, monthScopeTxns]);

  // The "you went over AGAIN" streak — drives the roast banner up top.
  const overStreak = useMemo(
    () =>
      weeklyOverStreak(
        txns,
        Number(settings?.weeklyAllowanceAmount) || 0,
        weeklyOverrides,
        today,
      ),
    [txns, settings, weeklyOverrides, today],
  );

  // The positive counterpart — drives the "look at you" hype banner.
  const underStreak = useMemo(
    () =>
      weeklyUnderStreak(
        txns,
        Number(settings?.weeklyAllowanceAmount) || 0,
        weeklyOverrides,
        today,
      ),
    [txns, settings, weeklyOverrides, today],
  );

  // Last 8 completed weeks' over/under — the drill bars under the week nav.
  const varianceSeries = useMemo(
    () =>
      weeklyVarianceSeries(
        txns,
        Number(settings?.weeklyAllowanceAmount) || 0,
        weeklyOverrides,
        today,
        8,
      ),
    [txns, settings, weeklyOverrides, today],
  );

  // Per-bucket drill-down groups. Weekly groups by its sub-bucket enum
  // (all four shown); monthly/unplanned group by category.
  const groupsByBucket = useMemo(() => {
    const result: Record<BucketKey, Group[]> = {
      weekly: [],
      monthly: [],
      unplanned: [],
    };

    // Weekly — fixed sub-buckets.
    const weeklyTxns = windowTxns.filter((t) => hasBucketFlag(t, "weekly"));
    result.weekly = SUB_BUCKETS.map((sub) => {
      const list = weeklyTxns
        .filter((t) => {
          const b = (t.weeklyBucket as SubBucket | null | undefined) ?? "misc";
          const resolved = SUB_BUCKETS.includes(b) ? b : "misc";
          return resolved === sub;
        })
        .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
      return {
        key: sub,
        label: SUB_LABEL[sub],
        amount: list.reduce((s, t) => s + expenseAmount(t), 0),
        txns: list,
      };
    });

    // Monthly / Unplanned — group by category, over the whole month.
    for (const key of ["monthly", "unplanned"] as const) {
      const buckets = new Map<string, Transaction[]>();
      for (const t of monthScopeTxns) {
        if (!hasBucketFlag(t, key)) continue;
        const cid = t.categoryId ?? "_uncat";
        const arr = buckets.get(cid);
        if (arr) arr.push(t);
        else buckets.set(cid, [t]);
      }
      result[key] = Array.from(buckets.entries())
        .map(([cid, list]) => ({
          key: cid,
          label:
            cid === "_uncat"
              ? "Uncategorized"
              : catNameById.get(cid) ?? "Uncategorized",
          amount: list.reduce((s, t) => s + expenseAmount(t), 0),
          txns: list.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1)),
        }))
        .sort((a, b) => b.amount - a.amount);
    }

    return result;
  }, [windowTxns, monthScopeTxns, SUB_LABEL, catNameById]);

  const [expanded, setExpanded] = useState<Set<BucketKey>>(new Set());
  // (#split) Transaction being split across weekly buckets, if any.
  const [splitTx, setSplitTx] = useState<Transaction | null>(null);
  const toggle = (key: BucketKey) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const periodLabel =
    mode === "week"
      ? isCurrent
        ? "This week"
        : `Week of ${formatWeekRange(weekStart)}`
      : isCurrent
        ? "This month"
        : formatMonth(monthStart);

  const rangeLabel =
    mode === "week"
      ? `Week of ${formatWeekRange(weekStart)}`
      : `Month of ${formatMonth(monthStart)}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[1.75rem] font-semibold tracking-tight text-foreground">
          Allowances
        </h1>
        <p className="text-muted-foreground">
          Where the money actually goes. No judgment… ok, a little. 😏
        </p>
      </div>

      {/* Exactly what to pay for the VIEWED week (aligned to the ◀▶ week picker),
          so "how over budget" and "which cards to pay" describe the same week. */}
      <KillStack
        emphasize
        weekStart={mode === "week" ? fmtISO(weekStart) : undefined}
      />

      <AiInsightBar />

      {roastForStreak(overStreak) ? (
        <div
          className="rounded-md border-2 px-4 py-3 flex items-start gap-3 animate-in fade-in slide-in-from-top-1 duration-300"
          style={{ background: "hsl(var(--negative) / 0.08)", borderColor: "hsl(var(--negative) / 0.5)" }}
          data-testid="allowance-roast"
        >
          <Ban className="w-5 h-5 mt-0.5 shrink-0 text-[hsl(var(--negative))] animate-pulse" />
          <div className="min-w-0">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.22em] text-[hsl(var(--negative))]">
              ⚠ Over budget · {overStreak} weeks running
            </div>
            <div className="text-sm font-bold text-foreground mt-1 leading-snug">
              {roastForStreak(overStreak)}
            </div>
          </div>
        </div>
      ) : praiseForStreak(underStreak) ? (
        <div
          className="rounded-md border-2 border-[hsl(var(--positive)/0.5)] bg-[hsl(var(--positive)/0.08)] px-4 py-3 flex items-start gap-3 animate-in fade-in slide-in-from-top-1 duration-300"
          data-testid="allowance-praise"
        >
          <Flame className="w-5 h-5 mt-0.5 shrink-0 text-[hsl(var(--positive))]" />
          <div className="min-w-0">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.22em] text-[hsl(var(--positive))]">
              🟢 Under budget · {underStreak} weeks running
            </div>
            <div className="text-sm font-bold mt-1 leading-snug">
              {praiseForStreak(underStreak)}
            </div>
          </div>
        </div>
      ) : null}

      {/* Time-range selector */}
      <div className="flex flex-col items-center gap-3">
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList>
            <TabsTrigger value="week" data-testid="tab-week">
              Week
            </TabsTrigger>
            <TabsTrigger value="month" data-testid="tab-month">
              Month
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={goPrev}
            data-testid="button-period-prev"
            aria-label="Previous period"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex flex-col items-center text-center min-w-[12rem]">
            <div className="text-sm font-medium tabular-nums flex items-center gap-2">
              {rangeLabel}
              {isLocked && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-5"
                  data-testid="badge-locked"
                >
                  Locked
                </Badge>
              )}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {isCurrent ? `Current ${mode}` : `Past ${mode}`}
            </div>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={goNext}
            disabled={atOrAfterCurrent}
            data-testid="button-period-next"
            aria-label="Next period"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 8-week over/under drill — click a bar to jump to that week. */}
      {mode === "week" &&
        Number(settings?.weeklyAllowanceAmount) > 0 &&
        varianceSeries.some((s) => s.variance !== 0) && (
          <Card>
            <CardContent className="p-5">
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                  Last 8 weeks · over / under
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Green = under · red = over · tap to jump
                </span>
              </div>
              <MiniBars
                height={48}
                activeIndex={varianceSeries.findIndex((s) => s.weekISO === weekStartISO)}
                onBarClick={(i) => setWeekStart(varianceSeries[i].weekSun)}
                data={varianceSeries.map((s) => ({
                  value: s.variance,
                  label: `${formatWeekRange(s.weekSun)} · ${s.variance > 0 ? "+" : ""}${formatCurrency(s.variance)}`,
                  color:
                    s.variance > 0
                      ? "hsl(var(--negative))"
                      : "hsl(var(--positive))",
                }))}
              />
            </CardContent>
          </Card>
        )}

      {/* Bucket summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 stagger-children">
        {BUCKETS.map((b) => (
          <BucketCard
            key={b.key}
            name={b.name}
            actual={actual[b.key]}
            planned={planned[b.key]}
            expanded={expanded.has(b.key)}
            onToggle={() => toggle(b.key)}
            onSavePlanned={(amount) => savePlanned(b.key, amount)}
            // The 8-week over/under history exists for the weekly allowance.
            trend={
              b.key === "weekly"
                ? varianceSeries.map((s) => ({
                    value: s.variance,
                    label: formatWeekRange(s.weekSun),
                  }))
                : undefined
            }
          />
        ))}
      </div>

      {/* Drill-down breakdown — one collapsible group per bucket, driven by
          the card's expanded state. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Transaction breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {BUCKETS.map((b) => {
            const open = expanded.has(b.key);
            const groups = groupsByBucket[b.key];
            const total = actual[b.key];
            return (
              <Collapsible
                key={b.key}
                open={open}
                onOpenChange={() => toggle(b.key)}
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2 py-2 text-sm font-medium hover:bg-muted/50 rounded-md focus:outline-none"
                    data-testid={`allowance-bucket-${b.key}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 shrink-0 transition-transform",
                          open ? "" : "-rotate-90",
                        )}
                      />
                      {b.name}
                    </span>
                    <span className="tabular-nums">{formatCurrency(total)}</span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-l ml-4 pl-1 py-1">
                    {groups.length === 0 ||
                    groups.every((g) => g.txns.length === 0) ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No {b.noun} transactions in this{" "}
                        {b.key === "weekly" ? mode : "month"}.
                      </div>
                    ) : (
                      groups.map((g) => (
                        <CategoryGroupRow
                          key={g.key}
                          group={g}
                          subLabels={b.key === "weekly" ? SUB_LABEL : undefined}
                          onChangeBucket={
                            b.key === "weekly" ? changeWeeklyBucket : undefined
                          }
                          categories={
                            b.key !== "weekly" ? categories ?? [] : undefined
                          }
                          onChangeCategory={
                            b.key !== "weekly" ? changeCategory : undefined
                          }
                          onToCancel={
                            b.key !== "weekly" ? handleToCancelTxn : undefined
                          }
                          isToCancel={
                            b.key !== "weekly"
                              ? (t) => toCancel.has(toCancelKeyFor(t))
                              : undefined
                          }
                          onSplit={setSplitTx}
                        />
                      ))
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </CardContent>
      </Card>

      {/* Over/under summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Over/under summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {BUCKETS.map((b) => {
            const a = actual[b.key];
            const p = planned[b.key];
            const variance = a - p;
            let text: string;
            if (p <= 0) {
              text = `${periodLabel} you spent ${formatCurrency(a)} (no ${b.noun} set).`;
            } else if (variance === 0) {
              text = `${periodLabel} you spent exactly your ${formatCurrency(p)} ${b.noun}.`;
            } else if (variance < 0) {
              text = `${periodLabel} you came in ${formatCurrency(Math.abs(variance))} under your ${formatCurrency(p)} ${b.noun}.`;
            } else {
              text = `${periodLabel} you went ${formatCurrency(variance)} over your ${formatCurrency(p)} ${b.noun}.`;
            }
            return (
              <p
                key={b.key}
                className="text-sm text-muted-foreground"
                data-testid={`allowance-summary-${b.key}`}
              >
                {text}
              </p>
            );
          })}
        </CardContent>
      </Card>

      <SplitTransactionDialog
        tx={splitTx}
        open={!!splitTx}
        onOpenChange={(o) => {
          if (!o) setSplitTx(null);
        }}
      />
    </div>
  );
}
