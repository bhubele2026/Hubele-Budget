import { useMemo } from "react";
import { Store, TrendingDown, Sparkles, Receipt } from "lucide-react";
import type { DashboardSummary } from "@workspace/api-client-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Confetti } from "@/components/confetti";
import { useCountUp } from "@/hooks/useCountUp";
import { cn, formatCurrency } from "@/lib/utils";

function monthLabel(): string {
  return new Date().toLocaleDateString("en-US", { month: "long" });
}

// Earned, savage one-line verdict on the month — tied to the real net.
function verdict(net: number, income: number): string {
  if (income <= 0) return "Sync your accounts and let's see the real damage.";
  if (net >= income * 0.2)
    return "Genuinely crushing it. Who are you two and what did you do with the DoorDash gremlins?";
  if (net > 0) return "In the black — barely — but we'll take it. Date night's funded. 😏";
  if (net > -income * 0.1)
    return "Basically broke even. Living on the edge, you muppets. Tighten it up.";
  return "Spent more than you made. Again. This isn't a budget, it's a cry for help. 🙈";
}

function BigStat({
  label,
  value,
  tone = "neutral",
  delayMs = 0,
}: {
  label: string;
  value: number;
  tone?: "neutral" | "good" | "bad";
  delayMs?: number;
}) {
  const shown = useCountUp(value, 900);
  return (
    <div
      className="rounded-lg border border-border bg-card/60 p-4 animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-2xl font-bold tabular-nums tracking-tight",
          tone === "good" && "text-emerald-500",
          tone === "bad" && "text-[hsl(var(--negative))]",
        )}
      >
        {formatCurrency(shown)}
      </div>
    </div>
  );
}

export function MonthlyWrapped({
  open,
  onOpenChange,
  dashboard,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dashboard: DashboardSummary | null;
}) {
  const d = dashboard;
  const income = d ? Number(d.monthlyIncome) : 0;
  const spend = d ? Number(d.monthlySpend) : 0;
  const net = d ? Number(d.netCashflow) : 0;
  const paid = d ? Number(d.paidThisMonth) : 0;

  const biggest = useMemo(() => {
    const txns = d?.recentTransactions ?? [];
    let worst: { desc: string; amt: number } | null = null;
    for (const t of txns) {
      const a = Number(t.amount) || 0;
      if (a < 0 && (worst == null || a < worst.amt)) {
        worst = { desc: t.description ?? "Something", amt: a };
      }
    }
    return worst;
  }, [d]);

  const topCat = d?.topCategories?.[0] ?? null;
  const celebrate = open && net > 0;

  return (
    <>
      <Confetti fire={celebrate} />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[440px] overflow-hidden">
          <div className="space-y-4">
            <div className="text-center">
              <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em] text-primary font-semibold">
                <Sparkles className="w-3.5 h-3.5" /> {monthLabel()}, Wrapped
              </div>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">
                The Hubeles, by the numbers
              </h2>
            </div>

            {!d ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                Loading your month…
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <BigStat label="Money in" value={income} tone="good" delayMs={60} />
                  <BigStat label="Money out" value={spend} tone="bad" delayMs={140} />
                  <BigStat
                    label="Net"
                    value={net}
                    tone={net >= 0 ? "good" : "bad"}
                    delayMs={220}
                  />
                  <BigStat
                    label="Paid to debt"
                    value={paid}
                    tone={paid > 0 ? "good" : "neutral"}
                    delayMs={300}
                  />
                </div>

                <div className="space-y-2">
                  {biggest ? (
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-2.5">
                      <TrendingDown className="w-4 h-4 text-[hsl(var(--negative))] shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                          Biggest single hit
                        </div>
                        <div className="text-sm font-medium truncate">
                          {biggest.desc}
                        </div>
                      </div>
                      <div className="text-sm font-bold tabular-nums text-[hsl(var(--negative))]">
                        {formatCurrency(biggest.amt)}
                      </div>
                    </div>
                  ) : null}

                  {topCat ? (
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-2.5">
                      <Store className="w-4 h-4 text-primary shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                          Where it went most
                        </div>
                        <div className="text-sm font-medium truncate">
                          {topCat.categoryName}
                        </div>
                      </div>
                      <div className="text-sm font-bold tabular-nums">
                        {formatCurrency(Number(topCat.total) || 0)}
                      </div>
                    </div>
                  ) : null}

                  {d.transactionCount ? (
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-2.5">
                      <Receipt className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="text-sm">
                        <span className="font-bold tabular-nums">
                          {d.transactionCount}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          transactions this month
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-widest text-primary font-semibold mb-1">
                    The verdict
                  </div>
                  <p className="text-sm font-medium leading-snug">
                    {verdict(net, income)}
                  </p>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
