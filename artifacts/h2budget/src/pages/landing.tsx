import { Link } from "wouter";
import { useMemo } from "react";
import { useUser, UserButton } from "@clerk/react";
import {
  Landmark,
  Receipt,
  LineChart,
  Flame,
  ArrowRight,
  Bell,
  Tv,
  Wifi,
  Zap,
  CreditCard,
  ShieldCheck,
} from "lucide-react";
import {
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
  useGetBillsSummary,
  getGetBillsSummaryQueryKey,
  useGetForecastCashSignal,
  getGetForecastCashSignalQueryKey,
  useListDebts,
  getListDebtsQueryKey,
} from "@workspace/api-client-react";
import { cn, formatCurrency } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { Sparkline } from "@/components/viz/Sparkline";
import { MiniBars, type MiniBar } from "@/components/viz/MiniBars";
import { MoneyText } from "@/components/viz/MoneyText";
import { FillMeter } from "@/components/stat/fill-meter";
import { PillBadge } from "@/components/pill-badge";

/**
 * Front door. A flowing wave + constellation header, a faint star-chart
 * watermark, account controls (bell + avatar) top-right, and four big tiles
 * that route into the app's four areas. Each tile carries a small REAL-DATA
 * visualization (server-computed aggregates only — no raw-transaction fetches;
 * every dollar figure is computed in code). The global nav ribbon is hidden
 * here (see layout.tsx) — the tiles ARE the navigation.
 */

// ── helpers ────────────────────────────────────────────────────────────────
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

