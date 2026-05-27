import { useEffect } from "react";
import {
  ArrowUpRight,
  ArrowDownRight,
  Info,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Search,
  Command,
  ChevronDown,
  Check,
} from "lucide-react";

const HAIRLINE = "rgba(0,0,0,0.07)";
const HAIRLINE_STRONG = "rgba(0,0,0,0.12)";
const INK = "#0A0A0A";
const INK_SOFT = "#404040";
const MUTED = "#737373";
const FAINT = "#A3A3A3";
const BG = "#FAFAF9";
const SURFACE = "#FFFFFF";
const SURFACE_ALT = "#F5F5F4";
const ACCENT = "#1E3A8A";
const ACCENT_DEEP = "#0F172A";

const fontStack =
  "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const monoStack =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

function useInterFont() {
  useEffect(() => {
    const id = "fm-inter-font";
    if (document.getElementById(id)) return;
    const pre1 = document.createElement("link");
    pre1.rel = "preconnect";
    pre1.href = "https://fonts.googleapis.com";
    const pre2 = document.createElement("link");
    pre2.rel = "preconnect";
    pre2.href = "https://fonts.gstatic.com";
    pre2.crossOrigin = "anonymous";
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.append(pre1, pre2, link);
  }, []);
}

const swatches: { hex: string; name: string; ink?: boolean }[] = [
  { hex: "#FAFAF9", name: "Canvas" },
  { hex: "#F5F5F4", name: "Surface" },
  { hex: "#E7E5E4", name: "Hairline" },
  { hex: "#737373", name: "Muted", ink: true },
  { hex: "#0A0A0A", name: "Ink", ink: true },
  { hex: "#1E3A8A", name: "Cobalt", ink: true },
  { hex: "#0F172A", name: "Navy", ink: true },
  { hex: "#047857", name: "Success", ink: true },
];

const transactions = [
  {
    date: "Nov 14",
    merchant: "Whole Foods Market",
    category: "Groceries",
    account: "Chase ••4471",
    amount: -184.22,
  },
  {
    date: "Nov 13",
    merchant: "Uplift Payroll — Hubele LLC",
    category: "Income",
    account: "Chase ••4471",
    amount: 4280.00,
  },
  {
    date: "Nov 12",
    merchant: "Pacific Gas & Electric",
    category: "Utilities",
    account: "Amex ••1008",
    amount: -142.67,
  },
  {
    date: "Nov 11",
    merchant: "Bartaco — Madison",
    category: "Dining",
    account: "Amex ••1008",
    amount: -68.40,
  },
  {
    date: "Nov 10",
    merchant: "Vanguard Brokerage",
    category: "Transfer",
    account: "Vanguard ••2210",
    amount: -1500.00,
  },
  {
    date: "Nov 09",
    merchant: "Spotify Family",
    category: "Subscriptions",
    account: "Amex ••1008",
    amount: -16.99,
  },
];

const chips = [
  { label: "Groceries", dot: "#0F766E" },
  { label: "Dining", dot: "#B45309" },
  { label: "Subscriptions", dot: "#7C3AED" },
  { label: "Utilities", dot: "#1E3A8A" },
  { label: "Transport", dot: "#0E7490" },
  { label: "Income", dot: "#047857" },
];

