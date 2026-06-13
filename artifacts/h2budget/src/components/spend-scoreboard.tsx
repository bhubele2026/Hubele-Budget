import { Crown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatCurrency } from "@/lib/utils";

export type MemberSpend = { name: string; spend: number };

/**
 * Him-vs-her (or whoever) spend scoreboard for the month. Lower spend "wins".
 * Renders nothing unless at least two named members have spending, so it only
 * shows up once there's an actual contest.
 */
export function SpendScoreboard({ entries }: { entries: MemberSpend[] }) {
  const named = entries.filter(
    (e) => e.name && e.name.toLowerCase() !== "unassigned",
  );
  if (named.length < 2) return null;

  const top = named.slice(0, 2);
  const max = Math.max(...top.map((e) => e.spend), 1);
  const winner = top.reduce((a, b) => (a.spend <= b.spend ? a : b));
  const loser = top.reduce((a, b) => (a.spend > b.spend ? a : b));
  const diff = Math.abs(loser.spend - winner.spend);

  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium mb-3">
          Scoreboard · who spent less
        </div>
        <div className="space-y-3">
          {top.map((m) => {
            const isWinner = m.name === winner.name && diff > 0;
            return (
              <div key={m.name}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="flex items-center gap-1.5 font-medium">
                    {isWinner ? (
                      <Crown className="w-3.5 h-3.5 text-amber-400" />
                    ) : null}
                    {m.name}
                  </span>
                  <span className="tabular-nums font-semibold">
                    {formatCurrency(m.spend)}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-700 ease-out",
                      isWinner ? "bg-emerald-500" : "bg-primary",
                    )}
                    style={{ width: `${Math.round((m.spend / max) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {diff > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            👑 <span className="font-semibold text-foreground">{winner.name}</span>{" "}
            is winning — spent {formatCurrency(diff)} less than {loser.name} this
            month. Don&apos;t let it go to your head. 😏
          </p>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Dead even this month. Suspicious. 👀
          </p>
        )}
      </CardContent>
    </Card>
  );
}
