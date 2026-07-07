import {
  useGetBudgetHealth,
  getGetBudgetHealthQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { RingStat, Sparkline } from "@/components/viz";
import { StatusPill } from "@/components/stat";
import { STATUS_COLOR, type Status } from "@/lib/statusThresholds";
import { cn } from "@/lib/utils";

// green/yellow/red (from the code-computed score) → the shared status vocabulary.
function toStatus(s: string | undefined): Status {
  if (s === "green") return "good";
  if (s === "yellow") return "warning";
  if (s === "red") return "danger";
  return "neutral";
}

function DirectionArrow({ delta }: { delta: number | null | undefined }) {
  if (delta == null) return null;
  const r = Math.round(delta);
  if (r === 0) return <span className="text-muted-foreground">◦ flat</span>;
  const up = r > 0;
  return (
    <span className={up ? "text-[hsl(var(--positive))]" : "text-[hsl(var(--negative))]"}>
      {up ? "▲" : "▼"} {Math.abs(r)}
    </span>
  );
}

/**
 * Budget Health — the one "how are we doing" card. The 0-100 score, status
 * band, grade, sub-scores and drivers are all computed server-side (the AI
 * never does the math); Fable 5 writes only the narrative. Reuses the shared
 * RingStat / Sparkline / StatusPill kit — no one-off styles.
 */
export function BudgetHealthCard({ className }: { className?: string }) {
  const { data, isLoading, isError } = useGetBudgetHealth({
    query: {
      queryKey: getGetBudgetHealthQueryKey(),
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
    },
  });

  if (isLoading) {
    return (
      <Card className={cn("p-5", className)} data-testid="card-budget-health-loading">
        <div className="h-4 w-32 rounded bg-muted animate-pulse" />
        <div className="mt-4 h-24 w-full rounded bg-muted/60 animate-pulse" />
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card className={cn("p-5", className)} data-testid="card-budget-health-error">
        <div className="text-sm font-medium">Budget Health</div>
        <p className="mt-2 text-sm text-muted-foreground">
          Couldn’t load your health score right now.
        </p>
      </Card>
    );
  }

  const status = toStatus(data.status);
  const color = STATUS_COLOR[status];
  const trendScores = (data.trend ?? []).map((p) => p.score);
  const summary = data.summary;

  return (
    <Card className={cn("p-5", className)} data-testid="card-budget-health">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold tracking-wide">Budget Health</div>
        <StatusPill status={status}>
          {data.status === "green" ? "On track" : data.status === "yellow" ? "Watch" : "At risk"}
        </StatusPill>
      </div>

      <div className="mt-4 flex items-center gap-5">
        <RingStat
          value={(Number(data.score) || 0) / 100}
          size={92}
          stroke={9}
          color={color}
          centerText={String(Math.round(Number(data.score) || 0))}
          centerSub={`grade ${data.grade}`}
        />
        <div className="min-w-0 flex-1">
          {trendScores.length > 1 ? (
            <Sparkline data={trendScores} variant="area" color={color} height={34} />
          ) : (
            <div className="text-xs text-muted-foreground">
              Trend fills in as the daily score is captured.
            </div>
          )}
          <div className="mt-1 flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">vs last week</span>
            <DirectionArrow delta={data.deltas?.vsLastWeek} />
            <span className="text-muted-foreground">· vs yesterday</span>
            <DirectionArrow delta={data.deltas?.vsYesterday} />
          </div>
        </div>
      </div>

      {summary ? (
        <div className="mt-4 space-y-1.5">
          <div className="text-sm font-medium">{summary.headline}</div>
          <p className="text-sm text-muted-foreground">{summary.body}</p>
          {summary.nextAction ? (
            <p className="mt-2 rounded-md border border-[hsl(var(--positive))]/25 bg-[hsl(var(--positive))]/10 px-3 py-2 text-sm">
              <span className="font-medium">Next: </span>
              {summary.nextAction}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
        {(data.dimensions ?? []).map((d) => {
          const dStatus: Status = d.score >= 75 ? "good" : d.score >= 50 ? "warning" : "danger";
          return (
            <div key={d.key} className="flex items-center gap-2 text-xs">
              <span
                className="h-2 w-2 flex-none rounded-full"
                style={{ background: STATUS_COLOR[dStatus] }}
              />
              <span className="flex-1 truncate text-muted-foreground">{d.label}</span>
              <span className="tabular-nums font-medium">{Math.round(d.score)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
