/**
 * PERF HARNESS — the client waterfall, measured in a headless Chromium against the REAL API server on the seeded
 * perf database. Never a visible window; never the live site.
 *
 *   PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH" caffeinate -i \
 *   pnpm --filter @workspace/scripts exec tsx ./perf/run.mts
 *     [ITER=15] [SCALE=8] [JOBS=off,on] [PORT=3290] [SKIP_BUILD=1] [ONLY=cold,warm,nav,phone,tabs,theme]
 *     [OUT=/private/tmp/claude-501/perf/local-before] [MD=/private/tmp/claude-501/perf/local-before-client.md]
 *
 * Needs `seed.mts` first (households.json). Builds once: the web app with Clerk's browser SDK swapped for a signed-in
 * stand-in (`vite.perf.config.mjs`) and the server bundle with `@clerk/express` swapped (`build-server.mjs`); then
 * starts `server-dist/index.mjs` (NOT NODE_ENV=production; MIGRATE_ON_BOOT=false) once per JOBS mode, serving that
 * build from the same origin, as production does.
 *
 * Scenarios (ITER runs each, after one unmeasured warm-up run):
 *   cold  — a fresh browser context (empty HTTP cache) opening /home; the auth hint is set, as for any browser that
 *           has signed in before (with no hint the app waits for Clerk, which this rig cannot measure).
 *   warm  — reload of /home in a context whose HTTP cache is warm (JS cached; data not — React Query is memory).
 *   nav   — /home, then Forecast → Chase (/transactions) → Amex → Reports → Banking → Home by client-side navigation.
 *   banking — a warm reload of /banking (HTTP cache warm): the review summary and the Needs-you list.
 *   phone — cold /home at 390×844, 150 ms latency, 1.6 Mbps down / 750 kbps up, CPU slowed 4×.
 *   tabs  — two tabs opening /home at the same moment in one context.
 *   theme — (3 runs) a dark device whose browser remembers "light" while the server says Auto: the page re-mounts once
 *           (ThemeRepaint); counts the requests fired after it.
 * One more run of each scenario records a HAR and a Chrome trace into OUT/<jobs>/.
 *
 * Collected per run: navigation timing, every /api resource (start, TTFB, end, and its Server-Timing), the h2:* marks
 * (lib/perfMarks.ts), LCP/CLS/INP (window.__h2perf), ledger and 400-day base builds (sum of Server-Timing counts),
 * queries, pool waits, identical duplicate requests. Raw JSON beside the HAR; the tables go to MD.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const APP = join(ROOT, "artifacts/h2budget");
const PERF = process.env.PERF_DIR ?? "/private/tmp/claude-501/perf";
const OUT = process.env.OUT ?? join(PERF, "local-before");
const MD = process.env.MD ?? join(PERF, "local-before-client.md");
const ITER = Number(process.env.ITER ?? 15);
const SCALE = Number(process.env.SCALE ?? 8);
const PORT = Number(process.env.PORT ?? 3290);
const BASE = `http://127.0.0.1:${PORT}`;
const JOBS = (process.env.JOBS ?? "off,on").split(",");
const ONLY = process.env.ONLY?.split(",") ?? null;
const WEB_OUT = join(PERF, "web-dist");
const SERVER_OUT = join(PERF, "server-dist");

const seeded = JSON.parse(readFileSync(join(PERF, "households.json"), "utf8")) as {
  databaseUrl: string;
  households: Array<{ scale: number; ownerUserId: string; householdId: string; rows: number }>;
};
const hh = seeded.households.find((h) => h.scale === SCALE);
if (!hh) throw new Error(`no seeded household at scale ${SCALE}: run seed.mts`);

const require = createRequire(join(APP, "package.json"));
const { chromium } = require("@playwright/test") as typeof import("@playwright/test");
type Browser = import("@playwright/test").Browser;
type BrowserContext = import("@playwright/test").BrowserContext;
type Page = import("@playwright/test").Page;

// ── BUILD ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout || "").slice(-800)}`);
}
if (!process.env.SKIP_BUILD) {
  console.log("building the web app (Clerk stand-in) …");
  run("pnpm", ["exec", "vite", "build", "--config", join(HERE, "vite.perf.config.mjs")], APP, {
    ...process.env, NODE_ENV: "production", BASE_PATH: "/", PERF_WEB_OUT: WEB_OUT, APP_BUILD_ID: "dev",
  });
  console.log("building the server bundle (Clerk stand-in) …");
  run("node", [join(HERE, "build-server.mjs")], ROOT, { ...process.env, OUT: SERVER_OUT });
}

// ── SERVER ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
let server: ChildProcess | null = null;
async function startServer(jobs: string): Promise<void> {
  mkdirSync(join(OUT, jobs), { recursive: true });
  const log = openSync(join(OUT, jobs, "server.log"), "w");
  server = spawn("node", ["--enable-source-maps", join(SERVER_OUT, "index.mjs")], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      DATABASE_URL: seeded.databaseUrl, PORT: String(PORT), MIGRATE_ON_BOOT: "false", JOBS_MODE: jobs,
      OWNER_EMAIL: "perf-owner@example.com", PERF_USER_ID: hh!.ownerUserId, WEB_DIST_DIR: WEB_OUT,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "info", APP_BUILD_ID: "dev", PERF_CLERK_API_MS: process.env.PERF_CLERK_API_MS ?? "0",
    },
    stdio: ["ignore", log, log],
  });
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: see ${join(OUT, jobs, "server.log")}`);
    try { if ((await fetch(`${BASE}/api/healthz`)).ok) break; } catch { /* not yet */ }
    if (i > 120) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function stopServer(): Promise<void> {
  const s = server;
  server = null;
  if (!s || s.exitCode !== null || !s.pid) return;
  s.kill("SIGTERM");
  await new Promise((r) => { s.once("exit", r); setTimeout(r, 5000); });
}
process.on("exit", () => { if (server?.pid && server.exitCode === null) try { server.kill("SIGKILL"); } catch { /* gone */ } });
process.on("SIGINT", () => { void stopServer().then(() => process.exit(130)); });

