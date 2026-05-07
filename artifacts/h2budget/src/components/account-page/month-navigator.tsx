import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export type MonthKey = { year: number; month: number };

export function monthKeyOf(d: Date): MonthKey {
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function monthKeyFromISO(iso: string): MonthKey {
  const [y, m] = iso.slice(0, 10).split("-").map(Number);
  return { year: y, month: m - 1 };
}

export function compareMonth(a: MonthKey, b: MonthKey): number {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

export function shiftMonth(mk: MonthKey, delta: number): MonthKey {
  const d = new Date(mk.year, mk.month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function formatMonthLabel(mk: MonthKey): string {
  // Compact `MMM 'YY` form (e.g. `May '26`) so the navigator pill stays
  // narrow and leaves more horizontal room for the KPI tiles next to it.
  const month = new Date(mk.year, mk.month, 1).toLocaleDateString("en-US", {
    month: "short",
  });
  const yy = String(mk.year % 100).padStart(2, "0");
  return `${month} '${yy}`;
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthFirstISO(mk: MonthKey): string {
  return isoDate(new Date(mk.year, mk.month, 1));
}

export function monthLastISO(mk: MonthKey): string {
  return isoDate(new Date(mk.year, mk.month + 1, 0));
}

export function MonthNavigator({
  value,
  onChange,
}: {
  value: MonthKey;
  onChange: (next: MonthKey) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border bg-card px-1 py-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => onChange(shiftMonth(value, -1))}
        aria-label="Previous month"
        data-testid="button-prev-month"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <div
        className="min-w-[58px] text-center font-mono text-xs font-semibold tabular-nums"
        data-testid="text-selected-month"
      >
        {formatMonthLabel(value)}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => onChange(shiftMonth(value, 1))}
        aria-label="Next month"
        data-testid="button-next-month"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
