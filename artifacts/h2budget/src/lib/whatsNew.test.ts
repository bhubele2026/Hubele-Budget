import { describe, it, expect } from "vitest";
import { addDaysISO, householdToday } from "@workspace/avalanche-core/householdTime";
import {
  READ_CLICK_FROM,
  WHATS_NEW,
  WHATS_NEW_ID,
  formatDay,
  formatReadDay,
  isKnownUpdateId,
  readLines,
  startFor,
  unreadUpdates,
  type WhatsNewUpdate,
} from "@workspace/avalanche-core/whatsNew";

/**
 * ⭐ THE WHAT'S NEW NOTES, HELD TO THEIR RULES (owner, 2026-10-15: "so my wife
 * can actually see what's changing as I update"). Written for the people who
 * use H2: short, newest first, real days, plain words — no version numbers,
 * package codes, system names, code words or cents, and the app is "H2", never
 * "I". The notes live in `lib/avalanche-core/src/whatsNew.ts`; this file runs
 * in the web suite (no database) under every timezone CI uses.
 */

// Code words and system names never reach the people reading this.
const BANNED =
  /\b(v\d+|version|commit|deploy(ed|s|ment)?|refactor|api|endpoint|component|query|queries|cache|schema|migration|database|server|backend|frontend|hook|webhook|bug ?fix|regression|plaid|spine|clerk|render|sentry|drizzle|orval|codegen|json|sql|pg-boss|ledger)\b/i;
// Package codes (F2, Q5, WP5b, PR-0, C11b) — "H2" is the app's name, not a code.
const PACKAGE_CODE = /\b(?!H2\b)[A-Z]{1,4}-?\d{1,3}[a-z]?\b/;
const CENTS = /\$\d[\d,]*\.\d{2}\b/;
// The app is "H2", never "I".
const FIRST_PERSON = /\bI\b|\bI'(m|ve|ll|d)\b/;

const everyText = (u: WhatsNewUpdate): string[] => [u.headline, ...u.items.flatMap((i) => [i.title, i.body])];

describe("the notes", () => {
  it("ids are unique, real days, newest first, and none is dated after tomorrow", () => {
    const ids = WHATS_NEW.map((u) => u.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort().reverse());
    const tomorrow = addDaysISO(householdToday(new Date()), 1);
    for (const id of ids) {
      expect(id, id).toMatch(WHATS_NEW_ID);
      const day = id.slice(0, 10);
      expect(addDaysISO(day, 0), `${id} is a real day`).toBe(day);
      expect(day <= tomorrow, `${id} is not in the future (a mistyped year?)`).toBe(true);
    }
  });

  it("the click starts at a real note", () => {
    expect(WHATS_NEW.some((u) => u.id === READ_CLICK_FROM)).toBe(true);
  });

  it("short enough to read on a phone", () => {
    for (const u of WHATS_NEW) {
      expect(u.headline.length, `${u.id} headline`).toBeLessThanOrEqual(60);
      expect(u.items.length, `${u.id} items`).toBeGreaterThanOrEqual(1);
      expect(u.items.length, `${u.id} items`).toBeLessThanOrEqual(6);
      for (const i of u.items) {
        expect(i.title.length, `${u.id} "${i.title}"`).toBeLessThanOrEqual(50);
        expect(i.body.length, `${u.id} "${i.title}" body`).toBeLessThanOrEqual(200);
      }
      for (const t of everyText(u)) {
        expect(t.length, `${u.id}: empty text`).toBeGreaterThan(0);
        expect(t, `${u.id}: stray spaces in "${t}"`).toBe(t.trim());
      }
    }
  });

  it("no version numbers, package codes, code words, system names or cents; the app is H2, never I", () => {
    for (const u of WHATS_NEW)
      for (const t of everyText(u)) {
        expect(t, `${u.id}: ${t}`).not.toMatch(BANNED);
        expect(t, `${u.id}: ${t}`).not.toMatch(PACKAGE_CODE);
        expect(t, `${u.id}: ${t}`).not.toMatch(CENTS);
        expect(t, `${u.id}: ${t}`).not.toMatch(FIRST_PERSON);
      }
  });

  it("the guards bite (each pattern catches what it is for)", () => {
    for (const bad of ["v12 is out", "We deployed it", "A new API", "Plaid sync", "the spine", "Faster cache"]) expect(bad).toMatch(BANNED);
    for (const bad of ["Done in F2", "Q5 and WP5b", "PR-0 shipped", "C11b"]) expect(bad).toMatch(PACKAGE_CODE);
    expect("H2 says so").not.toMatch(PACKAGE_CODE);
    expect("It costs $12.50").toMatch(CENTS);
    expect("It costs $12").not.toMatch(CENTS);
    for (const bad of ["I made it", "I've added", "Now I'll show"]) expect(bad).toMatch(FIRST_PERSON);
    expect("H2 shows it").not.toMatch(FIRST_PERSON);
  });

  it("isKnownUpdateId knows exactly the shipped notes", () => {
    for (const u of WHATS_NEW) expect(isKnownUpdateId(u.id)).toBe(true);
    expect(isKnownUpdateId("2020-01-01")).toBe(false);
    expect(isKnownUpdateId("h2-1")).toBe(false);
  });
});

