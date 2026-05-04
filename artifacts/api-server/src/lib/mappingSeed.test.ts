import { describe, it, expect } from "vitest";
import { SEED_MAPPING_RULES } from "./mappingSeed";
import { SEED_CATEGORIES } from "./budgetSeed";

describe("SEED_MAPPING_RULES sanity check", () => {
  const seedCategoryNames = new Set(SEED_CATEGORIES.map((c) => c.name));

  it("every rule's categoryName resolves to a SEED_CATEGORIES entry", () => {
    const orphans = SEED_MAPPING_RULES.filter(
      (r) => !seedCategoryNames.has(r.categoryName),
    );
    expect(
      orphans,
      `These mapping-rule patterns point at categories that don't exist in SEED_CATEGORIES, so /budget/seed-defaults will silently drop them on every fresh signup:\n${orphans
        .map((o) => `  - "${o.pattern}" -> "${o.categoryName}"`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("patterns are unique (case-insensitive) so we never insert duplicate rules", () => {
    const seen = new Map<string, string>();
    const dupes: { pattern: string; first: string; second: string }[] = [];
    for (const r of SEED_MAPPING_RULES) {
      const key = r.pattern.toLowerCase();
      if (seen.has(key)) {
        dupes.push({ pattern: r.pattern, first: seen.get(key)!, second: r.categoryName });
      } else {
        seen.set(key, r.categoryName);
      }
    }
    expect(
      dupes,
      `Duplicate seed patterns:\n${dupes.map((d) => `  "${d.pattern}" -> ${d.first} / ${d.second}`).join("\n")}`,
    ).toEqual([]);
  });

  it("patterns are non-empty and at least 3 characters (matches autoCategorize threshold)", () => {
    const tooShort = SEED_MAPPING_RULES.filter((r) => !r.pattern || r.pattern.length < 3);
    expect(tooShort, `Patterns shorter than 3 chars: ${JSON.stringify(tooShort)}`).toEqual([]);
  });
});
