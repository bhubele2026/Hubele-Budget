import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useListDebts,
  useGetAvalancheSettings,
} from "@workspace/api-client-react";
import type { Debt } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  simulate,
  fmtMoney,
  fmtPct,
  type SimDebt,
  type Strategy,
} from "@/lib/avalanche";

function debtToSim(d: Debt): SimDebt {
  return {
    id: d.id,
    name: d.name,
    apr: Number(d.apr),
    balance: Number(d.balance),
    minPayment: Number(d.minPayment),
    status: d.status,
  };
}

function fmtPayoffMonth(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", year: "numeric" }).toUpperCase();
}

function KillCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-8" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-16 mt-3" />
        <Skeleton className="h-8 w-28" />
      </CardContent>
    </Card>
  );
}

export function DashboardKillOrder() {
  const { data: debts, isLoading: debtsLoading } = useListDebts();
  const { data: settings, isLoading: settingsLoading } = useGetAvalancheSettings();

  const isLoading = debtsLoading || settingsLoading;
  const sectionRef = useRef<HTMLElement | null>(null);
  const [highlight, setHighlight] = useState(false);

  const scrollToKillOrder = () => {
    const el = sectionRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlight(true);
    window.setTimeout(() => setHighlight(false), 1600);
  };

  const simDebts = useMemo<SimDebt[]>(
    () => (debts ?? []).map(debtToSim).filter((d) => (d.status ?? "active") === "active"),
    [debts],
  );

  const strategy: Strategy = (settings?.strategy as Strategy) ?? "avalanche";
  const manualExtra = Number(settings?.manualExtra ?? 0);

  const next3 = useMemo(() => {
    if (simDebts.length === 0) return [];
    const sim = simulate({
      debts: simDebts,
      extraPerMonth: manualExtra,
      strategy,
    });
    const byId = new Map(simDebts.map((d) => [d.id, d]));
    return sim.killedOrder.slice(0, 3).map((k) => {
      const d = byId.get(k.id)!;
      return {
        id: k.id,
        name: d.name,
        apr: d.apr,
        balance: d.balance,
        minFreed: k.minFreed,
        date: k.date,
      };
    });
  }, [simDebts, manualExtra, strategy]);

  if (isLoading) {
    return (
      <section
        id="kill-order"
        ref={sectionRef}
        className={`scroll-mt-20 rounded-lg transition-shadow duration-700 ${
          highlight ? "ring-2 ring-warning ring-offset-2 ring-offset-background" : ""
        }`}
      >
        <div className="flex items-end justify-between mb-3 gap-4">
          <div>
            <button
              type="button"
              onClick={scrollToKillOrder}
              className="text-xs font-semibold tracking-widest text-warning uppercase cursor-pointer hover:underline focus:outline-none focus-visible:underline focus-visible:ring-2 focus-visible:ring-warning rounded-sm"
            >
              Avalanche Plan · Kill Order
            </button>
            <h2 className="text-lg font-serif font-semibold text-foreground">
              Your next 3 moves
            </h2>
          </div>
          <Link
            href="/avalanche?tab=projection"
            className="text-xs font-semibold tracking-widest text-warning uppercase cursor-pointer hover:underline focus:outline-none focus-visible:underline focus-visible:ring-2 focus-visible:ring-warning rounded-sm"
          >
            See full order →
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <KillCardSkeleton />
          <KillCardSkeleton />
          <KillCardSkeleton />
        </div>
      </section>
    );
  }

  if (next3.length === 0) return null;

  return (
    <section
      id="kill-order"
      ref={sectionRef}
      className={`scroll-mt-20 rounded-lg transition-shadow duration-700 ${
        highlight ? "ring-2 ring-warning ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="flex items-end justify-between mb-3 gap-4">
        <div>
          <button
            type="button"
            onClick={scrollToKillOrder}
            className="text-xs font-semibold tracking-widest text-warning uppercase cursor-pointer hover:underline focus:outline-none focus-visible:underline focus-visible:ring-2 focus-visible:ring-warning rounded-sm"
          >
            Avalanche Plan · Kill Order
          </button>
          <h2 className="text-lg font-serif font-semibold text-foreground">
            Your next 3 moves
          </h2>
        </div>
        <Link
          href="/avalanche?tab=projection"
          className="text-xs font-semibold tracking-widest text-warning uppercase cursor-pointer hover:underline focus:outline-none focus-visible:underline focus-visible:ring-2 focus-visible:ring-warning rounded-sm"
        >
          See full order →
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {next3.map((m, i) => (
          <Link
            key={m.id}
            href={`/avalanche?focus=${encodeURIComponent(m.id)}`}
            data-testid={`link-kill-order-${i}`}
            className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
          >
          <Card
            className={`cursor-pointer transition-all hover:border-foreground/60 hover:shadow-md ${
              i === 0 ? "border-2 border-foreground/80" : ""
            }`}
          >
            <CardContent className="p-5 space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded ${
                    i === 0
                      ? "bg-foreground text-background"
                      : "bg-muted text-foreground border border-border"
                  }`}
                >
                  #{i + 1}
                </span>
                <span className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                  Pay off by {fmtPayoffMonth(m.date)}
                </span>
              </div>
              <div
                className="text-lg font-serif font-semibold text-foreground truncate"
                title={m.name}
              >
                {m.name}
              </div>
              <div className="text-sm text-muted-foreground tabular-nums">
                {fmtPct(m.apr)} APR · {fmtMoney(m.balance)} balance
              </div>
              <div className="pt-2">
                <div className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                  Frees up
                </div>
                <div className="text-3xl font-bold tabular-nums text-positive">
                  {fmtMoney(m.minFreed)}
                  <span className="text-sm font-normal text-muted-foreground">/mo</span>
                </div>
              </div>
            </CardContent>
          </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
