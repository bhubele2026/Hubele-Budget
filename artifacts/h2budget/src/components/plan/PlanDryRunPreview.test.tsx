import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { PlanDryRunPreview, reserveLine } from "./PlanDryRunPreview";
import { planRefusalReason, planErrorWords } from "@/lib/planWords";

/** (F4) The plan dialog's preview: each reserve is its parts, to the cent. Synthetic. */
const reserve = (o: Record<string, string> = {}) => ({ amount: "240.00", onCurve: "240.00", basis: "plan", incurred: "120.00", paid: "0.00", carried: "0.00", allowanceLeft: "120.00", ...o });
const occ = (i: number, after: Record<string, string> = {}, before: unknown = reserve({ amount: "450.00", incurred: "120.00", allowanceLeft: "330.00" })) =>
  ({ planKey: `ws|2026-10-${10 + i}`, hook: "weekly", occurrenceDate: `2026-10-${10 + i}`, label: "Weekly Spend", before, after: reserve(after), cards: [] }) as never;
const dry = (n: number) =>
  ({
    dryRun: true, allowed: true, reason: null, plan: { period: "weekly", amount: "300.00", effectiveFrom: "2026-10-11" },
    occurrences: Array.from({ length: n }, (_, i) => occ(i + 1)),
    lowPoint: { before: { amount: "1941.95", date: "2026-10-20" }, after: { amount: null, date: null } },
  }) as never;

afterEach(() => cleanup());
const cents = (v: string) => Math.round(Number(v) * 100);

describe("reserveLine", () => {
  it("before → after = card purchases + carried + left to spend", () => {
    expect(reserveLine(occ(7))).toBe("Weekly Spend reserve $450.00 → $240.00 = card purchases $120.00 + carried $0.00 + left to spend $120.00");
  });

  it("already-paid shows only when there is some, so the parts always add to the reserve", () => {
    const a = reserve({ amount: "290.00", incurred: "240.00", paid: "50.00", carried: "0.00", allowanceLeft: "0.00" });
    const line = reserveLine({ ...(occ(1) as object), after: a } as never);
    expect(line).toContain("card purchases $240.00 + already paid $50.00 + carried $0.00 + left to spend $0.00");
    expect(cents(a.incurred) + cents(a.paid) + cents(a.carried) + cents(a.allowanceLeft)).toBe(cents(a.amount));
  });

  it("no reserve before says 'none'", () => {
    expect(reserveLine(occ(1, {}, null))).toContain("reserve none → $240.00");
  });
});

describe("the preview", () => {
  it("shows four Saturdays and folds the rest; the low point is unknown-safe", () => {
    render(<PlanDryRunPreview dry={dry(6)} />);
    expect(screen.getAllByTestId("dry-occurrence")).toHaveLength(6);
    const more = screen.getByTestId("dry-more");
    expect(within(more).getAllByTestId("dry-occurrence")).toHaveLength(2);
    expect(screen.getByTestId("dry-low").textContent).toContain("$1,941.95 on Tue Oct 20 → —");
  });
});

describe("plan refusal words", () => {
  it("reads the server's reason from a 409 plan_unsafe, and only then", () => {
    const refused = { status: 409, data: { code: "plan_unsafe", reason: "Choose how Platinum is paid first.", error: "x" } };
    expect(planRefusalReason(refused)).toBe("Choose how Platinum is paid first.");
    expect(planErrorWords(refused)).toBe("Choose how Platinum is paid first.");
    expect(planRefusalReason({ status: 409, data: null })).toBeNull();
    expect(planErrorWords({ status: 409, data: null })).toBe("That conflicts with another entry. Check the date.");
    expect(planRefusalReason({ status: 403 })).toBeNull();
  });
});