/** Compact axis tick, e.g. 2900 → "$2.9k", 480 → "$480". */
function kfmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return `$${(n / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

/** "2026-04" → "Apr" */
function monthShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" });
}

// ── decorative chrome ────────────────────────────────────────────────────────

/** Rich flowing wave field (left) + constellation network (right). */
function HeaderBanner() {
  // A phase-shifted stack of thin waves → the flowing sound-wave/topographic look.
  const waves = Array.from({ length: 16 }, (_, i) => {
    const y = 70 + i * 4.5;
    const amp = 26 + (i % 5) * 6;
    const d = `M0,${y} C160,${y - amp} 320,${y + amp} 480,${y} C640,${y - amp} 800,${y + amp} 980,${y} C1120,${y - amp * 0.7} 1180,${y + amp * 0.5} 1200,${y}`;
    return { d, opacity: 0.06 + (i / 16) * 0.34 };
  });
  // Constellation nodes on the right third + a few connecting edges.
  const nodes: [number, number][] = [
    [880, 60], [960, 120], [1040, 70], [1010, 150], [1110, 110],
    [1150, 60], [920, 170], [1080, 40], [990, 40], [1140, 160],
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 4], [1, 3], [3, 4], [2, 7], [5, 4], [1, 6], [8, 2], [4, 9],
  ];
  return (
    <div className="relative -mx-3 -mt-3 mb-2 h-36 overflow-hidden bg-gradient-to-b from-primary/12 via-primary/5 to-transparent sm:h-44 md:-mx-5 md:-mt-5">
      <svg
        viewBox="0 0 1200 200"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full text-primary"
      >
        {waves.map((w, i) => (
          <path
            key={i}
            d={w.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={i % 4 === 0 ? 1.4 : 0.9}
            opacity={w.opacity}
          />
        ))}
        {edges.map(([a, b], i) => (
          <line
            key={`e${i}`}
            x1={nodes[a][0]}
            y1={nodes[a][1]}
            x2={nodes[b][0]}
            y2={nodes[b][1]}
            stroke="currentColor"
            strokeWidth="0.7"
            opacity="0.28"
          />
        ))}
        {nodes.map(([cx, cy], i) => (
          <circle key={`n${i}`} cx={cx} cy={cy} r={i % 3 === 0 ? 2.6 : 1.8} fill="currentColor" opacity="0.4" />
        ))}
      </svg>
    </div>
  );
}

/** Faint star-chart watermark behind the content (dots + thin edges). */
function ConstellationBg() {
  const dots: [number, number][] = [
    [60, 120], [180, 300], [140, 520], [90, 700], [260, 90], [340, 420],
    [520, 640], [700, 200], [860, 500], [980, 120], [940, 680], [820, 320],
    [640, 80], [420, 720], [1080, 380], [1160, 200], [1120, 620], [300, 620],
  ];
  const edges: [number, number][] = [
    [0, 4], [1, 3], [2, 3], [5, 11], [6, 13], [7, 12], [8, 11], [9, 15], [10, 16], [14, 15],
  ];
  return (
    <svg
      viewBox="0 0 1200 760"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-[0.05]"
    >
      {edges.map(([a, b], i) => (
        <line
          key={`e${i}`}
          x1={dots[a][0]}
          y1={dots[a][1]}
          x2={dots[b][0]}
          y2={dots[b][1]}
          stroke="currentColor"
          strokeWidth="0.8"
        />
      ))}
      {dots.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={i % 4 === 0 ? 2.4 : 1.5} fill="currentColor" />
      ))}
    </svg>
  );
}

// ── tile shell + chart-slot states ───────────────────────────────────────────

function TileShell({
  icon,
  title,
  blurb,
  href,
  testid,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  href: string;
  testid: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="group relative flex min-h-[240px] flex-col rounded-2xl border border-card-border bg-card p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_10px_28px_-16px_rgba(0,0,0,0.18)] transition-all hover:border-primary/50 hover:shadow-[0_2px_6px_rgba(0,0,0,0.08),0_16px_36px_-16px_rgba(0,0,0,0.24)] sm:p-7"
      data-testid={`landing-tile-${testid}`}
    >
      <Link
        href={href}
        className="absolute inset-0 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/40"
        aria-label={title}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {icon}
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>
      <div className="mt-4 text-xl font-semibold">{title}</div>
      <p className="mt-1.5 text-sm text-muted-foreground">{blurb}</p>
      {children}
    </div>
  );
}

/** Cold-load placeholder for a chart slot — never a flat $0 line. */
function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted/60",
        className,
      )}
    />
  );
}

function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-14 items-center justify-end text-[11px] text-muted-foreground/70">
      {label}
    </div>
  );
}

/** The outline sub-link pill (nav) — matches the mockup's plain pills. */
function NavPill({
  href,
  label,
  testid,
}: {
  href: string;
  label: string;
  testid: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-md border border-card-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
      data-testid={testid}
    >
      {label}
    </Link>
  );
}

// ── tiles ─────────────────────────────────────────────────────────────────────

function BankingTile() {
  const { from, to } = useMemo(() => {
    const now = new Date();
    return {
      to: isoDate(now),
      from: isoDate(new Date(now.getFullYear(), now.getMonth() - 5, 1)),
    };
  }, []);
  const { data, isLoading } = useGetReportsSpendingFacts(
    { from, to },
    {
      query: {
        queryKey: getGetReportsSpendingFactsQueryKey({ from, to }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );
  const trends = data?.monthlyTrends ?? [];
  const series = trends.map((t) => t.total);
  const hasChart = series.length >= 2;
  const min = hasChart ? Math.min(...series) : 0;
  const max = hasChart ? Math.max(...series) : 0;
  const labels = trends.map((t) => monthShort(t.month));
  // Headline: this month's spend (month-to-date) + the change vs last month.
  const curMonthTotal = trends.length ? trends[trends.length - 1].total : null;
  const prevMonthTotal =
    trends.length >= 2 ? trends[trends.length - 2].total : null;
  const deltaPct =
    curMonthTotal != null && prevMonthTotal
      ? Math.round(((curMonthTotal - prevMonthTotal) / prevMonthTotal) * 100)
      : null;

  return (
    <TileShell
      testid="banking"
      href="/banking"
      icon={<Landmark className="h-5 w-5" />}
      title="Banking"
      blurb="How you're spending — this week & month, what to cancel, what to stop buying."
    >
      <div className="mt-auto pt-5">
        {curMonthTotal != null && (
          <div className="mb-3 flex items-center gap-2">
            <div className="leading-none">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                This month
              </div>
              <MoneyText
                amount={curMonthTotal}
                className="text-lg font-bold tabular-nums"
              />
            </div>
            {deltaPct != null && deltaPct !== 0 && (
              <PillBadge
                tone={deltaPct > 0 ? "danger" : "good"}
                dot={false}
                className="self-start"
              >
                {deltaPct > 0 ? "▲" : "▼"} {Math.abs(deltaPct)}% vs last mo
              </PillBadge>
            )}
          </div>
        )}
      <div className="flex items-end justify-between gap-3">
        <div className="relative z-10 flex flex-wrap content-end gap-2">
          <Link href="/transactions" data-testid="landing-link-banking-chase">
            <PillBadge tone="info" dot={false}>Chase</PillBadge>
          </Link>
          <Link href="/amex" data-testid="landing-link-banking-amex">
            <PillBadge
              dot={false}
              className="bg-[hsl(var(--card-blue)/0.14)] text-[hsl(var(--card-blue))]"
            >
              Amex
            </PillBadge>
          </Link>
          <Link href="/allowances" data-testid="landing-link-banking-allowance">
            <PillBadge tone="danger" dot={false}>Allowance</PillBadge>
          </Link>
        </div>
        <div className="pointer-events-none w-40 shrink-0">
          {isLoading ? (
            <ChartSkeleton className="h-14 w-full" />
          ) : hasChart ? (
            <>
              <div className="flex gap-1.5">
                <div className="flex flex-col justify-between py-0.5 text-[9px] tabular-nums text-muted-foreground/70">
                  <span>{kfmt(max)}</span>
                  <span>{kfmt((max + min) / 2)}</span>
                  <span>{kfmt(min)}</span>
                </div>
                <Sparkline data={series} variant="area" height={56} className="flex-1" />
              </div>
              <div className="mt-1 flex justify-between pl-7 text-[9px] text-muted-foreground/70">
                <span>{labels[0]}</span>
                {labels.length > 2 && <span>{labels[Math.floor(labels.length / 2)]}</span>}
                <span>{labels[labels.length - 1]}</span>
              </div>
            </>
          ) : (
            <ChartEmpty label="No spend yet" />
          )}
        </div>
      </div>
      </div>
    </TileShell>
  );
}

const BILL_GLYPHS = [Tv, Wifi, Zap, CreditCard, ShieldCheck];

function BillsTile() {
  const month = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  }, []);
  const { data, isLoading } = useGetBillsSummary(
    { month },
    {
      query: {
        queryKey: getGetBillsSummaryQueryKey({ month }),
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
      },
    },
  );
  const bills = useMemo(
    () =>
      (data?.bills ?? [])
        .map((b) => ({ name: b.item.name, amount: Math.abs(Number(b.monthlyAmount) || 0) }))
        .sort((a, b) => b.amount - a.amount),
    [data],
  );
  const top = bills.slice(0, 5);
  const names = bills.slice(0, 3).map((b) => b.name);
  const hasBars = top.length >= 1 && top.some((b) => b.amount > 0);

  return (
    <TileShell
      testid="bills"
      href="/bills"
      icon={<Receipt className="h-5 w-5" />}
      title="Bills"
      blurb="Your recurring bills & subscriptions — with an AI review of what to cut and what's missing."
    >
      <div className="mt-auto flex items-end justify-between gap-3 pt-5">
        <div className="flex flex-wrap content-end gap-2">
          {(names.length > 0 ? names : ["Subscriptions", "Utilities", "Recurring"]).map(
            (n) => (
              <span
                key={n}
                className="max-w-[7.5rem] truncate rounded-md border border-card-border px-2.5 py-1 text-xs font-medium text-muted-foreground"
              >
                {n}
              </span>
            ),
          )}
        </div>
        <div className="pointer-events-none w-40 shrink-0">
          {isLoading ? (
            <ChartSkeleton className="h-14 w-full" />
          ) : hasBars ? (
            <>
              <MiniBars
                data={top.map((b) => b.amount)}
                height={44}
                accent="hsl(var(--chart-1))"
              />
              <div className="mt-1 flex justify-between px-0.5 text-muted-foreground/45">
                {top.map((_, i) => {
                  const G = BILL_GLYPHS[i % BILL_GLYPHS.length];
                  return <G key={i} className="h-3 w-3" />;
                })}
              </div>
            </>
          ) : (
            <ChartEmpty label="No bills yet" />
          )}
        </div>
      </div>
    </TileShell>
  );
}

function ForecastTile() {
  const { data, isLoading } = useGetForecastCashSignal(
    { horizonDays: 90 },
    {
      query: {
        queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
        staleTime: 60_000,
        gcTime: 10 * 60_000,
      },
    },
  );
  const daily = data?.daily ?? [];
  const balances = daily.map((d) => Number(d.balance) || 0);
  const hasLine = balances.length >= 2;
  const projected = data?.endingBalance ?? data?.lowestProjected ?? null;

  // Downsample the daily series to ~7 bars; highlight the lowest point in teal.
  const bars: MiniBar[] = useMemo(() => {
    if (balances.length < 2) return [];
    const step = Math.max(1, Math.floor(balances.length / 7));
    const picked = balances.filter((_, i) => i % step === 0).slice(0, 7);
    const lowIdx = picked.indexOf(Math.min(...picked));
    return picked.map((v, i) => ({
      value: v,
      color: i === lowIdx ? "hsl(var(--chart-1))" : "hsl(var(--chart-3))",
    }));
  }, [balances]);

  return (
    <TileShell
      testid="forecast"
      href="/forecast"
      icon={<LineChart className="h-5 w-5" />}
      title="Forecast"
      blurb="See what's coming, then review and lock it in."
    >
      <div className="mt-auto pt-4">
        <div className="pointer-events-none mb-3 flex items-end justify-end gap-2">
          {isLoading ? (
            <ChartSkeleton className="h-10 w-32" />
          ) : hasLine ? (
            <>
              <div className="text-right leading-tight">
                <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">
                  Projected
                </div>
                {projected != null && (
                  <MoneyText amount={projected} className="text-sm font-semibold" />
                )}
              </div>
              <Sparkline data={balances} variant="area" height={40} className="w-28" />
            </>
          ) : (
            <ChartEmpty label="No forecast yet" />
          )}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="relative z-10 flex flex-wrap gap-2">
            <NavPill href="/forecast" label="Forecast" testid="landing-link-forecast-forecast" />
            <NavPill href="/review" label="Review" testid="landing-link-forecast-review" />
            <NavPill href="/budget" label="Budget" testid="landing-link-forecast-budget" />
          </div>
          {hasLine && bars.length > 0 && (
            <div className="pointer-events-none w-32 shrink-0">
              <MiniBars data={bars} height={36} />
            </div>
          )}
        </div>
      </div>
    </TileShell>
  );
}

function AvalancheTile() {
  const { data, isLoading } = useListDebts({
    query: {
      queryKey: getListDebtsQueryKey(),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    },
  });
  const active = (data ?? []).filter((d) => d.status !== "paid_off");
  const { overallPaid, target } = useMemo(() => {
    let sumOrig = 0;
    let sumBal = 0;
    for (const d of active) {
      const bal = Number(d.balance) || 0;
      const orig = Number(d.originalBalance ?? 0) || 0;
      if (orig > 0) {
        sumOrig += orig;
        sumBal += Math.min(bal, orig);
      }
    }
    const overall = sumOrig > 0 ? Math.max(0, Math.min(1, (sumOrig - sumBal) / sumOrig)) : null;
    // Avalanche target = highest-APR active debt with a carried balance.
    const withApr = active
      .filter((d) => (Number(d.balance) || 0) > 0 && Number(d.originalBalance ?? 0) > 0)
      .sort((a, b) => (Number(b.apr) || 0) - (Number(a.apr) || 0));
    const t = withApr[0];
    const tPaid = t
      ? Math.max(
          0,
          Math.min(
            1,
            ((Number(t.originalBalance) || 0) - (Number(t.balance) || 0)) /
              (Number(t.originalBalance) || 1),
          ),
        )
      : null;
    return { overallPaid: overall, target: t ? { name: t.name, paid: tPaid! } : null };
  }, [active]);

  const hasData = overallPaid != null;

  return (
    <TileShell
      testid="avalanche"
      href="/avalanche"
      icon={<Flame className="h-5 w-5" />}
      title="Avalanche"
      blurb="Attack the debt — manage the payoff plan and free-by date."
    >
      <div className="mt-auto flex items-end justify-between gap-4 pt-5">
        <div className="relative z-10">
          <NavPill href="/debts" label="Debts" testid="landing-link-avalanche-debts" />
        </div>
        <div className="pointer-events-none w-44 shrink-0 space-y-2">
          {isLoading ? (
            <ChartSkeleton className="h-12 w-full" />
          ) : hasData ? (
            <>
              <div>
                <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                  Overall paid
                </div>
                <FillMeter
                  value={overallPaid * 100}
                  ceiling={100}
                  status="good"
                  floorLabel="0%"
                  ceilingLabel="100%"
                  format={(n) => `${Math.round(n)}%`}
                />
              </div>
              {target && (
                <div>
                  <div className="mb-1 truncate text-[9px] uppercase tracking-wider text-muted-foreground/70">
                    {target.name}
                  </div>
                  <FillMeter
                    value={target.paid * 100}
                    ceiling={100}
                    status="warning"
                    floorLabel="0%"
                    ceilingLabel="100%"
                    format={(n) => `${Math.round(n)}%`}
                  />
                </div>
              )}
            </>
          ) : (
            <ChartEmpty label="No debts tracked" />
          )}
        </div>
      </div>
    </TileShell>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const { user } = useUser();
  const who = user?.firstName?.trim() || "Hubeles";
  const reviewCount = useReviewInboxCount();

  return (
    <div className="w-full">
      <HeaderBanner />

      <div className="relative mx-auto w-full max-w-5xl px-2 pb-12 sm:px-4">
        <ConstellationBg />

        {/* Greeting + account controls */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Hey, {who}.</h1>
            <p className="mt-1 text-base text-muted-foreground">
              Where do you want to go?
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <UserButton />
            <Link
              href="/review"
              aria-label={
                reviewCount > 0 ? `${reviewCount} items to review` : "Review inbox"
              }
              data-testid="landing-bell"
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-muted-foreground transition-colors hover:text-primary"
            >
              <Bell className="h-4 w-4" />
              {reviewCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
                  {reviewCount}
                </span>
              )}
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <BankingTile />
          <BillsTile />
          <ForecastTile />
          <AvalancheTile />
        </div>
      </div>
    </div>
  );
}
