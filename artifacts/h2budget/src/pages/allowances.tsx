import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Pencil, Split } from "lucide-react";
import { SplitTransactionDialog } from "@/components/split-transaction-dialog";
import {
  useListTransactions,
  useGetSettings,
  useListCategories,
  useUpdateTransaction,
  useUpdateSettings,
  getListTransactionsQueryKey,
  getGetSettingsQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, cn } from "@/lib/utils";
import {
  card,
  cardHead,
  btnSm,
  btnSecondarySm,
  btnLink,
  input,
  fieldLabel,
  th,
  td,
  tdNum,
  emptyNote,
  Field,
  Help,
  Foot,
} from "@/ui";
// CSS bars, not recharts — this page has no charting library in its chunk.
import { CssBars, CssFillMeter, type CssBarRow } from "@/lib/cssBars";
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
/** Short week stamp for a bar label — "Aug 3". */
function formatWeekStamp(sun: Date): string {
  return sun.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
// deterministic spine of the over-budget streak chip.
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

// The positive counterpart to weeklyOverStreak — how many COMPLETED weeks in a
// row, ending last week, they came in AT or UNDER the weekly allowance. Same
// deterministic walk-back.
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

/**
 * A streak is only worth reporting once it is a PATTERN rather than a single
 * week. Two is the floor — the same threshold the old prose banners used, so
 * the chips appear on exactly the weeks the sentences used to.
 */
const STREAK_MIN = 2;

// Last N completed Sun–Sat weeks' over/under variance (spend − planned) for
// the weekly allowance — the data behind the 8-week bars. Oldest first.
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

/**
 * The state, in words. Colour reinforces it and never carries it alone — the
 * chip class only tints a label that already says which side of plan this is.
 */
function bucketState(
  actual: number,
  planned: number,
): { label: string; chip: string } {
  if (planned <= 0) return { label: "No target", chip: "gray" };
  if (actual > planned) return { label: "Over", chip: "bad" };
  if (actual / planned >= 0.85) return { label: "Near cap", chip: "warn" };
  return { label: "Under", chip: "ok" };
}

// ----- drill-down rows ------------------------------------------------

function TxnRow({
  t,
  subLabels,
  onChangeBucket,
  categories,
  onChangeCategory,
  onSplit,
}: {
  t: Transaction;
  subLabels?: Record<SubBucket, string>;
  onChangeBucket?: (t: Transaction, sub: SubBucket) => void;
  categories?: { id: string; name: string }[];
  onChangeCategory?: (t: Transaction, categoryId: string) => void;
  onSplit?: (t: Transaction) => void;
}) {
  const current: SubBucket = SUB_BUCKETS.includes(t.weeklyBucket as SubBucket)
    ? (t.weeklyBucket as SubBucket)
    : "misc";
  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-brand-line/70 px-4 py-1.5 pl-10 text-body last:border-b-0"
      data-testid={`allowance-txn-${t.id}`}
    >
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="w-12 shrink-0 font-mono text-micro tabular-nums text-neutral-400">
          {formatTxnDate(t.occurredOn)}
        </span>
        <span className="truncate text-neutral-700">{t.description}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onChangeBucket && subLabels && (
          <Select
            value={current}
            onValueChange={(v) => onChangeBucket(t, v as SubBucket)}
          >
            <SelectTrigger
              className="h-7 w-[120px] text-micro"
              aria-label="Allowance bucket"
              data-testid={`allowance-bucket-select-${t.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUB_BUCKETS.map((s) => (
                <SelectItem key={s} value={s} className="text-micro">
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
              className="h-7 w-[160px] text-micro"
              aria-label="Category"
              data-testid={`allowance-category-select-${t.id}`}
            >
              <SelectValue placeholder="Uncategorized" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-micro">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {onSplit && (
          <button
            type="button"
            className={cn(btnLink, "w-[74px] justify-center")}
            onClick={() => onSplit(t)}
            data-testid={`allowance-split-${t.id}`}
            title="Split this purchase across weekly buckets"
          >
            <Split className="h-3 w-3" />
            Split
          </button>
        )}
        <span className="w-24 shrink-0 text-right font-mono text-label tabular-nums">
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
  onSplit,
}: {
  group: Group;
  subLabels?: Record<SubBucket, string>;
  onChangeBucket?: (t: Transaction, sub: SubBucket) => void;
  categories?: { id: string; name: string }[];
  onChangeCategory?: (t: Transaction, categoryId: string) => void;
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
            "flex w-full items-center justify-between gap-2 px-4 py-1.5 text-body focus:outline-none",
            expandable ? "cursor-pointer hover:bg-brand-tint" : "cursor-default",
          )}
          data-testid={`allowance-group-${group.key}`}
        >
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-neutral-700">
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                open ? "" : "-rotate-90",
                !expandable && "opacity-0",
              )}
            />
            <span className="truncate">{group.label}</span>
            <span className="font-mono text-micro tabular-nums text-neutral-400">
              {group.txns.length}
            </span>
          </span>
          <span className="whitespace-nowrap font-mono text-label tabular-nums">
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
            onSplit={onSplit}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ----- bucket card ----------------------------------------------------

function BucketCard({
  name,
  help,
  actual,
  planned,
  expanded,
  onToggle,
  onSavePlanned,
  periodLabel,
  periodSub,
  onPrevPeriod,
  onNextPeriod,
  canNextPeriod,
}: {
  name: string;
  help: string;
  actual: number;
  planned: number;
  expanded: boolean;
  onToggle: () => void;
  onSavePlanned?: (amount: number) => void;
  /** Per-card date cycler (weekly cycles weeks; monthly/unplanned cycle months). */
  periodLabel?: string;
  periodSub?: string;
  onPrevPeriod?: () => void;
  onNextPeriod?: () => void;
  canNextPeriod?: boolean;
}) {
  const variance = actual - planned;
  const over = variance > 0;
  const state = bucketState(actual, planned);
  const pct = planned > 0 ? Math.round((actual / planned) * 100) : 0;
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
    <div className={cn(card, expanded && "ring-brand-navy/30")}>
      <div className={cardHead}>
        <span className={cn(fieldLabel, "flex-1 truncate")}>{name}</span>
        <span className={`chip ${state.chip}`} data-testid={`allowance-state-${slug}`}>
          {state.label}
        </span>
        <Help>{help}</Help>
      </div>

      {/* Date cycler — kept OUTSIDE the expand button so ◀▶ don't toggle the
          drill-down. */}
      {onPrevPeriod && (
        <div className="flex items-center justify-between gap-2 border-b border-brand-line px-4 py-1.5">
          <button
            type="button"
            onClick={onPrevPeriod}
            aria-label="Previous period"
            className="press grid h-6 w-6 shrink-0 place-items-center rounded-control text-neutral-400 ring-1 ring-brand-line hover:text-brand-navy"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <div className="min-w-0 text-center leading-tight">
            <div className="truncate font-mono text-micro tabular-nums text-neutral-600">
              {periodLabel}
            </div>
            <div className={fieldLabel}>{periodSub}</div>
          </div>
          <button
            type="button"
            onClick={onNextPeriod}
            disabled={!canNextPeriod}
            aria-label="Next period"
            className="press grid h-6 w-6 shrink-0 place-items-center rounded-control text-neutral-400 ring-1 ring-brand-line hover:text-brand-navy disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="px-4 py-3">
        {/* The number is the expand toggle. The planned line below stays
            outside the button so the edit popover isn't nested in it. */}
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-baseline justify-between gap-2 text-left focus:outline-none"
          data-testid={`allowance-card-${slug}`}
          aria-expanded={expanded}
        >
          <span
            className={cn(
              "font-mono text-display font-semibold tabular-nums",
              over ? "text-bad" : "text-brand-navy",
            )}
          >
            {formatCurrency(actual)}
          </span>
          <span className="flex items-center gap-1.5">
            {planned > 0 && (
              <span className="font-mono text-micro tabular-nums text-neutral-400">
                {pct}%
              </span>
            )}
            <ChevronDown
              className={cn(
                "h-4 w-4 text-neutral-400",
                expanded ? "" : "-rotate-90",
              )}
            />
          </span>
        </button>

        <div className="mt-1 flex items-center gap-1.5">
          <span className="font-mono text-micro tabular-nums text-neutral-500">
            of {formatCurrency(planned)} planned
          </span>
          {onSavePlanned && (
            <Popover
              open={editOpen}
              onOpenChange={(o) => {
                setEditOpen(o);
                if (o) setDraft(planned > 0 ? planned.toFixed(2) : "");
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="press grid h-5 w-5 place-items-center rounded text-neutral-400 hover:text-brand-navy"
                  aria-label="Edit planned amount"
                  title="Edit planned amount"
                  data-testid={`allowance-edit-planned-${slug}`}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-3" align="start">
                <Field label={`Planned ${name.toLowerCase()}`}>
                  <input
                    className={cn(input, "font-mono tabular-nums")}
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
                </Field>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className={btnSecondarySm}
                    onClick={() => setEditOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={btnSm}
                    onClick={save}
                    disabled={!draft.trim()}
                  >
                    Save
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        <CssFillMeter
          value={actual}
          ceiling={planned}
          className="mt-2.5"
          title={`${formatCurrency(actual)} of ${formatCurrency(planned)}`}
        />

        <div
          className={cn(
            "mt-2 font-mono text-label tabular-nums",
            planned <= 0
              ? "text-neutral-400"
              : over
                ? "text-bad"
                : "text-brand-navy",
          )}
          data-testid={`allowance-variance-${slug}`}
        >
          {planned <= 0
            ? "No allowance set"
            : over
              ? `${formatCurrency(variance)} over`
              : `${formatCurrency(Math.abs(variance))} under`}
        </div>
      </div>
    </div>
  );
}

// ----- page -----------------------------------------------------------

export default function AllowancesPage() {
  const today = useMemo(() => new Date(), []);
  // Each card owns its own period (no shared Week/Month mode): the Weekly card
  // cycles Sun–Sat weeks; Monthly + Unplanned cycle whole calendar months.
  const [weekStart, setWeekStart] = useState<Date>(() => sundayOf(new Date()));
  const [monthStart, setMonthStart] = useState<Date>(() =>
    firstOfMonth(new Date()),
  );

  const currentWeekStart = useMemo(() => sundayOf(today), [today]);
  const currentMonthStart = useMemo(() => firstOfMonth(today), [today]);

  // Weekly card window (always the selected Sun–Sat week).
  const windowStart = fmtISO(weekStart);
  const windowEnd = fmtISO(addDays(weekStart, 6));
  const windowDays = 7;
  // Monthly + Unplanned window (always the selected calendar month). Ties to the
  // Banking dashboard's Month/Unplanned, which also key off the calendar month.
  const monthScopeStartDate = firstOfMonth(monthStart);
  const monthScopeStart = fmtISO(monthScopeStartDate);
  const monthScopeEnd = fmtISO(lastOfMonth(monthScopeStartDate));

  const weekIsCurrent = fmtISO(weekStart) === fmtISO(currentWeekStart);
  const monthIsCurrent = fmtISO(monthStart) === fmtISO(currentMonthStart);
  const weekAtCurrent = weekStart >= currentWeekStart;
  const monthAtCurrent = monthStart >= currentMonthStart;
  const weekPrev = () => setWeekStart((w) => addDays(w, -7));
  const weekNext = () =>
    setWeekStart((w) => (w >= currentWeekStart ? w : addDays(w, 7)));
  const monthPrev = () =>
    setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const monthNext = () =>
    setMonthStart((m) =>
      m >= currentMonthStart
        ? m
        : new Date(m.getFullYear(), m.getMonth() + 1, 1),
    );

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
  // editor's own browser).
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
    if (key === "weekly") {
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
    // key is narrowed to "monthly" | "unplanned" here (weekly returned above).
    const val = amount.toFixed(2);
    const data =
      key === "monthly"
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

  const weekStartISO = fmtISO(weekStart);

  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // Planned allowance for the window. Each allowance is held at its native
  // cadence (weekly vs monthly) and pro-rated by day count to the selected
  // window, so a weekly card in WEEK mode reads the raw weekly allowance and
  // a monthly card in MONTH mode reads the raw monthly allowance.
  const planned = useMemo<Record<BucketKey, number>>(() => {
    // A per-week override (set while viewing that week) wins over the global
    // weekly default; other weeks keep using the default.
    const weeklyOverride = weeklyOverrides[weekStartISO];
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
  }, [settings, windowDays, weeklyOverrides, weekStartISO]);

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

  // The consecutive-weeks-over streak — drives the warning chip.
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

  // The positive counterpart.
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

  // Last 8 completed weeks' over/under — the variance bars.
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

  /**
   * Stable row identities (the week's Sunday) so the CSS bars glide between
   * renders instead of tearing down and rebuilding.
   *
   * ⚠️ THE SIGN IS FLIPPED ON PURPOSE, at the render boundary only.
   * `weeklyVarianceSeries` returns spend − plan, so OVER is positive. But
   * `CssBars` colours a delta by sign via `barColorForSign` — navy up, deep
   * orange down — which would paint an under-budget week orange and an
   * over-budget week navy: the palette law exactly inverted.
   *
   * So the bar encodes MONEY LEFT (plan − spend) instead. Same magnitudes,
   * and now the signs line up with the palette: money left is navy and runs
   * right of the zero line, overspending is deep orange and runs left. "Left"
   * is also the word the Banking dashboard already uses for this quantity.
   * The underlying series is untouched.
   */
  const varianceRows = useMemo<CssBarRow[]>(
    () =>
      varianceSeries.map((s) => ({
        id: s.weekISO,
        label: formatWeekStamp(s.weekSun),
        value: -s.variance,
      })),
    [varianceSeries],
  );

  /**
   * Rank the bars CHRONOLOGICALLY, not by length.
   *
   * `CssBars` ranks by |value| by default, which is right when the bar length
   * IS the ranking. Here it is not: this is a time series, and sorting it by
   * magnitude shuffles the weeks into a meaningless order (Jun 28, Jul 5,
   * Aug 16, Jul 26 …), which reads as a ranked list of weeks rather than a
   * history. `varianceSeries` is already oldest-first, so position in that
   * array is the domain order.
   */
  const weekOrder = useMemo(() => {
    const m = new Map<string, number>();
    varianceSeries.forEach((s, i) => m.set(s.weekISO, i));
    return m;
  }, [varianceSeries]);

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

  const weeklyLabel = weekIsCurrent
    ? "This week"
    : `Week of ${formatWeekRange(weekStart)}`;
  const monthlyLabel = monthIsCurrent ? "This month" : formatMonth(monthStart);
  const labelFor = (key: BucketKey) =>
    key === "weekly" ? weeklyLabel : monthlyLabel;

  const helpFor = (key: BucketKey) =>
    key === "weekly"
      ? "Spend flagged weekly in the selected Sun–Sat week, against the weekly allowance prorated to that week."
      : key === "monthly"
        ? "Spend flagged monthly in the selected calendar month, against the full monthly allowance."
        : "Spend flagged unplanned in the selected calendar month, against the full unplanned allowance.";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display font-semibold text-brand-navy">Allowances</h1>
        {/* Streak state, in words. The chip is the whole message — the prose
            banners it replaces said this same fact in a paragraph. */}
        {(overStreak >= STREAK_MIN || underStreak >= STREAK_MIN) && (
          <div className="flex flex-wrap items-center gap-2">
            {overStreak >= STREAK_MIN ? (
              <span className="chip bad" data-testid="allowance-over-streak">
                Over budget · {overStreak} weeks running
              </span>
            ) : (
              <span className="chip ok" data-testid="allowance-praise">
                Under budget · {underStreak} weeks running
              </span>
            )}
            <Help>
              Consecutive completed Sun–Sat weeks, ending last week, where
              weekly spend was over (or at/under) the weekly allowance for that
              week.
            </Help>
          </div>
        )}
      </div>

      {/* One card per bucket. There is deliberately no combined total: weekly
          is scoped to a week and monthly/unplanned to a calendar month, so a
          sum of the three would mix time windows. */}
      <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-3">
        {BUCKETS.map((b) => (
          <BucketCard
            key={b.key}
            name={b.name}
            help={helpFor(b.key)}
            actual={actual[b.key]}
            planned={planned[b.key]}
            expanded={expanded.has(b.key)}
            onToggle={() => toggle(b.key)}
            onSavePlanned={(amount) => savePlanned(b.key, amount)}
            periodLabel={b.key === "weekly" ? weeklyLabel : monthlyLabel}
            periodSub={
              b.key === "weekly"
                ? weekIsCurrent
                  ? "Current week"
                  : "Past week"
                : monthIsCurrent
                  ? "Current month"
                  : "Past month"
            }
            onPrevPeriod={b.key === "weekly" ? weekPrev : monthPrev}
            onNextPeriod={b.key === "weekly" ? weekNext : monthNext}
            canNextPeriod={
              b.key === "weekly" ? !weekAtCurrent : !monthAtCurrent
            }
          />
        ))}
      </div>

      {/* Weekly history — CSS bars diverging from a centre zero line, so a
          week that came in under and a week that ran over read as opposite
          directions and not merely as two colours. */}
      <div className={card}>
        <div className={cardHead}>
          <span className={cn(fieldLabel, "flex-1")}>
            Weekly money left · last {varianceRows.length} weeks
          </span>
          <Help>
            The planned weekly allowance minus what was spent, for each
            completed Sun–Sat week. Right of the line is money left over; left
            of the line is over plan.
          </Help>
        </div>
        <div className="px-4 py-3">
          {varianceRows.length === 0 ? (
            <div className={emptyNote}>No completed weeks yet</div>
          ) : (
            <CssBars
              rows={varianceRows}
              mode="delta"
              rankBy={(r) => weekOrder.get(r.id) ?? 0}
              format={(v) => formatCurrency(v)}
              labelWidth={64}
              valueWidth={92}
              ariaLabel="Weekly allowance money left or over plan, by week"
            />
          )}
        </div>
      </div>

      {/* Drill-down breakdown — one collapsible group per bucket, driven by
          the card's expanded state. */}
      <div className={card}>
        <div className={cardHead}>
          <span className={cn(fieldLabel, "flex-1")}>Transaction breakdown</span>
        </div>
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
                  className="flex w-full items-center justify-between gap-2 border-b border-brand-line px-4 py-2 text-body font-medium hover:bg-brand-tint focus:outline-none"
                  data-testid={`allowance-bucket-${b.key}`}
                >
                  <span className="flex items-center gap-1.5">
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-neutral-400",
                        open ? "" : "-rotate-90",
                      )}
                    />
                    {b.name}
                  </span>
                  <span className="font-mono text-label tabular-nums">
                    {formatCurrency(total)}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="bg-brand-tint/40">
                  {groups.length === 0 ||
                  groups.every((g) => g.txns.length === 0) ? (
                    <div className={emptyNote}>
                      No {b.noun} transactions in this{" "}
                      {b.key === "weekly" ? "week" : "month"}
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
                        onSplit={setSplitTx}
                      />
                    ))
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>

      {/* Over/under summary — the three sentences this used to print, as the
          table they were describing. */}
      <div className={card}>
        <div className={cardHead}>
          <span className={cn(fieldLabel, "flex-1")}>Over / under summary</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px]">
            <thead>
              <tr>
                <th className={th}>Allowance</th>
                <th className={th}>Period</th>
                <th className={cn(th, "text-right")}>Spent</th>
                <th className={cn(th, "text-right")}>Planned</th>
                <th className={cn(th, "text-right")}>Variance</th>
                <th className={th}>State</th>
              </tr>
            </thead>
            <tbody>
              {BUCKETS.map((b) => {
                const a = actual[b.key];
                const p = planned[b.key];
                const variance = a - p;
                const state = bucketState(a, p);
                return (
                  <tr key={b.key} data-testid={`allowance-summary-${b.key}`}>
                    <td className={cn(td, "font-medium")}>{b.name}</td>
                    <td className={cn(td, "text-neutral-500")}>
                      {labelFor(b.key)}
                    </td>
                    <td className={tdNum}>{formatCurrency(a)}</td>
                    <td className={tdNum}>
                      {p > 0 ? formatCurrency(p) : "—"}
                    </td>
                    <td
                      className={cn(
                        tdNum,
                        p > 0 && variance > 0 && "text-bad",
                      )}
                    >
                      {p > 0 ? formatCurrency(Math.abs(variance)) : "—"}
                    </td>
                    <td className={td}>
                      <span className={`chip ${state.chip}`}>{state.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Foot>
          Variance is spend minus plan for each row's own period. Weekly is
          scoped to the selected Sun–Sat week; monthly and unplanned to the
          selected calendar month.
        </Foot>
      </div>

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