// ── IN THE PAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const INIT = `
  window.__name = (f) => f; // tsx names the functions it hands page.evaluate
  try { performance.setResourceTimingBufferSize(5000); } catch {}
  try { localStorage.setItem("h2:auth-hint", "1"); } catch {}
`;
interface Api { url: string; path: string; start: number; ttfb: number; end: number; st: Record<string, { dur: number; desc: string }> }
interface Collected {
  nav: { ttfb: number; dcl: number; load: number };
  scripts: { count: number; bytes: number; lastEnd: number };
  api: Api[];
  marks: Array<{ name: string; t: number; nav: number; path?: string }>;
  vitals: { lcp?: number; cls: number; inp?: number };
}
const COLLECT = () => {
  const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const scripts = res.filter((r) => r.initiatorType === "script" || /\.js(\?|$)/.test(r.name));
  const api = res
    .filter((r) => new URL(r.name).pathname.startsWith("/api/"))
    .map((r) => {
      const u = new URL(r.name);
      const st: Record<string, { dur: number; desc: string }> = {};
      for (const e of (r as unknown as { serverTiming?: Array<{ name: string; duration: number; description: string }> }).serverTiming ?? []) {
        st[e.name] = { dur: e.duration, desc: e.description };
      }
      return { url: u.pathname + u.search, path: u.pathname, start: r.startTime, ttfb: r.responseStart, end: r.responseEnd, st };
    });
  const marks = (performance.getEntriesByType("mark") as PerformanceMark[])
    .filter((m) => m.name.startsWith("h2:"))
    .map((m) => ({ name: m.name, t: m.startTime, nav: (m.detail as { nav?: number } | null)?.nav ?? 0, path: (m.detail as { path?: string } | null)?.path }));
  const v = (window as unknown as { __h2perf?: { lcp?: number; cls: number; inp?: number } }).__h2perf ?? { cls: 0 };
  return {
    nav: { ttfb: n?.responseStart ?? NaN, dcl: n?.domContentLoadedEventEnd ?? NaN, load: n?.loadEventEnd ?? NaN },
    scripts: { count: scripts.length, bytes: scripts.reduce((s, r) => s + (r.encodedBodySize || 0), 0), lastEnd: Math.max(0, ...scripts.map((r) => r.responseEnd)) },
    api,
    marks,
    vitals: { lcp: v.lcp, cls: v.cls, inp: v.inp },
  };
};

const HOME_MARKS = ["h2:home-numbers-ready", "h2:weekly-pay-ready"];
async function waitMarks(page: Page, names: string[], nav: number, timeout = 60_000): Promise<boolean> {
  return page
    .waitForFunction(
      ([ns, n]) => (ns as string[]).every((name) =>
        (performance.getEntriesByName(name, "mark") as PerformanceMark[]).some((m) => ((m.detail as { nav?: number } | null)?.nav ?? 0) === n)),
      [names, nav] as const,
      { timeout, polling: 50 },
    )
    .then(() => true, () => false);
}
/** No /api request in flight for `quietMs` (the warm-up included), or `capMs` passed. */
async function settle(page: Page, quietMs = 1500, capMs = 20_000): Promise<void> {
  await page.evaluate(
    ([q, cap]) =>
      new Promise<void>((done) => {
        const t0 = performance.now();
        let last = performance.now();
        let seen = 0;
        const tick = () => {
          const res = performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/"));
          if (res.length !== seen) { seen = res.length; last = performance.now(); }
          if (performance.now() - last >= q || performance.now() - t0 >= cap) return done();
          setTimeout(tick, 100);
        };
        tick();
      }),
    [quietMs, capMs] as const,
  );
}

// ── THE SCENARIOS ────────────────────────────────────────────────────────────────────────────────────────────────────────
const CTX = { colorScheme: "dark" as const, timezoneId: "America/Chicago", extraHTTPHeaders: { "x-perf-user": hh.ownerUserId } };
interface Run { scenario: string; i: number; ok: boolean; c: Collected; extra?: Record<string, unknown> }
const runs: Run[] = [];
let browser: Browser;

async function newCtx(o: { phone?: boolean; har?: string } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    ...CTX,
    ...(o.phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1440, height: 900 } }),
    ...(o.har ? { recordHar: { path: o.har, content: "omit" as const } } : {}),
  });
  await ctx.addInitScript(INIT);
  return ctx;
}
async function throttle(ctx: BrowserContext, page: Page): Promise<void> {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
}
async function traced<T>(page: Page, file: string | null, fn: () => Promise<T>): Promise<T> {
  if (!file) return fn();
  await browser.startTracing(page, { path: file, screenshots: false });
  try { return await fn(); } finally { await browser.stopTracing(); }
}
async function loadHome(page: Page, how: "goto" | "reload"): Promise<{ ok: boolean; c: Collected }> {
  if (how === "goto") await page.goto(`${BASE}/home`, { waitUntil: "commit" });
  else await page.reload({ waitUntil: "commit" });
  const ok = await waitMarks(page, HOME_MARKS, 0);
  await settle(page);
  return { ok, c: await page.evaluate(COLLECT) };
}

async function cold(i: number, rec: { har: string; trace: string } | null, phone = false): Promise<Run> {
  const ctx = await newCtx({ phone, har: rec?.har });
  const page = await ctx.newPage();
  if (phone) await throttle(ctx, page);
  const r = await traced(page, rec?.trace ?? null, () => loadHome(page, "goto"));
  await ctx.close();
  return { scenario: phone ? "phone" : "cold", i, ...r };
}

let warmCtx: BrowserContext | null = null;
let warmPage: Page | null = null;
async function warm(i: number, rec: { har: string; trace: string } | null): Promise<Run> {
  if (rec) {
    const ctx = await newCtx({ har: rec.har });
    const page = await ctx.newPage();
    await loadHome(page, "goto");
    const r = await traced(page, rec.trace, () => loadHome(page, "reload"));
    await ctx.close();
    return { scenario: "warm", i, ...r };
  }
  if (!warmPage) {
    warmCtx = await newCtx();
    warmPage = await warmCtx.newPage();
    await loadHome(warmPage, "goto");
  }
  return { scenario: "warm", i, ...(await loadHome(warmPage, "reload")) };
}

const STEPS: Array<{ path: string; mark: string }> = [
  { path: "/forecast", mark: "h2:page-ready:/forecast" },
  { path: "/transactions", mark: "h2:page-ready:/transactions" },
  { path: "/amex", mark: "h2:page-ready:/amex" },
  { path: "/reports", mark: "h2:page-ready:/reports" },
  { path: "/banking", mark: "h2:banking-needs-you-ready" },
  { path: "/home", mark: "h2:home-numbers-ready" },
];
let navCtx: BrowserContext | null = null;
async function nav(i: number, rec: { har: string; trace: string } | null): Promise<Run> {
  const ctx = rec ? await newCtx({ har: rec.har }) : (navCtx ??= await newCtx());
  const page = await ctx.newPage();
  const go = async () => {
    const home = await loadHome(page, "goto");
    const steps: Array<{ path: string; ok: boolean; ms: number; requests: number }> = [];
    for (const [k, s] of STEPS.entries()) {
      const before = await page.evaluate(() => performance.getEntriesByType("resource").length);
      await page.evaluate((p) => {
        window.history.pushState(null, "", p);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, s.path);
      const ok = await waitMarks(page, [s.mark], k + 1, 30_000);
      await settle(page, 1000, 15_000);
      const ms = await page.evaluate(([mark, n]) => {
        const start = (performance.getEntriesByName("h2:nav", "mark") as PerformanceMark[]).find((m) => (m.detail as { nav: number }).nav === n);
        const end = (performance.getEntriesByName(mark, "mark") as PerformanceMark[]).find((m) => (m.detail as { nav: number }).nav === n);
        return start && end ? end.startTime - start.startTime : NaN;
      }, [s.mark, k + 1] as const);
      const requests = await page.evaluate((b) => performance.getEntriesByType("resource").slice(b).filter((r) => r.name.includes("/api/")).length, before);
      steps.push({ path: s.path, ok, ms, requests });
    }
    return { ok: home.ok && steps.every((s) => s.ok), c: await page.evaluate(COLLECT), extra: { steps } };
  };
  const r = await traced(page, rec?.trace ?? null, go);
  await page.close();
  if (rec) await ctx.close();
  return { scenario: "nav", i, ...r };
}

async function tabs(i: number, rec: { har: string; trace: string } | null): Promise<Run[]> {
  const ctx = await newCtx({ har: rec?.har });
  const [a, b] = [await ctx.newPage(), await ctx.newPage()];
  const both = () => Promise.all([loadHome(a, "goto"), loadHome(b, "goto")]);
  const [ra, rb] = await traced(a, rec?.trace ?? null, both);
  await ctx.close();
  return [
    { scenario: "tabs", i, ok: ra.ok && rb.ok, c: ra.c, extra: { tab: "a" } },
    { scenario: "tabs", i, ok: ra.ok && rb.ok, c: rb.c, extra: { tab: "b" } },
  ];
}

let bankCtx: BrowserContext | null = null;
let bankPage: Page | null = null;
const BANK_MARKS = ["h2:page-ready:/banking", "h2:banking-needs-you-ready"];
async function bankingOnce(page: Page, how: "goto" | "reload"): Promise<{ ok: boolean; c: Collected }> {
  if (how === "goto") await page.goto(`${BASE}/banking`, { waitUntil: "commit" });
  else await page.reload({ waitUntil: "commit" });
  const ok = await waitMarks(page, BANK_MARKS, 0);
  await settle(page);
  return { ok, c: await page.evaluate(COLLECT) };
}
async function banking(i: number, rec: { har: string; trace: string } | null): Promise<Run> {
  if (rec) {
    const ctx = await newCtx({ har: rec.har });
    const page = await ctx.newPage();
    await bankingOnce(page, "goto");
    const r = await traced(page, rec.trace, () => bankingOnce(page, "reload"));
    await ctx.close();
    return { scenario: "banking", i, ...r };
  }
  if (!bankPage) {
    bankCtx = await newCtx();
    bankPage = await bankCtx.newPage();
    await bankingOnce(bankPage, "goto");
  }
  return { scenario: "banking", i, ...(await bankingOnce(bankPage, "reload")) };
}

async function theme(i: number): Promise<Run> {
  const ctx = await newCtx();
  await ctx.addInitScript(() => { try { localStorage.setItem("h2:appearance", "light"); } catch { /* blocked */ } });
  const page = await ctx.newPage();
  const r = await loadHome(page, "goto");
  await ctx.close();
  return { scenario: "theme", i, ...r };
}

// ── ANALYSIS ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const q = (xs: number[], p: number) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
};
const cnt = (d?: { desc: string }) => (d ? Number(d.desc.split(" ")[0]) || 0 : 0);
const markT = (c: Collected, name: string, nav = 0) => c.marks.find((m) => m.name === name && m.nav === nav)?.t ?? NaN;
function metrics(r: Run): Record<string, number> {
  const c = r.c;
  const home = c.api.filter((a) => a.start < (markT(c, "h2:warmup-start") || Infinity));
  const spine = c.api.find((a) => a.path === "/api/spine");
  const weekly = c.api.find((a) => a.path === "/api/avalanche/weekly");
  const byUrl = new Map<string, number>();
  for (const a of c.api) byUrl.set(a.url, (byUrl.get(a.url) ?? 0) + 1);
  const repaint = markT(c, "h2:theme-repaint");
  const refired = Number.isFinite(repaint) ? c.api.filter((a) => a.start > repaint && c.api.some((b) => b.url === a.url && b.start < repaint)).length : 0;
  return {
    docTtfb: c.nav.ttfb,
    dcl: c.nav.dcl,
    entryEval: markT(c, "h2:entry-eval"),
    jsKB: c.scripts.bytes / 1024,
    spineStart: spine?.start ?? NaN,
    spineTtfb: spine ? spine.ttfb - spine.start : NaN,
    spineEnd: spine?.end ?? NaN,
    spineServer: spine?.st.total?.dur ?? NaN,
    spineLedgerMs: spine?.st.ledger?.dur ?? NaN,
    spinePoolwait: spine?.st.poolwait?.dur ?? NaN,
    spineDb: spine?.st.db?.dur ?? NaN,
    homeNumbers: markT(c, "h2:home-numbers-ready"),
    weeklyPay: markT(c, "h2:weekly-pay-ready"),
    warmupStart: markT(c, "h2:warmup-start"),
    weeklyEnd: weekly?.end ?? NaN,
    warmupBeforeWeekly: Number.isFinite(markT(c, "h2:warmup-start")) && weekly ? (markT(c, "h2:warmup-start") < weekly.end ? 1 : 0) : NaN,
    lcp: c.vitals.lcp ?? NaN,
    cls: c.vitals.cls,
    apiCalls: c.api.length,
    apiCallsBeforeWarmup: home.length,
    ledgerBuilds: c.api.reduce((s, a) => s + cnt(a.st.ledger), 0),
    baseBuilds: c.api.reduce((s, a) => s + cnt(a.st.base400), 0),
    ledgerBuildsBeforeWarmup: home.reduce((s, a) => s + cnt(a.st.ledger), 0),
    baseBuildsBeforeWarmup: home.reduce((s, a) => s + cnt(a.st.base400), 0),
    shareJoined: c.api.reduce((s, a) => s + cnt(a.st.share), 0),
    queries: c.api.reduce((s, a) => s + cnt(a.st.db), 0),
    poolwaitMs: c.api.reduce((s, a) => s + (a.st.poolwait?.dur ?? 0), 0),
    maxDup: Math.max(0, ...byUrl.values()),
    dupExtra: [...byUrl.values()].reduce((s, n) => s + (n - 1), 0),
    themeRepaints: c.marks.filter((m) => m.name === "h2:theme-repaint").length,
    refiredAfterRepaint: refired,
  };
}
const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "—");

function table(rows: Run[], keys: Array<[string, string, number?]>): string {
  const ms = rows.filter((r) => r.ok).map(metrics);
  const out = ["| metric | median | p90 |", "|---|---:|---:|"];
  for (const [k, label, d] of keys) out.push(`| ${label} | ${fmt(q(ms.map((m) => m[k]!), 0.5), d)} | ${fmt(q(ms.map((m) => m[k]!), 0.9), d)} |`);
  return out.join("\n");
}
function apiTable(rows: Run[]): string {
  const per = new Map<string, Array<{ start: number; ttfb: number; end: number; server: number; db: number; q: number; wait: number; ledger: number; base: number }>>();
  for (const r of rows.filter((x) => x.ok)) {
    const cut = markT(r.c, "h2:warmup-start") || Infinity;
    for (const a of r.c.api.filter((x) => x.start < cut)) {
      const l = per.get(a.path) ?? [];
      l.push({ start: a.start, ttfb: a.ttfb - a.start, end: a.end, server: a.st.total?.dur ?? NaN, db: a.st.db?.dur ?? NaN, q: cnt(a.st.db), wait: a.st.poolwait?.dur ?? NaN, ledger: cnt(a.st.ledger), base: cnt(a.st.base400) });
      per.set(a.path, l);
    }
  }
  const out = ["| /api call (before warm-up) | n/run | start | wait (TTFB) | done | server total | db (sum) | queries | pool wait | ledger · base400 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|"];
  const runsOk = rows.filter((x) => x.ok).length || 1;
  for (const [path, l] of [...per].sort((a, b) => q(a[1].map((x) => x.start), 0.5) - q(b[1].map((x) => x.start), 0.5))) {
    const m = (f: (x: (typeof l)[number]) => number) => fmt(q(l.map(f), 0.5));
    out.push(`| ${path} | ${(l.length / runsOk).toFixed(1)} | ${m((x) => x.start)} | ${m((x) => x.ttfb)} | ${m((x) => x.end)} | ${m((x) => x.server)} | ${m((x) => x.db)} | ${m((x) => x.q)} | ${m((x) => x.wait)} | ${m((x) => x.ledger)} · ${m((x) => x.base)} |`);
  }
  return out.join("\n");
}
function dupList(rows: Run[]): string {
  const counts = new Map<string, number[]>();
  for (const r of rows.filter((x) => x.ok)) {
    const byUrl = new Map<string, number>();
    for (const a of r.c.api) byUrl.set(a.url, (byUrl.get(a.url) ?? 0) + 1);
    for (const [u, n] of byUrl) if (n > 1) (counts.get(u) ?? counts.set(u, []).get(u)!).push(n);
  }
  if (!counts.size) return "none";
  return [...counts].map(([u, ns]) => `\`${u.length > 90 ? u.slice(0, 90) + "…" : u}\` ×${q(ns, 0.5)} (in ${ns.length} runs)`).join("<br>");
}

