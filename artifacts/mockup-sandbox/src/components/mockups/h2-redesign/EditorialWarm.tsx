import {
  LayoutDashboard,
  Wallet,
  Receipt,
  TrendingUp,
  Flame,
  Calendar,
  Settings,
  Bell,
  RefreshCw,
  Building2,
  PiggyBank,
  CreditCard,
  ArrowUpRight,
  ArrowDownRight,
  Circle,
} from "lucide-react";

const INK = "#1C1A17";
const SECONDARY = "#6B6356";
const MUTED = "#A29888";
const ACCENT = "#B45309";
const POSITIVE = "#15803D";
const NEGATIVE = "#9F1239";
const PAGE_BG = "#F6F1E8";
const CARD_BG = "#FFFDF8";
const BORDER = "#E6DECC";

const cardShadow =
  "shadow-[0_1px_3px_rgba(28,26,23,0.04),0_8px_24px_-12px_rgba(28,26,23,0.06)]";

const fraunces = { fontFamily: "'Fraunces', Georgia, serif" };
const inter = { fontFamily: "'Inter', system-ui, sans-serif" };

function fmt(n: number, opts: { signed?: boolean; cents?: boolean } = {}) {
  const { signed, cents } = opts;
  const abs = Math.abs(n);
  const s = abs.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
  const sign = n < 0 ? "−" : signed ? "+" : "";
  return `${sign}$${s}`;
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
      className="flex items-center gap-3 px-3 py-2 rounded-[10px] cursor-pointer"
      style={{
        ...inter,
        color: active ? INK : SECONDARY,
        background: active ? "rgba(180,83,9,0.06)" : "transparent",
        fontWeight: active ? 500 : 400,
        fontSize: 14,
      }}
    >
      {active ? (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: ACCENT }}
        />
      ) : (
        <Icon className="w-4 h-4" strokeWidth={1.6} />
      )}
      {active ? <Icon className="w-4 h-4" strokeWidth={1.8} /> : null}
      <span>{label}</span>
      {active && (
        <span
          className="ml-auto italic"
          style={{ ...fraunces, color: ACCENT, fontSize: 13 }}
        >
          ·
        </span>
      )}
    </div>
  );
}