function Sparkline({
  points,
  stroke = ACCENT,
  width = 280,
  height = 64,
}: {
  points: number[];
  stroke?: string;
  width?: number;
  height?: number;
}) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const d = points
    .map((p, i) => {
      const x = i * step;
      const y = height - ((p - min) / range) * (height - 8) - 4;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const area =
    d +
    ` L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} className="block">
      <defs>
        <linearGradient id="fm-spark" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.14" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#fm-spark)" />
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <rect
          x="0.5"
          y="0.5"
          width="21"
          height="21"
          rx="4"
          fill={ACCENT_DEEP}
        />
        <path
          d="M6 6V16M6 11H12M12 6V16"
          stroke="#FAFAF9"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="16" cy="6.5" r="1.4" fill="#FAFAF9" />
      </svg>
      <span
        className="text-[15px] font-semibold"
        style={{ letterSpacing: "-0.02em", color: INK }}
      >
        H2 Budget
      </span>
      <span
        className="text-[11px] px-1.5 py-[1px] rounded-[4px] ml-1"
        style={{
          border: `1px solid ${HAIRLINE}`,
          color: MUTED,
          letterSpacing: "0.04em",
        }}
      >
        v2.4
      </span>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="px-10 py-14" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-3">
          <div
            className="text-[11px] font-medium uppercase mb-3"
            style={{ color: FAINT, letterSpacing: "0.12em" }}
          >
            {eyebrow}
          </div>
          <h3
            className="text-[20px] font-semibold"
            style={{ color: INK, letterSpacing: "-0.02em" }}
          >
            {title}
          </h3>
          {description && (
            <p
              className="mt-2 text-[13px] leading-[1.55]"
              style={{ color: MUTED }}
            >
              {description}
            </p>
          )}
        </div>
        <div className="col-span-9">{children}</div>
      </div>
    </section>
  );
}

function Btn({
  variant,
  disabled,
  children,
}: {
  variant: "primary" | "secondary" | "ghost" | "destructive";
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 text-[13px] font-medium h-9 px-3.5 rounded-[5px] transition-colors select-none";
  const styles: Record<string, React.CSSProperties> = {
    primary: {
      background: disabled ? "#E5E5E5" : ACCENT_DEEP,
      color: disabled ? FAINT : "#FAFAF9",
      boxShadow: disabled ? "none" : "0 1px 0 rgba(0,0,0,0.04)",
    },
    secondary: {
      background: SURFACE,
      color: disabled ? FAINT : INK,
      border: `1px solid ${disabled ? HAIRLINE : HAIRLINE_STRONG}`,
      boxShadow: disabled ? "none" : "0 1px 0 rgba(0,0,0,0.03)",
    },
    ghost: {
      background: "transparent",
      color: disabled ? FAINT : INK_SOFT,
    },
    destructive: {
      background: disabled ? "#FCE7E7" : "#B91C1C",
      color: disabled ? "#E5A3A3" : "#FAFAF9",
      boxShadow: disabled ? "none" : "0 1px 0 rgba(0,0,0,0.04)",
    },
  };
  return (
    <button
      className={base}
      style={{
        ...styles[variant],
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.8 : 1,
      }}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function FintechMinimal() {
  useInterFont();

  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: BG,
        color: INK,
        fontFamily: fontStack,
        fontFeatureSettings: '"cv11","ss01","ss03"',
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {/* HEADER */}
      <header
        className="sticky top-0 z-10"
        style={{
          background: "rgba(250,250,249,0.85)",
          backdropFilter: "saturate(180%) blur(8px)",
          borderBottom: `1px solid ${HAIRLINE}`,
        }}
      >
        <div className="px-10 h-14 flex items-center justify-between">
          <div className="flex items-center gap-10">
            <Wordmark />
            <nav className="flex items-center gap-1">
              {[
                { label: "Overview", active: true },
                { label: "Transactions" },
                { label: "Budget" },
                { label: "Reports" },
              ].map((n) => (
                <a
                  key={n.label}
                  className="px-2.5 py-1.5 rounded-[4px] text-[13px]"
                  style={{
                    color: n.active ? INK : MUTED,
                    fontWeight: n.active ? 500 : 400,
                    background: n.active ? "rgba(15,23,42,0.04)" : "transparent",
                  }}
                >
                  {n.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div
              className="flex items-center gap-2 h-8 px-2.5 rounded-[5px] text-[12px]"
              style={{
                border: `1px solid ${HAIRLINE}`,
                background: SURFACE,
                color: MUTED,
                width: 240,
              }}
            >
              <Search size={13} strokeWidth={1.75} />
              <span>Search merchants, accounts…</span>
              <span className="ml-auto flex items-center gap-0.5 text-[10px]">
                <span
                  className="px-1 h-4 inline-flex items-center rounded-[3px]"
                  style={{ border: `1px solid ${HAIRLINE}`, color: FAINT }}
                >
                  <Command size={9} />
                </span>
                <span
                  className="px-1 h-4 inline-flex items-center rounded-[3px]"
                  style={{ border: `1px solid ${HAIRLINE}`, color: FAINT }}
                >
                  K
                </span>
              </span>
            </div>
            <button
              className="h-8 px-3 rounded-[5px] text-[13px] font-medium"
              style={{
                background: ACCENT_DEEP,
                color: "#FAFAF9",
                boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
              }}
            >
              Link account
            </button>
          </div>
        </div>
      </header>

      {/* TITLE */}
      <div className="px-10 pt-20 pb-16">
        <div
          className="text-[11px] font-medium uppercase mb-5 inline-flex items-center gap-2"
          style={{ color: FAINT, letterSpacing: "0.14em" }}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: ACCENT }}
          />
          Foundations · 02
        </div>
        <h1
          className="text-[68px] leading-[1.02] font-semibold max-w-[820px]"
          style={{ color: INK, letterSpacing: "-0.035em" }}
        >
          Design System.
          <br />
          <span style={{ color: FAINT }}>
            Visual language for H2 Family Budget.
          </span>
        </h1>
        <p
          className="mt-7 max-w-[640px] text-[15px] leading-[1.6]"
          style={{ color: INK_SOFT }}
        >
          A precise, neutral interface system tuned for personal finance —
          tabular numerals, hairline rules, and a single restrained accent.
          Designed for clarity at a glance and trust over time.
        </p>
        <div className="mt-8 flex items-center gap-6 text-[12px]" style={{ color: MUTED }}>
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: "#047857" }}
            />
            Live build · v2.4.0
          </div>
          <div>Updated 14 Nov 2025</div>
          <div>Maintained by H2 Studio</div>
        </div>
      </div>

      {/* PALETTE */}
      <Section
        eyebrow="01 · Color"
        title="Palette"
        description="A near-neutral canvas with a single restrained accent. Color is reserved for state and emphasis — not decoration."
      >
        <div className="grid grid-cols-4 gap-px" style={{ background: HAIRLINE, border: `1px solid ${HAIRLINE}` }}>
          {swatches.map((s) => (
            <div
              key={s.hex}
              className="p-4 flex flex-col justify-between"
              style={{ background: s.hex, minHeight: 140 }}
            >
              <div
                className="text-[11px] font-medium uppercase"
                style={{
                  color: s.ink ? "rgba(250,250,249,0.7)" : MUTED,
                  letterSpacing: "0.1em",
                }}
              >
                {s.name}
              </div>
              <div
                className="text-[13px]"
                style={{
                  color: s.ink ? "#FAFAF9" : INK,
                  fontFamily: monoStack,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {s.hex}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* TYPOGRAPHY */}
      <Section
        eyebrow="02 · Typography"
        title="Type specimen"
        description="Inter across the stack with tight tracking on display sizes. Numerals always tabular for alignment in tables and ledgers."
      >
        <div className="divide-y" style={{ borderTop: `1px solid ${HAIRLINE}`, borderBottom: `1px solid ${HAIRLINE}` }}>
          {[
            {
              label: "Display / 64 · 600 · -0.035em",
              cls: "text-[64px] leading-[1.02] font-semibold",
              ls: "-0.035em",
              text: "$24,318.40",
              tab: true,
            },
            {
              label: "H1 / 40 · 600 · -0.025em",
              cls: "text-[40px] leading-[1.1] font-semibold",
              ls: "-0.025em",
              text: "November cash flow",
            },
            {
              label: "H2 / 28 · 600 · -0.02em",
              cls: "text-[28px] leading-[1.2] font-semibold",
              ls: "-0.02em",
              text: "Discretionary spending",
            },
            {
              label: "H3 / 18 · 600 · -0.01em",
              cls: "text-[18px] leading-[1.3] font-semibold",
              ls: "-0.01em",
              text: "Recurring subscriptions",
            },
            {
              label: "Body / 15 · 400",
              cls: "text-[15px] leading-[1.6]",
              ls: "0",
              text:
                "Track every household transaction with a calm, precise interface that puts numbers first.",
            },
            {
              label: "Small / 13 · 400",
              cls: "text-[13px] leading-[1.55]",
              ls: "0",
              text: "Reconciled with Chase ••4471 · last synced 3 minutes ago.",
            },
            {
              label: "Caption / 11 · 500 · uppercase · 0.12em",
              cls: "text-[11px] font-medium uppercase",
              ls: "0.12em",
              text: "Statement period",
              muted: true,
            },
          ].map((row) => (
            <div key={row.label} className="grid grid-cols-12 gap-6 py-6">
              <div
                className="col-span-3 text-[11px] font-medium uppercase pt-2"
                style={{ color: FAINT, letterSpacing: "0.1em", fontFamily: monoStack }}
              >
                {row.label}
              </div>
              <div
                className={`col-span-9 ${row.cls}`}
                style={{
                  letterSpacing: row.ls,
                  color: row.muted ? MUTED : INK,
                  fontVariantNumeric: row.tab ? "tabular-nums" : "normal",
                }}
              >
                {row.text}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* HERO BALANCE */}
      <Section
        eyebrow="03 · Data display"
        title="Hero figure"
        description="Anchor metric for a dashboard. Large display numeral, supporting delta, and a quiet sparkline for shape."
      >
        <div
          className="grid grid-cols-12 gap-px rounded-[6px] overflow-hidden"
          style={{
            background: HAIRLINE,
            border: `1px solid ${HAIRLINE}`,
            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
          }}
        >
          <div className="col-span-7 p-8" style={{ background: SURFACE }}>
            <div
              className="text-[11px] font-medium uppercase"
              style={{ color: FAINT, letterSpacing: "0.12em" }}
            >
              Net worth · all accounts
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <div
                className="text-[64px] leading-none font-semibold"
                style={{
                  color: INK,
                  letterSpacing: "-0.035em",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                $24,318.40
              </div>
              <div
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] text-[12px] font-medium"
                style={{
                  background: "rgba(4,120,87,0.08)",
                  color: "#047857",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <ArrowUpRight size={12} strokeWidth={2} />
                +2.4% MoM
              </div>
            </div>
            <div
              className="mt-1.5 text-[13px]"
              style={{ color: MUTED, fontVariantNumeric: "tabular-nums" }}
            >
              +$574.18 since 14 Oct · target $25,000 by 31 Dec
            </div>

            <div className="mt-8">
              <Sparkline
                points={[
                  22.1, 22.4, 22.0, 22.6, 23.0, 22.7, 23.2, 23.6, 23.4, 23.9,
                  24.0, 23.7, 24.1, 24.3,
                ]}
                width={520}
                height={88}
              />
              <div
                className="mt-2 flex justify-between text-[10px] uppercase"
                style={{ color: FAINT, letterSpacing: "0.1em" }}
              >
                <span>Oct 31</span>
                <span>Nov 07</span>
                <span>Nov 14</span>
              </div>
            </div>
          </div>
          <div className="col-span-5 grid grid-rows-3">
            {[
              {
                label: "Checking",
                value: "$8,412.09",
                sub: "Chase ••4471",
                delta: "+$284.10",
                up: true,
              },
              {
                label: "Savings",
                value: "$11,206.31",
                sub: "Ally ••0921",
                delta: "+$300.00",
                up: true,
              },
              {
                label: "Credit",
                value: "−$1,842.55",
                sub: "Amex ••1008",
                delta: "−$112.42",
                up: false,
              },
            ].map((m) => (
              <div
                key={m.label}
                className="p-6 flex items-center justify-between"
                style={{ background: SURFACE }}
              >
                <div>
                  <div
                    className="text-[11px] font-medium uppercase"
                    style={{ color: FAINT, letterSpacing: "0.12em" }}
                  >
                    {m.label}
                  </div>
                  <div
                    className="mt-1 text-[22px] font-semibold"
                    style={{
                      color: INK,
                      letterSpacing: "-0.02em",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {m.value}
                  </div>
                  <div className="mt-0.5 text-[12px]" style={{ color: MUTED }}>
                    {m.sub}
                  </div>
                </div>
                <div
                  className="inline-flex items-center gap-0.5 text-[12px] font-medium"
                  style={{
                    color: m.up ? "#047857" : "#B91C1C",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {m.up ? (
                    <ArrowUpRight size={13} strokeWidth={2} />
                  ) : (
                    <ArrowDownRight size={13} strokeWidth={2} />
                  )}
                  {m.delta}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* TABLE */}
      <Section
        eyebrow="04 · Tables"
        title="Recent transactions"
        description="Dense but breathable. Hairline rules, tabular numerals, right-aligned currency, and a quiet category dot."
      >
        <div
          className="rounded-[6px] overflow-hidden"
          style={{
            border: `1px solid ${HAIRLINE}`,
            background: SURFACE,
            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
          }}
        >
          <div
            className="grid items-center text-[11px] font-medium uppercase px-5 h-10"
            style={{
              gridTemplateColumns: "92px 1.6fr 1fr 1fr 140px",
              color: FAINT,
              letterSpacing: "0.1em",
              borderBottom: `1px solid ${HAIRLINE}`,
              background: SURFACE_ALT,
            }}
          >
            <div>Date</div>
            <div>Merchant</div>
            <div>Category</div>
            <div>Account</div>
            <div className="text-right">Amount</div>
          </div>
          {transactions.map((t, i) => (
            <div
              key={i}
              className="grid items-center px-5 h-[52px] text-[13px]"
              style={{
                gridTemplateColumns: "92px 1.6fr 1fr 1fr 140px",
                borderBottom:
                  i === transactions.length - 1
                    ? "none"
                    : `1px solid ${HAIRLINE}`,
                color: INK_SOFT,
              }}
            >
              <div
                style={{
                  color: MUTED,
                  fontFamily: monoStack,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 12,
                }}
              >
                {t.date}
              </div>
              <div style={{ color: INK, fontWeight: 500 }}>{t.merchant}</div>
              <div>
                <span
                  className="inline-flex items-center gap-1.5 text-[12px]"
                  style={{ color: INK_SOFT }}
                >
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
                    style={{
                      background:
                        chips.find((c) => c.label === t.category)?.dot ||
                        MUTED,
                    }}
                  />
                  {t.category}
                </span>
              </div>
              <div style={{ color: MUTED, fontSize: 12 }}>{t.account}</div>
              <div
                className="text-right"
                style={{
                  color: t.amount > 0 ? "#047857" : INK,
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 500,
                }}
              >
                {t.amount > 0 ? "+" : "−"}$
                {Math.abs(t.amount)
                  .toFixed(2)
                  .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* FORM */}
      <Section
        eyebrow="05 · Forms"
        title="Inputs & controls"
        description="Inputs sit on the surface with a hairline border. Focus is communicated with a single-pixel cobalt ring."
      >
        <div
          className="rounded-[6px] p-8"
          style={{
            border: `1px solid ${HAIRLINE}`,
            background: SURFACE,
            boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
          }}
        >
          <div className="grid grid-cols-2 gap-6">
            <div>
              <label
                className="block text-[12px] font-medium mb-1.5"
                style={{ color: INK }}
              >
                Email
              </label>
              <input
                type="email"
                defaultValue="brad@hubele.family"
                className="w-full h-10 px-3 text-[14px] rounded-[5px] outline-none"
                style={{
                  border: `1px solid ${HAIRLINE_STRONG}`,
                  background: SURFACE,
                  color: INK,
                  fontFamily: fontStack,
                }}
              />
              <div className="mt-1.5 text-[12px]" style={{ color: MUTED }}>
                Used for statement delivery and invite reminders.
              </div>
            </div>
            <div>
              <label
                className="block text-[12px] font-medium mb-1.5"
                style={{ color: INK }}
              >
                Amount
              </label>
              <div
                className="flex items-center h-10 rounded-[5px]"
                style={{
                  border: `1px solid ${HAIRLINE_STRONG}`,
                  background: SURFACE,
                }}
              >
                <span
                  className="px-3 h-full inline-flex items-center text-[14px]"
                  style={{
                    color: MUTED,
                    borderRight: `1px solid ${HAIRLINE}`,
                  }}
                >
                  USD
                </span>
                <input
                  defaultValue="1,500.00"
                  className="flex-1 h-full px-3 text-[14px] outline-none bg-transparent text-right"
                  style={{
                    color: INK,
                    fontVariantNumeric: "tabular-nums",
                    fontFamily: monoStack,
                  }}
                />
              </div>
              <div className="mt-1.5 text-[12px]" style={{ color: MUTED }}>
                Monthly transfer to Vanguard brokerage on the 1st.
              </div>
            </div>

            <div>
              <label
                className="block text-[12px] font-medium mb-1.5"
                style={{ color: INK }}
              >
                Category
              </label>
              <div
                className="flex items-center justify-between h-10 px-3 rounded-[5px] text-[14px]"
                style={{
                  border: `1px solid ${HAIRLINE_STRONG}`,
                  background: SURFACE,
                  color: INK,
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
                    style={{ background: "#0F766E" }}
                  />
                  Groceries
                </span>
                <ChevronDown size={14} color={MUTED} />
              </div>
              <div className="mt-1.5 text-[12px]" style={{ color: MUTED }}>
                Auto-tagged from merchant history. Override anytime.
              </div>
            </div>
            <div>
              <label
                className="block text-[12px] font-medium mb-1.5"
                style={{ color: INK }}
              >
                Frequency
              </label>
              <div
                className="flex items-center rounded-[5px] overflow-hidden text-[13px]"
                style={{ border: `1px solid ${HAIRLINE_STRONG}` }}
              >
                {["Once", "Weekly", "Monthly", "Yearly"].map((f, i) => (
                  <div
                    key={f}
                    className="flex-1 h-10 inline-flex items-center justify-center"
                    style={{
                      background: f === "Monthly" ? "rgba(15,23,42,0.04)" : SURFACE,
                      color: f === "Monthly" ? INK : MUTED,
                      fontWeight: f === "Monthly" ? 500 : 400,
                      borderLeft: i === 0 ? "none" : `1px solid ${HAIRLINE}`,
                    }}
                  >
                    {f}
                  </div>
                ))}
              </div>
              <div className="mt-1.5 text-[12px]" style={{ color: MUTED }}>
                Controls how often the rule applies to incoming transactions.
              </div>
            </div>
          </div>

          <div
            className="mt-8 pt-6 flex items-start gap-3"
            style={{ borderTop: `1px solid ${HAIRLINE}` }}
          >
            <div
              className="mt-[2px] w-4 h-4 rounded-[4px] inline-flex items-center justify-center"
              style={{ background: ACCENT_DEEP }}
            >
              <Check size={11} color="#FAFAF9" strokeWidth={3} />
            </div>
            <div>
              <div className="text-[13px] font-medium" style={{ color: INK }}>
                Apply rule to historical transactions
              </div>
              <div className="mt-0.5 text-[12px]" style={{ color: MUTED }}>
                We'll re-categorize 138 matching transactions from the last 90
                days. You can undo this from the activity log within 24 hours.
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* BUTTONS */}
      <Section
        eyebrow="06 · Buttons"
        title="Action gallery"
        description="Four roles, two states. Primary uses navy ink; destructive is the only saturated color in the system."
      >
        <div
          className="grid grid-cols-4 gap-px"
          style={{
            background: HAIRLINE,
            border: `1px solid ${HAIRLINE}`,
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {(
            [
              ["Primary", "primary"],
              ["Secondary", "secondary"],
              ["Ghost", "ghost"],
              ["Destructive", "destructive"],
            ] as const
          ).map(([label, v]) => (
            <div
              key={label}
              className="p-6 flex flex-col gap-4"
              style={{ background: SURFACE }}
            >
              <div
                className="text-[11px] font-medium uppercase"
                style={{ color: FAINT, letterSpacing: "0.12em" }}
              >
                {label}
              </div>
              <Btn variant={v}>
                {v === "destructive" ? "Delete rule" : "Save changes"}
              </Btn>
              <Btn variant={v} disabled>
                Disabled
              </Btn>
            </div>
          ))}
        </div>
      </Section>

      {/* CHIPS */}
      <Section
        eyebrow="07 · Tags"
        title="Category chips"
        description="A quiet dot carries category identity. Chips themselves stay neutral so they don't compete with the data."
      >
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <div
              key={c.label}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[4px] text-[12px]"
              style={{
                background: SURFACE,
                border: `1px solid ${HAIRLINE}`,
                color: INK_SOFT,
              }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: c.dot }}
              />
              {c.label}
            </div>
          ))}
          <div
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[4px] text-[12px]"
            style={{
              background: ACCENT_DEEP,
              color: "#FAFAF9",
            }}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: "#FAFAF9" }}
            />
            All categories
          </div>
        </div>
      </Section>

      {/* ALERTS */}
      <Section
        eyebrow="08 · Feedback"
        title="System alerts"
        description="Inline banners with a single accent stripe. Tone is conveyed by a small icon, not by saturating the whole surface."
      >
        <div className="flex flex-col gap-3">
          {[
            {
              tone: "info",
              icon: <Info size={14} />,
              color: ACCENT,
              title: "Plaid will rotate access tokens on Nov 28.",
              body: "No action required — H2 will refresh credentials automatically.",
            },
            {
              tone: "success",
              icon: <CheckCircle2 size={14} />,
              color: "#047857",
              title: "October statement reconciled.",
              body: "138 transactions matched across 4 accounts with no exceptions.",
            },
            {
              tone: "warning",
              icon: <AlertTriangle size={14} />,
              color: "#B45309",
              title: "Discretionary spend trending 14% above plan.",
              body: "Dining and Subscriptions are the largest contributors this cycle.",
            },
            {
              tone: "destructive",
              icon: <XCircle size={14} />,
              color: "#B91C1C",
              title: "Chase ••4471 needs re-authentication.",
              body: "Sync paused since Nov 12, 09:41 UTC. Re-link to resume.",
            },
          ].map((a) => (
            <div
              key={a.tone}
              className="flex items-start gap-3 p-4 rounded-[5px]"
              style={{
                background: SURFACE,
                border: `1px solid ${HAIRLINE}`,
                borderLeft: `2px solid ${a.color}`,
                boxShadow: "0 1px 0 rgba(0,0,0,0.03)",
              }}
            >
              <div
                className="mt-[2px] inline-flex items-center justify-center w-5 h-5 rounded-full"
                style={{ color: a.color }}
              >
                {a.icon}
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-medium" style={{ color: INK }}>
                  {a.title}
                </div>
                <div className="mt-0.5 text-[12px]" style={{ color: MUTED }}>
                  {a.body}
                </div>
              </div>
              <button
                className="text-[12px] font-medium h-7 px-2.5 rounded-[4px]"
                style={{
                  color: INK,
                  border: `1px solid ${HAIRLINE_STRONG}`,
                  background: SURFACE,
                }}
              >
                {a.tone === "destructive" ? "Re-link" : "Dismiss"}
              </button>
            </div>
          ))}
        </div>
      </Section>

      {/* FOOTER */}
      <footer
        className="px-10 py-10 flex items-center justify-between"
        style={{ borderTop: `1px solid ${HAIRLINE}`, color: MUTED }}
      >
        <div className="flex items-center gap-3 text-[12px]">
          <Wordmark />
          <span className="opacity-60">·</span>
          <span>Design system · Fintech Minimal</span>
        </div>
        <div
          className="text-[12px]"
          style={{ fontFamily: monoStack, fontVariantNumeric: "tabular-nums" }}
        >
          build 2.4.0 · 2025.11.14
        </div>
      </footer>
    </div>
  );
}

export default FintechMinimal;
