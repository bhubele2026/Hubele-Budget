// Central status thresholds for the BH-style stat cards. One place to tune the
// green/amber/red bands so every RingMeter / StatusPill / sparkline agrees.

export type Status = "good" | "warning" | "danger" | "neutral";

// For "spend vs target" style ratios: under is good, near is amber, over is red.
export const SPEND_BANDS = { warnAt: 0.85, overAt: 1.0 } as const;

/** Status for a spend/target ratio (0 = nothing spent, 1 = at target). */
export function spendStatus(ratio: number): Status {
  if (!Number.isFinite(ratio)) return "neutral";
  if (ratio > SPEND_BANDS.overAt) return "danger";
  if (ratio >= SPEND_BANDS.warnAt) return "warning";
  return "good";
}

/** Inverse: for "progress toward a goal" (higher is better). */
export function progressStatus(ratio: number): Status {
  if (!Number.isFinite(ratio)) return "neutral";
  if (ratio >= 1) return "good";
  if (ratio >= 0.5) return "warning";
  return "danger";
}

export const STATUS_COLOR: Record<Status, string> = {
  good: "hsl(var(--positive))",
  warning: "hsl(var(--warning))",
  danger: "hsl(var(--negative))",
  neutral: "hsl(var(--muted-foreground))",
};

/** Map a status to the PillBadge tone vocabulary. */
export function statusTone(s: Status): "good" | "warning" | "danger" | "neutral" {
  return s;
}
