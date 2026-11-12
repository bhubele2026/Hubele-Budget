/**
 * LIGHT AND DARK — the contract of `artifacts/h2budget/src/lib/theme.ts` proved in a headless browser, and every dark page MEASURED.
 *
 *   pnpm --filter @workspace/scripts exec tsx ./verify-theme.mts
 *   [OUT=<dir for stills>] [PORT=5271] [BASE=http://127.0.0.1:5251 to use a server that is already running] [ONLY=home,forecast]
 *
 * Headless only, never on a screen. Unless BASE is given it builds the REAL web app (its own index.html, main.tsx, App.tsx, every
 * route) into a temporary folder with `artifacts/h2budget/theme-guard/vite.config.mjs` and serves it with `vite preview`. That config
 * swaps two things so there is no network and no database: Clerk is a stand-in (a signed-in invented person), and every `/api/*`
 * call is answered from an INVENTED household (`theme-guard/api/`: "Cedar Hollow Bank", "Card A" …). The browser's clock is the
 * fixture's day, America/Chicago.
 *
 * What it proves:
 *   1. THE RULE. A dark device → <html data-theme="dark">, color-scheme dark; a light device → no data-theme. A device that states
 *      NO setting → the clock (21:00 dark, 12:00 light), and the clock crossing 19:00 / 07:00 repaints within one five-minute
 *      re-check with no reload. Each pick: Light on a dark device, Dark on a light one, Time of day at 21:00 and 12:00, Auto.
 *      ⚠️ Chromium cannot state "no setting" (its "no-preference" emulation still matches `prefers-color-scheme: light`), so the rig
 *      makes it the way the code defines it, neither query matching, with a matchMedia shim; what real Chromium does is an INFO line.
 *   2. NO FLASH. Every value `data-theme` takes is recorded from before the first script. A remembered Dark is on <html> before the
 *      first paint and never leaves while /api/me is still on its way; a remembered Light on a dark device never shows dark.
 *   3. THE SWITCH. The top bar's Appearance button: four radio items and the hint; a pick flips the page at once with no reload,
 *      sends exactly {"appearance": …}, the menu stays open; a refused save goes back. The page under it re-mounts and is put back
 *      where it was scrolled. The same four in the phone drawer and in Settings.
 *   4. EVERY PAGE, DARK, at 1440 and 390: (a) no near-white ground larger than 40×40; (b) no chart line left in the light navy;
 *      (c) every visible text node ≥ 4.5:1 against its real ground (3:1 for large text), found by walking up the ancestors and
 *      compositing translucent layers; (d) nothing brown (a dark, half-saturated orange ground or edge); (e) no sideways scroll.
 *      The navy top bar and the phone drawer are the SAME in light and dark by design, so they are measured and reported as INFO.
 *   5. THE OPEN STATES, dark: a dialog, a select list, the Ask thread, the home drawer, a chart tooltip, a toast, the phone
 *      drawer, the More menu, the Appearance menu: same scan.
 *   6. LIGHT is still light: no data-theme and the light token values on every page.
 *   7. Stills of every page (dark and light, 1440 and 390), every open state, and a short clip of Light → Dark → Auto → OUT.
 *
 * Prints PASS / FAIL / INFO lines, then "N/M passed", and exits 1 on any FAIL.
 */
import { createRequire } from "node:module";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APP = resolve(ROOT, "artifacts/h2budget");
const OUT = process.env["OUT"] ?? "/private/tmp/claude-501/theme-shots";
const PORT = Number(process.env["PORT"] ?? 5271);
const BASE = process.env["BASE"] ?? `http://127.0.0.1:${PORT}`;
const ONLY = process.env["ONLY"]?.split(",") ?? null;
if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(BASE)) throw new Error("BASE must be a local server");

const require = createRequire(join(APP, "package.json"));
const { chromium } = require("@playwright/test") as typeof import("@playwright/test");
type Page = import("@playwright/test").Page;
type BrowserContext = import("@playwright/test").BrowserContext;
const guard = (await import(pathToFileURL(join(APP, "theme-guard/pages.mjs")).href)) as {
  PAGES: Array<{ id: string; path: string; ready: string[] }>;
  NOW: string; TZ: string; APPEARANCE_KEY: string;
  visit(page: Page, base: string, p: { path: string; ready: string[] }): Promise<string>;
  growToFit(page: Page, w: number, h: number): Promise<void>;
};
const { NOW, TZ, APPEARANCE_KEY, visit, growToFit } = guard;
const PAGES = guard.PAGES.filter((p) => !ONLY || ONLY.includes(p.id));
for (const d of ["dark", "light", "overlays"]) mkdirSync(join(OUT, d), { recursive: true });

const NAVY = "rgb(25, 49, 91)"; // the light-mode navy, #19315b
const CLOCK_CHECK_MS = 5 * 60_000; // lib/theme.ts (its unit test pins the same number)
const DAY = NOW.slice(0, 10);
const AT = (hhmm: string) => `${DAY}T${hhmm}:00-06:00`; // America/Chicago in November
/** What may keep a near-white ground on a dark page. Extend with a selector, and the reason, when something is meant to. */
const ALLOW_LIGHT = "img, picture, video, canvas, iframe, svg image";
/** The navy chrome: the same in light and dark by design. Measured, reported as INFO. */
const CHROME = '[data-testid="app-header"], [role="dialog"]:has([data-testid="drawer-version"])';

// ── RESULTS ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const results: Array<{ ok: boolean | "info"; name: string; detail?: string }> = [];
const check = (ok: boolean, name: string, detail?: string) => { results.push({ ok, name, ...(detail ? { detail } : {}) }); };
const info = (name: string, detail?: string) => { results.push({ ok: "info", name, ...(detail ? { detail } : {}) }); };

// ── IN EVERY PAGE, BEFORE THE APP: a log of every value <html data-theme> takes, from before the first script.
const INIT = `
  window.__name = (f) => f;
  window.__themeLog = [];
  new MutationObserver((ms) => { for (const m of ms) if (m.target === document.documentElement) window.__themeLog.push(m.target.getAttribute("data-theme")); })
    .observe(document, { attributes: true, attributeFilter: ["data-theme"], subtree: true });
  window.__atFirstFrame = "unset";
  requestAnimationFrame(() => { window.__atFirstFrame = document.documentElement.getAttribute("data-theme"); });
`;
/** A device that states NO light/dark setting, as lib/theme.ts defines it: neither prefers-color-scheme query matches. */
const NO_DEVICE_SETTING = `
  (() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => /prefers-color-scheme/.test(q)
      ? { matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
      : real(q);
  })();
`;

