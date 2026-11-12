// THE LIGHT-UNCHANGED PROOF, rule by rule.
//   node theme-guard/csscompare.mjs <before.css> <after.css>
// Both stylesheets are parsed into (at-rule context, single selector) → declarations. Every `var(--x)` is replaced by the LIGHT
// value of --x from the same stylesheet (so `color: var(--text-color-brand-navy)` and `color: var(--color-brand-navy)` compare as
// the same #19315b), and anything scoped to `[data-theme="dark"]` in the new sheet is set aside (it cannot match a light page).
// Prints what differs; exits 1 if a rule that a light page can match computes differently.
import { readFileSync } from "node:fs";

function parse(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = []; // { ctx: string[], sel: string, decls: [prop, value][] }
  let i = 0;
  const n = css.length;
  function block(ctx) {
    let buf = "";
    const decls = [];
    while (i < n) {
      const ch = css[i];
      if (ch === '"' || ch === "'") { const j = css.indexOf(ch, i + 1); buf += css.slice(i, j + 1); i = j + 1; continue; }
      if (ch === "(") { let d = 0, j = i; for (; j < n; j++) { if (css[j] === "(") d++; else if (css[j] === ")") { d--; if (!d) break; } } buf += css.slice(i, j + 1); i = j + 1; continue; }
      if (ch === "{") {
        i++;
        const head = buf.trim(); buf = "";
        const inner = block([...ctx, head]);
        if (!head.startsWith("@") || /^@(font-face|property|page)/.test(head)) rules.push({ ctx, sel: head, decls: inner });
        else if (inner.length) rules.push({ ctx, sel: head + " (declarations)", decls: inner });
        continue;
      }
      if (ch === "}") { i++; const d = buf.trim(); if (d) push(decls, d); return decls; }
      if (ch === ";") { i++; const d = buf.trim(); buf = ""; if (d) push(decls, d); continue; }
      buf += ch; i++;
    }
    return decls;
  }
  function push(decls, d) { const k = d.indexOf(":"); if (k > 0) decls.push([d.slice(0, k).trim(), d.slice(k + 1).trim()]); }
  block([]);
  return rules;
}
const splitSel = (s) => { const out = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(" || ch === "[") d++; if (ch === ")" || ch === "]") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
const isDark = (r) => /data-theme/.test(r.sel) || r.ctx.some((c) => /data-theme/.test(c));

function load(file) {
  const all = parse(readFileSync(file, "utf8"));
  const dark = all.filter(isDark);
  const light = all.filter((r) => !isDark(r));
  // LIGHT custom properties: declared on :root / :host / html / *, outside any media query that is not always true.
  const vars = new Map();
  for (const r of light) {
    if (r.ctx.some((c) => /^@media/.test(c) && !/^@media\s*\(\s*width\s*>=\s*48rem\)/.test(c) ? true : false)) continue;
    if (!/(^|,)\s*(:root|:host|html|\*)/.test(r.sel) && !/^:root/.test(r.sel)) continue;
    for (const [p, v] of r.decls) if (p.startsWith("--")) vars.set(p, v);
  }
  const resolve = (v, depth = 0) => depth > 12 ? v : v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (m, name, fb) => vars.has(name) ? resolve(vars.get(name), depth + 1) : fb != null ? resolve(fb, depth + 1) : m);
  const norm = (v) => resolve(v).replace(/\s+/g, " ").replace(/#fff\b/gi, "#ffffff").replace(/\s*,\s*/g, ",").toLowerCase().trim();
  const map = new Map();
  for (const r of light) for (const sel of splitSel(r.sel)) {
    const key = r.ctx.join(" > ") + " | " + sel;
    const m = map.get(key) ?? new Map();
    for (const [p, v] of r.decls) m.set(p, norm(v));
    map.set(key, m);
  }
  return { map, vars, dark, norm };
}
const [fa, fb] = process.argv.slice(2);
const A = load(fa), B = load(fb);
let changed = 0, added = 0, removed = 0, same = 0, renamed = 0;
const lines = [];
for (const [key, a] of A.map) {
  const b = B.map.get(key);
  if (!b) {
    // A class that was RENAMED to a token (bg-brand-navy/5 → bg-brand-wash/5): the same declarations under a new name in the same context.
    const ctx = key.split(" | ")[0], body = JSON.stringify([...a]);
    const twin = [...B.map].find(([k, m]) => !A.map.has(k) && k.split(" | ")[0] === ctx && JSON.stringify([...m]) === body);
    if (twin) { renamed++; lines.push(`RENAMED  ${key.split(" | ")[1]}  →  a new class with the same declarations (${twin[0].split(" | ")[1]})`); continue; }
    removed++; lines.push(`REMOVED  ${key}  { ${[...a].map(([p, v]) => `${p}: ${v}`).join("; ").slice(0, 160)} }`); continue;
  }
  const diffs = [];
  for (const [p, v] of a) if (b.get(p) !== v && !p.startsWith("--")) diffs.push(`${p}: ${v}  →  ${b.get(p) ?? "(gone)"}`);
  for (const [p, v] of b) if (!a.has(p) && !p.startsWith("--")) diffs.push(`${p}: (new)  →  ${v}`);
  // custom properties: only a change to an existing one matters (a new one is inert until something reads it, and that reader is compared above)
  for (const [p, v] of a) if (p.startsWith("--") && b.has(p) && b.get(p) !== v) diffs.push(`${p}: ${v}  →  ${b.get(p)}`);
  for (const [p] of a) if (p.startsWith("--") && !b.has(p)) diffs.push(`${p}: (custom property no longer declared here)`);
  if (diffs.length) { changed++; lines.push(`CHANGED  ${key}\n           ${diffs.join("\n           ")}`); } else same++;
}
const newVars = [];
for (const [key, b] of B.map) {
  if (A.map.has(key)) { for (const [p, v] of b) if (p.startsWith("--") && !A.map.get(key).has(p)) newVars.push(`${p}: ${v}`); continue; }
  added++; lines.push(`ADDED    ${key}  { ${[...b].map(([p, v]) => `${p}: ${v}`).join("; ").slice(0, 200)} }`);
}
console.log(lines.join("\n"));
console.log(`\n${same} rules identical once light values are filled in · ${changed} changed · ${renamed} renamed (same declarations) · ${removed} removed (no longer used by any markup) · ${added} added (new classes) · ${B.dark.length} dark-only rules set aside (before: ${A.dark.length})`);
console.log(`new custom properties on existing rules (inert unless read): ${[...new Set(newVars)].join(" · ")}`);
process.exit(changed ? 1 : 0);
