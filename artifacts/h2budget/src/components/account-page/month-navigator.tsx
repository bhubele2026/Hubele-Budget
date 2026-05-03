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
  return new Date(mk.year, mk.month, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
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
    <div className="flex items-center gap-2 rounded-md border bg-card px-2 py-2">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => onChange(shiftMonth(value, -1))}
        aria-label="Previous month"
        data-testid="button-prev-month"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div
        className="min-w-[88px] text-center font-mono text-sm font-semibold tabular-nums"
        data-testid="text-selected-month"
      >
        {formatMonthLabel(value)}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => onChange(shiftMonth(value, 1))}
        aria-label="Next month"
        data-testid="button-next-month"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
