import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * (C0) `@/lib/charts` is the one door to recharts (its own header says pages
 * "do not reach for recharts directly"). reportsShared and the account balance
 * trend did; they now import the raw primitives from the kit.
 *
 * (C13) The forecast's `ProjectedBalanceChart.tsx`, the last exception,
 * moved with the forecast cut-over: no module but the kit imports recharts.
 * Do not add an exception.
 */
const SRC = join(import.meta.dirname, "..");
const ALLOWED = new Set(["lib/charts.tsx"]);

function files(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && name !== "test-recharts-stub.tsx") acc.push(p);
  }
  return acc;
}

const FROM_RECHARTS = /\bfrom\s+["']recharts["']/;
/** Code only: several comments QUOTE the import they forbid. */
const code = (f: string) =>
  readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("recharts comes through @/lib/charts", () => {
  it("no other module imports recharts directly", () => {
    const direct = files(SRC).map((f) => relative(SRC, f)).filter((f) => FROM_RECHARTS.test(code(f)));
    expect(direct.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });

  it("the three former direct importers now use the kit", () => {
    for (const f of [
      "pages/reports/reportsShared.tsx",
      "components/account-page/balance-trend-chart.tsx",
      "pages/forecast/ProjectedBalanceChart.tsx",
    ]) {
      const src = code(f);
      expect(src, f).not.toMatch(FROM_RECHARTS);
      expect(src, f).toMatch(/from "@\/lib\/charts";/);
    }
  });

  it("the jsdom recharts stub still covers every primitive the kit takes from recharts", () => {
    const kit = code("lib/charts.tsx");
    const stub = readFileSync(join(SRC, "test-recharts-stub.tsx"), "utf8");
    const stubbed = new Set(Array.from(stub.matchAll(/^export const (\w+)/gm), (m) => m[1]!));
    const used = new Set<string>();
    for (const m of kit.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*"recharts"/g)) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (name) used.add(name);
      }
    }
    expect(used.size).toBeGreaterThan(15);
    expect([...used].filter((n) => !stubbed.has(n))).toEqual([]);
  });
});
