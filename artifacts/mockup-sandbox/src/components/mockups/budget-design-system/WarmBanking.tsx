import { useEffect } from "react";
import {
  ArrowUpRight,
  Info,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  Check,
  Search,
  Bell,
} from "lucide-react";

const tokens = {
  cream: "#FAF6F0",
  creamDeep: "#F7F2EA",
  ink: "#0F2E2E",
  inkSoft: "#2A4544",
  muted: "#6B6357",
  brass: "#B08D57",
  brassDeep: "#8E6E3F",
  terracotta: "#A0522D",
  hairline: "#E8DFD3",
  paper: "#FFFFFF",
  sage: "#3F5E4E",
  amber: "#C18A2B",
  rose: "#9C3B2E",
  ivoryChip: "#F1E9DA",
  serif: "'Fraunces', 'Source Serif Pro', Georgia, serif",
  sans: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
  shadow: "0 1px 2px rgba(101, 67, 33, 0.06), 0 0 0 1px rgba(101,67,33,0.04)",
  shadowLg: "0 6px 24px -10px rgba(101, 67, 33, 0.18), 0 1px 2px rgba(101, 67, 33, 0.06)",
};

function Swatch({ name, hex, dark = false }: { name: string; hex: string; dark?: boolean }) {
  return (
    <div
      style={{
        border: `1px solid ${tokens.hairline}`,
        borderRadius: 10,
        background: tokens.paper,
        overflow: "hidden",
        boxShadow: tokens.shadow,
      }}
    >
      <div style={{ background: hex, height: 92 }} />
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontFamily: tokens.sans, fontSize: 12, color: tokens.ink, fontWeight: 500, letterSpacing: 0.2 }}>
          {name}
        </span>
        <span style={{ fontFamily: tokens.sans, fontSize: 11, color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>
          {hex.toUpperCase()}
        </span>
      </div>
    </div>
  );
}

function Sparkline() {
  const points = [40, 36, 42, 38, 46, 44, 52, 48, 56, 54, 62, 58, 66, 72, 68, 78];
  const max = Math.max(...points);
  const min = Math.min(...points);
  const w = 240;
  const h = 56;
  const step = w / (points.length - 1);
  const d = points
    .map((p, i) => {
      const x = i * step;
      const y = h - ((p - min) / (max - min)) * (h - 8) - 4;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={tokens.brass} stopOpacity="0.18" />
          <stop offset="100%" stopColor={tokens.brass} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="url(#sparkFill)" />
      <path d={d} fill="none" stroke={tokens.brass} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Monogram() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32">
      <rect x="0.5" y="0.5" width="31" height="31" rx="6" fill={tokens.ink} />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="Fraunces, Georgia, serif"
        fontSize="16"
        fontWeight="600"
        fill={tokens.cream}
      >
        H
      </text>
      <circle cx="23" cy="9" r="2" fill={tokens.brass} />
    </svg>
  );
}

type BtnVariant = "primary" | "secondary" | "ghost" | "destructive";
function Btn({
  variant,
  disabled,
  children,
}: {
  variant: BtnVariant;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const base: React.CSSProperties = {
    fontFamily: tokens.sans,
    fontSize: 13,
    fontWeight: 500,
    letterSpacing: 0.1,
    padding: "10px 18px",
    borderRadius: 8,
    border: "1px solid transparent",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    transition: "all 120ms ease",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  };
  const styles: Record<BtnVariant, React.CSSProperties> = {
    primary: { background: tokens.ink, color: tokens.cream, boxShadow: tokens.shadow },
    secondary: {
      background: tokens.paper,
      color: tokens.ink,
      borderColor: tokens.hairline,
      boxShadow: tokens.shadow,
    },
    ghost: { background: "transparent", color: tokens.ink },
    destructive: { background: tokens.rose, color: "#FBF3EF" },
  };
  return <button style={{ ...base, ...styles[variant] }}>{children}</button>;
}

function Chip({ label, dotColor }: { label: string; dotColor: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px 6px 10px",
        background: tokens.paper,
        border: `1px solid ${tokens.hairline}`,
        borderRadius: 999,
        fontFamily: tokens.sans,
        fontSize: 12,
        color: tokens.inkSoft,
        letterSpacing: 0.2,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: dotColor }} />
      {label}
    </span>
  );
}

