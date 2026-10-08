/**
 * The recharts stand-in for jsdom tests.
 *
 * Recharts measures its own container, which jsdom cannot do, so page tests
 * replace the library wholesale rather than assert on an SVG that never gets
 * a width. Every component renders `null`: these tests are about the page's
 * numbers and structure, never about the chart's pixels.
 *
 * ⚠️ ONE LIST, NOT ONE PER TEST FILE. `vi.mock` throws on the first named
 * import the factory does not provide, so a page that starts using one more
 * recharts primitive used to break every test that mocked the library with its
 * own short list. This module is the single place that list lives — it must
 * stay a superset of what `@/lib/charts` imports.
 *
 * Usage:  vi.mock("recharts", () => import("@/test-recharts-stub"));
 */

const Nothing = () => null;

export const ResponsiveContainer = Nothing;
export const ComposedChart = Nothing;
export const LineChart = Nothing;
export const PieChart = Nothing;
export const Line = Nothing;
export const Bar = Nothing;
export const Pie = Nothing;
export const Cell = Nothing;
export const XAxis = Nothing;
export const YAxis = Nothing;
export const CartesianGrid = Nothing;
export const Tooltip = Nothing;
export const Legend = Nothing;
export const LabelList = Nothing;
export const ReferenceArea = Nothing;
// (C0) The raw primitives `@/lib/charts` re-exports for reportsShared and the
// account balance trend.
export const AreaChart = Nothing;
export const Area = Nothing;
export const BarChart = Nothing;
export const ReferenceLine = Nothing;
export const ReferenceDot = Nothing;
export const Label = Nothing;