const fixture: WhatsNewUpdate[] = [
  { id: "2026-11-02.2", headline: "Newest", items: [{ title: "a", body: "b" }] },
  { id: "2026-11-02", headline: "Same day", items: [{ title: "a", body: "b" }] },
  { id: "2026-10-20", headline: "Middle", items: [{ title: "a", body: "b" }] },
  { id: "2026-10-01", headline: "Before the click", items: [{ title: "a", body: "b" }] },
];

describe("helpers", () => {
  it("unreadUpdates: every note from `from` on that is not read", () => {
    const ids = (r: WhatsNewUpdate[]) => r.map((u) => u.id);
    expect(ids(unreadUpdates(fixture, new Set(), "2026-10-15"))).toEqual(["2026-11-02.2", "2026-11-02", "2026-10-20"]);
    // Each read is its own: reading the newest leaves the older ones in front of them.
    expect(ids(unreadUpdates(fixture, new Set(["2026-11-02.2"]), "2026-10-15"))).toEqual(["2026-11-02", "2026-10-20"]);
    expect(ids(unreadUpdates(fixture, new Set(["2026-11-02.2", "2026-11-02", "2026-10-20"]), "2026-10-15"))).toEqual([]);
    // A person who joined later starts later: the note from before their start is history.
    expect(ids(unreadUpdates(fixture, new Set(), "2026-10-21"))).toEqual(["2026-11-02.2", "2026-11-02"]);
    // A suffixed id sorts after its day.
    expect(ids(unreadUpdates(fixture, new Set(), "2026-11-02"))).toEqual(["2026-11-02.2", "2026-11-02"]);
    // The old interim app's seen id is not a read of anything.
    expect(ids(unreadUpdates(fixture, new Set(["h2-1"]), "2026-10-15"))).toHaveLength(3);
  });

  it("startFor: the click's start, or the day after joining when that is later", () => {
    expect(startFor(null)).toBe(READ_CLICK_FROM);
    expect(startFor("2026-09-01")).toBe(READ_CLICK_FROM);
    // Joined the day the first note shipped: that note is not theirs to read.
    expect(startFor(READ_CLICK_FROM)).toBe(addDaysISO(READ_CLICK_FROM, 1));
    expect(startFor("2026-12-31")).toBe("2027-01-01");
    expect(startFor(addDaysISO(READ_CLICK_FROM, -1))).toBe(READ_CLICK_FROM);
  });

  it("formatDay names the day the same in every timezone, with or without a suffix", () => {
    expect(formatDay("2026-10-15")).toBe("Thursday, October 15");
    expect(formatDay("2026-10-15.2")).toBe("Thursday, October 15");
    expect(formatDay("2026-11-01")).toBe("Sunday, November 1");
  });

  it("formatReadDay is the household's day (Central), not the browser's or UTC's", () => {
    // 03:30 UTC on the 16th is still the evening of the 15th in Chicago.
    expect(formatReadDay("2026-10-16T03:30:00Z")).toBe("Thursday, October 15");
    expect(formatReadDay("2026-10-16T05:30:00Z")).toBe("Friday, October 16");
  });

  it("readLines: the owner's words under a note", () => {
    expect(readLines([])).toEqual([]);
    expect(readLines([{ name: "Jen", readAt: "2026-10-15T18:00:00Z" }])).toEqual(["Read by Jen on Thursday, October 15"]);
    expect(readLines([{ name: "Jen", readAt: null }])).toEqual(["Not read yet"]);
    expect(
      readLines([
        { name: "Jen", readAt: "2026-10-16T03:30:00Z" },
        { name: "Alex", readAt: null },
      ]),
    ).toEqual(["Read by Jen on Thursday, October 15", "Not read yet by Alex"]);
  });
});
