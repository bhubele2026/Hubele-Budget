// BH-style stat-card kit — reusable across pages. Composes the viz primitives
// into the ring + pill + sparkline + fill + "why" pattern.
export { RingMeter } from "./ring-meter";
export { StatusPill } from "./status-pill";
export { TrendSparkline, type TrendPoint } from "./trend-sparkline";
export { FillMeter } from "./fill-meter";
export { WhyExpander } from "./why-expander";
export { SectionHeader } from "./section-header";
export { Callout } from "./callout";
export {
  spendStatus,
  progressStatus,
  statusTone,
  STATUS_COLOR,
  type Status,
} from "@/lib/statusThresholds";
