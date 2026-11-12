/**
 * PERF HARNESS — server only: the API's own time per endpoint on the seeded perf database, read from Server-Timing,
 * with the server process's CPU time beside it. No browser.
 *
 *   PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH" caffeinate -i \
 *   pnpm --filter @workspace/scripts exec tsx ./perf/server-bench.mts [RUNS=15] [SCALES=3,8] [PORT=3291] [SKIP_BUILD=1]
 *     [MD=/private/tmp/claude-501/perf/server-bench.md]
 *
 * Needs `seed.mts` first. Builds the server bundle (`build-server.mjs`) unless SKIP_BUILD, starts it with JOBS_MODE=off
 * and LOG_LEVEL=warn (so log formatting does not count as request CPU), and for each household scale:
 *   1. SEQUENTIAL — each endpoint alone, RUNS times after one warm-up: client ms, Server-Timing (total, db summed,
 *      queries, pool wait, ledger and base400 builds and ms), and the server's CPU ms for that request
 *      (`ps` cputime before/after; nothing else runs, so it is the request's own).
 *   2. THE SPINE'S BRANCHES — the `sp.*` spans of the sequential spine runs (each branch's time to settle, measured
 *      from the start of the spine's fan-out; position/allowance/confidence await the cash signal inside).
 *   3. HOME'S REAL SET — what /home fires at open, together: spine, plaid/items, cash-signal 90, review count, me,
 *      avalanche/weekly, whats-new; then money/position after the spine (the page asks it only once the spine is
 *      in, as it does today). Wall time to the spine and to the position; builds summed over every response.
 *      Also the same set with money/position fired at once with the rest.
 * The laptop CPU is not production's: Render runs this service on 0.5 CPU.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PERF = process.env.PERF_DIR ?? "/private/tmp/claude-501/perf";
const MD = process.env.MD ?? join(PERF, "server-bench.md");
const RUNS = Number(process.env.RUNS ?? 15);
const PORT = Number(process.env.PORT ?? 3291);
const BASE = `http://127.0.0.1:${PORT}/api`;
const SERVER_OUT = join(PERF, "server-dist");
const seeded = JSON.parse(readFileSync(join(PERF, "households.json"), "utf8")) as {
  databaseUrl: string;
  households: Array<{ scale: number; ownerUserId: string; rows: number }>;
};
const SCALES = (process.env.SCALES ?? seeded.households.map((h) => h.scale).join(",")).split(",").map(Number);

if (!process.env.SKIP_BUILD) {
  const r = spawnSync("node", [join(HERE, "build-server.mjs")], { cwd: ROOT, env: { ...process.env, OUT: SERVER_OUT }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}

// ── SERVER ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(PERF, { recursive: true });
const log = openSync(join(PERF, "server-bench.log"), "w");
const server: ChildProcess = spawn("node", [join(SERVER_OUT, "index.mjs")], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    DATABASE_URL: seeded.databaseUrl, PORT: String(PORT), MIGRATE_ON_BOOT: "false", JOBS_MODE: "off",
    OWNER_EMAIL: "perf-owner@example.com", PERF_USER_ID: seeded.households[0]!.ownerUserId,
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn", APP_BUILD_ID: "dev", RATE_LIMIT_MAX: "1000000", // the bench outruns the 600/min abuse limiter
  },
  stdio: ["ignore", log, log],
});
const kill = () => { if (server.pid && server.exitCode === null) try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", kill);
process.on("SIGINT", () => { kill(); process.exit(130); });
for (let i = 0; ; i++) {
  if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: see ${join(PERF, "server-bench.log")}`);
  try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* not yet */ }
  if (i > 120) throw new Error("server did not come up");
  await new Promise((r) => setTimeout(r, 250));
}

/** The server's CPU time so far (ms), from ps (centisecond resolution). */
function cpuMs(): number {
  const out = spawnSync("ps", ["-o", "time=", "-p", String(server.pid)], { encoding: "utf8" }).stdout.trim();
  const m = out.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return NaN;
  const [, d, h, mi, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(mi) * 60 + Number(s)) * 1000;
}

