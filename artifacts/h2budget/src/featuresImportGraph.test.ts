import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * (C0) THE LANDING PATH NEVER IMPORTS A SUB-MODULE OF THE GENERATED CLIENT.
 *
 * `@workspace/api-client-react` (the main module) is imported by the shell, so
 * Rollup keeps it whole in the entry chunk: every hook ANY page uses from it is
 * landing JS. The fold-in operations (spec tag `features`) and the Chase
 * page's own (`chase-ledger`) are therefore generated into sub-modules that
 * only lazy pages import. Two ways to undo that, both pinned here:
 *
 *  1. something on the entry path imports `/features` or `/ledger` — the whole
 *     sub-module joins the entry chunk;
 *  2. a page imports a `features` hook from the MAIN module — the main module
 *     still carries those operations (the frozen h2 app imports them from it
 *     until the switch), so the hook would quietly land in the entry chunk.
 *
 * The walk follows STATIC imports from `main.tsx` exactly as Rollup decides
 * what loads on open: `import(…)` (every `lazy()` route) is the boundary, and
 * `import type` is erased, so neither is an edge.
 */

const SRC = import.meta.dirname;
const FEATURES = "@workspace/api-client-react/features";
const LEDGER = "@workspace/api-client-react/ledger";
const MAIN = "@workspace/api-client-react";

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

type Edge = { spec: string; names: string[] };

/** Static, value-carrying import/export-from edges of one module. */
function staticEdges(code: string): Edge[] {
  const out: Edge[] = [];
  const src = stripComments(code);
  for (const m of src.matchAll(/\b(import|export)\s+(?!\()([^;]*?)\s+from\s+["']([^"']+)["']/gs)) {
    const clause = m[2]!.trim();
    if (/^type\b/.test(clause)) continue; // `import type …` / `export type …` — erased
    const names = Array.from(clause.matchAll(/(?:^|[{,])\s*(?!type\s)([A-Za-z_$][\w$]*)/g), (n) => n[1]!);
    out.push({ spec: m[3]!, names });
  }
  for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push({ spec: m[1]!, names: [] });
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // a package
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile() && /\.(ts|tsx)$/.test(cand)) return cand;
  }
  return null; // css, json, svg…
}

/** Every module the browser loads to open the app, with the packages each imports. */
function entryGraph(): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  const queue = [join(SRC, "main.tsx")];
  while (queue.length) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const edges = staticEdges(readFileSync(file, "utf8"));
    graph.set(file, edges);
    for (const e of edges) {
      const next = resolveLocal(file, e.spec);
      if (next && !graph.has(next)) queue.push(next);
    }
  }
  return graph;
}

function allSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allSourceFiles(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

/** The value exports of the generated features module (hooks, fetchers, keys). */
function featureValueNames(): Set<string> {
  const generated = resolve(SRC, "../../../lib/api-client-react/src/features/generated/api.ts");
  const code = readFileSync(generated, "utf8");
  return new Set(Array.from(code.matchAll(/^export (?:const|function|async function) ([A-Za-z_$][\w$]*)/gm), (m) => m[1]!));
}

/**
 * (F3b) The ONLY `features` operations an entry-path file may take from the
 * MAIN module. The dashboard is the landing and its first screen reads the
 * money position (the summary row's "Room to spend" sublines). The main module
 * is in the entry chunk whole anyway and carries it, so this costs about 1 KB;
 * importing it from `/features` would drag that whole sub-module into the entry
 * chunk (~20 KB). Everything else a page needs from `features` stays a lazy
 * `/features` import — (dashboard refinement) including the recap preview,
 * which now loads only when "Preview tomorrow's morning text" is opened.
 */
const ENTRY_MAIN_FEATURES = {
  file: "pages/next/dashboard/queries.ts",
  names: new Set(["useGetMoneyPosition", "getGetMoneyPositionQueryKey"]),
};

const graph = entryGraph();
const rel = (f: string) => relative(SRC, f);

describe("the entry path and the generated client's sub-modules", () => {
  it("walks the real entry graph (positive controls)", () => {
    const files = new Set(Array.from(graph.keys(), rel));
    // The shell and the write-invalidation rule are on it (parity review C0.4)…
    expect(files.has("App.tsx")).toBe(true);
    expect(files.has("components/layout.tsx")).toBe(true);
    expect(files.has("lib/mutationInvalidation.ts")).toBe(true);
    // …and the lazy pages are not: `lazy(() => import(…))` is the boundary.
    expect(files.has("pages/transactions.tsx")).toBe(false);
    expect(files.has("pages/wishlist.tsx")).toBe(false);
    // (C11) The dashboard is the landing and statically imported, so its own
    // queries file IS on the entry path (the one allowance, below, is for two
    // MAIN-module names).
    expect(files.has("pages/next/dashboard/queries.ts")).toBe(true);
    // The main module IS imported on the entry path, which is the whole reason
    // the sub-modules exist.
    expect(Array.from(graph.values()).some((edges) => edges.some((e) => e.spec === MAIN))).toBe(true);
  });

  it("nothing on the entry path imports @workspace/api-client-react/features or /ledger", () => {
    // (F3b) NO ALLOWANCE. C11 let the dashboard's queries file import two
    // operations from `/features`; that was wrong: Rollup keeps a module whole
    // in the chunk that statically imports it and retains every export a lazy
    // chunk uses, so the whole sub-module (agent, wishlist, learned rules, AI
    // usage…) rode in the entry chunk. The two now come from the main module
    // (see ENTRY_MAIN_FEATURES below).
    const offenders: string[] = [];
    for (const [file, edges] of graph) {
      for (const e of edges) {
        if (e.spec === LEDGER || e.spec === FEATURES) offenders.push(`${rel(file)} → ${e.spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the features module is in use by a lazy page (so the guard above is live)", () => {
    const code = readFileSync(join(SRC, "pages/wishlist.tsx"), "utf8");
    expect(staticEdges(code).some((e) => e.spec === FEATURES)).toBe(true);
  });

  it("no page imports a `features` operation from the MAIN module", () => {
    const featureNames = featureValueNames();
    // Sanity: the module carries the moved hooks.
    expect(featureNames.has("usePreviewRecap")).toBe(true);
    expect(featureNames.has("useGetMoneyPosition")).toBe(true);
    // …and not the review queue, which the entry-resident badge will read.
    expect(featureNames.has("useListCategorizationReview")).toBe(false);
    const offenders: string[] = [];
    for (const file of allSourceFiles(SRC)) {
      for (const e of staticEdges(readFileSync(file, "utf8"))) {
        if (e.spec !== MAIN) continue;
        for (const n of e.names) {
          if (!featureNames.has(n)) continue;
          // The narrow, named exception: the first screen's own reads.
          if (rel(file) === ENTRY_MAIN_FEATURES.file && ENTRY_MAIN_FEATURES.names.has(n)) continue;
          offenders.push(`${rel(file)}: ${n}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("(F3b) the allowlist is exactly the dashboard's money position, on the entry path", () => {
    expect(graph.has(join(SRC, ENTRY_MAIN_FEATURES.file))).toBe(true);
    expect([...ENTRY_MAIN_FEATURES.names].sort()).toEqual(["getGetMoneyPositionQueryKey", "useGetMoneyPosition"]);
    // It is used: the file really imports each name from the main module.
    const edges = staticEdges(readFileSync(join(SRC, ENTRY_MAIN_FEATURES.file), "utf8")).filter((e) => e.spec === MAIN);
    const imported = new Set(edges.flatMap((e) => e.names));
    for (const n of ENTRY_MAIN_FEATURES.names) expect(imported.has(n), n).toBe(true);
  });

  it("(C11b, refinement) the dashboard's lazy panels, their queries, the recap preview and the chart are not on the entry path", () => {
    const files = new Set(Array.from(graph.keys(), rel));
    for (const lazyFile of [
      "pages/next/dashboard/BelowFold.tsx",
      "pages/next/dashboard/ForecastPanel.tsx",
      "pages/next/dashboard/UpcomingPanel.tsx",
      "pages/next/dashboard/SpendingPanel.tsx",
      "pages/next/dashboard/DebtPanel.tsx",
      "pages/next/dashboard/AttentionPanel.tsx",
      "pages/next/dashboard/ActivityPanel.tsx",
      "pages/next/dashboard/RecapPreview.tsx",
      "pages/next/dashboard/queriesLazy.ts",
      "pages/forecast/ProjectedBalanceChart.tsx",
    ]) {
      expect(files.has(lazyFile), `${lazyFile} must stay off the open path`).toBe(false);
    }
    // …while the first screen (header, summary row, accounts) is on it.
    for (const eager of ["DashboardHeader", "SummaryRow", "AccountsPanel"]) {
      expect(files.has(`pages/next/dashboard/${eager}.tsx`), `${eager} is the first screen`).toBe(true);
    }
    // No chart library is imported by anything on the open path.
    const chartImporters: string[] = [];
    for (const [file, edges] of graph) {
      for (const e of edges) if (e.spec === "recharts") chartImporters.push(rel(file));
    }
    expect(chartImporters).toEqual([]);
  });

  it("the edge parser ignores dynamic imports and type-only imports", () => {
    const edges = staticEdges(`
      import type { A } from "${FEATURES}";
      const P = lazy(() => import("${FEATURES}"));
      // import { x } from "${FEATURES}";
      import { useX, type B } from "${MAIN}";
      export { y } from "./y";
    `);
    expect(edges.map((e) => e.spec)).toEqual([MAIN, "./y"]);
    expect(edges[0]!.names).toEqual(["useX"]);
  });
});
