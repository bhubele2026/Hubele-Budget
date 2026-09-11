import { describe, it, expect } from "vitest";
import { applyResolutionWrite, withResolutionWrite } from "./forecastResolutionCache";
import type { Resolution } from "./forecastMatch";

// (PR5b second review N2) The cached bundle must read exactly as the table
// will after the write, or the refetch window re-offers what was answered.

const r = (id: string, status: string, plan: string | null, txn: string | null, extra: Partial<Resolution> = {}): Resolution => ({
  id,
  status,
  recurringItemId: plan ? plan.split("|")[0] : null,
  occurrenceDate: plan ? plan.split("|")[1] : null,
  matchedTxnId: txn,
  ...extra,
});
const ids = (list: Resolution[]) => list.map((x) => `${x.status}:${x.id}`).sort();

describe("applyResolutionWrite mirrors POST /forecast/resolutions", () => {
  it("'Not this' replaces the identical pair's match, partial or earlier rejection — nothing else", () => {
    const list = [
      r("m", "matched", "water|2026-05-20", "t1"),
      r("n-old", "not_match", "water|2026-05-20", "t1"),
      r("other", "matched", "rent|2026-05-22", "t2"),
      r("n-other", "not_match", "water|2026-05-20", "t9"),
    ];
    const out = applyResolutionWrite(list, r("n", "not_match", "water|2026-05-20", "t1"));
    expect(ids(out)).toEqual(["matched:other", "not_match:n", "not_match:n-other"]);
  });

  it("a match keeps a rejection of another row for the same plan, and clears the identical pair's rejection", () => {
    const list = [
      r("n1", "not_match", "water|2026-05-20", "t1"),
      r("n2", "not_match", "water|2026-05-20", "t2"),
      r("miss", "missed", "water|2026-05-20", null),
      r("ign", "ignored_unforecasted", null, "t2"),
    ];
    const out = applyResolutionWrite(list, r("m", "matched", "water|2026-05-20", "t2"));
    expect(ids(out)).toEqual(["matched:m", "not_match:n1"]);
  });

  it("a partial keeps the plan's reschedule; a match does not", () => {
    const moved = r("mv", "rescheduled", "rent|2026-05-22", null, { rescheduledTo: "2026-05-25" });
    expect(ids(applyResolutionWrite([moved], r("p", "partial", "rent|2026-05-22", "t1")))).toEqual([
      "partial:p",
      "rescheduled:mv",
    ]);
    expect(ids(applyResolutionWrite([moved], r("m", "matched", "rent|2026-05-22", "t1")))).toEqual(["matched:m"]);
  });

  it("withResolutionWrite updates a bundle's resolutions and passes anything else through", () => {
    const bundle = { today: "2026-05-14", resolutions: [r("m", "matched", "water|2026-05-20", "t1")] };
    const next = withResolutionWrite(bundle, r("n", "not_match", "water|2026-05-20", "t1"));
    expect(next.today).toBe("2026-05-14");
    expect(ids(next.resolutions)).toEqual(["not_match:n"]);
    expect(bundle.resolutions).toHaveLength(1);
    expect(withResolutionWrite(undefined, r("n", "not_match", "x|y", "t"))).toBeUndefined();
    expect(withResolutionWrite({ matches: [] }, r("n", "not_match", "x|y", "t"))).toEqual({ matches: [] });
  });
});
