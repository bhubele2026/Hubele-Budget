import {
  LayoutDashboard,
  LineChart,
  Receipt,
  CreditCard,
  Landmark,
  Search,
  Bell,
  ArrowUpRight,
  Plus,
  RefreshCw,
} from "lucide-react";

const PALETTE = {
  bg: "#FAFAF7",
  card: "#FFFFFF",
  hair: "#ECEAE3",
  ink: "#14181F",
  sec: "#6B7280",
  muted: "#9CA3AF",
  teal: "#0F766E",
  tealSoft: "#E6F2F0",
  pos: "#047857",
  neg: "#B91C1C",
};

function fmt(n: number, opts: { cents?: boolean } = {}) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

function HairCard({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={"bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] " + className}
      style={{
        borderRadius: 12,
        border: `1px solid ${PALETTE.hair}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
}: {
  icon: any;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className="relative flex items-center gap-3 px-4 py-2 cursor-default"
      style={{
        color: active ? PALETTE.teal : PALETTE.ink,
        fontWeight: active ? 600 : 500,
      }}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r"
          style={{ background: PALETTE.teal }}
        />
      )}
      <Icon className="w-[18px] h-[18px]" strokeWidth={active ? 2.2 : 1.8} />
      <span className="text-[14px]">{label}</span>
    </div>
  );
}

function KPI({
  label,
  value,
  hint,
  hintTone,
}: {
  label: string;
  value: string;
  hint?: string;
  hintTone?: "pos" | "neg" | "muted";
}) {
  const hintColor =
    hintTone === "pos"
      ? PALETTE.pos
      : hintTone === "neg"
        ? PALETTE.neg
        : PALETTE.sec;
  return (
    <HairCard className="px-5 py-5">
      <div
        className="text-[10px] font-semibold uppercase"
        style={{ color: PALETTE.muted, letterSpacing: "0.12em" }}
      >
        {label}
      </div>
      <div
        className="mt-3 text-3xl font-medium tabular-nums tracking-tight"
        style={{ color: PALETTE.ink }}
      >
        {value}
      </div>
      {hint && (
        <div
          className="mt-2 text-[12px] tabular-nums"
          style={{ color: hintColor }}
        >
          {hint}
        </div>
      )}
    </HairCard>
  );
}

function Bucket({
  code,
  name,
  spent,
  budget,
  over,
}: {
  code: string;
  name: string;
  spent: number;
  budget: number;
  over?: boolean;
}) {
  const pct = Math.min(100, (spent / budget) * 100);
  const remain = budget - spent;
  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="inline-flex items-center justify-center text-[10px] font-semibold tabular-nums"
            style={{
              width: 26,
              height: 20,
              borderRadius: 6,
              background: over ? "#FEF2F2" : PALETTE.tealSoft,
              color: over ? PALETTE.neg : PALETTE.teal,
              letterSpacing: "0.04em",
            }}
          >
            {code}
          </span>
          <span
            className="text-[13px] font-medium truncate"
            style={{ color: PALETTE.ink }}
          >
            {name}
          </span>
        </div>
        <div
          className="text-[13px] tabular-nums shrink-0"
          style={{ color: PALETTE.sec }}
        >
          <span style={{ color: over ? PALETTE.neg : PALETTE.ink, fontWeight: 500 }}>
            {fmt(spent)}
          </span>
          <span style={{ color: PALETTE.muted }}> / {fmt(budget)}</span>
        </div>
      </div>
      <div
        className="mt-2 h-[5px] w-full rounded-full overflow-hidden"
        style={{ background: "#F1EFEA" }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: over ? PALETTE.neg : PALETTE.teal,
          }}
        />
      </div>
      <div
        className="mt-1.5 text-[11px] tabular-nums"
        style={{ color: over ? PALETTE.neg : PALETTE.sec }}
      >
        {over
          ? `${fmt(-remain)} over`
          : `${fmt(remain)} remaining`}
      </div>
    </div>
  );
}

function DebtRow({
  rank,
  name,
  balance,
  apr,
  primary,
}: {
  rank: number;
  name: string;
  balance: number;
  apr: number;
  primary?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3 py-3"
      style={{ borderTop: rank === 1 ? "none" : `1px solid ${PALETTE.hair}` }}
    >
      <span
        className="inline-flex items-center justify-center text-[11px] font-semibold tabular-nums shrink-0"
        style={{
          width: 22,
          height: 22,
          borderRadius: 999,
          background: primary ? PALETTE.teal : "#F4F2EC",
          color: primary ? "#fff" : PALETTE.ink,
          border: primary ? "none" : `1px solid ${PALETTE.hair}`,
        }}
      >
        {rank}
      </span>
      <div className="flex-1 min-w-0">
        <div
          className="text-[13px] font-medium truncate"
          style={{ color: PALETTE.ink }}
        >
          {name}
        </div>
        <div
          className="text-[11px] tabular-nums"
          style={{ color: PALETTE.sec }}
        >
          {apr.toFixed(2)}% APR
        </div>
      </div>
      <div
        className="text-[13px] font-medium tabular-nums shrink-0"
        style={{ color: PALETTE.ink }}
      >
        {fmt(balance)}
      </div>
    </div>
  );
}

function Account({
  name,
  meta,
  amount,
  negative,
}: {
  name: string;
  meta: string;
  amount: number;
  negative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="min-w-0">
        <div
          className="text-[13px] font-medium truncate"
          style={{ color: PALETTE.ink }}
        >
          {name}
        </div>
        <div
          className="text-[11px]"
          style={{ color: PALETTE.muted }}
        >
          {meta}
        </div>
      </div>
      <div
        className="text-[13px] font-medium tabular-nums"
        style={{ color: negative ? PALETTE.neg : PALETTE.ink }}
      >
        {negative ? "-" : ""}
        {fmt(Math.abs(amount), { cents: true })}
      </div>
    </div>
  );
}

export default function QuietBank() {
  const income = 8420;
  const spent = 5217;
  const remaining = 3203;
  const dayN = 20;
  const dayTotal = 30;
  const monthPct = (spent / income) * 100;

  return (
    <div
      style={{
        background: PALETTE.bg,
        color: PALETTE.ink,
        fontFamily:
          "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        minHeight: "100vh",
      }}
    >
      <link
        rel="preconnect"
        href="https://fonts.googleapis.com"
      />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin=""
      />
      <link
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"
        rel="stylesheet"
      />

      <div className="flex min-h-screen">
        {/* Sidebar */}
        <aside
          className="shrink-0 flex flex-col"
          style={{
            width: 240,
            background: "#fff",
            borderRight: `1px solid ${PALETTE.hair}`,
          }}
        >
          <div className="px-5 py-5 flex items-center gap-2.5">
            <div
              className="flex items-center justify-center text-white text-[13px] font-semibold"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: PALETTE.teal,
                letterSpacing: "-0.02em",
              }}
            >
              H2
            </div>
            <div
              className="text-[14px] font-semibold"
              style={{ color: PALETTE.ink, letterSpacing: "-0.01em" }}
            >
              H2 Budget
            </div>
          </div>

          <nav className="mt-3 flex flex-col gap-0.5 pr-3">
            <NavItem icon={LayoutDashboard} label="Dashboard" active />
            <NavItem icon={LineChart} label="Forecast" />
            <NavItem icon={Receipt} label="Transactions" />
            <NavItem icon={CreditCard} label="Amex" />
            <NavItem icon={Landmark} label="Debts" />
          </nav>

          <div className="mt-auto px-5 pb-5 pt-6">
            <div
              className="flex items-center gap-3 px-3 py-2.5"
              style={{
                border: `1px solid ${PALETTE.hair}`,
                borderRadius: 10,
                background: "#FBFAF6",
              }}
            >
              <div
                className="flex items-center justify-center text-[11px] font-semibold"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  background: PALETTE.tealSoft,
                  color: PALETTE.teal,
                }}
              >
                HH
              </div>
              <div className="min-w-0">
                <div
                  className="text-[13px] font-medium truncate"
                  style={{ color: PALETTE.ink }}
                >
                  Hadi &amp; Hala
                </div>
                <div
                  className="text-[11px] truncate"
                  style={{ color: PALETTE.muted }}
                >
                  Family workspace
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 min-w-0">
          <div style={{ maxWidth: 1240 }} className="px-10 py-8 mx-auto">
            {/* Header */}
            <header className="flex items-center justify-between gap-6 mb-8">
              <div>
                <h1
                  className="text-2xl font-semibold tracking-tight"
                  style={{ color: PALETTE.ink, letterSpacing: "-0.02em" }}
                >
                  Dashboard
                </h1>
                <div
                  className="mt-1 text-[13px]"
                  style={{ color: PALETTE.sec }}
                >
                  Monday, April 20 · April 2026
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <div
                  className="flex items-center gap-2 px-3 h-9"
                  style={{
                    borderRadius: 8,
                    border: `1px solid ${PALETTE.hair}`,
                    background: "#fff",
                    color: PALETTE.muted,
                    minWidth: 220,
                  }}
                >
                  <Search className="w-[14px] h-[14px]" />
                  <span className="text-[13px]">Search transactions…</span>
                </div>
                <button
                  className="flex items-center justify-center"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    border: `1px solid ${PALETTE.hair}`,
                    background: "#fff",
                    color: PALETTE.sec,
                  }}
                >
                  <Bell className="w-[15px] h-[15px]" />
                </button>
                <button
                  className="flex items-center gap-2 h-9 px-4 text-[13px] font-medium"
                  style={{
                    borderRadius: 8,
                    background: PALETTE.teal,
                    color: "#fff",
                  }}
                >
                  <RefreshCw className="w-[14px] h-[14px]" />
                  Sync accounts
                </button>
              </div>
            </header>

            {/* KPI row */}
            <section className="grid grid-cols-4 gap-4 mb-6">
              <KPI label="Net income" value={fmt(income)} hint="Target this month" hintTone="muted" />
              <KPI label="Spent" value={fmt(spent)} hint={`${Math.round(monthPct)}% of income`} hintTone="muted" />
              <KPI label="Remaining" value={fmt(remaining)} hint="On pace · safe" hintTone="pos" />
              <KPI label="Days left" value={`${dayTotal - dayN}`} hint={`Day ${dayN} of ${dayTotal}`} hintTone="muted" />
            </section>

            {/* Two-column main */}
            <section className="grid gap-4" style={{ gridTemplateColumns: "1fr 380px" }}>
              {/* Left column */}
              <div className="flex flex-col gap-4">
                {/* April 2026 budget */}
                <HairCard className="px-7 py-7">
                  <div className="flex items-baseline justify-between mb-1">
                    <div>
                      <div
                        className="text-[10px] font-semibold uppercase"
                        style={{ color: PALETTE.muted, letterSpacing: "0.12em" }}
                      >
                        April 2026 budget
                      </div>
                      <div
                        className="mt-2 text-[28px] font-medium tabular-nums tracking-tight"
                        style={{ color: PALETTE.ink, letterSpacing: "-0.02em" }}
                      >
                        {fmt(spent)}{" "}
                        <span
                          className="text-[15px] font-normal"
                          style={{ color: PALETTE.muted }}
                        >
                          of {fmt(income)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className="text-[12px] tabular-nums"
                        style={{ color: PALETTE.sec }}
                      >
                        Day {dayN} of {dayTotal}
                      </div>
                      <div
                        className="text-[12px] tabular-nums mt-0.5"
                        style={{ color: PALETTE.pos }}
                      >
                        {fmt(remaining)} remaining
                      </div>
                    </div>
                  </div>

                  {/* Segmented progress: 30 days */}
                  <div className="mt-5 flex items-center gap-[3px]">
                    {Array.from({ length: dayTotal }).map((_, i) => {
                      const isPast = i < dayN;
                      const isToday = i === dayN - 1;
                      const filledDays = Math.round((monthPct / 100) * dayTotal);
                      const filled = i < filledDays;
                      return (
                        <div
                          key={i}
                          className="flex-1"
                          style={{
                            height: isToday ? 10 : 8,
                            borderRadius: 2,
                            background: filled
                              ? PALETTE.teal
                              : isPast
                                ? "#D9D5CC"
                                : "#EFEDE6",
                          }}
                        />
                      );
                    })}
                  </div>
                  <div
                    className="mt-2 flex items-center justify-between text-[11px] tabular-nums"
                    style={{ color: PALETTE.muted }}
                  >
                    <span>Apr 1</span>
                    <span style={{ color: PALETTE.teal }}>Today · Apr 20</span>
                    <span>Apr 30</span>
                  </div>

                  {/* Buckets divider */}
                  <div
                    className="mt-7 pt-5"
                    style={{ borderTop: `1px solid ${PALETTE.hair}` }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div
                        className="text-[10px] font-semibold uppercase"
                        style={{ color: PALETTE.muted, letterSpacing: "0.12em" }}
                      >
                        Buckets this month
                      </div>
                      <button
                        className="flex items-center gap-1 text-[11px] font-medium"
                        style={{ color: PALETTE.teal }}
                      >
                        Adjust caps <ArrowUpRight className="w-3 h-3" />
                      </button>
                    </div>
                    <Bucket code="WK" name="Weekly · groceries & gas" spent={843} budget={1200} />
                    <Bucket code="MO" name="Monthly · bills & subscriptions" spent={2310} budget={2800} />
                    <Bucket code="UN" name="Unbudgeted · one-offs" spent={612} budget={400} over />
                  </div>
                </HairCard>

                {/* Accounts */}
                <HairCard className="px-7 py-6">
                  <div className="flex items-center justify-between mb-3">
                    <div
                      className="text-[10px] font-semibold uppercase"
                      style={{ color: PALETTE.muted, letterSpacing: "0.12em" }}
                    >
                      Accounts
                    </div>
                    <button
                      className="flex items-center gap-1 text-[11px] font-medium"
                      style={{ color: PALETTE.teal }}
                    >
                      <Plus className="w-3 h-3" /> Link account
                    </button>
                  </div>
                  <div style={{ borderTop: `1px solid ${PALETTE.hair}` }}>
                    <Account name="Chase Checking" meta="••3421 · synced 4m ago" amount={4128.55} />
                    <div style={{ borderTop: `1px solid ${PALETTE.hair}` }} />
                    <Account name="Chase Savings" meta="••8810 · synced 4m ago" amount={11902.10} />
                    <div style={{ borderTop: `1px solid ${PALETTE.hair}` }} />
                    <Account name="Amex Gold" meta="••1006 · current statement" amount={2847.32} negative />
                  </div>
                </HairCard>
              </div>

              {/* Right column */}
              <div className="flex flex-col gap-4">
                {/* Kill Order */}
                <HairCard className="px-6 py-6">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <div
                        className="text-[10px] font-semibold uppercase"
                        style={{ color: PALETTE.muted, letterSpacing: "0.12em" }}
                      >
                        Kill order · Avalanche
                      </div>
                      <div
                        className="mt-1 text-[15px] font-semibold"
                        style={{ color: PALETTE.ink }}
                      >
                        Next 3 moves
                      </div>
                    </div>
                    <span
                      className="inline-flex w-1.5 h-1.5 rounded-full"
                      style={{ background: PALETTE.teal }}
                    />
                  </div>

                  <div className="mt-3">
                    <DebtRow rank={1} name="Discover" balance={4210} apr={24.99} primary />
                    <DebtRow rank={2} name="Capital One" balance={1895} apr={22.49} />
                    <DebtRow rank={3} name="Chase Sapphire" balance={987} apr={19.99} />
                  </div>

                  <div
                    className="mt-4 pt-4 flex items-center justify-between"
                    style={{ borderTop: `1px solid ${PALETTE.hair}` }}
                  >
                    <div>
                      <div
                        className="text-[11px]"
                        style={{ color: PALETTE.sec }}
                      >
                        Next payment
                      </div>
                      <div
                        className="text-[13px] font-medium tabular-nums"
                        style={{ color: PALETTE.ink }}
                      >
                        {fmt(450)} · Apr 28
                      </div>
                    </div>
                    <button
                      className="text-[12px] font-medium px-3 h-8 inline-flex items-center"
                      style={{
                        borderRadius: 8,
                        border: `1px solid ${PALETTE.hair}`,
                        color: PALETTE.ink,
                        background: "#fff",
                      }}
                    >
                      Schedule
                    </button>
                  </div>
                </HairCard>

                {/* Amex pay-down */}
                <HairCard className="px-6 py-6">
                  <div className="flex items-center justify-between">
                    <div
                      className="text-[10px] font-semibold uppercase"
                      style={{ color: PALETTE.muted, letterSpacing: "0.12em" }}
                    >
                      Amex pay-down
                    </div>
                    <span
                      className="text-[10px] font-medium tabular-nums px-2 py-0.5"
                      style={{
                        borderRadius: 999,
                        background: PALETTE.tealSoft,
                        color: PALETTE.teal,
                        letterSpacing: "0.04em",
                      }}
                    >
                      DUE MAY 15
                    </span>
                  </div>

                  <div className="mt-3">
                    <div
                      className="text-[11px]"
                      style={{ color: PALETTE.sec }}
                    >
                      Statement balance
                    </div>
                    <div
                      className="mt-1 text-3xl font-medium tabular-nums tracking-tight"
                      style={{ color: PALETTE.ink, letterSpacing: "-0.02em" }}
                    >
                      {fmt(2847.32, { cents: true })}
                    </div>
                  </div>

                  {/* Mini bar showing pay-down */}
                  <div className="mt-5">
                    <div
                      className="h-[6px] w-full rounded-full overflow-hidden flex"
                      style={{ background: "#F1EFEA" }}
                    >
                      <div
                        style={{
                          width: `${(1500 / 2847.32) * 100}%`,
                          background: PALETTE.teal,
                        }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] tabular-nums">
                      <span style={{ color: PALETTE.sec }}>
                        Planned payment{" "}
                        <span style={{ color: PALETTE.ink, fontWeight: 500 }}>
                          {fmt(1500)}
                        </span>
                      </span>
                      <span style={{ color: PALETTE.sec }}>
                        Projected end{" "}
                        <span style={{ color: PALETTE.pos, fontWeight: 500 }}>
                          {fmt(1347)}
                        </span>
                      </span>
                    </div>
                  </div>

                  <button
                    className="mt-5 w-full h-9 text-[13px] font-medium"
                    style={{
                      borderRadius: 8,
                      background: PALETTE.teal,
                      color: "#fff",
                    }}
                  >
                    Schedule payment
                  </button>
                </HairCard>
              </div>
            </section>

            <div
              className="mt-10 text-[11px] text-center"
              style={{ color: PALETTE.muted }}
            >
              H2 Budget · Quiet Bank preview
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
