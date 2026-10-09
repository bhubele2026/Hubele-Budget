import { describe, it, expect, afterEach } from "vitest";
import { PROMPTS, resolvePrompt } from "../ai/prompts";
import { recapV2 } from "../ai/prompts/recap.v2";
import { recapV3 } from "../ai/prompts/recap.v3";

// (Dashboard refinement, owner-approved 2026-10-09) The morning text names
// `availableUntilPayday` the way the dashboard does: "Checking covers $X until
// <weekday>". "Room in the plan" named a different figure on the dashboard.
describe("recap.v3 — the cash sentence in the dashboard's words", () => {
  afterEach(() => {
    delete process.env.AI_PROMPT_RECAP;
  });

  it("asks for \"Checking covers $X until <day>\" and never \"Room in the plan\"", () => {
    expect(recapV3.PROMPT_VERSION).toBe("recap.v3");
    expect(recapV3.system).toContain("Checking covers $1,234 until Fri");
    expect(recapV3.system).toContain("Checking covers $1,234 until Saturday");
    expect(recapV3.system).not.toMatch(/room in the plan/i);
  });

  it("changes nothing else: v2's text with the one sentence swapped, and the same message builder", () => {
    const strip = (t: string) => t.split("\n").filter((l) => !/room in the plan|checking covers/i.test(l)).join("\n");
    expect(strip(recapV3.system)).toBe(strip(recapV2.system));
    expect(recapV3.build).toBe(recapV2.build);
  });

  it("is the version that runs (newest), and v2 can still be pinned", () => {
    expect(PROMPTS.recap?.v3).toBe(recapV3);
    expect(resolvePrompt("recap")?.PROMPT_VERSION).toBe("recap.v3");
    process.env.AI_PROMPT_RECAP = "v2";
    expect(resolvePrompt("recap")?.PROMPT_VERSION).toBe("recap.v2");
  });
});
