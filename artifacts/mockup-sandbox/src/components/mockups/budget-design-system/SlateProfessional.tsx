import { Fragment, useEffect } from "react";
import {
  ArrowUpRight,
  ArrowDownRight,
  Search,
  Bell,
  Info,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  Check,
  ShoppingBag,
  Coffee,
  Repeat,
  Car,
  Home,
  Sparkles,
} from "lucide-react";

const INK = "#0F172A";
const SUBTLE = "#475569";
const MUTED = "#64748B";
const BORDER = "#CBD5E1";
const BORDER_SOFT = "#E2E8F0";
const PAGE_BG = "#F1F5F9";
const CARD_BG = "#FFFFFF";
const ACCENT = "#047857";
const ACCENT_SOFT = "#ECFDF5";
const ACCENT_BORDER = "#A7F3D0";

const SHADOW_SM = "0 1px 3px rgba(15, 23, 42, 0.04)";
const SHADOW_MD =
  "0 1px 3px rgba(15, 23, 42, 0.04), 0 4px 12px rgba(15, 23, 42, 0.03)";
const SHADOW_LG =
  "0 1px 3px rgba(15, 23, 42, 0.05), 0 12px 32px rgba(15, 23, 42, 0.06)";

const FONT_STACK =
  "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

function Card({
  children,
  className = "",
  style,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  padded?: boolean;
}) {
  return (
    <div
      className={className}
      style={{
        background: CARD_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 14,
        boxShadow: SHADOW_MD,
        padding: padded ? 28 : 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: MUTED,
      }}
    >
      {children}
    </div>
  );
}

function Swatch({
  hex,
  name,
  textOnDark = false,
}: {
  hex: string;
  name: string;
  textOnDark?: boolean;
}) {
  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: SHADOW_SM,
        background: CARD_BG,
      }}
    >
      <div
        style={{
          background: hex,
          height: 96,
          borderBottom: `1px solid ${BORDER_SOFT}`,
        }}
      />
      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{name}</div>
        <div
          style={{
            fontSize: 12,
            color: MUTED,
            fontVariantNumeric: "tabular-nums",
            marginTop: 2,
            letterSpacing: "0.02em",
          }}
        >
          {hex}
        </div>
      </div>
    </div>
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
  const base: React.CSSProperties = {
    padding: "10px 18px",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    fontFamily: FONT_STACK,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    transition: "all 120ms ease",
    border: "1px solid transparent",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    letterSpacing: "-0.005em",
  };
  let styles: React.CSSProperties = {};
  if (variant === "primary") {
    styles = {
      background: ACCENT,
      color: "#fff",
      boxShadow: disabled
        ? "none"
        : "0 1px 0 rgba(255,255,255,0.15) inset, 0 1px 2px rgba(4,120,87,0.25)",
      borderColor: "#065F46",
    };
  } else if (variant === "secondary") {
    styles = {
      background: "#fff",
      color: INK,
      borderColor: BORDER,
      boxShadow: SHADOW_SM,
    };
  } else if (variant === "ghost") {
    styles = {
      background: "transparent",
      color: INK,
      borderColor: "transparent",
    };
  } else {
    styles = {
      background: "#fff",
      color: "#B91C1C",
      borderColor: "#FECACA",
      boxShadow: SHADOW_SM,
    };
  }
  return (
    <button disabled={disabled} style={{ ...base, ...styles }}>
      {children}
    </button>
  );
}

