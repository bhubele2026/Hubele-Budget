import {
  LayoutDashboard,
  Wallet,
  Receipt,
  TrendingDown,
  PieChart,
  Settings,
  Search,
  RefreshCcw,
  ArrowUpRight,
  ArrowDownRight,
  CreditCard,
  Calendar,
  Flame,
  ChevronRight,
  Bell,
} from "lucide-react";

const COLORS = {
  bg: "#0A0A0B",
  card: "#131316",
  cardElev: "#1A1A1F",
  border: "#232328",
  text: "#F5F5F7",
  text2: "#A1A1AA",
  muted: "#52525B",
  indigo: "#6366F1",
  violet: "#8B5CF6",
  pos: "#22C55E",
  neg: "#F43F5E",
};

function Sparkline({
  points,
  color = COLORS.indigo,
  width = 80,
  height = 24,
}: {
  points: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * step;
      const y = height - ((p - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        points={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NavItem({
  icon: Icon,
  label,
  active = false,
  badge,
}: {
  icon: any;
  label: string;
  active?: boolean;
  badge?: string;
}) {
  return (
    <div
      className="relative flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors"
      style={{
        background: active ? "rgba(99,102,241,0.10)" : "transparent",
        color: active ? COLORS.text : COLORS.text2,
        boxShadow: active ? "inset 0 0 0 1px rgba(99,102,241,0.4)" : "none",
      }}
    >
      {active && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-4 rounded-r"
          style={{ background: COLORS.indigo }}
        />
      )}
      <Icon className="w-4 h-4" strokeWidth={2} />
      <span className="text-[13px] font-medium flex-1">{label}</span>
      {badge && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium"
          style={{ background: COLORS.cardElev, color: COLORS.text2 }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

function Card({
  children,
  className = "",
  style = {},
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-[10px] ${className}`}
      style={{
        background: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function KpiCard({
  label,
  value,
  delta,
  deltaPositive,
  spark,
  sparkColor = COLORS.indigo,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaPositive?: boolean;
  spark: number[];
  sparkColor?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div
          className="text-[11px] uppercase font-medium"
          style={{ color: COLORS.muted, letterSpacing: "0.12em" }}
        >
          {label}
        </div>
        {delta && (
          <div
            className="flex items-center gap-0.5 text-[11px] font-medium tabular-nums"
            style={{ color: deltaPositive ? COLORS.pos : COLORS.neg }}
          >
            {deltaPositive ? (
              <ArrowUpRight className="w-3 h-3" />
            ) : (
              <ArrowDownRight className="w-3 h-3" />
            )}
            {delta}
          </div>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div
          className="text-[28px] leading-none font-semibold tabular-nums"
          style={{ color: COLORS.text, letterSpacing: "-0.02em" }}
        >
          {value}
        </div>
        <Sparkline points={spark} color={sparkColor} width={72} height={22} />
      </div>
    </Card>
  );
}

function BucketRow({
  code,
  label,
  spent,
  budget,
  over,
}: {
  code: string;
  label: string;
  spent: number;
  budget: number;
  over?: boolean;
}) {
  const pct = Math.min(100, (spent / budget) * 100);
  const overflow = spent > budget;
  const fmt = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className="text-[10px] font-semibold tracking-wider px-1.5 py-0.5 rounded"
            style={{
              background: COLORS.cardElev,
              color: overflow ? COLORS.neg : COLORS.text2,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            {code}
          </span>
          <span className="text-[13px] font-medium" style={{ color: COLORS.text }}>
            {label}
          </span>
          {over && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{ color: COLORS.neg, background: "rgba(244,63,94,0.10)" }}
            >
              OVER
            </span>
          )}
        </div>
        <div className="text-[13px] tabular-nums" style={{ color: COLORS.text2 }}>
          <span style={{ color: overflow ? COLORS.neg : COLORS.text, fontWeight: 600 }}>
            {fmt(spent)}
          </span>{" "}
          <span style={{ color: COLORS.muted }}>/ {fmt(budget)}</span>
        </div>
      </div>
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ background: COLORS.cardElev }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: overflow
              ? COLORS.neg
              : COLORS.indigo,
          }}
        />
      </div>
    </div>
  );
}

function DebtRow({
  rank,
  name,
  balance,
  apr,
  next = false,
}: {
  rank: number;
  name: string;
  balance: string;
  apr: string;
  next?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-3 rounded-lg"
      style={{
        background: next ? "rgba(99,102,241,0.06)" : "transparent",
        border: next ? `1px solid rgba(99,102,241,0.25)` : `1px solid transparent`,
      }}
    >
      <div
        className="w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-semibold tabular-nums"
        style={{
          background: next ? COLORS.indigo : COLORS.cardElev,
          color: next ? "#fff" : COLORS.text2,
          border: next ? "none" : `1px solid ${COLORS.border}`,
        }}
      >
        {rank}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate" style={{ color: COLORS.text }}>
          {name}
        </div>
        <div className="text-[11px]" style={{ color: COLORS.muted }}>
          Balance {balance}
        </div>
      </div>
      <span
        className="text-[10px] font-semibold px-1.5 py-0.5 rounded tabular-nums"
        style={{
          color: COLORS.neg,
          background: "rgba(244,63,94,0.08)",
          border: `1px solid rgba(244,63,94,0.20)`,
        }}
      >
        {apr} APR
      </span>
      <ChevronRight className="w-4 h-4" style={{ color: COLORS.muted }} />
    </div>
  );
}

export default function FintechDark() {
  const fontFamily =
    "'Inter Tight', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: COLORS.bg,
        color: COLORS.text,
        fontFamily,
        fontFeatureSettings: "'cv11', 'ss01', 'tnum'",
      }}
    >
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&display=swap"
      />

      <div className="flex min-h-screen">
        {/* Sidebar */}
        <aside
          className="flex flex-col"
          style={{
            width: 220,
            background: COLORS.bg,
            borderRight: `1px solid ${COLORS.border}`,
          }}
        >
          <div className="px-4 pt-5 pb-6 flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] font-bold text-white"
              style={{
                background: COLORS.indigo,
              }}
            >
              H2
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-semibold tracking-tight">H2 Budget</span>
              <span className="text-[10px]" style={{ color: COLORS.muted }}>
                Hadi & Hala
              </span>
            </div>
          </div>

          <div className="px-3">
            <div
              className="text-[10px] uppercase font-semibold mb-2 px-3"
              style={{ color: COLORS.muted, letterSpacing: "0.14em" }}
            >
              Workspace
            </div>
            <nav className="space-y-0.5">
              <NavItem icon={LayoutDashboard} label="Dashboard" active />
              <NavItem icon={Wallet} label="Budget" />
              <NavItem icon={Receipt} label="Transactions" badge="12" />
              <NavItem icon={TrendingDown} label="Avalanche" />
              <NavItem icon={CreditCard} label="Amex" />
              <NavItem icon={PieChart} label="Reports" />
            </nav>
          </div>

          <div className="px-3 mt-6">
            <div
              className="text-[10px] uppercase font-semibold mb-2 px-3"
              style={{ color: COLORS.muted, letterSpacing: "0.14em" }}
            >
              System
            </div>
            <nav className="space-y-0.5">
              <NavItem icon={Bell} label="Alerts" badge="3" />
              <NavItem icon={Settings} label="Settings" />
            </nav>
          </div>

          <div className="mt-auto p-3">
            <div
              className="flex items-center gap-2.5 p-2 rounded-lg"
              style={{ background: COLORS.card, border: `1px solid ${COLORS.border}` }}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold"
                style={{ background: COLORS.cardElev, color: COLORS.text }}
              >
                HH
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium truncate">Hadi Hubele</div>
                <div className="text-[10px] truncate" style={{ color: COLORS.muted }}>
                  hadi@h2.family
                </div>
              </div>
              <ChevronRight className="w-4 h-4" style={{ color: COLORS.muted }} />
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 min-w-0">
          {/* Header */}
          <header
            className="flex items-center justify-between px-8 py-5"
            style={{ borderBottom: `1px solid ${COLORS.border}` }}
          >
            <div>
              <div
                className="text-[11px] flex items-center gap-1.5"
                style={{ color: COLORS.muted }}
              >
                <span>Home</span>
                <ChevronRight className="w-3 h-3" />
                <span style={{ color: COLORS.text2 }}>Dashboard</span>
              </div>
              <h1
                className="text-[24px] font-semibold mt-1"
                style={{ color: COLORS.text, letterSpacing: "-0.02em" }}
              >
                April 2026 overview
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
                style={{
                  background: COLORS.card,
                  border: `1px solid ${COLORS.border}`,
                  color: COLORS.text2,
                }}
              >
                <Search className="w-4 h-4" />
              </button>
              <button
                className="h-9 px-3.5 rounded-lg flex items-center gap-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                style={{
                  background: COLORS.indigo,
                  boxShadow: "0 1px 0 rgba(255,255,255,0.10) inset, 0 4px 12px rgba(99,102,241,0.25)",
                }}
              >
                <RefreshCcw className="w-3.5 h-3.5" />
                Sync accounts
              </button>
            </div>
          </header>

          <div className="p-8 space-y-6" style={{ maxWidth: 1240 }}>
            {/* Hero tile */}
            <Card className="p-6 relative overflow-hidden">
              <div
                className="absolute -top-24 -right-24 w-72 h-72 rounded-full opacity-30 blur-3xl pointer-events-none"
                style={{
                  background: `radial-gradient(circle, ${COLORS.indigo} 0%, ${COLORS.violet} 60%, transparent 100%)`,
                }}
              />
              <div className="relative flex items-start justify-between gap-8">
                <div className="flex-1">
                  <div
                    className="text-[11px] uppercase font-medium"
                    style={{ color: COLORS.muted, letterSpacing: "0.12em" }}
                  >
                    Remaining this month
                  </div>
                  <div className="mt-2 flex items-baseline gap-3">
                    <span
                      className="text-[64px] leading-none font-semibold tabular-nums"
                      style={{
                        background: `linear-gradient(135deg, ${COLORS.text} 0%, #C7C7D1 100%)`,
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                        letterSpacing: "-0.035em",
                      }}
                    >
                      $3,203
                    </span>
                    <span
                      className="text-[14px] font-medium tabular-nums flex items-center gap-1 px-2 py-1 rounded-md"
                      style={{
                        color: COLORS.pos,
                        background: "rgba(34,197,94,0.10)",
                      }}
                    >
                      <ArrowUpRight className="w-3.5 h-3.5" />
                      4.2% vs Mar
                    </span>
                  </div>
                  <div
                    className="mt-3 text-[13px] flex items-center gap-2"
                    style={{ color: COLORS.text2 }}
                  >
                    <span className="tabular-nums" style={{ color: COLORS.text }}>
                      $5,217
                    </span>
                    spent of
                    <span className="tabular-nums" style={{ color: COLORS.text }}>
                      $8,420
                    </span>
                    <span style={{ color: COLORS.muted }}>·</span>
                    <span style={{ color: COLORS.muted }}>Day 20 of 30</span>
                  </div>

                  {/* Segmented progress */}
                  <div className="mt-5 flex gap-1">
                    {Array.from({ length: 30 }).map((_, i) => {
                      const filled = i < 20;
                      const overBudget = i < 18.6;
                      return (
                        <div
                          key={i}
                          className="flex-1 h-1.5 rounded-sm"
                          style={{
                            background: overBudget
                              ? `linear-gradient(180deg, ${COLORS.indigo}, ${COLORS.violet})`
                              : filled
                              ? "rgba(99,102,241,0.25)"
                              : COLORS.cardElev,
                          }}
                        />
                      );
                    })}
                  </div>
                  <div
                    className="mt-2 flex justify-between text-[10px]"
                    style={{ color: COLORS.muted, letterSpacing: "0.10em" }}
                  >
                    <span>APR 1</span>
                    <span>67% THROUGH MONTH</span>
                    <span>APR 30</span>
                  </div>
                </div>

                <div
                  className="w-px self-stretch"
                  style={{ background: COLORS.border }}
                />

                <div className="flex flex-col gap-4 w-56">
                  <div>
                    <div
                      className="text-[11px] uppercase font-medium"
                      style={{ color: COLORS.muted, letterSpacing: "0.12em" }}
                    >
                      Daily run-rate
                    </div>
                    <div
                      className="text-[24px] font-semibold tabular-nums mt-1"
                      style={{ color: COLORS.text, letterSpacing: "-0.02em" }}
                    >
                      $260.85
                    </div>
                    <div className="text-[11px]" style={{ color: COLORS.text2 }}>
                      Safe to spend{" "}
                      <span style={{ color: COLORS.pos }}>$320/day</span>
                    </div>
                  </div>
                  <div>
                    <div
                      className="text-[11px] uppercase font-medium"
                      style={{ color: COLORS.muted, letterSpacing: "0.12em" }}
                    >
                      Projected leftover
                    </div>
                    <div
                      className="text-[24px] font-semibold tabular-nums mt-1"
                      style={{ color: COLORS.text, letterSpacing: "-0.02em" }}
                    >
                      $1,178
                    </div>
                    <div className="text-[11px]" style={{ color: COLORS.text2 }}>
                      Auto-route to Avalanche
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            {/* KPI row */}
            <div className="grid grid-cols-4 gap-4">
              <KpiCard
                label="Net income"
                value="$8,420"
                delta="2.1%"
                deltaPositive
                spark={[40, 42, 41, 44, 46, 45, 48, 50]}
                sparkColor={COLORS.pos}
              />
              <KpiCard
                label="Spent"
                value="$5,217"
                delta="6.8%"
                deltaPositive={false}
                spark={[20, 28, 35, 42, 50, 58, 64, 72]}
                sparkColor={COLORS.indigo}
              />
              <KpiCard
                label="Days left"
                value="10"
                spark={[30, 27, 24, 21, 18, 15, 12, 10]}
                sparkColor="#71717A"
              />
              <KpiCard
                label="Top category"
                value="Groceries"
                delta="$612"
                deltaPositive={false}
                spark={[15, 22, 18, 30, 28, 35, 32, 40]}
                sparkColor={COLORS.indigo}
              />
            </div>

            {/* Weekly buckets row */}
            <Card className="p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <div
                    className="text-[11px] uppercase font-medium"
                    style={{ color: COLORS.muted, letterSpacing: "0.12em" }}
                  >
                    Spending buckets · Week of Apr 19
                  </div>
                  <h2
                    className="text-[18px] font-semibold mt-0.5"
                    style={{ color: COLORS.text, letterSpacing: "-0.02em" }}
                  >
                    Weekly buckets
                  </h2>
                </div>
                <div className="flex gap-1.5">
                  {["WK", "MO", "UN"].map((b) => (
                    <span
                      key={b}
                      className="text-[10px] font-semibold tracking-wider px-2 py-1 rounded"
                      style={{
                        background: COLORS.cardElev,
                        color: COLORS.text2,
                        border: `1px solid ${COLORS.border}`,
                      }}
                    >
                      {b}
                    </span>
                  ))}
                </div>
              </div>
              <div className="space-y-5">
                <BucketRow
                  code="WK"
                  label="Weekly · Groceries & Gas"
                  spent={843}
                  budget={1200}
                />
                <BucketRow
                  code="MO"
                  label="Monthly · Bills & Subscriptions"
                  spent={2310}
                  budget={2800}
                />
                <BucketRow
                  code="UN"
                  label="Unbudgeted · Discretionary"
                  spent={612}
                  budget={400}
                  over
                />
              </div>
            </Card>

            {/* 2-col bottom */}
            <div className="grid grid-cols-2 gap-6">
              {/* Kill order */}
              <Card className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Flame className="w-4 h-4" style={{ color: COLORS.indigo }} />
                    <div>
                      <div
                        className="text-[11px] uppercase font-medium"
                        style={{ color: COLORS.muted, letterSpacing: "0.12em" }}
                      >
                        Avalanche · Kill order
                      </div>
                      <h2
                        className="text-[16px] font-semibold mt-0.5"
                        style={{ color: COLORS.text, letterSpacing: "-0.02em" }}
                      >
                        Next 3 moves
                      </h2>
                    </div>
                  </div>
                  <button
                    className="text-[11px] font-medium px-2.5 py-1.5 rounded-md"
                    style={{
                      color: COLORS.text2,
                      background: COLORS.cardElev,
                      border: `1px solid ${COLORS.border}`,
                    }}
                  >
                    See plan
                  </button>
                </div>
                <div className="space-y-1">
                  <DebtRow rank={1} name="Discover" balance="$4,210" apr="24.99%" next />
                  <DebtRow rank={2} name="Capital One" balance="$1,895" apr="22.49%" />
                  <DebtRow rank={3} name="Chase Sapphire" balance="$987" apr="19.99%" />
                </div>
                <div
                  className="mt-4 pt-4 flex items-center justify-between"
                  style={{ borderTop: `1px solid ${COLORS.border}` }}
                >
                  <div className="flex items-center gap-2">
                    <Calendar className="w-3.5 h-3.5" style={{ color: COLORS.muted }} />
                    <div className="text-[12px]" style={{ color: COLORS.text2 }}>
                      Next payment{" "}
                      <span style={{ color: COLORS.text }}>$450</span> · Due Apr 28
                    </div>
                  </div>
                  <button
                    className="text-[12px] font-medium px-3 py-1.5 rounded-md text-white"
                    style={{ background: COLORS.indigo }}
                  >
                    Pay now
                  </button>
                </div>
              </Card>

              {/* Right column: Amex + Accounts */}
              <div className="space-y-6">
                {/* Amex pay-down */}
                <Card className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center"
                        style={{
                          background: COLORS.cardElev,
                          border: `1px solid ${COLORS.border}`,
                        }}
                      >
                        <CreditCard className="w-4 h-4" style={{ color: COLORS.indigo }} />
                      </div>
                      <div>
                        <div
                          className="text-[11px] uppercase font-medium"
                          style={{ color: COLORS.muted, letterSpacing: "0.12em" }}
                        >
                          Amex Gold · Pay-down
                        </div>
                        <div
                          className="text-[16px] font-semibold mt-0.5"
                          style={{ color: COLORS.text }}
                        >
                          Statement due May 15
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div
                      className="p-3 rounded-lg"
                      style={{ background: COLORS.cardElev, border: `1px solid ${COLORS.border}` }}
                    >
                      <div
                        className="text-[10px] uppercase"
                        style={{ color: COLORS.muted, letterSpacing: "0.10em" }}
                      >
                        Balance
                      </div>
                      <div
                        className="text-[18px] font-semibold tabular-nums mt-1"
                        style={{ color: COLORS.text }}
                      >
                        $2,847
                      </div>
                    </div>
                    <div
                      className="p-3 rounded-lg"
                      style={{ background: COLORS.cardElev, border: `1px solid ${COLORS.border}` }}
                    >
                      <div
                        className="text-[10px] uppercase"
                        style={{ color: COLORS.muted, letterSpacing: "0.10em" }}
                      >
                        Planned
                      </div>
                      <div
                        className="text-[18px] font-semibold tabular-nums mt-1"
                        style={{ color: COLORS.indigo }}
                      >
                        $1,500
                      </div>
                    </div>
                    <div
                      className="p-3 rounded-lg"
                      style={{ background: COLORS.cardElev, border: `1px solid ${COLORS.border}` }}
                    >
                      <div
                        className="text-[10px] uppercase"
                        style={{ color: COLORS.muted, letterSpacing: "0.10em" }}
                      >
                        End of mo.
                      </div>
                      <div
                        className="text-[18px] font-semibold tabular-nums mt-1"
                        style={{ color: COLORS.pos }}
                      >
                        $1,347
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div
                      className="h-1.5 rounded-full overflow-hidden"
                      style={{ background: COLORS.cardElev }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: "53%",
                          background: `linear-gradient(90deg, ${COLORS.indigo}, ${COLORS.violet})`,
                        }}
                      />
                    </div>
                    <div
                      className="mt-2 text-[11px] flex justify-between"
                      style={{ color: COLORS.text2 }}
                    >
                      <span>53% of statement covered</span>
                      <span style={{ color: COLORS.muted }}>$1,347 remaining</span>
                    </div>
                  </div>
                </Card>

                {/* Accounts mini */}
                <Card className="p-5">
                  <div
                    className="text-[11px] uppercase font-medium mb-3"
                    style={{ color: COLORS.muted, letterSpacing: "0.12em" }}
                  >
                    Accounts
                  </div>
                  <div className="space-y-2.5">
                    {[
                      { name: "Chase Checking", sub: "···4128", val: "$4,128.55", pos: true },
                      { name: "Chase Savings", sub: "···2210", val: "$11,902.10", pos: true },
                      { name: "Amex Gold", sub: "Statement", val: "−$2,847.32", pos: false },
                    ].map((a) => (
                      <div
                        key={a.name}
                        className="flex items-center justify-between py-1.5"
                      >
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-7 h-7 rounded-md flex items-center justify-center text-[10px] font-semibold"
                            style={{
                              background: COLORS.cardElev,
                              color: COLORS.text2,
                              border: `1px solid ${COLORS.border}`,
                            }}
                          >
                            {a.name.split(" ").map((s) => s[0]).join("").slice(0, 2)}
                          </div>
                          <div>
                            <div
                              className="text-[13px] font-medium"
                              style={{ color: COLORS.text }}
                            >
                              {a.name}
                            </div>
                            <div className="text-[10px]" style={{ color: COLORS.muted }}>
                              {a.sub}
                            </div>
                          </div>
                        </div>
                        <div
                          className="text-[13px] font-semibold tabular-nums"
                          style={{ color: a.pos ? COLORS.text : COLORS.neg }}
                        >
                          {a.val}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            </div>

            <div
              className="text-[11px] pt-2 pb-6 flex items-center gap-2"
              style={{ color: COLORS.muted }}
            >
              <span>Last sync · 4 min ago</span>
              <span>·</span>
              <span>3 accounts connected</span>
              <span>·</span>
              <span style={{ color: COLORS.pos }}>● All systems normal</span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
