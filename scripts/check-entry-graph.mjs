#!/usr/bin/env node
/**
 * Entry-graph guard (PR A2 of the FAST OPEN overhaul).
 *
 * After `pnpm run build`, this script inspects what the browser actually
 * downloads to open the app: the <script type="module"> entry plus every
 * <link rel="modulepreload"> chunk in artifacts/h2budget/dist/public/
 * index.html, expanded through each chunk's STATIC imports (a statically
 * imported chunk loads on open even if index.html forgot to preload it;
 * dynamic `import(...)` chunks are lazy and excluded on purpose).
 *
 * It FAILS (exit 1) when:
 *  (a) any landing chunk carries a recharts fingerprint — charts must only
 *      ever arrive via the lazy route chunks (/forecast, /avalanche, reports);
 *  (b) a react-dom fingerprint ("MessageChannel" AND "Hydration" in the same
 *      chunk) appears in a landing chunk not named vendor-react-* — that is
 *      exactly how react-dom once fell into vendor-clerk;
 *  (c) total landing JS exceeds the byte budget below.
 *
 * On success it prints every landing chunk with its size so the numbers are
 * visible in CI logs. Plain node builtins only — no dependencies.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Landing-route JS byte budget (raw, pre-gzip). NEVER RAISE THIS.
//
// History: 1,059.4 KB → 608.4 KB (2026-08-23, vendor-charts evicted from the
// landing graph) → 571.1 KB (2026-08-25, the Budget overhaul dropped dnd-kit
// from that route). Cap ratcheted 620 → 580 KB to lock the win in; the real
// figure has ~9 KB of headroom under it.
//
// ⚠️ THE 500 KB TARGET IS RETIRED, DELIBERATELY. It was a stretch goal I set
// during the overhaul, not a requirement. Closing the last 71 KB means
// refactoring two things that are load-bearing and visual: tailwind-merge
// (26.6 KB — `cn()` is extended with the custom text/rounded/shadow scales,
// and getting that wrong silently deletes classes; it has already shipped a
// 1.2:1-contrast button once) and the radix menu/toast/tooltip + floating-ui
// cluster (~75 KB) that layout.tsx pulls at open. Both are refactors with real
// regression risk on pages that were just rebuilt, traded against roughly a
// tenth of a second on a warm open. Not worth it. If someone revisits this,
// revisit it as a deliberate piece of work — not as a leftover chore.
const MAX_TOTAL_BYTES = 580_000;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.join(repoRoot, "artifacts", "h2budget", "dist", "public");
const indexHtmlPath = path.join(distRoot, "index.html");

function die(msg) {
  console.error(`\n[check-entry-graph] FAIL: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(indexHtmlPath)) {
  die(
    `${indexHtmlPath} not found — run \`pnpm run build\` before this script.`,
  );
}

const html = readFileSync(indexHtmlPath, "utf8");

/** Resolve a URL as emitted in index.html (e.g. "/assets/index-abc.js",
 *  possibly BASE_PATH-prefixed) to a file inside dist/public. */
function resolveUrlToFile(url) {
  const clean = url.split(/[?#]/)[0];
  const direct = path.join(distRoot, clean.replace(/^\//, ""));
  if (existsSync(direct)) return direct;
  const assetsIdx = clean.lastIndexOf("assets/");
  if (assetsIdx !== -1) {
    const viaAssets = path.join(distRoot, clean.slice(assetsIdx));
    if (existsSync(viaAssets)) return viaAssets;
  }
  die(`index.html references "${url}" but no such file exists under ${distRoot}`);
}

// --- 1. Collect the chunks index.html itself pulls -------------------------
const referenced = new Map(); // absolute file path -> { url }

for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
  const src = tag.match(/\bsrc="([^"]+\.js)"/)?.[1];
  if (src) referenced.set(resolveUrlToFile(src), { url: src });
}
for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
  if (!/\brel="modulepreload"/.test(tag)) continue;
  const href = tag.match(/\bhref="([^"]+\.js)"/)?.[1];
  if (href) referenced.set(resolveUrlToFile(href), { url: href });
}

if (referenced.size === 0) {
  die("no module scripts or modulepreload links found in index.html — parser drift?");
}