const HOME_KEYS: Array<[string, string, number?]> = [
  ["docTtfb", "document TTFB (ms)"], ["dcl", "DOMContentLoaded (ms)"], ["entryEval", "entry JS evaluated (h2:entry-eval, ms)"], ["jsKB", "JS transferred (KB)"],
  ["spineStart", "/api/spine start (ms)"], ["spineTtfb", "/api/spine wait (TTFB − start, ms)"], ["spineEnd", "/api/spine done (ms)"],
  ["spineServer", "/api/spine server total (ms)"], ["spineDb", "/api/spine db time, summed (ms)"], ["spinePoolwait", "/api/spine pool wait, summed (ms)"], ["spineLedgerMs", "/api/spine ledger build (ms)"],
  ["homeNumbers", "⭐ h2:home-numbers-ready (ms)"], ["weeklyPay", "⭐ h2:weekly-pay-ready (ms)"], ["warmupStart", "h2:warmup-start (ms)"],
  ["lcp", "LCP (ms)"], ["cls", "CLS", 3],
  ["apiCallsBeforeWarmup", "/api calls before warm-up"], ["apiCalls", "/api calls incl. warm-up"],
  ["ledgerBuildsBeforeWarmup", "90-day ledger builds before warm-up"], ["baseBuildsBeforeWarmup", "400-day base builds before warm-up"],
  ["ledgerBuilds", "ledger builds incl. warm-up"], ["baseBuilds", "base400 builds incl. warm-up"], ["shareJoined", "builds joined (shared)"],
  ["queries", "queries (all calls)"], ["poolwaitMs", "pool wait, all calls (ms)"],
  ["dupExtra", "identical duplicate requests"], ["themeRepaints", "theme re-mounts"], ["warmupBeforeWeekly", "warm-up began before /avalanche/weekly finished (1 = yes)", 2],
];

