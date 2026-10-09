import { describe, it, expect } from "vitest";
import {
  MODE_LADDER,
  backlogLine,
  bandWord,
  bankLine,
  engineLine,
  fullDate,
  requirementFigure,
  resolutionWord,
  runResultLine,
  sourceWord,
  unreviewedLine,
} from "./automationWords";

// (F5) Ported from h2's `household/automation.test.tsx` "Automation words".

describe("Automation words", () => {
  it("map every source, band and resolution", () => {
    expect(["rule", "memory", "recurring", "inherited", "model", "user"].map((s) => sourceWord(s as never))).toEqual([
      "Rule",
      "Memory",
      "Recurring",
      "Carried over",
      "Model",
      "You",
    ]);
    expect(["auto", "provisional", "queue"].map((b) => bandWord(b as never))).toEqual(["Filed", "Provisional", "Queued"]);
    expect(resolutionWord({ resolution: "accepted", resolvedBy: "user" })).toBe("Accepted");
    expect(resolutionWord({ resolution: "corrected", resolvedBy: "user" })).toBe("Corrected");
    expect(resolutionWord({ resolution: "skipped", resolvedBy: "user" })).toBe("Skipped");
    expect(resolutionWord({ resolution: "unreviewed", resolvedBy: "silent" })).toBe("Unreviewed");
    // An old accepted + silent row never reads as anything but Accepted.
    expect(resolutionWord({ resolution: "accepted", resolvedBy: "silent" })).toBe("Accepted");
    expect(resolutionWord({ resolution: null, resolvedBy: null } as never)).toBe("Waiting");
  });

  it("figures, dates, backlog, run result, bank and engine lines", () => {
    expect(requirementFigure({ key: "judged", current: 18, target: 30 })).toBe("18 of 30 verified");
    expect(requirementFigure({ key: "accuracy", current: 16, target: 18 })).toBe("16 of 18 right");
    expect(requirementFigure({ key: "ai", current: 1, target: 1 })).toBeNull();
    expect(fullDate("2026-03-04")).toBe("Mar 4, 2026");
    expect(backlogLine({ unfiled: 1, oldestUnfiledOn: "2025-12-31" })).toBe("Unfiled charges: 1 · oldest Dec 31, 2025");
    expect(backlogLine({ unfiled: 0, oldestUnfiledOn: "2025-12-31" })).toBe("Unfiled charges: 0");
    expect(runResultLine({ filed: 0, suggested: 1, queued: 2, unreviewed: 3 })).toBe(
      "Filed 0 · Suggested 1 (provisional) · 2 need a look · 3 left unchanged",
    );
    expect(bankLine({ name: null, lastDataOn: null, lastSyncedAt: null, autoUpdates: { on: false, reason: "no_url" } })).toBe(
      "Bank · data through not yet · last synced not yet · Automatic updates Off",
    );
    // (WP3) Two dates, each named: the newest bank row, and the last sync on the
    // household's calendar (03:00 UTC on Oct 8 is still Oct 7 in Chicago).
    expect(bankLine({ name: "Chase", lastDataOn: "2026-10-05", lastSyncedAt: "2026-10-08T03:00:00Z", autoUpdates: { on: true, reason: "ok" } })).toBe(
      "Chase · data through Oct 5, 2026 · last synced Oct 7, 2026 · Automatic updates On",
    );
    expect(engineLine({ rules: 0, learned: 1, recurring: 2 })).toBe(
      "Rules you wrote: 0 · Learned from your corrections: 1 · Recurring bills: 2",
    );
    expect(unreviewedLine(4)).toBe("Left unchanged, not verified: 4");
  });

  it("the ladder, in order", () => {
    expect(MODE_LADDER.map((m) => m.key)).toEqual(["off", "suggest", "auto"]);
  });
});
