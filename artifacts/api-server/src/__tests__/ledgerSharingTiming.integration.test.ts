// (P2) TIMING HARNESS — not a gate. Skipped unless LEDGER_TIMING=1.
//
//   LEDGER_TIMING=1 [LEDGER_TIMING_RUNS=7] [LEDGER_TIMING_SCALE=3] [LEDGER_TIMING_OUT=/path.json] \
//     pnpm --filter api-server exec vitest run ledgerSharingTiming
//
// Seeds the rich synthetic household, then times the dashboard's eight first
// requests fired together, and the /amex page's summaries fired together:
// wall time, each request's time, and the queries each request ran (counted
// on the pool, attributed per request with AsyncLocalStorage — a shared build's
// queries count for the request that started it; queries inside a
// `db.transaction` are not counted). Each scenario runs with
// LEDGER_SHARING=off and on (code that predates sharing ignores the switch, so
// the same file times the code before this change too). Median of the runs
// after one warm-up.

import { describe, it, expect, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import express from "express";

const OWNER = `p2-timing-${process.pid}-${randomUUID().slice(0, 8)}`;
let HOUSEHOLD_ID = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HOUSEHOLD_ID;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import { pool } from "@workspace/db";
import fullRouter from "../routes";
import * as ledgerModule from "../lib/forecastLedger";
import {
  RICH_MONTH,
  RICH_NOW,
  RICH_TODAY,
  RICH_WEEK,
  cleanupRichHouseholds,
  seedRichHousehold,
} from "./_fixtures/richHousehold";

type Store = { queries: number };
const als = new AsyncLocalStorage<Store>();
const stores = new Map<string, Store>();

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const buildCount = (): number | null =>
  typeof (ledgerModule as Record<string, unknown>).forecastLedgerBuildCount === "function"
    ? (ledgerModule as unknown as { forecastLedgerBuildCount: () => number }).forecastLedgerBuildCount()
    : null;

describe.skipIf(process.env.LEDGER_TIMING !== "1")("P2 timing harness", () => {
  it(
    "times the dashboard's first requests and the /amex summaries, sharing off and on",
    async () => {
      const RUNS = Number(process.env.LEDGER_TIMING_RUNS ?? 7);
      const SCALE = Number(process.env.LEDGER_TIMING_SCALE ?? 3);
      vi.setSystemTime(RICH_NOW);
      const rich = await seedRichHousehold(OWNER, { scale: SCALE });
      HOUSEHOLD_ID = rich.householdId;

      const origQuery = pool.query;
      (pool as unknown as { query: unknown }).query = function (this: unknown, ...args: unknown[]) {
        const s = als.getStore();
        if (s) s.queries += 1;
        return (origQuery as (...a: unknown[]) => unknown).apply(this, args);
      };

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        const id = String(req.headers["x-req-id"] ?? "");
        const store: Store = { queries: 0 };
        stores.set(id, store);
        als.run(store, () => next());
      });
      app.use("/api", fullRouter);
      const server = createServer(app);
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no address");
      const base = `http://127.0.0.1:${addr.port}/api`;

      const PAGE: Array<[string, string]> = [
        ["spine", "/spine"],
        ["position", "/money/position"],
        ["cash-signal 90", "/forecast/cash-signal?horizonDays=90"],
        ["amex summary all", `/amex/summary?accountId=all&from=${RICH_WEEK.from}&to=${RICH_WEEK.to}`],
        ["breakdown week", `/money/period-breakdown?period=week&start=${RICH_WEEK.from}&rowsPerGroup=50`],
        ["breakdown month", `/money/period-breakdown?period=month&start=${RICH_MONTH.from}&rowsPerGroup=50`],
        ["banking review", `/banking/review?from=${RICH_MONTH.from}&to=${RICH_TODAY}&rowsPerBucket=1`],
        ["categorization review", "/categorization/review?limit=20"],
      ];
      const AMEX: Array<[string, string]> = [
        ["amex all", `/amex/summary?accountId=all&from=${RICH_WEEK.from}&to=${RICH_WEEK.to}`],
        ["amex platinum", `/amex/summary?accountId=${rich.accounts.platinum}&from=${RICH_WEEK.from}&to=${RICH_WEEK.to}`],
        ["amex gold", `/amex/summary?accountId=${rich.accounts.gold}&from=${RICH_WEEK.from}&to=${RICH_WEEK.to}`],
        ["amex blue", `/amex/summary?accountId=${rich.accounts.blue}&from=${RICH_MONTH.from}&to=${RICH_MONTH.to}`],
      ];

      async function fire(reqs: Array<[string, string]>) {
        const b0 = buildCount();
        const t0 = performance.now();
        const per = await Promise.all(
          reqs.map(async ([name, path]) => {
            const id = randomUUID();
            const s = performance.now();
            const r = await fetch(`${base}${path}`, { headers: { "x-req-id": id } });
            await r.json();
            if (r.status !== 200) throw new Error(`${path} -> ${r.status}`);
            const ms = performance.now() - s;
            const queries = stores.get(id)?.queries ?? 0;
            stores.delete(id);
            return { name, ms, queries };
          }),
        );
        const b1 = buildCount();
        return { wall: performance.now() - t0, per, builds: b0 == null || b1 == null ? null : b1 - b0 };
      }

      async function scenario(label: string, reqs: Array<[string, string]>, sharing: "off" | "on") {
        if (sharing === "off") process.env.LEDGER_SHARING = "off";
        else delete process.env.LEDGER_SHARING;
        await fire(reqs); // warm-up
        const runs: Array<Awaited<ReturnType<typeof fire>>> = [];
        for (let i = 0; i < RUNS; i += 1) runs.push(await fire(reqs));
        delete process.env.LEDGER_SHARING;
        return {
          label,
          sharing,
          wallMs: Math.round(median(runs.map((r) => r.wall))),
          builds: runs[0]!.builds,
          totalQueries: median(runs.map((r) => r.per.reduce((s, p) => s + p.queries, 0))),
          per: reqs.map(([name], i) => ({
            name,
            ms: Math.round(median(runs.map((r) => r.per[i]!.ms))),
            queries: median(runs.map((r) => r.per[i]!.queries)),
          })),
        };
      }

      // Alone, for reference: the spine with nothing beside it.
      const results = [
        await scenario("spine alone", [PAGE[0]!], "off"),
        await scenario("dashboard (8 together)", PAGE, "off"),
        await scenario("dashboard (8 together)", PAGE, "on"),
        await scenario("/amex (4 summaries together)", AMEX, "off"),
        await scenario("/amex (4 summaries together)", AMEX, "on"),
      ];

      (pool as unknown as { query: unknown }).query = origQuery;
      await new Promise<void>((res) => server.close(() => res()));
      vi.useRealTimers();
      await cleanupRichHouseholds([OWNER]);

      const lines = [`rows seeded: ${rich.rowCount} · runs: ${RUNS} (median) · pool max 8`];
      for (const r of results) {
        lines.push(
          `\n${r.label} · sharing ${r.sharing} · wall ${r.wallMs} ms · queries ${r.totalQueries} · ledger builds ${r.builds ?? "n/a"}`,
        );
        for (const p of r.per) lines.push(`  ${p.name.padEnd(24)} ${String(p.ms).padStart(6)} ms  ${String(p.queries).padStart(4)} q`);
      }
      console.log(`\n[P2 timing]\n${lines.join("\n")}\n`);
      if (process.env.LEDGER_TIMING_OUT) writeFileSync(process.env.LEDGER_TIMING_OUT, JSON.stringify({ rows: rich.rowCount, results }, null, 2));
      expect(results.length).toBe(5);
    },
    15 * 60_000,
  );
});
