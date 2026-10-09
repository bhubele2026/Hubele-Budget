import { describe, it, expect } from "vitest";
import type { RecapFacts } from "../recap/facts";
import { pickAction } from "../recap/action";
import { renderRecapTemplate, FINDING_PHRASES } from "../recap/template";
import { allowedNumbers, maxTextFor, validateRecapDraft, MAX_MESSAGE_CHARS, MAX_TEXT_CHARS } from "../recap/validate";
import { findForbidden, isGsmSafe, safeName, toGsm } from "../recap/text";
import { recapLink, withLink } from "../recap/generate";

// (AI-4a) The validator and the template, with no database. The property that
// matters: whatever the facts are, the deterministic template passes the same
// validator the model's text must pass, so the fallback is never refused by the
// rule that sent us to it.

// A small seeded generator, so a failure is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const money = (r: () => number, max = 6000): number => Math.round(r() * max * 100) / 100;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CATS = ["Groceries", "Dining Out", "Gas", "Kids", "Fun", "Household", "Pets", "Coffee", "Other"];
const BILLS = ["Rent", "Electric", "Water", "Phone", "Internet", "Insurance"];

function randomFacts(seed: number): RecapFacts {
  const r = rng(seed);
  const total = r() < 0.2 ? 0 : money(r, 900);
  const stale = r() < 0.3;
  const ncat = total > 0 ? Math.floor(r() * 4) : 0;
  const bills = Array.from({ length: Math.floor(r() * 5) }, (_, i) => ({
    name: pick(r, BILLS),
    date: `2026-10-${String(8 + (i % 3)).padStart(2, "0")}`,
    weekday: pick(r, WEEKDAYS),
    amount: money(r, 2500),
    dueTomorrow: r() < 0.4,
  }));
  const review = Math.floor(r() * 12) * (r() < 0.5 ? 1 : 0);
  const cat = Math.floor(r() * 3) * (r() < 0.3 ? 1 : 0);
  const payday = r() < 0.7;
  const cap = r() < 0.8 ? money(r, 800) : null;
  const core: Omit<RecapFacts, "action"> = {
    forDate: "2026-10-07",
    yesterday: "2026-10-06",
    yesterdayWeekday: "Tue",
    spentYesterday: {
      total,
      count: total > 0 ? 1 + Math.floor(r() * 9) : 0,
      topCategories: Array.from({ length: ncat }, (_, i) => ({ name: CATS[(i + Math.floor(r() * 5)) % CATS.length]!, total: money(r, 300) })),
    },
    lateArrivals:
      r() < 0.3
        ? { count: 1 + Math.floor(r() * 4), total: money(r, 400), fromDate: "2026-10-03", fromWeekday: pick(r, WEEKDAYS) }
        : { count: 0, total: 0, fromDate: null, fromWeekday: null },
    weekToDate: {
      spent: money(r, 700),
      cap,
      remainingWeek: cap === null ? null : Math.round((cap - money(r, 900)) * 100) / 100,
      withinPlan: cap === null ? null : pick(r, ["yes", "tight", "over"] as const),
    },
    position: {
      safeToSpendNow: r() < 0.8 ? money(r) : null,
      availableUntilPayday: r() < 0.85 ? money(r, 12000) : null,
      paydayDate: payday ? "2026-10-09" : null,
      paydayWeekday: payday ? "Fri" : null,
      horizonKind: payday ? "payday" : "week_end",
      confidence: pick(r, ["firm", "estimated"] as const),
      degraded: stale,
    },
    billsNext3Days: bills,
    reviewCount: review,
    categorizationReviewCount: cat,
    needsLookCount: review + cat,
    nextStep: review + cat > 0 ? "review" : bills.some((b) => b.dueTomorrow) ? "bill_tomorrow" : null,
    debt: { payoffPct: r() < 0.8 ? Math.floor(r() * 100) : null, confirmedPaymentsYesterday: Math.floor(r() * 3), topAprName: r() < 0.6 ? pick(r, ["Visa", "Store Card", "Car Loan"]) : null },
    freshness: {
      stale,
      staleReason: stale ? pick(r, ["old", "refresh_failed", "manual_old"]) : null,
      asOfBank: r() < 0.9 ? "2026-10-02T14:00:00.000Z" : null,
      daysSinceBank: r() < 0.9 ? Math.floor(r() * 9) : null,
    },
    progress: { lowerThanLastWeek: r() < 0.4, debtPayment: r() < 0.3 },
    findings:
      r() < 0.5
        ? [{ id: "f1", kind: pick(r, Object.keys(FINDING_PHRASES)), severity: pick(r, ["info", "watch", "high"] as const), summary: "a bill came in at $212, up $34 from usual", surfaced: r() < 0.3, shortBy: r() < 0.5 ? money(r, 900) : null }]
        : [],
  };
  return { ...core, action: pickAction(core) };
}

const LINK = recapLink("2026-10-07");
const MAX = maxTextFor(LINK);

