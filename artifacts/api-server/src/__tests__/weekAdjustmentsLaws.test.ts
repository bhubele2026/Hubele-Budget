// (V5) "Never for the agent", enforced by reading source (the pattern of
// askLaws.test.ts's memory scan):
//   1. Nothing under src/ai — directly or through anything it imports, however
//      deep — reaches the plan-adjustment writer (`lib/weekAdjustments.ts`) or
//      the ways-back maths (`computeWaysBack`, avalanche-core `waysBack.ts`).
//   2. Nothing in that closure writes `plan_adjustments` (insert / update /
//      delete). The money position READS the table — the agent may see a
//      carry-over the household chose — but nothing it can reach may make one.
//   3. The agent's tool registry has no tool that names an adjustment, and no
//      job may write one either.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..");
const ROOT = resolve(SRC, "../../..");
const WRITER = join(SRC, "lib/weekAdjustments.ts");
const WAYS_BACK = join(ROOT, "lib/avalanche-core/src/waysBack.ts");
const NAMES = /weekAdjustments|waysBack|computeWaysBack|upsertCarryOver|deleteCarryOver|buildWaysBack/;
const WRITES = /\.(?:insert|update|delete)\(\s*planAdjustmentsTable\b|(?:insert\s+into|update|delete\s+from)\s+plan_adjustments\b/i;

const tsFiles = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
      });

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [`${base}.ts`, join(base, "index.ts"), base]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of importsOf(f)) {
      const r = resolveImport(f, spec);
      if (r) stack.push(r);
    }
  }
  return seen;
}

const rel = (f: string) => f.slice(ROOT.length + 1);

describe("⚠️ (V5) the agent never reaches a week adjustment", () => {
  const aiFiles = tsFiles(join(SRC, "ai"));
  const reach = closure(aiFiles);

  it("the scan is live: src/ai is there, and it reaches the money position (which reads the table)", () => {
    expect(aiFiles.length).toBeGreaterThan(10);
    expect(existsSync(WRITER)).toBe(true);
    expect(existsSync(WAYS_BACK)).toBe(true);
    expect(reach.has(join(SRC, "lib/moneyPosition.ts"))).toBe(true);
    expect(readFileSync(join(SRC, "lib/moneyPosition.ts"), "utf8")).toMatch(/planAdjustmentsTable/);
  });

  it("nothing src/ai imports, however deep, is the writer or names the ways-back maths", () => {
    expect(reach.has(WRITER)).toBe(false);
    for (const f of reach) expect(NAMES.test(readFileSync(f, "utf8")), `${rel(f)} must not reach the adjustment writer`).toBe(false);
  });

  it("nothing in that closure writes plan_adjustments", () => {
    for (const f of reach) expect(WRITES.test(readFileSync(f, "utf8")), `${rel(f)} must not write plan_adjustments`).toBe(false);
  });

  it("the scan would catch it: the writer itself writes, and the money routes import it", () => {
    expect(WRITES.test(readFileSync(WRITER, "utf8"))).toBe(true);
    expect(NAMES.test(readFileSync(join(SRC, "routes/money.ts"), "utf8"))).toBe(true);
  });

  it("the tool registry has no adjustment tool", () => {
    const tools = tsFiles(join(SRC, "ai/tools"));
    expect(tools.length).toBeGreaterThan(0);
    const names = tools.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    expect(names).toContain("get_position");
    for (const n of names) expect(n, n).not.toMatch(/adjust|carry|ways_back|week_lower/);
    for (const f of tools) expect(/plan_adjustments|planAdjustments|week-adjustments|carry_over/.test(readFileSync(f, "utf8")), rel(f)).toBe(false);
  });

  it("only the money routes write it: no job, monitor or other module imports the writer", () => {
    const importers = tsFiles(SRC).filter((f) => /["'](?:\.\.?\/)+(?:lib\/)?weekAdjustments["']/.test(readFileSync(f, "utf8")));
    expect(importers.map(rel)).toEqual(["artifacts/api-server/src/routes/money.ts"]);
    const writers = tsFiles(SRC).filter((f) => WRITES.test(readFileSync(f, "utf8")));
    expect(writers.map(rel)).toEqual(["artifacts/api-server/src/lib/weekAdjustments.ts"]);
  });
});
