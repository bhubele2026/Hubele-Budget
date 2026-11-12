import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { CHART_ROUTES, routeImporters } from "./routePrefetch";
import { _resetPerfMarksForTests, markReady } from "./perfMarks";
import { _resetSpeculativeForTests, trackChunk, warmAllowedFor, whenForegroundIdle } from "./speculative";

const SRC = resolve(import.meta.dirname, "..");

// ── The chart table is the real import graph ────────────────────────────────
// Same edge rules as featuresImportGraph.test.ts: static, value-carrying imports only (`import(…)` is the lazy
// boundary, `import type` is erased).
function staticSpecs(code: string): string[] {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of src.matchAll(/\b(import|export)\s+(?!\()([^;]*?)\s+from\s+["']([^"']+)["']/gs)) {
    if (/^type\b/.test(m[2]!.trim())) continue;
    out.push(m[3]!);
  }
  for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}
function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile() && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}
function reachesRecharts(file: string): boolean {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of staticSpecs(readFileSync(f, "utf8"))) {
      if (spec === "recharts") return true;
      const next = resolveLocal(f, spec);
      if (next) queue.push(next);
    }
  }
  return false;
}
/** Each importer in routePrefetch.ts → the page file it imports. */
function importerFiles(): Map<string, string> {
  const code = readFileSync(join(SRC, "lib/routePrefetch.ts"), "utf8");
  const byName = new Map<string, string>();
  for (const m of code.matchAll(/export const (import\w+) = \(\) => import\("([^"]+)"\)/g)) {
    byName.set(m[1]!, resolveLocal(join(SRC, "lib/routePrefetch.ts"), m[2]!)!);
  }
  const out = new Map<string, string>();
  for (const href of Object.keys(routeImporters)) {
    const name = [...byName.keys()].find((n) => code.includes(`"${href}": ${n},`));
    expect(name, href).toBeTruthy();
    out.set(href, byName.get(name!)!);
  }
  return out;
}
describe("CHART_ROUTES (perf phase 2)", () => {
  it("is exactly the routes whose page statically reaches recharts", () => {
    const drawsCharts = [...importerFiles()].filter(([, f]) => reachesRecharts(f)).map(([h]) => h).sort();
    expect([...CHART_ROUTES].sort()).toEqual(drawsCharts);
  });
  it("positive controls: Forecast draws charts, the Banking command center does not", () => {
    const files = importerFiles();
    expect(reachesRecharts(files.get("/forecast")!)).toBe(true);
    expect(reachesRecharts(files.get("/banking")!)).toBe(false);
  });
});

// ── The device and network rule ─────────────────────────────────────────────
describe("warmAllowed", () => {
  const nav = (o: object) => o as Navigator;
  it("a normal connection and device may warm", () => {
    expect(warmAllowedFor(nav({ connection: { effectiveType: "4g" }, deviceMemory: 8 }))).toBe(true);
    expect(warmAllowedFor(nav({}))).toBe(true); // a browser that says nothing (Safari, Firefox)
  });
  it("never on Save-Data, 2G, slow 2G, 3G, or a ≤ 2 GB device", () => {
    expect(warmAllowedFor(nav({ connection: { saveData: true, effectiveType: "4g" } }))).toBe(false);
    for (const t of ["slow-2g", "2g", "3g"]) expect(warmAllowedFor(nav({ connection: { effectiveType: t } })), t).toBe(false);
    expect(warmAllowedFor(nav({ deviceMemory: 2 }))).toBe(false);
    expect(warmAllowedFor(nav({ deviceMemory: 1 }))).toBe(false);
    expect(warmAllowedFor(nav({ deviceMemory: 4 }))).toBe(true);
  });
  it("no navigator (not a browser): no", () => {
    expect(warmAllowedFor(undefined)).toBe(false);
  });
});

// ── The gate ────────────────────────────────────────────────────────────────
describe("whenForegroundIdle", () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    _resetPerfMarksForTests();
    _resetSpeculativeForTests();
    qc = new QueryClient();
  });
  afterEach(() => vi.useRealTimers());

  it("with no marks asked for: runs once the foreground is quiet, and only once", async () => {
    const run = vi.fn();
    whenForegroundIdle(qc, { quietMs: 400 }, run);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a mark arriving starts the check at once", async () => {
    const run = vi.fn();
    whenForegroundIdle(qc, { marks: ["h2:x"], quietMs: 0, checkMs: 10_000 }, run);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).not.toHaveBeenCalled();
    markReady("h2:x");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel stops it for good", async () => {
    const run = vi.fn();
    const cancel = whenForegroundIdle(qc, { quietMs: 400 }, run);
    cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("a chunk in flight holds it; a failed chunk lets go too", async () => {
    const run = vi.fn();
    let fail: (e: Error) => void = () => {};
    void trackChunk(new Promise<void>((_, r) => (fail = r))).catch(() => {});
    whenForegroundIdle(qc, { quietMs: 0 }, run);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    fail(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