// ── MAIN ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const want = (s: string) => !ONLY || ONLY.includes(s);
const md: string[] = [
  `# Local client waterfall — before (${new Date().toISOString().slice(0, 16)}Z)`,
  "",
  `Real API server (\`server-dist/index.mjs\`, Clerk stand-in) on the seeded perf DB · rich household scale ${SCALE} (${hh.rows} transactions, weekly avalanche cadence) · headless Chromium, dark device · ${ITER} runs per scenario (median, p90), after one unmeasured warm-up. Times are ms from navigation start unless named. Laptop CPU — production runs on 0.5 CPU.`,
];
browser = await chromium.launch({ headless: true });
try {
  for (const jobs of JOBS) {
    await startServer(jobs);
    console.log(`server up (JOBS_MODE=${jobs})`);
    const recDir = join(OUT, jobs);
    const rec = (s: string) => ({ har: join(recDir, `${s}.har`), trace: join(recDir, `${s}.trace.json`) });
    const start = runs.length;
    const scen: Array<[string, (i: number, r: ReturnType<typeof rec> | null) => Promise<Run | Run[]>]> = [
      ["cold", (i, r) => cold(i, r)],
      ["warm", warm],
      ["nav", nav],
      ["phone", (i, r) => cold(i, r, true)],
      ["tabs", tabs],
      ["banking", banking],
    ];
    for (const [name, fn] of scen) {
      if (!want(name)) continue;
      await fn(-1, null); // warm-up, not measured
      for (let i = 0; i < ITER; i++) {
        const r = await fn(i, null);
        for (const x of Array.isArray(r) ? r : [r]) runs.push({ ...x, extra: { ...x.extra, jobs } });
        process.stdout.write(".");
      }
      const recorded = await fn(ITER, rec(name));
      writeFileSync(join(recDir, `${name}.recorded.json`), JSON.stringify(recorded, null, 1));
      console.log(` ${name} done`);
    }
    if (want("theme")) for (let i = 0; i < 3; i++) runs.push({ ...(await theme(i)), extra: { jobs } });
    if (warmCtx) { await warmCtx.close(); warmCtx = null; warmPage = null; }
    if (navCtx) { await navCtx.close(); navCtx = null; }
    if (bankCtx) { await bankCtx.close(); bankCtx = null; bankPage = null; }
    await stopServer();

    const these = runs.slice(start);
    writeFileSync(join(recDir, "runs.json"), JSON.stringify(these));
    const by = (s: string) => these.filter((r) => r.scenario === s);
    md.push("", `## JOBS_MODE=${jobs}`);
    for (const s of ["cold", "warm", "phone", "tabs"]) {
      const rs = by(s);
      if (!rs.length) continue;
      md.push("", `### ${s} — Home (${rs.filter((r) => r.ok).length}/${rs.length} runs reached both marks)`, "", table(rs, HOME_KEYS), "", apiTable(rs), "", `Identical duplicates: ${dupList(rs)}`);
      if (s === "tabs") {
        const pairs = new Map<number, Run[]>();
        for (const r of rs) (pairs.get(r.i) ?? pairs.set(r.i, []).get(r.i)!).push(r);
        const tot = [...pairs.values()].map((p) => p.map(metrics)).map((p) => ({
          l: p.reduce((x, m) => x + m.ledgerBuildsBeforeWarmup!, 0), b: p.reduce((x, m) => x + m.baseBuildsBeforeWarmup!, 0),
          la: p.reduce((x, m) => x + m.ledgerBuilds!, 0), ba: p.reduce((x, m) => x + m.baseBuilds!, 0), j: p.reduce((x, m) => x + m.shareJoined!, 0),
        }));
        md.push("", `Both tabs together (median): 90-day ledger builds before warm-up ${fmt(q(tot.map((t) => t.l), 0.5))}, 400-day base ${fmt(q(tot.map((t) => t.b), 0.5))}; incl. warm-up ${fmt(q(tot.map((t) => t.la), 0.5))} / ${fmt(q(tot.map((t) => t.ba), 0.5))}; joined ${fmt(q(tot.map((t) => t.j), 0.5))}.`);
      }
    }
    const banks = by("banking");
    if (banks.length) {
      const ms = banks.filter((r) => r.ok).map((r) => ({
        summary: markT(r.c, "h2:page-ready:/banking"), needsYou: markT(r.c, "h2:banking-needs-you-ready"),
        ny: r.c.api.find((a) => a.path === "/api/banking/needs-you"), rv: r.c.api.find((a) => a.path === "/api/banking/review"),
        m: metrics(r),
      }));
      const row = (label: string, xs: number[]) => `| ${label} | ${fmt(q(xs, 0.5))} | ${fmt(q(xs, 0.9))} |`;
      md.push("", `### banking — warm reload of /banking (${ms.length}/${banks.length} ok)`, "", "| metric | median | p90 |", "|---|---:|---:|",
        row("⭐ h2:page-ready:/banking (summary real, ms)", ms.map((x) => x.summary)),
        row("⭐ h2:banking-needs-you-ready (ms)", ms.map((x) => x.needsYou)),
        row("/api/banking/review done (ms)", ms.map((x) => x.rv?.end ?? NaN)),
        row("/api/banking/review server total", ms.map((x) => x.rv?.st.total?.dur ?? NaN)),
        row("/api/banking/needs-you start (ms)", ms.map((x) => x.ny?.start ?? NaN)),
        row("/api/banking/needs-you done (ms)", ms.map((x) => x.ny?.end ?? NaN)),
        row("/api/banking/needs-you server total", ms.map((x) => x.ny?.st.total?.dur ?? NaN)),
        row("ledger builds (all calls)", ms.map((x) => x.m.ledgerBuilds!)),
        row("base400 builds (all calls)", ms.map((x) => x.m.baseBuilds!)),
        row("builds joined", ms.map((x) => x.m.shareJoined!)),
        row("/api calls", ms.map((x) => x.m.apiCalls!)),
        row("identical duplicate requests", ms.map((x) => x.m.dupExtra!)),
        "", apiTable(banks), "", `Identical duplicates: ${dupList(banks)}`);
    }
    const navs = by("nav");
    if (navs.length) {
      md.push("", `### nav — Home → Forecast → Chase → Amex → Reports → Banking → Home (${navs.filter((r) => r.ok).length}/${navs.length} ok)`, "", "| step | ready after nav (median) | p90 | /api calls (median) | duplicates in the step |", "|---|---:|---:|---:|---|");
      for (const [k, s] of STEPS.entries()) {
        const xs = navs.map((r) => (r.extra!.steps as Array<{ ms: number; requests: number }>)[k]!);
        md.push(`| ${s.path} | ${fmt(q(xs.map((x) => x.ms), 0.5))} | ${fmt(q(xs.map((x) => x.ms), 0.9))} | ${fmt(q(xs.map((x) => x.requests), 0.5))} | |`);
      }
      // Per page: the identical requests made inside each step.
      const stepDups: string[] = [];
      for (const r of navs.filter((x) => x.ok).slice(0, 1)) {
        const navMarks = r.c.marks.filter((m) => m.name === "h2:nav");
        for (const [k, s] of STEPS.entries()) {
          const t0 = navMarks.find((m) => m.nav === k + 1)?.t ?? Infinity;
          const t1 = navMarks.find((m) => m.nav === k + 2)?.t ?? Infinity;
          const inStep = r.c.api.filter((a) => a.start >= t0 && a.start < t1);
          const byUrl = new Map<string, number>();
          for (const a of inStep) byUrl.set(a.url, (byUrl.get(a.url) ?? 0) + 1);
          const d = [...byUrl].filter(([, n]) => n > 1).map(([u, n]) => `\`${u.slice(0, 80)}\` ×${n}`);
          const builds = inStep.reduce((x, a) => x + cnt(a.st.ledger), 0);
          const bases = inStep.reduce((x, a) => x + cnt(a.st.base400), 0);
          const calls = inStep.map((a) => `${a.url.slice(0, 70)} (${Math.round(a.end - a.start)} ms${cnt(a.st.ledger) || cnt(a.st.base400) ? `, ledger ${cnt(a.st.ledger)}/base ${cnt(a.st.base400)}` : ""}${cnt(a.st.share) ? `, joined ${cnt(a.st.share)}` : ""})`);
          stepDups.push(`- ${s.path}: ${inStep.length} calls, ledger builds ${builds}, base400 ${bases}; duplicates: ${d.join(", ") || "none"}<br>&nbsp;&nbsp;${calls.join("<br>&nbsp;&nbsp;")}`);
        }
      }
      md.push("", "One representative nav run, per step:", ...stepDups);
    }
    const th = by("theme");
    if (th.length) {
      const ms = th.map(metrics);
      const r0 = th[0]!.c;
      const rp = markT(r0, "h2:theme-repaint");
      const refired = r0.api.filter((a) => a.start > rp && r0.api.some((b) => b.url === a.url && b.start < rp)).map((a) => `\`${a.url.slice(0, 70)}\``);
      md.push("", `### theme — remembered Light on a dark device, server Auto (${th.length} runs)`, "", `theme re-mounts per load: ${ms.map((m) => m.themeRepaints).join(", ")} · re-mount at ${fmt(rp)} ms (run 1) · requests re-fired after it (same URL as before it): ${ms.map((m) => m.refiredAfterRepaint).join(", ")} — ${refired.join(", ") || "none"}`);
    }
  }
} finally {
  await browser.close();
  await stopServer();
}
writeFileSync(MD, md.join("\n") + "\n");
console.log(`\n→ ${MD}`);
