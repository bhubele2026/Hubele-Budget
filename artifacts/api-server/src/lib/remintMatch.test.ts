import { describe, expect, it } from "vitest";
import { laterRowIsNearer, pickRemintCandidate, type RemintBatchEntry } from "./remintMatch";

const entry = (id: string, date: string, extra: Partial<RemintBatchEntry> = {}): RemintBatchEntry => ({
  id,
  accountId: "chase",
  date,
  signedAmount: "-25.00",
  namesPendingRow: false,
  onFileAtStart: false,
  firstCopy: true,
  ...extra,
});

describe("laterRowIsNearer", () => {
  it("defers to a later row strictly nearer the candidate's date — the re-mint, not the separate charge", () => {
    const batch = [entry("B", "2026-09-11"), entry("NEW", "2026-09-10")];
    expect(laterRowIsNearer(batch, 0, "2026-09-10")).toBe(true);
    expect(laterRowIsNearer(batch, 1, "2026-09-10")).toBe(false);
  });

  it("never defers to an earlier row, to itself, or on a tie with a later-dated row", () => {
    expect(laterRowIsNearer([entry("NEW", "2026-09-10"), entry("B", "2026-09-11")], 1, "2026-09-10")).toBe(false);
    expect(laterRowIsNearer([entry("B", "2026-09-11"), entry("B", "2026-09-10")], 0, "2026-09-10")).toBe(false);
    expect(laterRowIsNearer([entry("NEW", "2026-09-09"), entry("X", "2026-09-11")], 0, "2026-09-10")).toBe(false);
  });

  it("(PR4d-2) an exact tie goes to the earlier-dated row, whatever the list order", () => {
    expect(laterRowIsNearer([entry("X", "2026-09-11"), entry("NEW", "2026-09-09")], 0, "2026-09-10")).toBe(true);
    // Same date: the tie is left to list order (without institution times either pick moves cash the same way).
    expect(laterRowIsNearer([entry("X", "2026-09-11"), entry("Y", "2026-09-11")], 0, "2026-09-10")).toBe(false);
  });

  it("ignores later rows that cannot claim it: another account or amount, on file, naming a pending row, or a later copy", () => {
    const at = (extra: Partial<RemintBatchEntry>) =>
      laterRowIsNearer([entry("B", "2026-09-11"), entry("X", "2026-09-10", extra)], 0, "2026-09-10");
    expect(at({ accountId: "savings" })).toBe(false);
    expect(at({ signedAmount: "-26.00" })).toBe(false);
    expect(at({ onFileAtStart: true })).toBe(false);
    expect(at({ namesPendingRow: true })).toBe(false);
    expect(at({ firstCopy: false })).toBe(false);
    expect(at({})).toBe(true);
  });
});

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