function Sidebar() {
  return (
    <aside
      className="shrink-0 h-full flex flex-col"
      style={{
        width: 248,
        background: "#F2EBDC",
        borderRight: `1px solid ${BORDER}`,
      }}
    >
      <div className="px-6 pt-7 pb-8 flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: ACCENT }}
        >
          <span
            style={{ ...fraunces, color: "#FFFDF8", fontSize: 15, fontWeight: 600 }}
          >
            H2
          </span>
        </div>
        <div>
          <div style={{ ...fraunces, color: INK, fontSize: 17, fontWeight: 600 }}>
            H2 Budget
          </div>
          <div
            style={{ ...inter, color: MUTED, fontSize: 11, letterSpacing: 0.4 }}
            className="uppercase"
          >
            Family Budget
          </div>
        </div>
      </div>

      <nav className="px-3 space-y-1">
        <NavItem icon={LayoutDashboard} label="Dashboard" active />
        <NavItem icon={Wallet} label="Budget" />
        <NavItem icon={Receipt} label="Transactions" />
        <NavItem icon={Calendar} label="Bills" />
        <NavItem icon={TrendingUp} label="Forecast" />
        <NavItem icon={Flame} label="Avalanche" />
      </nav>

      <div
        className="mt-6 mx-6 pt-5"
        style={{ borderTop: `1px solid ${BORDER}` }}
      >
        <div
          style={{ ...inter, color: MUTED, fontSize: 10, letterSpacing: 1.2 }}
          className="uppercase mb-2"
        >
          Workspace
        </div>
        <div className="space-y-1 -mx-3">
          <NavItem icon={CreditCard} label="Amex Gold" />
          <NavItem icon={Settings} label="Settings" />
        </div>
      </div>

      <div
        className="mt-auto mx-6 mb-6 pt-5"
        style={{ borderTop: `1px solid ${BORDER}` }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{
              background: "#E8DEC8",
              color: INK,
              ...fraunces,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            HH
          </div>
          <div>
            <div style={{ ...inter, color: INK, fontSize: 13, fontWeight: 500 }}>
              Hadi & Hala
            </div>
            <div style={{ ...inter, color: MUTED, fontSize: 11 }}>
              Shared household
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Header() {
  return (
    <header className="flex items-end justify-between mb-10">
      <div>
        <div
          style={{ ...inter, color: MUTED, fontSize: 11, letterSpacing: 1.4 }}
          className="uppercase mb-2"
        >
          Overview
        </div>
        <h1
          style={{
            ...fraunces,
            color: INK,
            fontSize: 32,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            lineHeight: 1.1,
          }}
        >
          April, 2026
        </h1>
        <div
          className="mt-2 h-[2px] w-10"
          style={{ background: ACCENT }}
        />
        <div
          className="mt-3"
          style={{ ...inter, color: SECONDARY, fontSize: 13 }}
        >
          Hadi & Hala — week 3 of 4 · day 20 of 30
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="w-10 h-10 rounded-[10px] flex items-center justify-center"
          style={{
            border: `1px solid ${BORDER}`,
            background: CARD_BG,
            color: SECONDARY,
          }}
        >
          <Bell className="w-4 h-4" strokeWidth={1.6} />
        </button>
        <button
          className="px-4 h-10 rounded-[10px] flex items-center gap-2"
          style={{
            border: `1px solid ${ACCENT}`,
            color: ACCENT,
            ...inter,
            fontSize: 13,
            fontWeight: 500,
            background: "transparent",
          }}
        >
          <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
          Sync accounts
        </button>
      </div>
    </header>
  );
}

function Kpi({
  label,
  value,
  sub,
  trend,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: string;
  positive?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl p-5 ${cardShadow}`}
      style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}
    >
      <div
        style={{ ...inter, color: MUTED, fontSize: 10.5, letterSpacing: 1.2 }}
        className="uppercase mb-3"
      >
        {label}
      </div>
      <div
        style={{
          ...fraunces,
          color: INK,
          fontSize: 30,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
        className="tabular-nums"
      >
        {value}
      </div>
      {(sub || trend) && (
        <div
          className="mt-3 flex items-center justify-between"
          style={{ ...inter, fontSize: 12, color: SECONDARY }}
        >
          <span>{sub}</span>
          {trend && (
            <span
              className="inline-flex items-center gap-1"
              style={{ color: positive ? POSITIVE : NEGATIVE, fontWeight: 500 }}
            >
              {positive ? (
                <ArrowUpRight className="w-3.5 h-3.5" strokeWidth={2} />
              ) : (
                <ArrowDownRight className="w-3.5 h-3.5" strokeWidth={2} />
              )}
              {trend}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function HeadlinePanel() {
  const income = 8420;
  const spent = 5217;
  const remaining = 3203;
  const pctSpent = (spent / income) * 100;

  // Bucket pill data
  const buckets = [
    { code: "WK", label: "Weekly", spent: 843, cap: 1200 },
    { code: "MO", label: "Monthly", spent: 2310, cap: 2800 },
    { code: "UN", label: "Unbudgeted", spent: 612, cap: 400 },
  ];

  return (
    <div
      className={`rounded-2xl p-10 ${cardShadow}`}
      style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}
    >
      <div className="flex items-start justify-between gap-10">
        <div className="flex-1">
          <div
            style={{ ...inter, color: MUTED, fontSize: 11, letterSpacing: 1.4 }}
            className="uppercase"
          >
            Remaining this month
          </div>
          <div className="mt-3 inline-block">
            <div
              style={{
                ...fraunces,
                color: INK,
                fontSize: 72,
                fontWeight: 500,
                letterSpacing: "-0.035em",
                lineHeight: 1,
              }}
              className="tabular-nums"
            >
              ${remaining.toLocaleString()}
            </div>
            <div
              className="mt-3 h-[3px]"
              style={{ background: ACCENT, width: 88 }}
            />
          </div>
          <div
            className="mt-5"
            style={{ ...inter, color: SECONDARY, fontSize: 13.5 }}
          >
            of{" "}
            <span style={{ ...fraunces, fontWeight: 500 }}>
              ${income.toLocaleString()}
            </span>{" "}
            net target ·{" "}
            <span style={{ ...fraunces, fontWeight: 500 }}>
              ${spent.toLocaleString()}
            </span>{" "}
            spent so far
          </div>
        </div>

        <div className="text-right">
          <div
            style={{ ...inter, color: MUTED, fontSize: 11, letterSpacing: 1.4 }}
            className="uppercase mb-2"
          >
            Pace
          </div>
          <div
            style={{
              ...fraunces,
              color: POSITIVE,
              fontSize: 22,
              fontWeight: 500,
            }}
          >
            On track
          </div>
          <div
            className="mt-1"
            style={{ ...inter, color: SECONDARY, fontSize: 12 }}
          >
            67% through · 62% spent
          </div>
        </div>
      </div>

      {/* Stacked bar */}
      <div className="mt-8">
        <div
          className="h-2 w-full rounded-full overflow-hidden flex"
          style={{ background: "#EFE6D2" }}
        >
          <div
            style={{
              width: `${pctSpent}%`,
              background:
                "linear-gradient(90deg, #1C1A17 0%, #2C2823 60%, #B45309 100%)",
            }}
          />
        </div>
        <div
          className="mt-2 flex items-center justify-between"
          style={{ ...inter, fontSize: 11.5, color: MUTED, letterSpacing: 0.6 }}
        >
          <span>SPENT ${spent.toLocaleString()}</span>
          <span>REMAINING ${remaining.toLocaleString()}</span>
        </div>
      </div>

      {/* Bucket pills */}
      <div className="mt-7 flex items-center gap-3 flex-wrap">
        {buckets.map((b) => {
          const over = b.spent > b.cap;
          return (
            <div
              key={b.code}
              className="inline-flex items-center gap-3 px-4 py-2 rounded-full"
              style={{
                border: `1px solid ${BORDER}`,
                background: "#FBF7EE",
              }}
            >
              <span
                style={{
                  ...inter,
                  fontSize: 10,
                  letterSpacing: 1.4,
                  color: over ? NEGATIVE : ACCENT,
                  fontWeight: 600,
                }}
                className="uppercase"
              >
                {b.code}
              </span>
              <span
                style={{ ...inter, fontSize: 12, color: SECONDARY }}
              >
                {b.label}
              </span>
              <span
                style={{
                  ...fraunces,
                  fontSize: 14,
                  fontWeight: 500,
                  color: over ? NEGATIVE : INK,
                }}
                className="tabular-nums"
              >
                ${b.spent} / ${b.cap}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AccountRow({
  icon: Icon,
  name,
  sub,
  amount,
  negative,
  iconBg,
  iconColor,
}: {
  icon: any;
  name: string;
  sub: string;
  amount: string;
  negative?: boolean;
  iconBg: string;
  iconColor: string;
}) {
  return (
    <div
      className="flex items-center justify-between py-4"
      style={{ borderBottom: `1px solid ${BORDER}` }}
    >
      <div className="flex items-center gap-4">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ background: iconBg }}
        >
          <Icon className="w-4.5 h-4.5" strokeWidth={1.6} style={{ color: iconColor }} />
        </div>
        <div>
          <div style={{ ...inter, color: INK, fontSize: 14, fontWeight: 500 }}>
            {name}
          </div>
          <div style={{ ...inter, color: MUTED, fontSize: 12 }}>{sub}</div>
        </div>
      </div>
      <div
        style={{
          ...fraunces,
          color: negative ? NEGATIVE : INK,
          fontSize: 22,
          fontWeight: 500,
          letterSpacing: "-0.01em",
        }}
        className="tabular-nums"
      >
        {amount}
      </div>
    </div>
  );
}

function AccountsCard() {
  return (
    <div
      className={`rounded-2xl p-7 ${cardShadow}`}
      style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <h3
          style={{
            ...fraunces,
            color: INK,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          Account snapshots
        </h3>
        <span style={{ ...inter, color: ACCENT, fontSize: 12, fontWeight: 500 }}>
          View all →
        </span>
      </div>
      <div
        style={{ ...inter, color: MUTED, fontSize: 12 }}
        className="mb-3"
      >
        As of today, 8:14am
      </div>

      <div>
        <AccountRow
          icon={Building2}
          name="Chase Checking"
          sub="…5526 · primary"
          amount="$4,128.55"
          iconBg="#E8DEC8"
          iconColor={INK}
        />
        <AccountRow
          icon={PiggyBank}
          name="Chase Savings"
          sub="…2049 · emergency"
          amount="$11,902.10"
          iconBg="#DDE9DD"
          iconColor={POSITIVE}
        />
        <AccountRow
          icon={CreditCard}
          name="Amex Gold"
          sub="…1006 · current statement"
          amount="−$2,847.32"
          negative
          iconBg="#F4DDD8"
          iconColor={NEGATIVE}
        />
      </div>

      <div
        className="mt-4 pt-4 flex items-center justify-between"
        style={{ borderTop: `1px solid ${BORDER}` }}
      >
        <span
          style={{ ...inter, color: SECONDARY, fontSize: 12 }}
        >
          Net worth
        </span>
        <span
          style={{
            ...fraunces,
            color: INK,
            fontSize: 22,
            fontWeight: 500,
          }}
          className="tabular-nums"
        >
          $13,183.33
        </span>
      </div>
    </div>
  );
}

function KillOrderCard() {
  const debts = [
    { n: 1, name: "Discover", balance: 4210, apr: 24.99 },
    { n: 2, name: "Capital One", balance: 1895, apr: 22.49 },
    { n: 3, name: "Chase Sapphire", balance: 987, apr: 19.99 },
  ];
  return (
    <div
      className={`rounded-2xl p-7 ${cardShadow}`}
      style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}
    >
      <div className="flex items-baseline justify-between mb-1">
        <h3
          style={{
            ...fraunces,
            color: INK,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          Kill order
        </h3>
        <span style={{ ...inter, color: ACCENT, fontSize: 12, fontWeight: 500 }}>
          Avalanche →
        </span>
      </div>
      <div style={{ ...inter, color: MUTED, fontSize: 12 }} className="mb-2">
        Highest APR first · next payment{" "}
        <span style={{ color: INK, fontWeight: 500 }}>$450</span> due Apr 28
      </div>

      <div className="mt-3">
        {debts.map((d, i) => (
          <div
            key={d.name}
            className="flex items-center gap-5 py-4"
            style={{
              borderBottom:
                i < debts.length - 1 ? `1px solid ${BORDER}` : "none",
            }}
          >
            <div
              className="w-10 text-right"
              style={{
                ...fraunces,
                color: i === 0 ? ACCENT : MUTED,
                fontSize: 28,
                fontWeight: 500,
                fontStyle: i === 0 ? "italic" : "normal",
                lineHeight: 1,
              }}
            >
              {d.n}
            </div>
            <div className="flex-1">
              <div style={{ ...inter, color: INK, fontSize: 14, fontWeight: 500 }}>
                {d.name}
              </div>
              <div style={{ ...inter, color: MUTED, fontSize: 12 }}>
                {d.apr.toFixed(2)}% APR
              </div>
            </div>
            <div
              style={{
                ...fraunces,
                color: INK,
                fontSize: 20,
                fontWeight: 500,
              }}
              className="tabular-nums"
            >
              ${d.balance.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <div
        className="mt-5 pt-4 flex items-center justify-between"
        style={{ borderTop: `1px solid ${BORDER}` }}
      >
        <span style={{ ...inter, color: SECONDARY, fontSize: 12 }}>
          Total revolving debt
        </span>
        <span
          style={{ ...fraunces, color: INK, fontSize: 22, fontWeight: 500 }}
          className="tabular-nums"
        >
          $7,092
        </span>
      </div>
    </div>
  );
}

function AmexCard() {
  const stmt = 2847.32;
  const planned = 1500;
  const projected = 1347;
  const pct = (planned / stmt) * 100;
  return (
    <div
      className={`rounded-2xl p-7 ${cardShadow}`}
      style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}
    >
      <div className="flex items-baseline justify-between mb-1">
        <h3
          style={{
            ...fraunces,
            color: INK,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          Amex Gold pay-down
        </h3>
        <span style={{ ...inter, color: MUTED, fontSize: 11.5 }}>
          Due May 15
        </span>
      </div>
      <div style={{ ...inter, color: MUTED, fontSize: 12 }}>
        Statement closes Apr 30
      </div>

      <div className="mt-6 grid grid-cols-3 gap-4">
        <div>
          <div
            style={{ ...inter, color: MUTED, fontSize: 10.5, letterSpacing: 1.2 }}
            className="uppercase mb-1.5"
          >
            Statement
          </div>
          <div
            style={{ ...fraunces, color: INK, fontSize: 22, fontWeight: 500 }}
            className="tabular-nums"
          >
            $2,847
          </div>
        </div>
        <div>
          <div
            style={{ ...inter, color: MUTED, fontSize: 10.5, letterSpacing: 1.2 }}
            className="uppercase mb-1.5"
          >
            Planned
          </div>
          <div
            style={{
              ...fraunces,
              color: ACCENT,
              fontSize: 22,
              fontWeight: 500,
            }}
            className="tabular-nums"
          >
            $1,500
          </div>
        </div>
        <div>
          <div
            style={{ ...inter, color: MUTED, fontSize: 10.5, letterSpacing: 1.2 }}
            className="uppercase mb-1.5"
          >
            Projected EOM
          </div>
          <div
            style={{
              ...fraunces,
              color: POSITIVE,
              fontSize: 22,
              fontWeight: 500,
            }}
            className="tabular-nums"
          >
            $1,347
          </div>
        </div>
      </div>

      <div className="mt-6">
        <div
          className="h-2 rounded-full overflow-hidden"
          style={{ background: "#EFE6D2" }}
        >
          <div
            style={{
              width: `${pct}%`,
              background: ACCENT,
              height: "100%",
            }}
          />
        </div>
        <div
          className="mt-2 flex justify-between"
          style={{ ...inter, color: MUTED, fontSize: 11.5 }}
        >
          <span>53% of statement covered</span>
          <span style={{ color: SECONDARY }}>
            $1,347 carries to May
          </span>
        </div>
      </div>

      <button
        className="mt-6 w-full h-10 rounded-[10px] flex items-center justify-center gap-2"
        style={{
          background: ACCENT,
          color: "#FFFDF8",
          ...inter,
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        Schedule $1,500 payment
      </button>
    </div>
  );
}

function BucketHealthCard() {
  const buckets = [
    { code: "WK", label: "Weekly groceries / gas", spent: 843, cap: 1200 },
    { code: "MO", label: "Monthly bills", spent: 2310, cap: 2800 },
    { code: "UN", label: "Unbudgeted", spent: 612, cap: 400 },
  ];
  return (
    <div
      className={`rounded-2xl p-7 ${cardShadow}`}
      style={{ background: CARD_BG, border: `1px solid ${BORDER}` }}
    >
      <div className="flex items-baseline justify-between mb-1">
        <h3
          style={{
            ...fraunces,
            color: INK,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          Weekly bucket health
        </h3>
        <span style={{ ...inter, color: ACCENT, fontSize: 12, fontWeight: 500 }}>
          Open buckets →
        </span>
      </div>
      <div style={{ ...inter, color: MUTED, fontSize: 12 }} className="mb-5">
        Three rolling buckets · week 3 of 4
      </div>

      <div className="space-y-4">
        {buckets.map((b) => {
          const over = b.spent > b.cap;
          const pct = Math.min(100, (b.spent / b.cap) * 100);
          return (
            <div key={b.code}>
              <div className="flex items-baseline justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className="px-2 py-0.5 rounded-md"
                    style={{
                      ...inter,
                      fontSize: 10,
                      letterSpacing: 1.2,
                      fontWeight: 600,
                      color: over ? NEGATIVE : ACCENT,
                      border: `1px solid ${over ? NEGATIVE : ACCENT}`,
                      background: "transparent",
                    }}
                  >
                    {b.code}
                  </span>
                  <span style={{ ...inter, color: INK, fontSize: 13 }}>
                    {b.label}
                  </span>
                </div>
                <div
                  style={{
                    ...fraunces,
                    fontSize: 14,
                    fontWeight: 500,
                    color: over ? NEGATIVE : INK,
                  }}
                  className="tabular-nums"
                >
                  ${b.spent.toLocaleString()}{" "}
                  <span style={{ color: MUTED, fontWeight: 400 }}>
                    / ${b.cap.toLocaleString()}
                  </span>
                </div>
              </div>
              <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{ background: "#EFE6D2" }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: over ? NEGATIVE : INK,
                  }}
                />
              </div>
              {over && (
                <div
                  className="mt-1.5"
                  style={{ ...inter, color: NEGATIVE, fontSize: 11.5 }}
                >
                  ${b.spent - b.cap} over · review on Amex page
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function EditorialWarm() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin=""
      />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap"
      />
      <div
        className="min-h-screen w-full flex"
        style={{ background: PAGE_BG, ...inter, color: INK }}
      >
        <Sidebar />
        <main className="flex-1 min-w-0 px-12 py-10" style={{ maxWidth: 1240 }}>
          <Header />

          {/* KPI row */}
          <div className="grid grid-cols-4 gap-5 mb-8">
            <Kpi
              label="Net income · April"
              value="$8,420"
              sub="Projected"
              trend="2.1%"
              positive
            />
            <Kpi
              label="Spent so far"
              value="$5,217"
              sub="62% of target"
              trend="On pace"
              positive
            />
            <Kpi
              label="Remaining"
              value="$3,203"
              sub="10 days left"
            />
            <Kpi
              label="Revolving debt"
              value="$7,092"
              sub="3 cards · avalanche"
              trend="−$612"
              positive
            />
          </div>

          {/* Headline */}
          <div className="mb-8">
            <HeadlinePanel />
          </div>

          {/* 2-col: accounts + kill order */}
          <div className="grid grid-cols-2 gap-6 mb-8">
            <AccountsCard />
            <KillOrderCard />
          </div>

          {/* Bottom row: Amex + bucket health */}
          <div className="grid grid-cols-2 gap-6 mb-12">
            <AmexCard />
            <BucketHealthCard />
          </div>

          <footer
            className="pt-6 flex items-center justify-between"
            style={{ borderTop: `1px solid ${BORDER}`, color: MUTED, fontSize: 11.5 }}
          >
            <span>H2 Family Budget · v37 — editorial</span>
            <span className="inline-flex items-center gap-2">
              <Circle className="w-2 h-2 fill-current" />
              Synced 8:14am · Plaid healthy
            </span>
          </footer>
        </main>
      </div>
    </>
  );
}
