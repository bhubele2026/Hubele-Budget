// (AI-2) Two laws, enforced by reading source.
//   1. Memory never touches a money figure: nothing the money readers import,
//      directly or through anything they import, reaches the memory module.
//   2. The model never reaches a plan writer: nothing under src/ai names the
//      proposal applier or the writers it calls.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "..");
const ROOT = resolve(SRC, "../../..");
const MEMORY = /agentMemory|agent_memory|agentMemoryTable/;

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

describe("⚠️ memory never feeds a money figure", () => {
  const entries = ["moneyPosition", "forecastLedger", "cashSignal", "spendingFacts", "budgetActuals"].map((n) => join(SRC, "lib", `${n}.ts`));

  it("the money readers exist (the scan is live)", () => {
    for (const e of entries) expect(existsSync(e), e).toBe(true);
    expect(closure(entries).size).toBeGreaterThan(entries.length);
  });

  it("nothing they import, however deep, names the memory module or table", () => {
    for (const f of closure(entries)) {
      expect(MEMORY.test(readFileSync(f, "utf8")), `${f.slice(SRC.length + 1)} must not touch memory`).toBe(false);
    }
  });

  it("nothing in lib/avalanche-core names it", () => {
    const core = tsFiles(join(ROOT, "lib/avalanche-core/src"));
    expect(core.length).toBeGreaterThan(5);
    for (const f of core) expect(MEMORY.test(readFileSync(f, "utf8")), f).toBe(false);
  });

  it("the scan would catch it: the agent's own tools do import memory", () => {
    expect(MEMORY.test(readFileSync(join(SRC, "ai/tools/index.ts"), "utf8"))).toBe(true);
  });
});

describe("⚠️ the model never reaches a plan writer", () => {
  const WRITERS = /proposalApply|allowancePlanWriter|writeOwnerAllowancePlan|allowancePlansTable|allowance_plans|syncAvalanchePaymentCategory/;
  it("no file under src/ai names the applier or a writer it calls", () => {
    const files = tsFiles(join(SRC, "ai"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(WRITERS.test(readFileSync(f, "utf8")), f.slice(SRC.length + 1)).toBe(false);
  });
  it("only the approve route imports the applier", () => {
    const importers = [...tsFiles(SRC)].filter((f) => /["']\.\.?\/(?:lib\/)?proposalApply["']/.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => f.slice(SRC.length + 1))).toEqual(["routes/ai.ts"]);
  });
});