function Alert({
  tone,
  title,
  body,
  Icon,
}: {
  tone: "info" | "success" | "warning" | "destructive";
  title: string;
  body: string;
  Icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
}) {
  const palette = {
    info: { bg: "#F1EEE6", bar: tokens.inkSoft, icon: tokens.inkSoft },
    success: { bg: "#EEF1EB", bar: tokens.sage, icon: tokens.sage },
    warning: { bg: "#F5EDDA", bar: tokens.amber, icon: tokens.amber },
    destructive: { bg: "#F3E4DE", bar: tokens.rose, icon: tokens.rose },
  }[tone];
  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        padding: "14px 16px",
        borderRadius: 10,
        background: palette.bg,
        borderLeft: `3px solid ${palette.bar}`,
        border: `1px solid ${tokens.hairline}`,
        borderLeftWidth: 3,
      }}
    >
      <Icon size={18} color={palette.icon} strokeWidth={1.75} />
      <div>
        <div
          style={{
            fontFamily: tokens.sans,
            fontSize: 13,
            fontWeight: 600,
            color: tokens.ink,
            letterSpacing: 0.1,
          }}
        >
          {title}
        </div>
        <div style={{ fontFamily: tokens.sans, fontSize: 12.5, color: tokens.inkSoft, marginTop: 2, lineHeight: 1.5 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

const txns = [
  { date: "Mar 14", merchant: "Whole Foods Market", category: "Groceries", amount: -184.22 },
  { date: "Mar 13", merchant: "Pacific Northwest Utilities", category: "Bills", amount: -212.55 },
  { date: "Mar 12", merchant: "Patreon — A. Hubele", category: "Subscriptions", amount: -18.00 },
  { date: "Mar 11", merchant: "Direct Deposit — Quarterly", category: "Income", amount: 5420.0 },
  { date: "Mar 10", merchant: "Olmsted & Sons Wine Co.", category: "Dining", amount: -64.75 },
  { date: "Mar 09", merchant: "Vanguard Brokerage Transfer", category: "Investments", amount: -1500.0 },
];

export function WarmBanking() {
  useEffect(() => {
    const id = "warm-banking-fonts";
    if (document.getElementById(id)) return;
    const preconnect1 = document.createElement("link");
    preconnect1.rel = "preconnect";
    preconnect1.href = "https://fonts.googleapis.com";
    const preconnect2 = document.createElement("link");
    preconnect2.rel = "preconnect";
    preconnect2.href = "https://fonts.gstatic.com";
    preconnect2.crossOrigin = "anonymous";
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap";
    document.head.appendChild(preconnect1);
    document.head.appendChild(preconnect2);
    document.head.appendChild(link);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: tokens.cream,
        color: tokens.ink,
        fontFamily: tokens.sans,
      }}
    >
      {/* Header */}
      <header
        style={{
          borderBottom: `1px solid ${tokens.hairline}`,
          background: tokens.cream,
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            padding: "20px 48px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Monogram />
            <span
              style={{
                fontFamily: tokens.serif,
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: 0.5,
                color: tokens.ink,
              }}
            >
              H2 Budget
            </span>
            <span
              style={{
                marginLeft: 10,
                padding: "2px 8px",
                borderRadius: 999,
                border: `1px solid ${tokens.hairline}`,
                background: tokens.paper,
                fontSize: 10.5,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color: tokens.brassDeep,
                fontWeight: 500,
              }}
            >
              Private
            </span>
          </div>
          <nav style={{ display: "flex", gap: 36, alignItems: "center" }}>
            {["Overview", "Accounts", "Budget", "Advisor"].map((l, i) => (
              <a
                key={l}
                href="#"
                style={{
                  fontFamily: tokens.sans,
                  fontSize: 13.5,
                  color: i === 0 ? tokens.ink : tokens.inkSoft,
                  fontWeight: i === 0 ? 600 : 400,
                  letterSpacing: 0.2,
                  textDecoration: "none",
                  borderBottom: i === 0 ? `1px solid ${tokens.brass}` : "none",
                  paddingBottom: 2,
                }}
              >
                {l}
              </a>
            ))}
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                border: `1px solid ${tokens.hairline}`,
                background: tokens.paper,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Search size={15} color={tokens.inkSoft} strokeWidth={1.75} />
            </button>
            <button
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                border: `1px solid ${tokens.hairline}`,
                background: tokens.paper,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Bell size={15} color={tokens.inkSoft} strokeWidth={1.75} />
            </button>
            <Btn variant="primary">
              Open an account <ArrowUpRight size={14} />
            </Btn>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "56px 48px 96px" }}>
        {/* Title */}
        <section style={{ marginBottom: 56 }}>
          <div
            style={{
              fontFamily: tokens.sans,
              fontSize: 11.5,
              letterSpacing: 2.4,
              textTransform: "uppercase",
              color: tokens.brassDeep,
              marginBottom: 18,
              fontWeight: 500,
            }}
          >
            — Volume I · Foundations
          </div>
          <h1
            style={{
              fontFamily: tokens.serif,
              fontSize: 72,
              lineHeight: 1.02,
              fontWeight: 500,
              letterSpacing: -0.5,
              color: tokens.ink,
              margin: 0,
              maxWidth: 880,
            }}
          >
            Design System
          </h1>
          <p
            style={{
              fontFamily: tokens.serif,
              fontStyle: "italic",
              fontSize: 22,
              color: tokens.inkSoft,
              marginTop: 18,
              fontWeight: 400,
              maxWidth: 720,
              lineHeight: 1.45,
            }}
          >
            The visual language for H2 Family Budget — a quiet, considered framework for the
            stewardship of household finances.
          </p>
        </section>

        {/* Color palette */}
        <Section eyebrow="01" title="Palette" caption="Warm neutrals with brass accents.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 14 }}>
            <Swatch name="Cream" hex={tokens.cream} />
            <Swatch name="Paper" hex={tokens.paper} />
            <Swatch name="Hairline" hex={tokens.hairline} />
            <Swatch name="Ink" hex={tokens.ink} dark />
            <Swatch name="Ink Soft" hex={tokens.inkSoft} dark />
            <Swatch name="Brass" hex={tokens.brass} />
            <Swatch name="Terracotta" hex={tokens.terracotta} />
            <Swatch name="Sage" hex={tokens.sage} dark />
          </div>
        </Section>

        {/* Typography */}
        <Section eyebrow="02" title="Typography" caption="Fraunces display · Inter text.">
          <div
            style={{
              background: tokens.paper,
              border: `1px solid ${tokens.hairline}`,
              borderRadius: 12,
              padding: "40px 44px",
              boxShadow: tokens.shadow,
            }}
          >
            <TypeRow
              label="Display"
              meta="Fraunces · 72/76 · 500"
              style={{ fontFamily: tokens.serif, fontSize: 72, lineHeight: 1.05, fontWeight: 500, letterSpacing: -0.5 }}
              text="A thoughtful balance."
            />
            <TypeRow
              label="H1"
              meta="Fraunces · 44/52 · 500"
              style={{ fontFamily: tokens.serif, fontSize: 44, lineHeight: 1.15, fontWeight: 500, letterSpacing: -0.3 }}
              text="Quarterly household review"
            />
            <TypeRow
              label="H2"
              meta="Fraunces · 30/38 · 500"
              style={{ fontFamily: tokens.serif, fontSize: 30, lineHeight: 1.25, fontWeight: 500 }}
              text="March cash-flow summary"
            />
            <TypeRow
              label="H3"
              meta="Inter · 18/26 · 600"
              style={{ fontFamily: tokens.sans, fontSize: 18, fontWeight: 600, letterSpacing: 0.1 }}
              text="Recurring obligations"
            />
            <TypeRow
              label="Body"
              meta="Inter · 15/24 · 400"
              style={{ fontFamily: tokens.sans, fontSize: 15, lineHeight: 1.6, color: tokens.inkSoft }}
              text="Your discretionary spending is tracking 6% below last quarter — a measured improvement worth preserving."
            />
            <TypeRow
              label="Small"
              meta="Inter · 13/20 · 400"
              style={{ fontFamily: tokens.sans, fontSize: 13, lineHeight: 1.55, color: tokens.muted }}
              text="Posted Mar 14, 2026 · Pacific time"
            />
            <TypeRow
              label="Caption"
              meta="Inter · 11/16 · 500 · 2.4 tracking"
              style={{
                fontFamily: tokens.sans,
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: 2.4,
                textTransform: "uppercase",
                color: tokens.brassDeep,
              }}
              text="Confidential · For the Hubele household"
              last
            />
          </div>
        </Section>

        {/* Balance hero */}
        <Section eyebrow="03" title="Figure" caption="A statement card for capital under stewardship.">
          <div
            style={{
              background: tokens.paper,
              border: `1px solid ${tokens.hairline}`,
              borderRadius: 12,
              padding: "44px 48px",
              boxShadow: tokens.shadowLg,
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr",
              gap: 48,
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: tokens.sans,
                  fontSize: 11,
                  letterSpacing: 2.4,
                  textTransform: "uppercase",
                  color: tokens.brassDeep,
                  fontWeight: 500,
                  marginBottom: 16,
                }}
              >
                Account Balance · As of Mar 14
              </div>
              <div
                style={{
                  fontFamily: tokens.serif,
                  fontSize: 84,
                  lineHeight: 1,
                  fontWeight: 500,
                  letterSpacing: -1.2,
                  color: tokens.ink,
                  fontVariantNumeric: "tabular-nums",
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                }}
              >
                <span style={{ fontSize: 44, color: tokens.muted, fontWeight: 400 }}>$</span>
                24,318
                <span style={{ fontSize: 44, color: tokens.muted, fontWeight: 400 }}>.40</span>
              </div>
              <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 16 }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    background: "#EEF1EB",
                    color: tokens.sage,
                    borderRadius: 6,
                    fontSize: 12.5,
                    fontWeight: 500,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <ArrowUpRight size={13} strokeWidth={2} /> +2.4% MoM
                </span>
                <span style={{ fontSize: 13, color: tokens.muted }}>
                  +$571.18 since February statement
                </span>
              </div>
              <div
                style={{
                  marginTop: 36,
                  paddingTop: 28,
                  borderTop: `1px solid ${tokens.hairline}`,
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 32,
                }}
              >
                {[
                  { l: "Inflows", v: "$8,420.00" },
                  { l: "Outflows", v: "$7,848.82" },
                  { l: "Reserved", v: "$3,200.00" },
                ].map((s) => (
                  <div key={s.l}>
                    <div
                      style={{
                        fontFamily: tokens.sans,
                        fontSize: 11,
                        letterSpacing: 1.8,
                        textTransform: "uppercase",
                        color: tokens.muted,
                        marginBottom: 6,
                      }}
                    >
                      {s.l}
                    </div>
                    <div
                      style={{
                        fontFamily: tokens.serif,
                        fontSize: 22,
                        color: tokens.ink,
                        fontWeight: 500,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {s.v}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div
              style={{
                background: tokens.creamDeep,
                borderRadius: 10,
                padding: "28px 28px 20px",
                border: `1px solid ${tokens.hairline}`,
              }}
            >
              <div
                style={{
                  fontFamily: tokens.sans,
                  fontSize: 11,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: tokens.brassDeep,
                  marginBottom: 8,
                  fontWeight: 500,
                }}
              >
                Trailing 12 weeks
              </div>
              <div
                style={{
                  fontFamily: tokens.serif,
                  fontSize: 18,
                  fontStyle: "italic",
                  color: tokens.inkSoft,
                  marginBottom: 16,
                  lineHeight: 1.45,
                }}
              >
                A gentle climb — your reserves have grown for nine consecutive weeks.
              </div>
              <Sparkline />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontFamily: tokens.sans,
                  fontSize: 11,
                  color: tokens.muted,
                  marginTop: 6,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>Dec</span>
                <span>Jan</span>
                <span>Feb</span>
                <span>Mar</span>
              </div>
            </div>
          </div>
        </Section>

        {/* Transactions table */}
        <Section eyebrow="04" title="Tabular" caption="Recent activity — Hubele household.">
          <div
            style={{
              background: tokens.paper,
              border: `1px solid ${tokens.hairline}`,
              borderRadius: 12,
              overflow: "hidden",
              boxShadow: tokens.shadow,
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: tokens.sans,
                fontSize: 13.5,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <thead>
                <tr style={{ background: tokens.creamDeep }}>
                  {["Date", "Merchant", "Category", "Amount"].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        textAlign: i === 3 ? "right" : "left",
                        padding: "16px 24px",
                        fontSize: 11,
                        letterSpacing: 1.8,
                        textTransform: "uppercase",
                        color: tokens.brassDeep,
                        fontWeight: 500,
                        borderBottom: `1px solid ${tokens.hairline}`,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {txns.map((t, i) => (
                  <tr key={i} style={{ borderBottom: i === txns.length - 1 ? "none" : `1px solid ${tokens.hairline}` }}>
                    <td style={{ padding: "18px 24px", color: tokens.muted, width: 100 }}>{t.date}</td>
                    <td
                      style={{
                        padding: "18px 24px",
                        color: tokens.ink,
                        fontFamily: tokens.serif,
                        fontSize: 15,
                        fontWeight: 500,
                      }}
                    >
                      {t.merchant}
                    </td>
                    <td style={{ padding: "18px 24px" }}>
                      <span
                        style={{
                          fontSize: 12,
                          color: tokens.inkSoft,
                          padding: "3px 10px",
                          background: tokens.ivoryChip,
                          borderRadius: 999,
                          border: `1px solid ${tokens.hairline}`,
                        }}
                      >
                        {t.category}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "18px 24px",
                        textAlign: "right",
                        color: t.amount > 0 ? tokens.sage : tokens.ink,
                        fontWeight: 500,
                      }}
                    >
                      {t.amount > 0 ? "+" : "−"}$
                      {Math.abs(t.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Form */}
        <Section eyebrow="05" title="Forms" caption="Inputs and controls.">
          <div
            style={{
              background: tokens.paper,
              border: `1px solid ${tokens.hairline}`,
              borderRadius: 12,
              padding: "40px 44px",
              boxShadow: tokens.shadow,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 32,
            }}
          >
            <Field label="Email address" hint="Statements are delivered on the 1st of each month.">
              <input
                defaultValue="advisor@hubelefamily.com"
                style={inputStyle}
              />
            </Field>
            <Field label="Contribution amount" hint="Drawn from your reserve account.">
              <div style={{ position: "relative" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 16,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: tokens.muted,
                    fontFamily: tokens.serif,
                    fontSize: 16,
                  }}
                >
                  $
                </span>
                <input
                  defaultValue="1,500.00"
                  style={{ ...inputStyle, paddingLeft: 30, fontVariantNumeric: "tabular-nums" }}
                />
              </div>
            </Field>
            <Field label="Allocation strategy" hint="Used for cash-flow forecasting.">
              <div style={{ position: "relative" }}>
                <select style={{ ...inputStyle, appearance: "none", paddingRight: 40 }}>
                  <option>Conservative — capital preservation</option>
                  <option>Balanced — moderate growth</option>
                  <option>Growth — long horizon</option>
                </select>
                <ChevronDown
                  size={16}
                  color={tokens.inkSoft}
                  style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
                />
              </div>
            </Field>
            <Field label="Statement frequency" hint="A printed copy is mailed quarterly.">
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, paddingTop: 8 }}>
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    background: tokens.ink,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  <Check size={12} color={tokens.cream} strokeWidth={3} />
                </span>
                <div>
                  <div style={{ fontSize: 14, color: tokens.ink, fontWeight: 500 }}>
                    Send a paper statement
                  </div>
                  <div style={{ fontSize: 12.5, color: tokens.muted, marginTop: 3, lineHeight: 1.5 }}>
                    Printed on Mohawk Superfine, posted via first-class mail.
                  </div>
                </div>
              </div>
            </Field>
          </div>
        </Section>

        {/* Buttons */}
        <Section eyebrow="06" title="Buttons" caption="Considered actions.">
          <div
            style={{
              background: tokens.paper,
              border: `1px solid ${tokens.hairline}`,
              borderRadius: 12,
              padding: "36px 40px",
              boxShadow: tokens.shadow,
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 28,
            }}
          >
            {(
              [
                ["Primary", "primary"],
                ["Secondary", "secondary"],
                ["Ghost", "ghost"],
                ["Destructive", "destructive"],
              ] as [string, BtnVariant][]
            ).map(([label, v]) => (
              <div key={label}>
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: 2,
                    textTransform: "uppercase",
                    color: tokens.brassDeep,
                    marginBottom: 12,
                    fontWeight: 500,
                  }}
                >
                  {label}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
                  <Btn variant={v}>{label === "Destructive" ? "Close account" : label === "Ghost" ? "Learn more" : "Continue"}</Btn>
                  <Btn variant={v} disabled>
                    {label === "Destructive" ? "Close account" : label === "Ghost" ? "Learn more" : "Continue"}
                  </Btn>
                </div>
                <div style={{ fontSize: 11, color: tokens.muted, marginTop: 10 }}>Default · Disabled</div>
              </div>
            ))}
          </div>
        </Section>

        {/* Chips */}
        <Section eyebrow="07" title="Categories" caption="Tags for the household ledger.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <Chip label="Groceries" dotColor={tokens.sage} />
            <Chip label="Dining" dotColor={tokens.terracotta} />
            <Chip label="Subscriptions" dotColor={tokens.brass} />
            <Chip label="Utilities" dotColor={tokens.inkSoft} />
            <Chip label="Childcare" dotColor={tokens.amber} />
            <Chip label="Investments" dotColor={tokens.ink} />
          </div>
        </Section>

        {/* Alerts */}
        <Section eyebrow="08" title="Notices" caption="Communiqués from your advisor.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Alert
              tone="info"
              Icon={Info}
              title="Quarterly review scheduled"
              body="Your March 31 review with the household advisor is confirmed. Materials enclosed."
            />
            <Alert
              tone="success"
              Icon={CheckCircle2}
              title="Reserve goal reached"
              body="The Vermont sabbatical fund has been fully provisioned, three months ahead of plan."
            />
            <Alert
              tone="warning"
              Icon={AlertTriangle}
              title="Discretionary spending nearing limit"
              body="You have spent 84% of the March dining envelope. Consider deferring non-essential outings."
            />
            <Alert
              tone="destructive"
              Icon={XCircle}
              title="Connection requires attention"
              body="Chase Sapphire credentials lapsed on Mar 12. Please re-authorize to resume reconciliation."
            />
          </div>
        </Section>

        <footer
          style={{
            marginTop: 80,
            paddingTop: 32,
            borderTop: `1px solid ${tokens.hairline}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontFamily: tokens.sans,
            fontSize: 12,
            color: tokens.muted,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Monogram />
            <span style={{ fontFamily: tokens.serif, fontSize: 14, color: tokens.inkSoft }}>
              H2 Budget — Private Banking
            </span>
          </div>
          <div style={{ letterSpacing: 1.4, textTransform: "uppercase", fontSize: 11 }}>
            Est. MMXXVI · Confidential
          </div>
        </footer>
      </main>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  caption,
  children,
}: {
  eyebrow: string;
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 72 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "180px 1fr",
          gap: 24,
          alignItems: "baseline",
          marginBottom: 24,
          paddingBottom: 16,
          borderBottom: `1px solid ${tokens.hairline}`,
        }}
      >
        <div
          style={{
            fontFamily: tokens.sans,
            fontSize: 11,
            letterSpacing: 2.4,
            textTransform: "uppercase",
            color: tokens.brassDeep,
            fontWeight: 500,
          }}
        >
          § {eyebrow}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 24 }}>
          <h2
            style={{
              fontFamily: tokens.serif,
              fontSize: 34,
              fontWeight: 500,
              letterSpacing: -0.3,
              color: tokens.ink,
              margin: 0,
            }}
          >
            {title}
          </h2>
          <span
            style={{
              fontFamily: tokens.serif,
              fontStyle: "italic",
              fontSize: 15,
              color: tokens.muted,
            }}
          >
            {caption}
          </span>
        </div>
      </div>
      {children}
    </section>
  );
}

function TypeRow({
  label,
  meta,
  text,
  style,
  last,
}: {
  label: string;
  meta: string;
  text: string;
  style: React.CSSProperties;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr",
        gap: 24,
        alignItems: "baseline",
        padding: "20px 0",
        borderBottom: last ? "none" : `1px solid ${tokens.hairline}`,
      }}
    >
      <div>
        <div
          style={{
            fontFamily: tokens.sans,
            fontSize: 11,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: tokens.brassDeep,
            fontWeight: 500,
          }}
        >
          {label}
        </div>
        <div style={{ fontFamily: tokens.sans, fontSize: 11, color: tokens.muted, marginTop: 4 }}>
          {meta}
        </div>
      </div>
      <div style={{ color: tokens.ink, ...style }}>{text}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 16px",
  background: tokens.creamDeep,
  border: `1px solid ${tokens.hairline}`,
  borderRadius: 8,
  fontFamily: "'Inter', system-ui, sans-serif",
  fontSize: 14,
  color: tokens.ink,
  outline: "none",
  boxSizing: "border-box",
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 12,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          color: tokens.brassDeep,
          fontWeight: 500,
          display: "block",
          marginBottom: 10,
        }}
      >
        {label}
      </label>
      {children}
      <div
        style={{
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: 12,
          color: tokens.muted,
          marginTop: 8,
          fontStyle: "italic",
        }}
      >
        {hint}
      </div>
    </div>
  );
}

export default WarmBanking;
