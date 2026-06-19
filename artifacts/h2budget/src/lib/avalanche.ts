// Thin client shim over the shared isomorphic payoff engine. All the pure
// math (types + simulate / simulateMinimumsOnly / identifyUnderwater / etc.)
// now lives in @workspace/avalanche-core and is re-exported verbatim here, so
// every `@/lib/avalanche` import keeps working with zero call-site changes.
// The 4 UI formatters below stay client-side because they touch Intl/locale.

export * from "@workspace/avalanche-core";

export function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function fmtMoneyCompact(n: number): string {
  if (Math.abs(n) >= 10000) {
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  }
  return fmtMoney(n);
}

export function fmtMonth(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", year: "numeric" });
}

export function fmtPct(p: number, digits = 2): string {
  return `${(p * 100).toFixed(digits)}%`;
}
