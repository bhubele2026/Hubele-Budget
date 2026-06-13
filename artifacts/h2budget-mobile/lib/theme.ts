// Corporate palette — mirrors the web app's navy + clean neutral system.
export const colors = {
  bg: "#F3F4F6",
  card: "#FFFFFF",
  border: "#E3E6EA",
  navy: "#1C3F6E",
  navyDeep: "#16314F",
  text: "#16202E",
  muted: "#6B7585",
  faint: "#9AA2AD",
  positive: "#1E8A5C",
  positiveBg: "#E7F4ED",
  negative: "#B23A3A",
  negativeBg: "#FAEAEA",
  warning: "#B7791F",
  trackBg: "#EAECEF",
};

export const radius = { sm: 8, md: 12, lg: 16 };

export const fonts = {
  // System font; tabular figures applied per-Text where money is shown.
  tabular: { fontVariant: ["tabular-nums" as const] },
};

export function formatCurrency(n: number): string {
  const sign = n < 0 ? "-" : "";
  return (
    sign +
    "$" +
    Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