describe("template always passes the validator (property)", () => {
  it("1000 random fact sets", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const facts = randomFacts(seed);
      const text = renderRecapTemplate(facts, { maxLen: MAX });
      const verdict = validateRecapDraft({ text, factsUsed: [] }, facts, { link: LINK });
      expect(verdict, `seed ${seed}: ${text}`).toBeNull();
      expect(text.length).toBeLessThanOrEqual(MAX);
      expect(withLink(text, facts.forDate).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
      expect(isGsmSafe(text)).toBe(true);
      expect(findForbidden(text)).toBeNull();
    }
  });

  it("still fits when the app URL is long", () => {
    const saved = process.env.APP_URL;
    process.env.APP_URL = `https://${"budget-".repeat(14)}example.com`;
    try {
      const link = recapLink("2026-10-07");
      const max = maxTextFor(link);
      expect(max).toBeLessThan(MAX_TEXT_CHARS);
      for (let seed = 1; seed <= 200; seed++) {
        const facts = randomFacts(seed);
        const text = renderRecapTemplate(facts, { maxLen: max });
        expect(validateRecapDraft({ text, factsUsed: [] }, facts, { link })).toBeNull();
      }
    } finally {
      if (saved === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = saved;
    }
  });
});

describe("validator rejects", () => {
  const facts = randomFacts(7);
  const ok = (text: string, used: string[] = []) => validateRecapDraft({ text, factsUsed: used }, facts, { link: LINK });

  it("a dollar figure that is not in the facts", () => {
    expect(ok("Yesterday: $987,654 spent.")).toMatch(/not in the facts/);
  });
  it("a bare number that is not in the facts", () => {
    expect(ok("You made 987655 purchases.")).toMatch(/not in the facts/);
  });
  it("accepts the three renderings of a figure", () => {
    const f: RecapFacts = { ...facts, spentYesterday: { total: 1234.56, count: 2, topCategories: [] } };
    for (const t of ["$1,235 spent.", "$1,234 spent.", "$1,234.56 spent.", "$1234.56 spent."]) {
      expect(validateRecapDraft({ text: t, factsUsed: [] }, f, { link: LINK })).toBeNull();
    }
    expect(validateRecapDraft({ text: "$1,236 spent.", factsUsed: [] }, f, { link: LINK })).toMatch(/not in the facts/);
  });
  for (const phrase of ["should have", "shame", "bad job", "disappointing", "again?", "!"]) {
    it(`the forbidden phrase "${phrase}"`, () => {
      expect(ok(`Quiet day ${phrase} ok`)).toMatch(/contains/);
      expect(ok(`Quiet day ${phrase.toUpperCase()} ok`)).toMatch(/contains/);
    });
  }
  it("text that does not fit with the link", () => {
    const long = "Quiet day. ".repeat(30);
    expect(ok(long)).toMatch(/characters/);
    const exact = "x".repeat(MAX);
    expect(ok(exact)).toBeNull();
    expect(ok(exact + "x")).toMatch(/characters/);
    expect(ok("x".repeat(MAX_TEXT_CHARS + 1))).toMatch(/under 240/);
  });
  it("an empty text, a non-ASCII leftover, and a factsUsed key the facts do not have", () => {
    expect(ok("   ")).toMatch(/empty/);
    expect(ok("Quiet day \u{1F600}")).toMatch(/ASCII/);
    expect(ok("Quiet day.", ["position", "madeUpKey"])).toMatch(/madeUpKey/);
    expect(ok("Quiet day.", ["position", "spentYesterday"])).toBeNull();
  });
  it("folds curly quotes, dashes and ellipses to ASCII instead of refusing them", () => {
    expect(toGsm("It’s a “quiet” day — fine…")).toBe('It\'s a "quiet" day - fine...');
    expect(ok("It’s a quiet day — fine.")).toBeNull();
  });
  it("account-number-shaped digits", () => {
    expect(ok("Card 4242424242424242 used.")).toMatch(/not in the facts/);
  });
});

describe("the numbers a text may use come only from the facts", () => {
  it("a date allows its day of the month and nothing else of it", () => {
    const a = allowedNumbers(randomFacts(3));
    expect(a.counts.has("9.00")).toBe(true); // 2026-10-09
    expect(a.counts.has("2026.00")).toBe(false);
  });
  it("safeName strips digits, punctuation and forbidden words", () => {
    expect(safeName("Car 401k!!")).toBe("Car k");
    expect(safeName("1234")).toBe("Other");
    expect(safeName("Shame spending", "X")).toBe("X");
    expect(safeName("  Eat & Drink  ")).toBe("Eat & Drink");
    expect(safeName(null, "Unfiled")).toBe("Unfiled");
  });
});

