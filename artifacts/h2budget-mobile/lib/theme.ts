// Matte-black palette — mirrors the web app: dead-flat black surfaces with a
// single clean blue accent. Semantic keys are reused across every screen, so
// changing them here re-skins the whole app. (`navy`/`navyDeep` keep their key
// names for compatibility but now hold the blue accent.)
export const colors = {
  bg: "#0B0B0D", // matte black canvas
  card: "#161619", // lifted matte panel
  border: "#26262C", // hairline
  navy: "#4D9DFF", // accent (blue)
  navyDeep: "#2F6FD6", // accent deep
  text: "#ECECEE", // off-white
  muted: "#9A9AA2",
  faint: "#6E6E78",
  positive: "#34D27B",
  positiveBg: "#102A1D",
  negative: "#FF5A5A",
  negativeBg: "#2A1212",
  warning: "#F5B544",
  trackBg: "#26262C",
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
