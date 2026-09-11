import { describe, expect, it } from "vitest";
import { pickRemintCandidate } from "./remintMatch";

const row = (id: string, oldPtid: string | null, occurredOn: string) => ({ id, oldPtid, occurredOn });

describe("pickRemintCandidate", () => {
  it("adopts nothing when every candidate's old id still exists — a second real charge", () => {
    const live = new Set(["A"]);
    expect(pickRemintCandidate([row("r1", "A", "2026-09-10")], "2026-09-11", (c) => !live.has(c.oldPtid))).toBeNull();
  });

  it("adopts a candidate whose old id is gone", () => {
    const picked = pickRemintCandidate([row("r1", "A", "2026-09-10")], "2026-09-10", (c) => c.oldPtid === "A");
    expect(picked?.id).toBe("r1");
  });

  it("skips live candidates and takes the gone one", () => {
    const picked = pickRemintCandidate(
      [row("r1", "LIVE", "2026-09-10"), row("r2", "GONE", "2026-09-12")],
      "2026-09-10",
      (c) => c.oldPtid === "GONE",
    );
    expect(picked?.id).toBe("r2");
  });

  it("prefers the nearest date, then the id, among gone candidates", () => {
    const all = () => true;
    expect(
      pickRemintCandidate([row("r1", "A", "2026-09-08"), row("r2", "B", "2026-09-11")], "2026-09-10", all)?.id,
    ).toBe("r2");
    expect(
      pickRemintCandidate([row("r9", "A", "2026-09-09"), row("r3", "B", "2026-09-11")], "2026-09-10", all)?.id,
    ).toBe("r3");
  });

  it("hands the whole candidate to the evidence check, and never offers a row with no Plaid id", () => {
    const seen: string[] = [];
    const picked = pickRemintCandidate(
      [
        { ...row("r1", null, "2026-09-10"), occurredOnUserOverridden: false },
        { ...row("r2", "A", "2026-09-09"), occurredOnUserOverridden: true },
      ],
      "2026-09-10",
      (c) => {
        seen.push(`${c.id}:${c.occurredOn}`);
        return !c.occurredOnUserOverridden;
      },
    );
    expect(seen).toEqual(["r2:2026-09-09"]);
    expect(picked).toBeNull();
  });
});