// --- 2. Expand through static imports (BFS) --------------------------------
// Static forms in Rollup output: `import"./x.js"`, `import{a}from"./x.js"`,
// `export{a}from"./x.js"`. Dynamic `import("./x.js")` deliberately does NOT
// match either pattern (the "(" breaks both), so lazy chunks stay excluded.
const STATIC_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*)["'](\.\.?\/[^"']+\.js)["']/g;

const queue = [...referenced.keys()];
const landing = new Map(); // absolute file path -> { bytes, content }
while (queue.length > 0) {
  const file = queue.shift();
  if (landing.has(file)) continue;
  const content = readFileSync(file, "utf8");
  landing.set(file, { bytes: statSync(file).size, content });
  for (const m of content.matchAll(STATIC_IMPORT_RE)) {
    const dep = path.resolve(path.dirname(file), m[1]);
    if (existsSync(dep) && !landing.has(dep)) queue.push(dep);
  }
}

// --- 3. Checks --------------------------------------------------------------
const problems = [];
const rows = [];
let totalBytes = 0;
let totalGzBytes = 0;

for (const [file, { bytes, content }] of [...landing.entries()].sort(
  (a, b) => b[1].bytes - a[1].bytes,
)) {
  const name = path.basename(file);
  totalBytes += bytes;
  totalGzBytes += gzipSync(content).length;
  rows.push({ name, bytes });

  // (a) recharts must never be in the landing graph.
  if (content.includes("recharts") || content.includes("CartesianChart")) {
    problems.push(
      `${name} contains a recharts fingerprint — charts leaked into the landing graph. ` +
        `Only lazy route chunks (/forecast, /avalanche, reports) may import recharts.`,
    );
  }

  // (b) react-dom must live only in vendor-react-*.
  const hasReactDomFingerprint =
    content.includes("MessageChannel") && content.includes("Hydration");
  if (hasReactDomFingerprint && !name.startsWith("vendor-react-")) {
    problems.push(
      `${name} carries the react-dom fingerprint ("MessageChannel"+"Hydration") ` +
        `but is not vendor-react-* — react-dom fell into the wrong chunk.`,
    );
  }
}

// Fingerprint-drift tripwire: if NO built vendor-react chunk carries the
// react-dom fingerprint, check (b) has gone vacuous (react/react-dom renamed
// their internals) and must be re-derived rather than silently passing.
const assetsDir = path.join(distRoot, "assets");
const vendorReactAssets = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter(
      (f) => f.startsWith("vendor-react-") && f.endsWith(".js"),
    )
  : [];
const fingerprintAlive = vendorReactAssets.some((f) => {
  const c = readFileSync(path.join(assetsDir, f), "utf8");
  return c.includes("MessageChannel") && c.includes("Hydration");
});
if (!fingerprintAlive) {
  problems.push(
    vendorReactAssets.length === 0
      ? "no vendor-react-*.js chunk was emitted at all — manualChunks drifted."
      : "the react-dom fingerprint no longer matches vendor-react-* — update the " +
          "fingerprint strings in scripts/check-entry-graph.mjs (check (b) is vacuous).",
  );
}

// (c) byte budget.
if (totalBytes > MAX_TOTAL_BYTES) {
  problems.push(
    `landing JS total ${totalBytes.toLocaleString()} bytes exceeds the ` +
      `${MAX_TOTAL_BYTES.toLocaleString()}-byte budget.`,
  );
}

// --- 4. Report --------------------------------------------------------------
const kb = (n) => `${(n / 1000).toFixed(1)} KB`;
console.log("[check-entry-graph] landing-route JS (entry + modulepreload + static imports):");
for (const { name, bytes } of rows) {
  console.log(`  ${kb(bytes).padStart(9)}  ${name}`);
}
console.log(
  `  ${kb(totalBytes).padStart(9)}  TOTAL raw (${kb(totalGzBytes)} gz) — budget ${kb(MAX_TOTAL_BYTES)}`,
);

if (problems.length > 0) {
  for (const p of problems) console.error(`[check-entry-graph] FAIL: ${p}`);
  process.exit(1);
}
console.log("[check-entry-graph] OK — no recharts on open; react-dom confined to vendor-react-*; budget met.");