// ── THE SERVER: the production bundle of the guard app under `vite preview`. Its own process group; only PIDs this run started.
const servers: ChildProcess[] = [];
let distDir: string | null = null;
async function up(): Promise<void> {
  if (!process.env["BASE"]) {
    distDir = mkdtempSync(join(tmpdir(), "h2-theme-guard-"));
    const env = { ...process.env, GUARD_OUT: distDir, PORT: String(PORT), BASE_PATH: "/" };
    const b = spawnSync("pnpm", ["exec", "vite", "build", "--config", "theme-guard/vite.config.mjs", "--logLevel", "error"], { cwd: APP, env, encoding: "utf8" });
    if (b.status !== 0) throw new Error(`vite build failed: ${(b.stderr || b.stdout || "").slice(-400)}`);
    const c = spawn("pnpm", ["exec", "vite", "preview", "--config", "theme-guard/vite.config.mjs", "--port", String(PORT), "--strictPort"], { cwd: APP, env, stdio: "ignore", detached: true });
    servers.push(c);
  }
  for (let i = 0; ; i++) {
    if (servers[0] && servers[0].exitCode !== null) throw new Error(`vite preview exited (${servers[0].exitCode}): is port ${PORT} taken? pass PORT=<n>`);
    try { if ((await fetch(`${BASE}/api/me`)).ok) return; } catch { /* not yet */ }
    if (i >= 120) throw new Error(`the server did not come up on ${BASE}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const stop = () => {
  for (const c of servers) if (c.pid && c.exitCode === null) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } }
  if (distDir) { try { rmSync(distDir, { recursive: true, force: true }); } catch { /* left for the OS */ } distDir = null; }
};
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

// ── BROWSER HELPERS ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type Scheme = "dark" | "light" | "no-preference";
type Pick = "auto" | "light" | "dark" | "time" | "none";
interface Opened { ctx: BrowserContext; page: Page; errors: string[]; puts: string[] }
let browser: import("@playwright/test").Browser;
async function open(o: {
  scheme: Scheme; w?: number; h?: number; noDeviceSetting?: boolean; clockAt?: string; fixedTime?: boolean;
  server?: Pick; stored?: Pick; meDelayMs?: number; failPut?: boolean; signedOut?: boolean; video?: string;
}): Promise<Opened> {
  const headers: Record<string, string> = { "x-guard-appearance": o.server ?? "none" };
  if (o.meDelayMs) headers["x-guard-me-delay"] = String(o.meDelayMs);
  if (o.failPut) headers["x-guard-fail-put"] = "1";
  const ctx = await browser.newContext({
    viewport: { width: o.w ?? 1440, height: o.h ?? 900 }, colorScheme: o.scheme, reducedMotion: "reduce", timezoneId: TZ, extraHTTPHeaders: headers,
    ...(o.video ? { recordVideo: { dir: o.video, size: { width: o.w ?? 1440, height: o.h ?? 900 } } } : {}),
  });
  await ctx.addInitScript(INIT);
  if (o.noDeviceSetting) await ctx.addInitScript(NO_DEVICE_SETTING);
  if (o.stored && o.stored !== "none") await ctx.addInitScript(([k, v]) => { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch { /* blocked */ } }, [APPEARANCE_KEY, o.stored] as const);
  if (o.signedOut) await ctx.addInitScript(() => { try { localStorage.setItem("guard:signed-out", "1"); } catch { /* blocked */ } });
  const page = await ctx.newPage();
  if (o.clockAt) await page.clock.install({ time: new Date(o.clockAt) });
  else if (o.fixedTime !== false) await page.clock.setFixedTime(new Date(NOW));
  const errors: string[] = [];
  const puts: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().endsWith("/api/me/ui-preferences")) puts.push(r.postData() ?? ""); });
  return { ctx, page, errors, puts };
}
const dataTheme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const themeLog = (page: Page) => page.evaluate(() => (window as unknown as { __themeLog: Array<string | null> }).__themeLog);
const fmt = (v: string | null) => (v === null ? "absent" : `"${v}"`);
const HOME = PAGES.find((p) => p.id === "home") ?? guard.PAGES[0]!;
/** Load the home page and let it settle on `want` (null = no data-theme). */
async function home(o: Opened, want: "dark" | null): Promise<string | null> {
  await o.page.goto(`${BASE}${HOME.path}`, { waitUntil: "load" });
  await o.page.waitForSelector(HOME.ready[0]!, { timeout: 20_000 }).catch(() => {});
  await o.page.waitForFunction((w) => document.documentElement.getAttribute("data-theme") === w, want, { timeout: 4_000 }).catch(() => {});
  await o.page.waitForTimeout(300); // a late repaint would land here
  return dataTheme(o.page);
}

// ── THE DARK PAGE MEASURED, in the page ─────────────────────────────────────────────────────────────────────────────────────
interface Offender { sel: string; where: string; detail: string; n?: number; ratio?: number; area?: number }
interface Scan {
  nearWhite: { count: number; top: Offender[] };
  navyStrokes: { count: number; charts: number; top: Offender[] };
  navyFills: { count: number; top: Offender[] };
  brown: { count: number; top: Offender[] };
  contrast: { measured: number; failing: number; chrome: number; disabled: number; unmeasurable: number; top: Offender[]; chromeTop: Offender[] };
}
const SCAN_JS = String.raw`(function (o) {
  const CS = new Map();
  const cs = (el) => { let s = CS.get(el); if (!s) { s = getComputedStyle(el); CS.set(el, s); } return s; };
  const parse = (c) => {
    if (!c || c === "none" || c === "transparent" || /^url\(/.test(c)) return null;
    const srgb = /^color\(srgb/.test(c);
    if (/^(oklab|oklch|lab|lch|color\()/.test(c) && !srgb) return null;
    const m = (c.match(/-?[\d.]+(e-?\d+)?/g) || []).map(Number);
    if (m.length < 3) return null;
    const k = srgb ? 255 : 1;
    return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 };
  };
  const stops = (img) => (img && img !== "none" ? (img.match(/(rgba?|color)\([^)]*\)/g) || []).map(parse).filter(Boolean) : []);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, a, base) => ({ r: top.r * a + base.r * (1 - a), g: top.g * a + base.g * (1 - a), b: top.b * a + base.b * (1 - a), a: 1 });
  const rgb = (c) => "rgb(" + Math.round(c.r) + ", " + Math.round(c.g) + ", " + Math.round(c.b) + ")";
  // OKLCH (Björn Ottosson): brown = a dark, part-saturated orange.
  const oklch = (c) => {
    const r = lin(c.r), g = lin(c.g), b = lin(c.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(A, B), H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
  };
  const isBrown = (c) => { const k = oklch(c); return k.H >= 25 && k.H <= 80 && k.C >= 0.03 && k.L >= 0.16 && k.L <= 0.52; };
  const shown = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) < 0.05 || s.contentVisibility === "hidden") return false;
    }
    return true;
  };
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + "#" + el.id;
    if (el.getAttribute("data-testid")) return s + '[data-testid="' + el.getAttribute("data-testid") + '"]';
    const cls = (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
    for (const c of cls) s += "." + c;
    if (el.getAttribute("role")) s += "[role=" + el.getAttribute("role") + "]";
    return s;
  };
  const sel = (el) => { if (el === document.body || el === document.documentElement) return el.tagName.toLowerCase(); const parts = []; for (let n = el, i = 0; n && n.nodeType === 1 && i < 3 && n !== document.body; n = n.parentElement, i++) parts.unshift(name(n)); return parts.join(" > "); };
  const where = (el) => {
    const card = el.closest("[role=dialog], [role=menu], [role=listbox], .panel, .surface, section, header");
    const h = card && card.querySelector("h1, h2, h3");
    return ((h && h.textContent) || (card && card.textContent) || "page").trim().replace(/\s+/g, " ").slice(0, 40);
  };
  const root = (o.textRoot && document.querySelector(o.textRoot)) || document.body;
  const canvas = /dark/.test(cs(document.documentElement).colorScheme) ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };

  /** The colours an element's own ground could be, composited down through its ancestors. */
  const groundsOf = (el, cx, cy, startLayers) => {
    const layers = startLayers || [];
    let opaque = layers.length > 0 && layers[layers.length - 1].every((c) => c.a >= 0.99), image = false, alpha = 1;
    for (let n = el; n && n.nodeType === 1 && !opaque; n = n.parentElement) {
      const ns = cs(n);
      if (n !== el || !startLayers) {
        // an absolutely-positioned sibling underlay with a ground of its own (a toggle's pill, a bar under a label)
        if (n !== el) for (const c of n.children) {
          if (c.contains(el)) continue;
          const s = cs(c); if (s.position !== "absolute") continue;
          const bg = parse(s.backgroundColor); if (!bg || bg.a < 0.5) continue;
          const r = c.getBoundingClientRect();
          if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom && (c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) { layers.push([bg]); if (bg.a >= 0.99) opaque = true; }
        }
        if (opaque) break;
      }
      if (/url\(/.test(ns.backgroundImage)) { image = true; break; }
      const g = stops(ns.backgroundImage).filter((c) => c.a > 0);
      if (g.length) { layers.push(g); if (g.every((c) => c.a >= 0.99)) { opaque = true; break; } }
      const bg = parse(ns.backgroundColor);
      if (bg && bg.a > 0) { layers.push([bg]); if (bg.a >= 0.99) { opaque = true; break; } }
      alpha *= Number(ns.opacity);
    }
    if (image) return null;
    let grounds = opaque ? layers.pop().map((c) => ({ ...c, a: 1 })) : [canvas];
    while (layers.length) {
      const L = layers.pop(); const next = [];
      for (const b of grounds) for (const c of L) next.push(over(c, c.a, b));
      next.sort((a, b) => lum(a) - lum(b));
      grounds = next.length > 8 ? [next[0], next[next.length - 1]] : next;
    }
    return { grounds, alpha };
  };

  // (a) near-white grounds larger than 40×40 · (d) brown grounds and edges
  const nearWhite = [], brown = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.closest(o.allow) || el.closest("svg")) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 3 && r.height > 3)) continue;
    const s = cs(el);
    const bg = parse(s.backgroundColor);
    const big = r.width > 40 && r.height > 40;
    let hit = big && bg && bg.a >= 0.5 && lum(bg) > 0.9 ? ["background-color", bg] : null;
    if (big && !hit) { const g = stops(s.backgroundImage).find((c) => c.a >= 0.5 && lum(c) > 0.9); if (g) hit = ["gradient stop", g]; }
    if (hit && shown(el)) nearWhite.push({ sel: sel(el), where: where(el), area: Math.round(r.width * r.height), detail: Math.round(r.width) + "×" + Math.round(r.height) + " " + hit[0] + " " + rgb(hit[1]) });
    if (el.closest(o.chrome)) continue;
    // brown: this element's own ground, composited; and its border
    if (bg && bg.a > 0.02 && r.width * r.height >= 60) {
      const under = el.parentElement ? groundsOf(el.parentElement, r.left + r.width / 2, r.top + r.height / 2) : { grounds: [canvas] };
      if (under) for (const g of under.grounds) { const c = over(bg, bg.a, g); if (isBrown(c) && shown(el)) { brown.push({ sel: sel(el), where: where(el), area: Math.round(r.width * r.height), detail: "ground " + rgb(c) + " (" + s.backgroundColor + ")" }); break; } }
    }
    for (const side of ["Top", "Left"]) {
      if (parseFloat(s["border" + side + "Width"]) <= 0 || s["border" + side + "Style"] === "none") continue;
      const bc = parse(s["border" + side + "Color"]);
      if (!bc || bc.a <= 0.02) continue;
      const under = groundsOf(el, r.left + 1, r.top + 1);
      if (under) for (const g of under.grounds) { const c = over(bc, bc.a, g); if (isBrown(c) && shown(el)) { brown.push({ sel: sel(el), where: where(el), area: 1, detail: "border " + rgb(c) + " (" + s["border" + side + "Color"] + ")" }); break; } }
      break;
    }
  }
  // …and inside charts: a translucent fill, or a gradient stop, composited over the card.
  for (const el of root.querySelectorAll("svg rect, svg path, svg circle, svg polygon, svg stop")) {
    if (el.closest(o.chrome)) continue;
    const s = cs(el);
    const isStop = el.tagName.toLowerCase() === "stop";
    const c0 = parse(isStop ? s.stopColor : s.fill);
    if (!c0) continue;
    const a = c0.a * Number((isStop ? s.stopOpacity : s.fillOpacity) || 1) * (isStop ? 1 : Number(s.opacity || 1));
    if (a <= 0.03 || a >= 0.97) continue;
    const svg = el.closest("svg");
    const r = (isStop ? svg : el).getBoundingClientRect();
    if (r.width * r.height < 60 || !shown(svg)) continue;
    const under = groundsOf(svg.parentElement || svg, r.left + r.width / 2, r.top + r.height / 2);
    if (under) for (const g of under.grounds) { const c = over(c0, a, g); if (isBrown(c)) { brown.push({ sel: sel(el), where: where(svg), area: Math.round(r.width * r.height), detail: (isStop ? "gradient stop " : "chart fill ") + rgb(c) + " (" + rgb(c0) + " at " + a.toFixed(2) + ")" }); break; } }
  }
  nearWhite.sort((a, b) => b.area - a.area);
  brown.sort((a, b) => b.area - a.area);

  // (b) chart strokes in the light-mode navy, and (INFO) chart fills in it
  const charts = [...document.querySelectorAll("svg")].filter((v) => { const r = v.getBoundingClientRect(); return r.width >= 80 && r.height >= 60 && !v.parentElement?.closest("svg") && shown(v); });
  const navyStrokes = [], navyFills = [];
  for (const svg of charts) {
    for (const el of svg.querySelectorAll("path, line, polyline, rect, circle, text")) {
      const s = cs(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (/^(path|line|polyline|circle)$/.test(el.tagName) && s.stroke === o.navy && parseFloat(s.strokeWidth) > 0 && Number(s.strokeOpacity) > 0 && shown(el))
        navyStrokes.push({ sel: sel(el), where: where(svg), detail: el.tagName + " stroke " + s.stroke });
      if (s.fill === o.navy && Number(s.fillOpacity) > 0 && shown(el))
        navyFills.push({ sel: sel(el), where: where(svg), detail: el.tagName + " fill " + s.fill });
    }
  }
  const group = (list) => { const m = new Map(); for (const x of list) { const k = x.where + "|" + x.detail; const g = m.get(k); if (g) g.n++; else m.set(k, { ...x, n: 1 }); } return [...m.values()].sort((a, b) => b.n - a.n); };

  // (c) text contrast against the effective background
  const shapes = new Map();
  const shapesOf = (svg) => {
    let l = shapes.get(svg);
    if (!l) {
      l = [];
      for (const sh of svg.querySelectorAll("rect, path, circle, ellipse, polygon")) {
        const s = cs(sh); const f = parse(s.fill);
        if (!f) continue;
        const a = f.a * Number(s.fillOpacity || 1) * Number(s.opacity || 1);
        if (a >= 0.5) l.push({ el: sh, bg: { ...f, a }, rect: sh.getBoundingClientRect() });
      }
      shapes.set(svg, l);
    }
    return l;
  };
  const clippedAway = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (/rect\(0px,? 0px,? 0px,? 0px\)/.test(s.clip) || /inset\(50%\)/.test(s.clipPath)) return true;
      if (s.overflow !== "visible" && s.position === "absolute") { const r = n.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) return true; }
    }
    return false;
  };
  const failing = new Map(), chromeFailing = new Map();
  let measured = 0, disabled = 0, unmeasurable = 0, failCount = 0, chromeCount = 0;
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!/\S/.test(t.nodeValue || "")) continue;
    const el = t.parentElement;
    if (!el || el.closest("script, style, noscript, title, option")) continue;
    range.selectNodeContents(t);
    const rects = [...range.getClientRects()];
    const area = rects.reduce((a, r) => a + r.width * r.height, 0);
    if (area < 4) continue;
    if (!shown(el) || clippedAway(el)) continue;
    if (el.closest(":disabled, [aria-disabled=true], [data-disabled]")) { disabled++; continue; }
    const s = cs(el);
    const isSvg = el instanceof SVGElement;
    const fg0 = parse(isSvg ? s.fill : s.color);
    if (!fg0 || fg0.a === 0) continue;
    const cx = rects[0].left + rects[0].width / 2, cy = rects[0].top + rects[0].height / 2;
    const start = [];
    if (isSvg && el.ownerSVGElement) {
      const under = shapesOf(el.ownerSVGElement).filter((u) => !u.el.contains(el) && (u.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
        && cx >= u.rect.left && cx <= u.rect.right && cy >= u.rect.top && cy <= u.rect.bottom).pop();
      if (under) start.push([under.bg]);
    }
    const g = groundsOf(el, cx, cy, start.length ? start : undefined);
    if (!g) { unmeasurable++; continue; }
    const alpha = fg0.a * (isSvg ? Number(s.fillOpacity || 1) : 1) * g.alpha;
    let worst = Infinity, wg = g.grounds[0], wf = fg0;
    for (const gr of g.grounds) { const f = over(fg0, alpha, gr); const r = ratio(f, gr); if (r < worst) { worst = r; wg = gr; wf = f; } }
    measured++;
    const px = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
    const need = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;
    if (worst + 1e-6 >= need) continue;
    const inChrome = !!el.closest(o.chrome);
    const bucket = inChrome ? chromeFailing : failing;
    if (inChrome) chromeCount++; else failCount++;
    const k = sel(el) + "|" + rgb(wf) + "|" + rgb(wg);
    const prev = bucket.get(k);
    if (prev) { prev.n++; prev.ratio = Math.min(prev.ratio, worst); continue; }
    bucket.set(k, { sel: sel(el), where: where(el), ratio: worst, n: 1,
      detail: '"' + (t.nodeValue || "").trim().replace(/\s+/g, " ").slice(0, 28) + '" ' + worst.toFixed(2) + ":1 (needs " + need + "), ink " + rgb(wf) + " on " + rgb(wg) + ", " + px + "px/" + s.fontWeight });
  }
  const top = (m) => [...m.values()].sort((a, b) => a.ratio - b.ratio).slice(0, o.topN);
  return {
    nearWhite: { count: nearWhite.length, top: nearWhite.slice(0, o.topN) },
    navyStrokes: { count: navyStrokes.length, charts: charts.length, top: group(navyStrokes).slice(0, o.topN) },
    navyFills: { count: navyFills.length, top: group(navyFills).slice(0, o.topN) },
    brown: { count: brown.length, top: group(brown).slice(0, o.topN) },
    contrast: { measured, failing: failCount, chrome: chromeCount, disabled, unmeasurable, top: top(failing), chromeTop: top(chromeFailing) },
  };
})`;
const scan = (page: Page, textRoot?: string): Promise<Scan> =>
  page.evaluate(([js, opts]) => (0, eval)(js as string)(opts), [SCAN_JS, { allow: ALLOW_LIGHT, chrome: CHROME, navy: NAVY, textRoot: textRoot ?? null, topN: 10 }] as const) as Promise<Scan>;
const list = (xs: Offender[]) => xs.map((x) => `\n        · ${x.n && x.n > 1 ? `${x.n}× ` : ""}${x.detail} — ${x.sel} [in: ${x.where}]`).join("");

/** The four dark checks on what is on screen now. `tag` names the page or the open state. */
const chromeSeen = new Map<string, Offender>();
async function measure(page: Page, tag: string, textRoot?: string): Promise<void> {
  const r = await scan(page, textRoot);
  check(r.nearWhite.count === 0, `4a · ${tag}: no near-white ground larger than 40×40`, r.nearWhite.count ? `${r.nearWhite.count} elements; largest:${list(r.nearWhite.top)}` : undefined);
  check(r.navyStrokes.count === 0, `4b · ${tag}: no chart line in the light-mode navy`, r.navyStrokes.count ? `${r.navyStrokes.count} strokes:${list(r.navyStrokes.top)}` : `${r.navyStrokes.charts} charts looked at`);
  if (r.navyFills.count) info(`4b · ${tag}: chart shapes FILLED in the light-mode navy`, `${r.navyFills.count}:${list(r.navyFills.top)}`);
  check(r.contrast.failing === 0 && r.contrast.measured > 0, `4c · ${tag}: every visible text node meets 4.5:1 (3:1 large)`,
    `${r.contrast.failing} of ${r.contrast.measured} text nodes below${r.contrast.disabled ? ` · ${r.contrast.disabled} disabled exempt` : ""}${r.contrast.unmeasurable ? ` · ${r.contrast.unmeasurable} on an image, not measured` : ""}${r.contrast.top.length ? `; worst:${list(r.contrast.top)}` : ""}`);
  check(r.brown.count === 0, `4d · ${tag}: nothing brown (no dark, part-saturated orange ground or edge)`, r.brown.count ? `${r.brown.count}:${list(r.brown.top)}` : undefined);
  for (const c of r.contrast.chromeTop) if (!chromeSeen.has(c.sel + c.detail.replace(/^"[^"]*"/, ""))) chromeSeen.set(c.sel + c.detail.replace(/^"[^"]*"/, ""), c);
}

/** No horizontal page scroll: the document and the shell's scroller are no wider than the window. */
const sideways = (page: Page) => page.evaluate(() => {
  const d = document.documentElement;
  const m = document.querySelector<HTMLElement>("[data-shell-scroller]");
  window.scrollTo(100_000, window.scrollY);
  const moved = window.scrollX;
  window.scrollTo(0, window.scrollY);
  const over = Math.max(d.scrollWidth - d.clientWidth, m ? m.scrollWidth - m.clientWidth : 0);
  return { over, moved, client: d.clientWidth };
});

const only = (id: string) => !ONLY || ONLY.includes(id);

try {
  await up();
  browser = await chromium.launch({ headless: true });

  if (!ONLY) {
    // ════════ 1 · THE RULE ════════
    for (const scheme of ["dark", "light"] as const) {
      const o = await open({ scheme });
      const t = await home(o, scheme === "dark" ? "dark" : null);
      const meta = await o.page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null);
      const cs2 = await o.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      check(t === (scheme === "dark" ? "dark" : null), `1 · ${scheme} device, no pick (Auto) → data-theme ${scheme === "dark" ? '"dark"' : "absent"}`, `data-theme=${fmt(t)}`);
      check(cs2 === scheme, `1 · ${scheme} device → <html> color-scheme ${scheme}`, cs2);
      check(meta === "#19315b", `1 · ${scheme} device → theme-color stays the navy bar's #19315b`, `${meta}`);
      await o.ctx.close();
    }
    for (const [hhmm, want] of [["21:00", "dark"], ["12:00", null]] as const) {
      const o = await open({ scheme: "no-preference", noDeviceSetting: true, clockAt: AT(hhmm) });
      const t = await home(o, want);
      check(t === want, `1 · no device setting, clock ${hhmm} → ${want ? "dark" : "light"}`, `data-theme=${fmt(t)}`);
      await o.ctx.close();
    }
    for (const [from, before, after] of [["18:58", null, "dark"], ["06:58", "dark", null]] as const) {
      const o = await open({ scheme: "no-preference", noDeviceSetting: true, clockAt: AT(from) });
      const t0 = await home(o, before);
      let navs = 0;
      o.page.on("framenavigated", (f) => { if (f === o.page.mainFrame()) navs++; });
      await o.page.clock.fastForward(CLOCK_CHECK_MS);
      await o.page.waitForFunction((w) => document.documentElement.getAttribute("data-theme") === w, after, { timeout: 3_000 }).catch(() => {});
      const t1 = await dataTheme(o.page);
      check(t0 === before && t1 === after && navs === 0, `1 · clock ${from} → past ${from.startsWith("18") ? "19:00" : "07:00"}: repaints within one five-minute re-check, no reload`, `at ${from}: ${fmt(t0)} · five minutes on: ${fmt(t1)} · navigations ${navs}`);
      await o.ctx.close();
    }
    {
      const o = await open({ scheme: "no-preference", clockAt: AT("21:00") });
      const t = await home(o, null);
      const mq = await o.page.evaluate(() => ({ dark: matchMedia("(prefers-color-scheme: dark)").matches, light: matchMedia("(prefers-color-scheme: light)").matches }));
      info(`1 · Chromium's own "no-preference" at 21:00 → data-theme ${fmt(t)}`, `(prefers-color-scheme: dark)=${mq.dark}, (light)=${mq.light}: Chromium never states "no setting", so the clock is reached only where neither query matches`);
      await o.ctx.close();
    }
    for (const [name, scheme, server, want, clockAt] of [
      ["Light on a dark device → light", "dark", "light", null, undefined],
      ["Dark on a light device → dark", "light", "dark", "dark", undefined],
      ["Auto on a dark device → dark", "dark", "auto", "dark", undefined],
      ["Auto on a light device → light", "light", "auto", null, undefined],
      ["Time of day on a light device at 21:00 → dark", "light", "time", "dark", AT("21:00")],
      ["Time of day on a dark device at 12:00 → light", "dark", "time", null, AT("12:00")],
    ] as const) {
      const o = await open({ scheme, server, ...(clockAt ? { clockAt } : {}) });
      const t = await home(o, want);
      const mem = await o.page.evaluate((k) => localStorage.getItem(k), APPEARANCE_KEY);
      // Auto is what a browser with nothing remembered means, so "auto" may be stored as nothing at all.
      check(t === want && (mem === server || (server === "auto" && mem === null)), `1 · the person's saved pick ${name}, and this browser remembers it`, `data-theme=${fmt(t)} · ${APPEARANCE_KEY}=${mem}`);
      await o.ctx.close();
    }

    // ════════ 2 · NO FLASH ════════
    {
      // A remembered Dark on a light device, /api/me held back: dark from before the first frame, never light.
      const o = await open({ scheme: "light", server: "dark", stored: "dark", meDelayMs: 2_500 });
      await o.page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
      await o.page.waitForTimeout(1_200); // /api/me is still on its way
      const early = await dataTheme(o.page);
      const first = await o.page.evaluate(() => (window as unknown as { __atFirstFrame: string | null }).__atFirstFrame);
      const boot = await o.page.evaluate(() => { const b = document.getElementById("boot"); return b ? getComputedStyle(document.documentElement).backgroundColor : null; });
      await o.page.waitForTimeout(2_200);
      const log = await themeLog(o.page);
      check(early === "dark" && first === "dark" && JSON.stringify(log) === '["dark"]', "2 · a remembered Dark is on <html> before the first frame and never leaves (set once, by the boot script)", `first frame ${fmt(first)}, while /api/me was pending ${fmt(early)}, every value taken ${JSON.stringify(log)}`);
      if (boot) info("2 · the boot shell was still up at that moment", `html ground ${boot}`);
      await o.ctx.close();
    }
    {
      const o = await open({ scheme: "dark", server: "light", stored: "light", meDelayMs: 2_500 });
      await o.page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
      await o.page.waitForTimeout(3_400);
      const log = await themeLog(o.page);
      const first = await o.page.evaluate(() => (window as unknown as { __atFirstFrame: string | null }).__atFirstFrame);
      check(first === null && log.length === 0, "2 · a remembered Light on a dark device never shows dark", `first frame ${fmt(first)}, every value taken ${JSON.stringify(log)}`);
      await o.ctx.close();
    }
    {
      // The boot shell itself, with scripts' answers held: its ground under a remembered Dark.
      const o = await open({ scheme: "light", stored: "dark", server: "dark" });
      await o.ctx.route(/\/src\/main\.tsx|\/assets\/index-[^/]*\.js/, (r) => r.abort());
      await o.page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
      await o.page.waitForTimeout(400);
      const shell = await o.page.evaluate(() => {
        const b = document.getElementById("boot"); const t = document.querySelector("#boot .tile"); const band = document.querySelector("#boot .band");
        return b && t && band ? { html: getComputedStyle(document.documentElement).backgroundColor, boot: getComputedStyle(b).backgroundColor, tile: getComputedStyle(t).backgroundColor, band: getComputedStyle(band).backgroundColor } : null;
      });
      check(!!shell && shell.html === "rgb(14, 15, 17)" && shell.boot === "rgb(14, 15, 17)" && shell.tile === "rgb(23, 24, 27)" && shell.band === NAVY, "2 · the boot shell (before any app script) is dark under a remembered Dark: black ground, card tiles, the navy band", JSON.stringify(shell));
      await o.page.screenshot({ path: join(OUT, "overlays", "1440-dark-boot-shell.png") });
      await o.ctx.close();
    }

    // ════════ 3 · THE SWITCH ════════
    {
      const o = await open({ scheme: "light" });
      const fc = guard.PAGES.find((p) => p.id === "forecast")!;
      const miss = await visit(o.page, BASE, fc);
      await o.page.evaluate(() => { (window as unknown as { __doc: number }).__doc = 42; });
      let navs = 0;
      o.page.on("framenavigated", (f) => { if (f === o.page.mainFrame()) navs++; });
      const y = await o.page.evaluate(() => { const m = document.querySelector<HTMLElement>("[data-shell-scroller]")!; m.scrollTop = Math.min(700, m.scrollHeight - m.clientHeight); return Math.round(m.scrollTop); });
      const btn = o.page.getByRole("button", { name: "Appearance", exact: true });
      await btn.click();
      const menu = o.page.getByRole("menu");
      await menu.waitFor({ timeout: 5_000 }).catch(() => {});
      const items = await menu.getByRole("menuitemradio").allTextContents();
      const hint = await menu.locator('[data-testid="appearance-hint"]').textContent().catch(() => null);
      check(JSON.stringify(items) === JSON.stringify(["Auto", "Light", "Dark", "Time of day"]), "3 · the Appearance button (beside Ask) opens four radio items: Auto · Light · Dark · Time of day", items.join(" · "));
      check(hint === "Auto follows this device. Time of day: dark 7 PM–7 AM.", "3 · the menu carries the hint line", String(hint));
      const checked0 = await menu.getByRole("menuitemradio", { checked: true }).allTextContents();
      await menu.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
      const at = await dataTheme(o.page); // read at once, before the save can have answered
      await o.page.waitForTimeout(1_200);
      const y1 = await o.page.evaluate(() => Math.round(document.querySelector<HTMLElement>("[data-shell-scroller]")!.scrollTop));
      const stillOpen = await menu.isVisible();
      const checked1 = await menu.getByRole("menuitemradio", { checked: true }).allTextContents();
      check(!miss && at === "dark" && JSON.stringify(checked0) === '["Auto"]' && JSON.stringify(checked1) === '["Dark"]', "3 · picking Dark on a light device flips the page at once, and the checked item moves", `data-theme at once ${fmt(at)} · checked ${checked0} → ${checked1}${miss ? ` (page: ${miss})` : ""}`);
      check(stillOpen, "3 · the menu stays open and usable after the pick (the page under it re-mounted)", `visible=${stillOpen}`);
      check(y > 0 && Math.abs(y1 - y) <= 2, "3 · the re-mounted page is put back where it was scrolled", `scrolled to ${y}, after the flip ${y1}`);
      await o.page.screenshot({ path: join(OUT, "overlays", "1440-dark-appearance-menu.png") });
      await measure(o.page, "[1440 dark] the Appearance menu, open", '[role="menu"]');
      await menu.getByRole("menuitemradio", { name: "Time of day", exact: true }).click();
      await o.page.waitForTimeout(500);
      const tTime = await dataTheme(o.page); // the fixture's clock is 10:00
      await menu.getByRole("menuitemradio", { name: "Auto", exact: true }).click();
      await o.page.waitForTimeout(500);
      const tAuto = await dataTheme(o.page);
      const same = (await o.page.evaluate(() => (window as unknown as { __doc?: number }).__doc)) === 42;
      check(tTime === null && tAuto === null, "3 · Time of day at 10:00 → light; Auto hands back to the (light) device", `time ${fmt(tTime)} · auto ${fmt(tAuto)}`);
      check(same && navs === 0, "3 · no reload at any point: the same document, no navigation", `same document=${same}, navigations=${navs}`);
      check(JSON.stringify(o.puts) === JSON.stringify(['{"appearance":"dark"}', '{"appearance":"time"}', '{"appearance":"auto"}']), "3 · each pick is one PUT /api/me/ui-preferences with exactly {appearance}", o.puts.join(" , "));
      check(o.errors.length === 0, "3 · no uncaught page error while switching", o.errors.slice(0, 2).join(" · "));
      await o.ctx.close();
    }
    {
      // The device flips mid-session, on Auto.
      const o = await open({ scheme: "dark" });
      const t0 = await home(o, "dark");
      await o.page.emulateMedia({ colorScheme: "light" });
      await o.page.waitForFunction(() => !document.documentElement.hasAttribute("data-theme"), undefined, { timeout: 3_000 }).catch(() => {});
      const t1 = await dataTheme(o.page);
      await o.page.emulateMedia({ colorScheme: "dark" });
      await o.page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark", undefined, { timeout: 3_000 }).catch(() => {});
      const t2 = await dataTheme(o.page);
      check(t0 === "dark" && t1 === null && t2 === "dark", "3 · on Auto the page follows the device flipping dark → light → dark, no reload", `${fmt(t0)} → ${fmt(t1)} → ${fmt(t2)}`);
      await o.ctx.close();
    }
    {
      // A refused save goes back.
      const o = await open({ scheme: "light", failPut: true });
      await home(o, null);
      await o.page.getByRole("button", { name: "Appearance", exact: true }).click();
      await o.page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
      await o.page.waitForFunction(() => (window as unknown as { __themeLog: unknown[] }).__themeLog.length >= 2, undefined, { timeout: 4_000 }).catch(() => {});
      const log = await themeLog(o.page); // the refusal can land within a frame, so the log is the witness
      const after = await dataTheme(o.page);
      const mem = await o.page.evaluate((k) => localStorage.getItem(k), APPEARANCE_KEY);
      const toast = await o.page.locator('[role=region][aria-label^="Notifications"] li').first().textContent({ timeout: 3_000 }).catch(() => null);
      check(JSON.stringify(log) === '["dark",null]' && after === null && mem !== "dark" && o.puts.length === 1, "3 · a refused save: the page flips, then goes back, and the browser does not keep the pick", `values taken ${JSON.stringify(log)} · after the refusal ${fmt(after)} · remembered ${mem}`);
      check(!!toast && /not saved/i.test(toast), "3 · …and it says so", String(toast));
      await o.ctx.close();
    }
    {
      // Settings → Household, and the phone drawer: the same four.
      const o = await open({ scheme: "light" });
      await o.page.goto(`${BASE}/settings?tab=household`, { waitUntil: "load" });
      const row = o.page.locator('[data-testid="panel-appearance"]').getByRole("radiogroup", { name: "Appearance" });
      await row.waitFor({ timeout: 20_000 }).catch(() => {});
      const names = await row.getByRole("radio").allTextContents();
      await row.getByRole("radio", { name: "Dark", exact: true }).click();
      await o.page.waitForTimeout(700);
      const t = await dataTheme(o.page);
      const focused = await o.page.evaluate(() => document.activeElement?.getAttribute("data-appearance") ?? null);
      check(JSON.stringify(names) === JSON.stringify(["Auto", "Light", "Dark", "Time of day"]) && t === "dark", "3 · Settings → Household has an Appearance row with the same four, and it works", `${names.join(" · ")} → data-theme ${fmt(t)}`);
      check(focused === "dark", "3 · …and the pressed choice keeps the keyboard focus across the re-mount", `focused: ${focused}`);
      await o.page.screenshot({ path: join(OUT, "overlays", "1440-dark-settings-appearance.png") });
      await measure(o.page, "[1440 dark] Settings → Household (Appearance row)");
      await o.ctx.close();
      const ph = await open({ scheme: "light", w: 390, h: 844 });
      await home(ph, null);
      const header = await ph.page.getByRole("button", { name: "Appearance", exact: true }).isVisible().catch(() => false);
      await ph.page.click('[data-testid="button-mobile-menu"]');
      const drawer = ph.page.locator('[data-testid="drawer-appearance"]').getByRole("radiogroup", { name: "Appearance" });
      await drawer.waitFor({ timeout: 10_000 }).catch(() => {});
      const dn = await drawer.getByRole("radio").allTextContents();
      await drawer.getByRole("radio", { name: "Dark", exact: true }).click();
      await ph.page.waitForTimeout(700);
      const pt = await dataTheme(ph.page);
      const open2 = await drawer.isVisible();
      check(JSON.stringify(dn) === JSON.stringify(["Auto", "Light", "Dark", "Time of day"]) && pt === "dark" && open2, "3 · on a phone the four choices are at the foot of the navigation drawer; a pick works and the drawer stays open", `${dn.join(" · ")} → data-theme ${fmt(pt)}, drawer open=${open2}`);
      info("3 · the top bar's button on a 390 px phone", header ? "shown" : "not shown (no room beside the title; the drawer carries it)");
      await ph.page.screenshot({ path: join(OUT, "overlays", "390-dark-phone-drawer.png") });
      await measure(ph.page, "[390 dark] the phone drawer, open", '[role="dialog"]');
      await ph.ctx.close();
    }
  }

  // ════════ 4 · EVERY PAGE, DARK · 6 · LIGHT IS STILL LIGHT · 7 · STILLS ════════
  for (const scheme of ["dark", "light"] as const) {
    for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
      for (const p of PAGES) {
        const o = await open({ scheme: "light", server: scheme, stored: scheme, w: vp.w, h: vp.h });
        const tag = `[${vp.w} ${scheme}] ${p.path}`;
        const miss = await visit(o.page, BASE, p);
        const t = await dataTheme(o.page);
        if (miss) check(false, `${tag}: the page came up`, miss);
        if (o.errors.length) check(false, `${tag}: no uncaught page error`, o.errors.slice(0, 2).join(" · "));
        if (scheme === "dark") {
          if (t !== "dark") check(false, `${tag}: data-theme "dark"`, `data-theme=${fmt(t)}`);
          const sw = await sideways(o.page);
          check(sw.over <= 1 && sw.moved === 0, `4e · ${tag}: no sideways scroll`, `content ${sw.over > 0 ? `${sw.over}px wider than` : "fits"} the ${sw.client}px window`);
          await measure(o.page, tag);
        } else {
          const v = await o.page.evaluate(() => { const s = getComputedStyle(document.documentElement); return { white: s.getPropertyValue("--background-color-white").trim(), bg: s.getPropertyValue("--background").trim(), ink: s.getPropertyValue("--text-color-brand-navy").trim(), scheme: s.colorScheme, body: getComputedStyle(document.body).backgroundColor }; });
          check(t === null && /^#fff(fff)?$/i.test(v.white) && v.bg === "216 45.5% 97.8%" && v.ink === "#19315b" && v.scheme === "light" && v.body === "rgb(247, 249, 252)", `6 · ${tag}: no data-theme, the light token values`, `data-theme=${fmt(t)} · ${JSON.stringify(v)}`);
        }
        await growToFit(o.page, vp.w, vp.h);
        await o.page.screenshot({ path: join(OUT, scheme, `${vp.w}-${p.id}.png`) });
        await o.ctx.close();
      }
    }
  }

  // ════════ 5 · THE OPEN STATES, DARK ════════
  type Step = (page: Page) => Promise<unknown>;
  const OVERLAYS: Array<{ id: string; label: string; path: string; w?: number; root?: string; steps: Step[]; proof: string }> = [
    { id: "dialog-add-bill", label: "a dialog (Add income or bill)", path: "/bills/all", root: '[role="dialog"]', proof: '[role="dialog"]',
      steps: [(p) => p.click('[data-testid="button-add-bill"]')] },
    { id: "select-open", label: "a select list, open (bill frequency)", path: "/bills/all", root: '[role="listbox"]', proof: '[role="listbox"]',
      steps: [(p) => p.click('[data-testid="button-add-bill"]'), (p) => p.click('[data-testid="select-frequency"]')] },
    { id: "dialog-new-transaction", label: "a dialog with native date field (New Transaction)", path: "/transactions", root: '[role="dialog"]', proof: '[role="dialog"]',
      steps: [(p) => p.click('[data-testid="button-add-transaction"]')] },
    { id: "alert-dialog", label: "a confirm dialog (approve a proposal)", path: "/review/suggestions", root: '[role="alertdialog"]', proof: '[role="alertdialog"]',
      steps: [(p) => p.locator('[data-testid="proposal-approve"]').first().click()] },
    { id: "ask-thread", label: "the Ask page with a conversation open", path: "/ask", proof: '[data-testid="thread"] [data-testid="msg-assistant"]',
      steps: [(p) => p.locator('[data-testid="conversation-index"] [data-testid="conversation-item"]').first().click()] },
    { id: "home-more", label: "the home drawer (Accounts, allowances and tools), open", path: "/home", proof: '[data-testid="dash-more"][open] [data-testid="tile-banking"]',
      steps: [(p) => p.click('[data-testid="dash-more-summary"]')] },
    { id: "chart-tooltip", label: "a chart tooltip (Reports → Debt, Payoff timeline)", path: "/reports/debt", proof: 'section.panel:has(h2:text-is("Payoff timeline")) .recharts-tooltip-wrapper',
      steps: [async (p) => { const b = await p.locator('section.panel:has(h2:text-is("Payoff timeline")) .recharts-wrapper').boundingBox(); if (b) { await p.mouse.move(b.x + b.width / 2 - 20, b.y + b.height / 2); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); } }] },
    { id: "forecast-tooltip", label: "the Forecast chart's hover card", path: "/forecast", proof: '[data-testid="tooltip-calm"]',
      steps: [async (p) => { const b = await p.locator(".recharts-wrapper").first().boundingBox(); if (b) { await p.mouse.move(b.x + b.width / 2 - 20, b.y + b.height / 2); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); } }] },
    { id: "toast", label: "a toast (Already in sync)", path: "/avalanche", root: '[role=region][aria-label^="Notifications"]', proof: '[role=region][aria-label^="Notifications"] li[data-state="open"]',
      steps: [(p) => p.getByRole("button", { name: "Sync minimums" }).click()] },
    { id: "toast-alarm", label: "an alarm toast (Name is required)", path: "/bills/all", root: '[role=region][aria-label^="Notifications"]', proof: '[role=region][aria-label^="Notifications"] li[data-state="open"]',
      steps: [(p) => p.click('[data-testid="button-add-bill"]'), (p) => p.click('[data-testid="button-save"]')] },
    { id: "more-menu", label: "the More menu in the top bar", path: "/home", root: '[role="menu"]', proof: '[role="menu"] [data-testid="morenav-settings"]',
      steps: [(p) => p.click('[data-testid="topnav-more"]')] },
  ];
  for (const ov of OVERLAYS) {
    if (!only(ov.id) && !only("overlays")) continue;
    const o = await open({ scheme: "light", server: "dark", stored: "dark", w: ov.w ?? 1440 });
    const tag = `[${ov.w ?? 1440} dark] ${ov.label}`;
    const pg = guard.PAGES.find((p) => p.path === ov.path) ?? { path: ov.path, ready: ["main"] };
    await visit(o.page, BASE, pg);
    let why = "";
    try {
      for (const step of ov.steps) { await step(o.page); await o.page.waitForTimeout(350); }
      await o.page.waitForSelector(ov.proof, { timeout: 8_000, state: "visible" });
    } catch (e) { why = (e as Error).message.split("\n")[0]!.slice(0, 160); }
    await o.page.waitForTimeout(500);
    check(!why, `5 · ${tag}: it opened`, why || undefined);
    await o.page.screenshot({ path: join(OUT, "overlays", `${ov.w ?? 1440}-dark-${ov.id}.png`) });
    if (!why) await measure(o.page, tag, ov.root);
    await o.ctx.close();
  }

  if (!ONLY) {
    // The signed-out screen. ⚠️ Clerk's own card needs Clerk's network, so the card here is a stand-in drawn with the classes
    // App.tsx hands Clerk; the page around it (the brand panel, the invitation check) is the app's own.
    for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
      const o = await open({ scheme: "light", stored: "dark", signedOut: true, w: vp.w, h: vp.h });
      await o.page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
      const ok = await o.page.waitForSelector('[data-testid="guard-sign-in"]', { timeout: 15_000 }).then(() => true, () => false);
      await o.page.waitForTimeout(600);
      const t = await dataTheme(o.page);
      check(ok && t === "dark", `5 · [${vp.w} dark] the signed-out screen comes up dark from the browser's memory alone (no /api/me)`, `data-theme=${fmt(t)}`);
      await o.page.screenshot({ path: join(OUT, "dark", `${vp.w}-sign-in.png`), fullPage: true });
      if (ok) await measure(o.page, `[${vp.w} dark] /sign-in (the app's page; Clerk's card is a stand-in)`);
      await o.ctx.close();
      const l = await open({ scheme: "light", signedOut: true, w: vp.w, h: vp.h });
      await l.page.goto(`${BASE}/sign-in`, { waitUntil: "load" });
      await l.page.waitForSelector('[data-testid="guard-sign-in"]', { timeout: 15_000 }).catch(() => {});
      await l.page.waitForTimeout(600);
      await l.page.screenshot({ path: join(OUT, "light", `${vp.w}-sign-in.png`), fullPage: true });
      await l.ctx.close();
    }
    info("5 · Clerk's real sign-in card and account menu", "NOT rendered here (they load from Clerk's network); they read the same tokens through App.tsx's `clerkAppearance`");

    // ════════ 7 · THE CLIP: Light → Dark → Auto on home ════════
    {
      const dir = mkdtempSync(join(tmpdir(), "h2-theme-clip-"));
      const o = await open({ scheme: "light", server: "light", stored: "light", video: dir, fixedTime: true });
      await home(o, null);
      await o.page.waitForTimeout(900);
      await o.page.getByRole("button", { name: "Appearance", exact: true }).click();
      await o.page.waitForTimeout(700);
      await o.page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
      await o.page.waitForTimeout(1_800);
      await o.page.getByRole("menuitemradio", { name: "Auto", exact: true }).click();
      await o.page.waitForTimeout(1_500);
      await o.page.keyboard.press("Escape");
      await o.page.waitForTimeout(600);
      await o.ctx.close();
      const f = readdirSync(dir).find((x) => x.endsWith(".webm"));
      if (f) renameSync(join(dir, f), join(OUT, "switch-light-dark-auto.webm"));
      check(!!f, "7 · the clip of Light → Dark → Auto on home was recorded", f ? join(OUT, "switch-light-dark-auto.webm") : "no video file");
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (chromeSeen.size) info("4c · the navy top bar and phone drawer (the SAME in light and dark, by design): text below 4.5:1 there", `${chromeSeen.size} kinds:${list([...chromeSeen.values()].slice(0, 8))}`);
  await browser.close();
} catch (e) {
  check(false, "the rig ran to the end", (e as Error).stack ?? String(e));
} finally {
  stop();
}

let failed = 0, counted = 0;
for (const r of results) {
  if (r.ok !== "info") { counted++; if (!r.ok) failed++; }
  console.log(`${r.ok === "info" ? "INFO" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
}
console.log(`\n${counted - failed}/${counted} passed · stills in ${OUT}`);
process.exit(failed ? 1 : 0);
