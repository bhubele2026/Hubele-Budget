import type { RecapFacts } from "./facts";
import { MAX_TEXT_CHARS } from "./validate";

// (AI-4a) The deterministic recap: always available, always valid. Used when
// the model is off, over budget, refuses, or writes something the validator
// rejects. Every figure is read from the facts; every sentence is fixed.
//
// Branches: normal / no spending / stale / late arrivals / progress. Parts are
// listed most-important-first and dropped from the end until the text fits.

const usd = (n: number): string => `$${Math.round(Math.max(0, n)).toLocaleString("en-US")}`;

/** One short sentence for the finding the recap may mention, never with a number. */
export const FINDING_PHRASES: Readonly<Record<string, string>> = {
  bill_increase: "A bill came in higher than usual.",
  category_acceleration: "One category is running ahead of its plan.",
  shortfall_before_income: "Cash looks tight before payday.",
  duplicate_charge: "Two matching charges landed close together.",
  limit_near: "The weekly limit is nearly used.",
  goal_behind: "A goal is behind schedule.",
};

function staleLine(f: RecapFacts): string {
  const d = f.freshness.daysSinceBank;
  if (d === null || d < 1) return "Bank data may be out of date; figures may be incomplete.";
  return `Bank data last updated ${d} ${d === 1 ? "day" : "days"} ago; figures may be incomplete.`;
}

function yesterdayLine(f: RecapFacts, categories: number): string {
  const y = f.spentYesterday;
  if (y.total <= 0) return "Yesterday: nothing spent.";
  const cats = y.topCategories.slice(0, categories).map((c) => `${c.name} ${usd(c.total)}`);
  return `Yesterday: ${usd(y.total)} spent${cats.length ? ` (${cats.join(", ")})` : ""}.`;
}

function planLine(f: RecapFacts): string | null {
  switch (f.weekToDate.withinPlan) {
    case "yes":
      return "On track this week.";
    case "tight":
      return "Tight this week.";
    case "over":
      return "Over plan this week.";
    default:
      return null;
  }
}

function roomLine(f: RecapFacts): string | null {
  const free = f.position.availableUntilPayday;
  if (free === null) return null;
  const until = f.position.horizonKind === "payday" && f.position.paydayWeekday ? f.position.paydayWeekday : "Saturday";
  return `Room in the plan: ${usd(free)} until ${until}.`;
}

function billsLine(f: RecapFacts): string | null {
  if (f.billsNext3Days.length === 0) return null;
  const shown = f.billsNext3Days.slice(0, 2).map((b) => {
    const when = b.date === f.forDate ? "today" : b.dueTomorrow ? "tomorrow" : b.weekday;
    return `${b.name} ${usd(b.amount)} ${when}`;
  });
  const more = f.billsNext3Days.length > 2 ? " and more" : "";
  return `Due soon: ${shown.join(", ")}${more}.`;
}

function progressLine(f: RecapFacts): string | null {
  if (f.progress.debtPayment) return "A debt payment went through.";
  if (f.progress.lowerThanLastWeek) return `Spending is lower than last ${f.yesterdayWeekday} so far.`;
  return null;
}

/** The one finding the recap may mention: unseen, serious enough, not the stale-bank story, and not the shortfall the action line already tells. */
function pickFinding(f: RecapFacts) {
  return f.findings.find(
    (x) =>
      !x.surfaced &&
      x.severity !== "info" &&
      x.kind !== "bank_stale" &&
      FINDING_PHRASES[x.kind] &&
      !(x.kind === "shortfall_before_income" && f.action?.kind === "shortfall"),
  );
}

function findingLine(f: RecapFacts): string | null {
  const pick = pickFinding(f);
  return pick ? FINDING_PHRASES[pick.kind]! : null;
}

/**
 * The finding row the template's text mentions, if any (to mark it surfaced).
 * It counts only when its sentence survived the length cut: a finding the
 * member never read stays unseen.
 */
export function templateFindingId(f: RecapFacts, opts: { maxLen?: number } = {}): string | null {
  const pick = pickFinding(f);
  if (!pick) return null;
  const max = Math.min(opts.maxLen ?? MAX_TEXT_CHARS, MAX_TEXT_CHARS);
  const text = renderRecapTemplate(f, { maxLen: max });
  return text.includes(FINDING_PHRASES[pick.kind]!) ? pick.id : null;
}

function parts(f: RecapFacts, categories: number): Array<string | null> {
  const stale = f.freshness.stale;
  const first: string[] = [];
  if (stale) {
    if (f.spentYesterday.total > 0) first.push(yesterdayLine(f, categories));
    first.push(staleLine(f));
  } else {
    first.push(yesterdayLine(f, categories));
  }
  const late =
    f.lateArrivals.count > 0 && f.lateArrivals.fromWeekday
      ? `Arrived late: ${usd(f.lateArrivals.total)} from ${f.lateArrivals.fromWeekday}.`
      : null;
  // The action line already says "N charges need a look"; do not say it twice.
  const review =
    f.needsLookCount > 0 && f.action?.kind !== "review"
      ? `${f.needsLookCount} ${f.needsLookCount === 1 ? "charge needs" : "charges need"} a look.`
      : null;
  // Most important first; the tail is dropped when the text is too long.
  return [first.join(" "), roomLine(f), planLine(f), f.action?.text ?? null, late, review, billsLine(f), progressLine(f), findingLine(f)];
}

export function renderRecapTemplate(f: RecapFacts, opts: { maxLen?: number } = {}): string {
  const max = Math.min(opts.maxLen ?? MAX_TEXT_CHARS, MAX_TEXT_CHARS);
  for (let categories = 3; categories >= 0; categories--) {
    const all = parts(f, categories).filter((p): p is string => !!p);
    for (let keep = all.length; keep >= 1; keep--) {
      const text = all.slice(0, keep).join(" ");
      if (text.length <= max) return text;
    }
  }
  // Even the first sentence is too long for this link: say the minimum.
  return (f.freshness.stale ? "Bank data may be out of date." : "Your morning recap is ready.").slice(0, max);
}