// ── REQUESTS ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
type ST = Record<string, { dur: number; n: number }>;
function parseST(v: string | null): ST {
  const out: ST = {};
  for (const part of (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [name, ...ps] = part.split(";");
    let dur = NaN, n = NaN;
    for (const p of ps) {
      const [k, raw] = p.split("=");
      if (k === "dur") dur = Number(raw);
      if (k === "desc") n = Number(raw!.replace(/"/g, "").split(" ")[0]);
    }
    out[name!] = { dur, n };
  }
  return out;
}
async function get(path: string, user: string): Promise<{ ms: number; st: ST; t0: number; t1: number }> {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, { headers: { "x-perf-user": user } });
  await r.arrayBuffer();
  const t1 = performance.now();
  if (r.status !== 200) throw new Error(`${path} → ${r.status}`);
  return { ms: t1 - t0, st: parseST(r.headers.get("server-timing")), t0, t1 };
}

const q = (xs: number[], p: number) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};
const f = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const med = (xs: number[]) => q(xs, 0.5);

const chicagoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = chicagoToday();
const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
const weekFrom = addDays(today, -dow);
const weekTo = addDays(weekFrom, 6);
const monthFrom = `${today.slice(0, 7)}-01`;

const ENDPOINTS: Array<[string, string]> = [
  ["spine", "/spine"],
  ["money/position", "/money/position"],
  ["forecast/cash-signal 90", "/forecast/cash-signal?horizonDays=90"],
  ["avalanche/weekly", "/avalanche/weekly"],
  ["forecast?days=90", "/forecast?days=90"],
  ["banking/review (month, 25/bucket)", `/banking/review?from=${monthFrom}&to=${today}&rowsPerBucket=25`],
  ["banking/needs-you", "/banking/needs-you"],
  ["amex/summary (all, week)", `/amex/summary?accountId=all&from=${weekFrom}&to=${weekTo}&rowsPerGroup=50`],
  ["transactions/ledger (week, 50)", `/transactions/ledger?limit=50&from=${weekFrom}&to=${today}`],
];
const HOME_SET: Array<[string, string]> = [
  ["spine", "/spine"],
  ["plaid/items", "/plaid/items"],
  ["cash-signal 90", "/forecast/cash-signal?horizonDays=90"],
  ["review count", "/categorization/review/count"],
  ["me", "/me"],
  ["avalanche/weekly", "/avalanche/weekly"],
  ["whats-new/me", "/whats-new/me"],
];

const md: string[] = [
  `# Server-only bench — before (${new Date().toISOString().slice(0, 16)}Z)`,
  "",
  `The real server bundle (Clerk stand-in), JOBS_MODE=off, LOG_LEVEL=warn, local Postgres 16 on this laptop, pool max 8. ${RUNS} runs after one warm-up; median (p90). "db" is the SUM of query time (queries fired together overlap, so it can exceed the request); "pool wait" is the summed wait for a connection; CPU is the server process's CPU time across that one request (nothing else running). ⚠️ Production runs on 0.5 CPU: CPU-bound time there is about 2× this laptop's per-core speed difference on top (not measured here).`,
];

for (const scale of SCALES) {
  const h = seeded.households.find((x) => x.scale === scale)!;
  const user = h.ownerUserId;
  md.push("", `## Scale ${scale} — ${h.rows} transactions, weekly avalanche cadence`, "", "### 1. Each endpoint alone (sequential)", "",
    "| endpoint | client ms | server total | db (sum) | queries | pool wait | CPU ms | ledger builds (ms) | base400 builds (ms) | joined |", "|---|---:|---:|---:|---:|---:|---:|---|---|---:|");
  const spineRuns: ST[] = [];
  for (const [label, path] of ENDPOINTS) {
    await get(path, user);
    const rs: Array<{ ms: number; st: ST; cpu: number }> = [];
    for (let i = 0; i < RUNS; i++) {
      const c0 = cpuMs();
      const r = await get(path, user);
      rs.push({ ...r, cpu: cpuMs() - c0 });
      if (label === "spine") spineRuns.push(r.st);
    }
    const m = (k: string, x: "dur" | "n") => med(rs.map((r) => r.st[k]?.[x] ?? NaN));
    const mp = (k: string, x: "dur" | "n") => q(rs.map((r) => r.st[k]?.[x] ?? NaN), 0.9);
    md.push(`| ${label} | ${f(med(rs.map((r) => r.ms)))} (${f(q(rs.map((r) => r.ms), 0.9))}) | ${f(m("total", "dur"))} (${f(mp("total", "dur"))}) | ${f(m("db", "dur"))} | ${f(m("db", "n"))} | ${f(m("poolwait", "dur"), 1)} | ${f(med(rs.map((r) => r.cpu)))} | ${f(m("ledger", "n"))} (${f(m("ledger", "dur"))}) | ${f(m("base400", "n"))} (${f(m("base400", "dur"))}) | ${f(m("share", "n"))} |`);
  }

  // 2. The spine's branches.
  const names = [...new Set(spineRuns.flatMap((s) => Object.keys(s).filter((k) => k.startsWith("sp."))))];
  const rows = names.map((n) => [n, med(spineRuns.map((s) => s[n]?.dur ?? NaN)), q(spineRuns.map((s) => s[n]?.dur ?? NaN), 0.9)] as const).sort((a, b) => b[1] - a[1]);
  md.push("", "### 2. The spine's branches (alone; time for each to settle)", "", "| branch | median ms | p90 |", "|---|---:|---:|", ...rows.map(([n, a, b]) => `| ${n} | ${f(a)} | ${f(b)} |`),
    "", `spine total ${f(med(spineRuns.map((s) => s.total?.dur ?? NaN)))} ms · ledger build ${f(med(spineRuns.map((s) => s.ledger?.dur ?? NaN)))} ms (of which the 400-day base ${f(med(spineRuns.map((s) => s.base400?.dur ?? NaN)))} ms) · db summed ${f(med(spineRuns.map((s) => s.db?.dur ?? NaN)))} ms over ${f(med(spineRuns.map((s) => s.db?.n ?? NaN)))} queries · pool wait summed ${f(med(spineRuns.map((s) => s.poolwait?.dur ?? NaN)), 1)} ms · auth ${f(med(spineRuns.map((s) => s.auth?.dur ?? NaN)), 1)} ms`);

  // 3. Home's real set.
  async function homeOnce(positionSerial: boolean) {
    const t0 = performance.now();
    const c0 = cpuMs();
    const fired = HOME_SET.map(([label, path]) => get(path, user).then((r) => ({ label, ...r })));
    let position: Promise<{ label: string; ms: number; st: ST; t0: number; t1: number }>;
    if (positionSerial) position = fired[0]!.then(() => get("/money/position", user).then((r) => ({ label: "money/position", ...r })));
    else position = get("/money/position", user).then((r) => ({ label: "money/position", ...r }));
    const all = await Promise.all([...fired, position]);
    const spine = all.find((x) => x.label === "spine")!;
    const pos = all.find((x) => x.label === "money/position")!;
    const sum = (k: string) => all.reduce((s, x) => s + (x.st[k]?.n || 0), 0);
    return {
      wall: performance.now() - t0, spineDone: spine.t1 - t0, positionDone: pos.t1 - t0,
      ledger: sum("ledger"), base: sum("base400"), joined: sum("share"), queries: sum("db"),
      wait: all.reduce((s, x) => s + (x.st.poolwait?.dur || 0), 0), cpu: cpuMs() - c0,
      per: all.map((x) => ({ label: x.label, ms: x.t1 - x.t0, server: x.st.total?.dur ?? NaN, ledger: x.st.ledger?.n ?? 0, base: x.st.base400?.n ?? 0, joined: x.st.share?.n ?? 0, wait: x.st.poolwait?.dur ?? 0 })),
    };
  }
  for (const serial of [true, false]) {
    await homeOnce(serial);
    const rs = [];
    for (let i = 0; i < RUNS; i++) rs.push(await homeOnce(serial));
    const m = (k: keyof (typeof rs)[number]) => f(med(rs.map((r) => r[k] as number)));
    const mp = (k: keyof (typeof rs)[number]) => f(q(rs.map((r) => r[k] as number), 0.9));
    md.push("", `### 3${serial ? "a" : "b"}. Home's real set together${serial ? " — money/position after the spine (as today)" : " — money/position fired with the rest"}`, "",
      `spine done ${m("spineDone")} (${mp("spineDone")}) ms · money/position done ${m("positionDone")} (${mp("positionDone")}) ms · all done ${m("wall")} (${mp("wall")}) ms · **90-day ledger builds ${m("ledger")}, 400-day base builds ${m("base")}**, joined ${m("joined")} · queries ${m("queries")} · pool wait summed ${m("wait")} ms · server CPU ${m("cpu")} ms`,
      "", "| call | client ms | server total | ledger · base400 · joined | pool wait |", "|---|---:|---:|---|---:|",
      ...rs[0]!.per.map((_, j) => {
        const xs = rs.map((r) => r.per[j]!);
        return `| ${xs[0]!.label} | ${f(med(xs.map((x) => x.ms)))} | ${f(med(xs.map((x) => x.server)))} | ${f(med(xs.map((x) => x.ledger)))} · ${f(med(xs.map((x) => x.base)))} · ${f(med(xs.map((x) => x.joined)))} | ${f(med(xs.map((x) => x.wait)), 1)} |`;
      }));
  }
  console.log(`scale ${scale} done`);
}
kill();
writeFileSync(MD, md.join("\n") + "\n");
console.log(`→ ${MD}`);
