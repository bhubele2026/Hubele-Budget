import type { RecapFacts } from "./facts";

// (V2) THE ONE ACTION LINE — chosen by code, never by a model. First match wins:
//   (a) stale bank data      -> none (the stale line already says it)
//   (b) week is over plan    -> hold non-essentials until Sunday
//   (c) shortfall finding    -> the gap under the buffer before payday
//   (d) charges need a look  -> "N charges need a look"
//   (e) a bill due tomorrow  -> "<name> $<amount> is due tomorrow"
//   (f) on plan, payday <= 3 days away, a debt with an APR -> extra toward it
//   (g) otherwise            -> nothing to do today
// `figures` lists every number the text contains; each one is also a figure in
// the facts (the validator is still the single gate on the final text).

export type ActionKind =
  | "hold_spending"
  | "shortfall"
  | "review"
  | "bill_tomorrow"
  | "extra_debt"
  | "nothing";

export interface RecapAction {
  kind: ActionKind;
  text: string;
  figures: number[];
}

export type ActionInput = Omit<RecapFacts, "action">;

const usd = (n: number): string => `$${Math.round(Math.max(0, n)).toLocaleString("en-US")}`;
const dayGap = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export function pickAction(f: ActionInput): RecapAction | null {
  // (a)
  if (f.freshness.stale) return null;

  // (b)
  if (f.weekToDate.withinPlan === "over") {
    const free = f.position.availableUntilPayday;
    if (free === null) return { kind: "hold_spending", text: "Hold non-essentials until Sunday.", figures: [] };
    const until = f.position.horizonKind === "payday" ? "until payday" : "through Saturday";
    return {
      kind: "hold_spending",
      text: `Hold non-essentials until Sunday; that keeps ${usd(free)} ${until}.`,
      figures: [free],
    };
  }

  // (c)
  const gap = f.findings.find((x) => x.kind === "shortfall_before_income" && typeof x.shortBy === "number" && x.shortBy > 0);
  if (gap && typeof gap.shortBy === "number") {
    return {
      kind: "shortfall",
      text: `Cash may dip ${usd(gap.shortBy)} under the buffer before payday.`,
      figures: [gap.shortBy],
    };
  }

  // (d)
  if (f.needsLookCount > 0) {
    const n = f.needsLookCount;
    return { kind: "review", text: `${n} ${n === 1 ? "charge needs" : "charges need"} a look.`, figures: [n] };
  }

  // (e)
  const tomorrow = f.billsNext3Days.find((b) => b.dueTomorrow);
  if (tomorrow) {
    return {
      kind: "bill_tomorrow",
      text: `${tomorrow.name} ${usd(tomorrow.amount)} is due tomorrow.`,
      figures: [tomorrow.amount],
    };
  }

  // (f)
  const onPlan = f.weekToDate.withinPlan === "yes";
  const payday = f.position.horizonKind === "payday" ? f.position.paydayDate : null;
  const soon = payday !== null && dayGap(f.forDate, payday) >= 0 && dayGap(f.forDate, payday) <= 3;
  if (onPlan && soon && f.debt.topAprName) {
    return { kind: "extra_debt", text: `On plan. Extra toward ${f.debt.topAprName} is on the table.`, figures: [] };
  }

  // (g)
  return {
    kind: "nothing",
    text: onPlan ? "On plan. Nothing to do today." : "Nothing to do today.",
    figures: [],
  };
}