describe("template branches", () => {
  const base = randomFacts(11);
  const quiet: RecapFacts = {
    ...base,
    spentYesterday: { total: 0, count: 0, topCategories: [] },
    lateArrivals: { count: 0, total: 0, fromDate: null, fromWeekday: null },
    billsNext3Days: [],
    reviewCount: 0,
    categorizationReviewCount: 0,
    needsLookCount: 0,
    nextStep: null,
    action: null,
    findings: [],
    freshness: { stale: false, staleReason: null, asOfBank: "2026-10-06T12:00:00.000Z", daysSinceBank: 1 },
    progress: { lowerThanLastWeek: false, debtPayment: false },
    position: { ...base.position, availableUntilPayday: 1234, paydayDate: "2026-10-09", paydayWeekday: "Fri", horizonKind: "payday" },
    weekToDate: { spent: 100, cap: 250, remainingWeek: 150, withinPlan: "yes" },
  };

  it("normal: yesterday's total and top categories, on track, free until payday, bills, a charge to look at", () => {
    const f: RecapFacts = {
      ...quiet,
      spentYesterday: { total: 92.4, count: 3, topCategories: [{ name: "Groceries", total: 50 }, { name: "Dining", total: 12.4 }] },
      billsNext3Days: [{ name: "Electric", date: "2026-10-08", weekday: "Thu", amount: 90, dueTomorrow: true }],
      reviewCount: 1,
      needsLookCount: 1,
      nextStep: "review",
    };
    expect(renderRecapTemplate(f)).toBe(
      "Yesterday: $92 spent (Groceries $50, Dining $12). Checking covers $1,234 until Fri. On track this week. 1 charge needs a look. Due soon: Electric $90 tomorrow.",
    );
  });

  it("no spending: says nothing was spent only when the bank is fresh", () => {
    expect(renderRecapTemplate(quiet)).toBe("Yesterday: nothing spent. Checking covers $1,234 until Fri. On track this week.");
  });

  it("stale: says how old the bank data is and never claims nothing was spent", () => {
    const stale: RecapFacts = {
      ...quiet,
      freshness: { stale: true, staleReason: "old", asOfBank: "2026-10-03T12:00:00.000Z", daysSinceBank: 4 },
    };
    const t = renderRecapTemplate(stale);
    expect(t).toContain("Bank data last updated 4 days ago; figures may be incomplete.");
    expect(t).not.toMatch(/nothing spent/i);
    const one = renderRecapTemplate({ ...stale, freshness: { ...stale.freshness, daysSinceBank: 1 } });
    expect(one).toContain("last updated 1 day ago");
    const unknown = renderRecapTemplate({ ...stale, freshness: { ...stale.freshness, daysSinceBank: null } });
    expect(unknown).toContain("Bank data may be out of date; figures may be incomplete.");
    // With spending, both are said.
    const both = renderRecapTemplate({ ...stale, spentYesterday: { total: 40, count: 1, topCategories: [] } });
    expect(both).toContain("Yesterday: $40 spent.");
    expect(both).toContain("figures may be incomplete");
  });

  it("late arrivals: names the weekday they came from", () => {
    const t = renderRecapTemplate({ ...quiet, lateArrivals: { count: 2, total: 60, fromDate: "2026-10-05", fromWeekday: "Mon" } });
    expect(t).toContain("Arrived late: $60 from Mon.");
  });

  it("progress: one line, only when a flag is set", () => {
    expect(renderRecapTemplate(quiet)).not.toMatch(/lower than|debt payment/i);
    expect(renderRecapTemplate({ ...quiet, progress: { lowerThanLastWeek: true, debtPayment: false } })).toContain("Spending is lower than last Tue so far.");
    const both = renderRecapTemplate({ ...quiet, progress: { lowerThanLastWeek: true, debtPayment: true } });
    expect(both).toContain("A debt payment went through.");
    expect(both).not.toContain("lower than");
  });

  it("no payday in sight: free through Saturday; no cap, no plan words", () => {
    const t = renderRecapTemplate({
      ...quiet,
      position: { ...quiet.position, horizonKind: "week_end", paydayDate: null, paydayWeekday: null },
      weekToDate: { spent: 0, cap: null, remainingWeek: null, withinPlan: null },
    });
    expect(t).toBe("Yesterday: nothing spent. Checking covers $1,234 until Saturday.");
  });

  it("at most one next step and at most one finding; an already-surfaced or stale-bank finding is not repeated", () => {
    const withFindings: RecapFacts = {
      ...quiet,
      findings: [
        { id: "a", kind: "bank_stale", severity: "high", summary: "bank data is out of date", surfaced: false },
        { id: "b", kind: "bill_increase", severity: "watch", summary: "x", surfaced: true },
        { id: "c", kind: "shortfall_before_income", severity: "high", summary: "y", surfaced: false },
        { id: "d", kind: "limit_near", severity: "watch", summary: "z", surfaced: false },
      ],
    };
    const t = renderRecapTemplate(withFindings);
    expect(t).toContain("Cash looks tight before payday.");
    expect(t).not.toContain("weekly limit");
    expect(t).not.toContain("higher than usual");
  });

  it("never carries an exclamation mark, a question mark, or a link", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const t = renderRecapTemplate(randomFacts(seed), { maxLen: MAX });
      expect(t).not.toMatch(/[!?]|https?:/);
    }
  });
});