function ButtonCell({
  label,
  variant,
  disabled,
}: {
  label: string;
  variant: "primary" | "secondary" | "ghost" | "destructive";
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <Btn variant={variant} disabled={disabled}>
        {label}
      </Btn>
      <div
        style={{
          fontSize: 11,
          color: MUTED,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        {variant} · {disabled ? "disabled" : "default"}
      </div>
    </div>
  );
}

function Chip({
  label,
  dot,
  tint,
}: {
  label: string;
  dot: string;
  tint: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: tint,
        color: INK,
        border: `1px solid ${BORDER}`,
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 500,
        boxShadow: SHADOW_SM,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: dot,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

function Alert({
  tone,
  title,
  message,
}: {
  tone: "info" | "success" | "warning" | "destructive";
  title: string;
  message: string;
}) {
  const config = {
    info: {
      bg: "#EFF6FF",
      border: "#BFDBFE",
      icon: <Info size={18} strokeWidth={2} />,
      iconColor: "#1D4ED8",
    },
    success: {
      bg: ACCENT_SOFT,
      border: ACCENT_BORDER,
      icon: <CheckCircle2 size={18} strokeWidth={2} />,
      iconColor: ACCENT,
    },
    warning: {
      bg: "#FFFBEB",
      border: "#FDE68A",
      icon: <AlertTriangle size={18} strokeWidth={2} />,
      iconColor: "#B45309",
    },
    destructive: {
      bg: "#FEF2F2",
      border: "#FECACA",
      icon: <XCircle size={18} strokeWidth={2} />,
      iconColor: "#B91C1C",
    },
  }[tone];
  return (
    <div
      style={{
        background: config.bg,
        border: `1px solid ${config.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        boxShadow: SHADOW_SM,
      }}
    >
      <div style={{ color: config.iconColor, marginTop: 1 }}>{config.icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: SUBTLE, marginTop: 2 }}>
          {message}
        </div>
      </div>
    </div>
  );
}

const transactions = [
  {
    date: "Mar 14",
    merchant: "Whole Foods Market",
    category: "Groceries",
    amount: -184.22,
  },
  {
    date: "Mar 13",
    merchant: "Shell — Pine St.",
    category: "Transport",
    amount: -56.4,
  },
  {
    date: "Mar 12",
    merchant: "Payroll · Hubele LLC",
    category: "Income",
    amount: 4820.0,
  },
  {
    date: "Mar 11",
    merchant: "Netflix",
    category: "Subscriptions",
    amount: -15.99,
  },
  {
    date: "Mar 10",
    merchant: "Trader Joe's",
    category: "Groceries",
    amount: -72.18,
  },
  {
    date: "Mar 09",
    merchant: "Blue Bottle Coffee",
    category: "Dining",
    amount: -8.5,
  },
];

function fmt(n: number) {
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

function Sparkline() {
  const points = [22, 26, 21, 28, 30, 27, 34, 31, 38, 36, 41, 39, 44, 42, 48];
  const w = 220;
  const h = 56;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const step = w / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * step;
      const y = h - ((p - min) / (max - min)) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id="sp-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.18" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sp-grad)" />
      <path
        d={path}
        fill="none"
        stroke={ACCENT}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: INK,
          color: "#fff",
          display: "grid",
          placeItems: "center",
          fontWeight: 700,
          fontSize: 14,
          letterSpacing: "-0.02em",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
        }}
      >
        H₂
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: INK,
          letterSpacing: "-0.02em",
        }}
      >
        H2 Budget
      </div>
    </div>
  );
}

export function SlateProfessional() {
  useEffect(() => {
    const id = "slate-pro-inter-font";
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
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";
    document.head.appendChild(preconnect1);
    document.head.appendChild(preconnect2);
    document.head.appendChild(link);
  }, []);

  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: PAGE_BG,
        color: INK,
        fontFamily: FONT_STACK,
        fontFeatureSettings: '"cv11", "ss01"',
      }}
    >
      {/* Header / nav */}
      <header
        style={{
          background: "rgba(255,255,255,0.85)",
          backdropFilter: "saturate(180%) blur(8px)",
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            padding: "16px 40px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
            <Logo />
            <nav style={{ display: "flex", gap: 28 }}>
              {["Overview", "Accounts", "Budget", "Reports"].map((l, i) => (
                <a
                  key={l}
                  href="#"
                  style={{
                    fontSize: 14,
                    fontWeight: i === 0 ? 600 : 500,
                    color: i === 0 ? INK : SUBTLE,
                    textDecoration: "none",
                    position: "relative",
                    padding: "4px 0",
                    borderBottom:
                      i === 0
                        ? `2px solid ${ACCENT}`
                        : "2px solid transparent",
                  }}
                >
                  {l}
                </a>
              ))}
            </nav>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                background: "#fff",
                border: `1px solid ${BORDER}`,
                borderRadius: 10,
                color: MUTED,
                fontSize: 13,
                width: 240,
                boxShadow: SHADOW_SM,
              }}
            >
              <Search size={14} />
              <span>Search transactions…</span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  border: `1px solid ${BORDER}`,
                  padding: "1px 6px",
                  borderRadius: 4,
                  color: MUTED,
                  background: PAGE_BG,
                }}
              >
                ⌘K
              </span>
            </div>
            <button
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                border: `1px solid ${BORDER}`,
                background: "#fff",
                display: "grid",
                placeItems: "center",
                color: SUBTLE,
                boxShadow: SHADOW_SM,
                cursor: "pointer",
              }}
            >
              <Bell size={16} />
            </button>
            <Btn variant="primary">
              <Sparkles size={14} /> New budget
            </Btn>
          </div>
        </div>
      </header>

      <main
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: "56px 40px 80px",
        }}
      >
        {/* Title */}
        <div style={{ marginBottom: 56 }}>
          <SectionLabel>H2 Family Budget · v3.6</SectionLabel>
          <h1
            style={{
              fontSize: 56,
              fontWeight: 700,
              letterSpacing: "-0.035em",
              color: INK,
              lineHeight: 1.05,
              margin: "16px 0 12px",
            }}
          >
            Design System
          </h1>
          <p
            style={{
              fontSize: 18,
              color: SUBTLE,
              maxWidth: 640,
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            Visual language for H2 Family Budget — a calm, confident interface
            for households managing accounts, bills, and shared goals.
          </p>
        </div>

        {/* Color palette */}
        <section style={{ marginBottom: 64 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Color
            </h2>
            <SectionLabel>01 — Palette</SectionLabel>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(8, 1fr)",
              gap: 16,
            }}
          >
            <Swatch hex="#0F172A" name="Ink" />
            <Swatch hex="#475569" name="Slate" />
            <Swatch hex="#94A3B8" name="Slate Muted" />
            <Swatch hex="#CBD5E1" name="Border" />
            <Swatch hex="#F1F5F9" name="Surface" />
            <Swatch hex="#FFFFFF" name="Card" />
            <Swatch hex="#047857" name="Emerald" />
            <Swatch hex="#B91C1C" name="Crimson" />
          </div>
        </section>

        {/* Typography */}
        <section style={{ marginBottom: 64 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Typography
            </h2>
            <SectionLabel>02 — Inter</SectionLabel>
          </div>
          <Card>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "160px 1fr",
                rowGap: 28,
                alignItems: "baseline",
              }}
            >
              {[
                {
                  label: "Display · 56 / 700",
                  size: 56,
                  weight: 700,
                  spacing: "-0.035em",
                  text: "Run the family books.",
                },
                {
                  label: "H1 · 36 / 700",
                  size: 36,
                  weight: 700,
                  spacing: "-0.025em",
                  text: "March 2026 overview",
                },
                {
                  label: "H2 · 24 / 600",
                  size: 24,
                  weight: 600,
                  spacing: "-0.015em",
                  text: "Spending by category",
                },
                {
                  label: "H3 · 18 / 600",
                  size: 18,
                  weight: 600,
                  spacing: "-0.01em",
                  text: "Recent transactions",
                },
                {
                  label: "Body · 15 / 400",
                  size: 15,
                  weight: 400,
                  spacing: "0",
                  text: "You're on track to save $1,240 this month — about 6.2% ahead of last month at the same point.",
                },
                {
                  label: "Small · 13 / 500",
                  size: 13,
                  weight: 500,
                  spacing: "0",
                  text: "Updated 4 minutes ago · synced from Chase ••3091",
                },
                {
                  label: "Caption · 11 / 600",
                  size: 11,
                  weight: 600,
                  spacing: "0.12em",
                  text: "ALL FIGURES IN USD · TABULAR NUMS",
                },
              ].map((row) => (
                <Fragment key={row.label}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: MUTED,
                      paddingTop: 8,
                    }}
                  >
                    {row.label}
                  </div>
                  <div
                    style={{
                      fontSize: row.size,
                      fontWeight: row.weight,
                      letterSpacing: row.spacing,
                      color: INK,
                      lineHeight: row.size > 30 ? 1.1 : 1.4,
                      textTransform:
                        row.label.startsWith("Caption") ? "uppercase" : "none",
                    }}
                  >
                    {row.text}
                  </div>
                </Fragment>
              ))}
            </div>
          </Card>
        </section>

        {/* Hero balance + Sidebar info */}
        <section style={{ marginBottom: 64 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Figure cards
            </h2>
            <SectionLabel>03 — Data display</SectionLabel>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 1fr",
              gap: 20,
            }}
          >
            <Card style={{ padding: 32, boxShadow: SHADOW_LG }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <SectionLabel>Account balance · all accounts</SectionLabel>
                  <div
                    style={{
                      fontSize: 14,
                      color: SUBTLE,
                      marginTop: 10,
                    }}
                  >
                    Hubele household · checking + savings
                  </div>
                </div>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px 5px 8px",
                    background: ACCENT_SOFT,
                    border: `1px solid ${ACCENT_BORDER}`,
                    borderRadius: 999,
                    color: ACCENT,
                    fontSize: 12,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <ArrowUpRight size={13} strokeWidth={2.5} />
                  +2.4% MoM
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "space-between",
                  marginTop: 24,
                  gap: 32,
                }}
              >
                <div
                  style={{
                    fontSize: 64,
                    fontWeight: 700,
                    letterSpacing: "-0.04em",
                    color: INK,
                    fontVariantNumeric: "tabular-nums",
                    lineHeight: 1,
                  }}
                >
                  $24,318
                  <span style={{ color: MUTED, fontWeight: 600 }}>.40</span>
                </div>
                <div style={{ marginBottom: 6 }}>
                  <Sparkline />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: MUTED,
                      marginTop: 4,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <span>Feb 14</span>
                    <span>Today</span>
                  </div>
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 0,
                  marginTop: 32,
                  paddingTop: 24,
                  borderTop: `1px solid ${BORDER_SOFT}`,
                }}
              >
                {[
                  { label: "Income MTD", value: "$8,420.00", delta: "+12.1%" },
                  {
                    label: "Spending MTD",
                    value: "$5,182.66",
                    delta: "−3.4%",
                    down: true,
                  },
                  { label: "Available to budget", value: "$1,240.00" },
                ].map((s, i) => (
                  <div
                    key={s.label}
                    style={{
                      paddingLeft: i === 0 ? 0 : 24,
                      borderLeft:
                        i === 0 ? "none" : `1px solid ${BORDER_SOFT}`,
                    }}
                  >
                    <SectionLabel>{s.label}</SectionLabel>
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 700,
                        letterSpacing: "-0.02em",
                        marginTop: 8,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {s.value}
                    </div>
                    {s.delta && (
                      <div
                        style={{
                          fontSize: 12,
                          color: s.down ? "#B91C1C" : ACCENT,
                          marginTop: 4,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontWeight: 600,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {s.down ? (
                          <ArrowDownRight size={12} />
                        ) : (
                          <ArrowUpRight size={12} />
                        )}
                        {s.delta} vs Feb
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>

            <Card style={{ padding: 28, display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <SectionLabel>Upcoming bills · next 7 days</SectionLabel>
              </div>
              {[
                { name: "PG&E Electric", date: "Mar 18", amt: "$142.20" },
                { name: "Verizon Family", date: "Mar 20", amt: "$214.99" },
                { name: "Mortgage · Wells", date: "Mar 21", amt: "$2,840.00" },
                { name: "AppleCare+", date: "Mar 22", amt: "$24.99" },
              ].map((b, i) => (
                <div
                  key={b.name}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingBottom: 14,
                    borderBottom:
                      i === 3 ? "none" : `1px solid ${BORDER_SOFT}`,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
                      {b.name}
                    </div>
                    <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                      Due {b.date}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      fontVariantNumeric: "tabular-nums",
                      color: INK,
                    }}
                  >
                    {b.amt}
                  </div>
                </div>
              ))}
              <button
                style={{
                  marginTop: "auto",
                  fontSize: 13,
                  fontWeight: 600,
                  color: ACCENT,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  alignSelf: "flex-start",
                }}
              >
                View all 12 upcoming →
              </button>
            </Card>
          </div>
        </section>

        {/* Table */}
        <section style={{ marginBottom: 64 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Recent transactions
            </h2>
            <SectionLabel>04 — Table</SectionLabel>
          </div>
          <Card padded={false}>
            <div
              style={{
                padding: "20px 28px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: `1px solid ${BORDER_SOFT}`,
              }}
            >
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: INK }}>
                  Chase Checking ••3091
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  Showing 6 of 142 transactions this month
                </div>
              </div>
              <Btn variant="secondary">
                Export <ChevronDown size={14} />
              </Btn>
            </div>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 14,
              }}
            >
              <thead>
                <tr>
                  {["Date", "Merchant", "Category", "Amount"].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        textAlign: i === 3 ? "right" : "left",
                        padding: "12px 28px",
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: MUTED,
                        background: "#FAFBFC",
                        borderBottom: `1px solid ${BORDER_SOFT}`,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transactions.map((t, i) => (
                  <tr key={i}>
                    <td
                      style={{
                        padding: "16px 28px",
                        borderBottom:
                          i === transactions.length - 1
                            ? "none"
                            : `1px solid ${BORDER_SOFT}`,
                        color: SUBTLE,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {t.date}
                    </td>
                    <td
                      style={{
                        padding: "16px 28px",
                        borderBottom:
                          i === transactions.length - 1
                            ? "none"
                            : `1px solid ${BORDER_SOFT}`,
                        color: INK,
                        fontWeight: 500,
                      }}
                    >
                      {t.merchant}
                    </td>
                    <td
                      style={{
                        padding: "16px 28px",
                        borderBottom:
                          i === transactions.length - 1
                            ? "none"
                            : `1px solid ${BORDER_SOFT}`,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          padding: "3px 10px",
                          borderRadius: 6,
                          background: "#F1F5F9",
                          color: SUBTLE,
                          border: `1px solid ${BORDER_SOFT}`,
                          fontWeight: 500,
                        }}
                      >
                        {t.category}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "16px 28px",
                        textAlign: "right",
                        borderBottom:
                          i === transactions.length - 1
                            ? "none"
                            : `1px solid ${BORDER_SOFT}`,
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 600,
                        color: t.amount > 0 ? ACCENT : INK,
                      }}
                    >
                      {fmt(t.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>

        {/* Form */}
        <section style={{ marginBottom: 64 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Forms
            </h2>
            <SectionLabel>05 — Inputs</SectionLabel>
          </div>
          <Card style={{ padding: 32 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 24,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: INK,
                    display: "block",
                    marginBottom: 8,
                  }}
                >
                  Email address
                </label>
                <input
                  type="email"
                  defaultValue="bradley@hubele.family"
                  style={{
                    width: "100%",
                    padding: "11px 14px",
                    background: "#fff",
                    border: `1px solid ${BORDER}`,
                    borderRadius: 10,
                    fontSize: 14,
                    color: INK,
                    fontFamily: FONT_STACK,
                    outline: "none",
                    boxShadow: SHADOW_SM,
                  }}
                />
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                  Used for weekly digest and account alerts.
                </div>
              </div>
              <div>
                <label
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: INK,
                    display: "block",
                    marginBottom: 8,
                  }}
                >
                  Amount
                </label>
                <div style={{ position: "relative" }}>
                  <span
                    style={{
                      position: "absolute",
                      left: 14,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: MUTED,
                      fontSize: 14,
                      fontWeight: 500,
                    }}
                  >
                    $
                  </span>
                  <input
                    type="text"
                    defaultValue="1,250.00"
                    style={{
                      width: "100%",
                      padding: "11px 14px 11px 28px",
                      background: "#fff",
                      border: `1px solid ${BORDER}`,
                      borderRadius: 10,
                      fontSize: 14,
                      color: INK,
                      fontFamily: FONT_STACK,
                      outline: "none",
                      fontVariantNumeric: "tabular-nums",
                      boxShadow: SHADOW_SM,
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                  Monthly contribution to "Vacation 2026" goal.
                </div>
              </div>
              <div>
                <label
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: INK,
                    display: "block",
                    marginBottom: 8,
                  }}
                >
                  Category
                </label>
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    background: "#fff",
                    border: `1px solid ${BORDER}`,
                    borderRadius: 10,
                    padding: "11px 14px",
                    boxShadow: SHADOW_SM,
                  }}
                >
                  <span style={{ fontSize: 14, color: INK }}>
                    Savings · Long-term goals
                  </span>
                  <ChevronDown
                    size={16}
                    style={{ marginLeft: "auto", color: MUTED }}
                  />
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                  Choose where this contribution will be recorded.
                </div>
              </div>
              <div>
                <label
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: INK,
                    display: "block",
                    marginBottom: 8,
                  }}
                >
                  Frequency
                </label>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                  }}
                >
                  {["One-time", "Monthly", "Per paycheck"].map((opt, i) => (
                    <div
                      key={opt}
                      style={{
                        flex: 1,
                        padding: "10px 12px",
                        textAlign: "center",
                        border: `1px solid ${i === 1 ? ACCENT : BORDER}`,
                        background: i === 1 ? ACCENT_SOFT : "#fff",
                        color: i === 1 ? ACCENT : INK,
                        fontSize: 13,
                        fontWeight: 600,
                        borderRadius: 10,
                        boxShadow: SHADOW_SM,
                      }}
                    >
                      {opt}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div
              style={{
                marginTop: 28,
                paddingTop: 24,
                borderTop: `1px solid ${BORDER_SOFT}`,
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  background: ACCENT,
                  border: `1px solid ${ACCENT}`,
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                  marginTop: 1,
                  boxShadow: "0 1px 2px rgba(4,120,87,0.2)",
                }}
              >
                <Check size={13} color="#fff" strokeWidth={3} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
                  Auto-transfer on payday
                </div>
                <div style={{ fontSize: 13, color: SUBTLE, marginTop: 2 }}>
                  We'll move the amount above to your savings account within 24
                  hours of each scheduled paycheck. You can pause anytime.
                </div>
              </div>
            </div>
            <div
              style={{
                marginTop: 28,
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
              }}
            >
              <Btn variant="ghost">Cancel</Btn>
              <Btn variant="secondary">Save as draft</Btn>
              <Btn variant="primary">Create contribution</Btn>
            </div>
          </Card>
        </section>

        {/* Buttons */}
        <section style={{ marginBottom: 64 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Buttons
            </h2>
            <SectionLabel>06 — Actions</SectionLabel>
          </div>
          <Card style={{ padding: 32 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 32,
              }}
            >
              <ButtonCell label="Save changes" variant="primary" />
              <ButtonCell label="View report" variant="secondary" />
              <ButtonCell label="Skip for now" variant="ghost" />
              <ButtonCell label="Remove account" variant="destructive" />
              <ButtonCell label="Save changes" variant="primary" disabled />
              <ButtonCell label="View report" variant="secondary" disabled />
              <ButtonCell label="Skip for now" variant="ghost" disabled />
              <ButtonCell
                label="Remove account"
                variant="destructive"
                disabled
              />
            </div>
          </Card>
        </section>

        {/* Chips */}
        <section style={{ marginBottom: 64 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Category tags
            </h2>
            <SectionLabel>07 — Chips</SectionLabel>
          </div>
          <Card style={{ padding: 28 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <Chip label="Groceries" dot="#047857" tint="#F0FDF4" />
              <Chip label="Dining" dot="#B45309" tint="#FFFBEB" />
              <Chip label="Subscriptions" dot="#4338CA" tint="#EEF2FF" />
              <Chip label="Transport" dot="#0369A1" tint="#F0F9FF" />
              <Chip label="Housing" dot="#475569" tint="#F8FAFC" />
              <Chip label="Entertainment" dot="#BE185D" tint="#FDF2F8" />
            </div>
            <div
              style={{
                marginTop: 20,
                paddingTop: 20,
                borderTop: `1px solid ${BORDER_SOFT}`,
                display: "flex",
                gap: 24,
                fontSize: 13,
                color: SUBTLE,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ShoppingBag size={15} color={MUTED} />
                <span>342 transactions tagged</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Coffee size={15} color={MUTED} />
                <span>14 dining merchants</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Repeat size={15} color={MUTED} />
                <span>9 active subscriptions</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Car size={15} color={MUTED} />
                <span>$412 transport MTD</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Home size={15} color={MUTED} />
                <span>1 mortgage tracked</span>
              </div>
            </div>
          </Card>
        </section>

        {/* Alerts */}
        <section style={{ marginBottom: 16 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Alerts
            </h2>
            <SectionLabel>08 — Feedback</SectionLabel>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 14,
            }}
          >
            <Alert
              tone="info"
              title="Plaid sync scheduled"
              message="Chase ••3091 will refresh in about 4 minutes. You can close this tab."
            />
            <Alert
              tone="success"
              title="March budget on track"
              message="You're 6.2% under target with 14 days left in the cycle. Nicely done."
            />
            <Alert
              tone="warning"
              title="Verizon bill higher than usual"
              message="$214.99 is $38 above your 3-month average. Review the line items?"
            />
            <Alert
              tone="destructive"
              title="Re-link required for Amex ••1004"
              message="Your bank revoked Plaid consent on Mar 12. Reconnect to resume syncing."
            />
          </div>
        </section>

        {/* Footer */}
        <footer
          style={{
            marginTop: 56,
            paddingTop: 24,
            borderTop: `1px solid ${BORDER}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 12,
            color: MUTED,
          }}
        >
          <div>H2 Family Budget · Design System v3.6 · Slate Professional</div>
          <div style={{ fontVariantNumeric: "tabular-nums" }}>
            Last published Mar 14, 2026 · 14:22 PT
          </div>
        </footer>
      </main>
    </div>
  );
}

export default SlateProfessional;
