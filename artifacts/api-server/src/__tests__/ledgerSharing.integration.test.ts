// ⭐ (P2) ONE PAGE LOAD BUILDS ONE FORECAST LEDGER — AND EVERY FIGURE IS THE
// SAME AS WHEN EACH REQUEST BUILT ITS OWN.
//
// The dashboard's eight first requests (spine, money position, cash signal 90,
// Amex summary, this week's and this month's breakdown, the banking review, the
// categorization queue) fired together on a rich synthetic household:
//   - the ledger builder runs ONCE (it used to run once per request that needs it);
//   - every response deep-equals the same request run on its own, one after
//     the other, with `LEDGER_SHARING=off`;
//   - nothing is kept: run one after the other with sharing on, each request
//     builds its own ledger again.
// The same for the /amex page's three summaries. A failure inside a shared
// build rejects every waiter, and the next call builds again. The suite runs
// with every result deep-frozen (vitest.config.ts), and this file checks the
// freeze is really on.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";

const OWNER = `p2-share-${process.pid}-${randomUUID().slice(0, 8)}`;
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

import { db } from "@workspace/db";
import fullRouter from "../routes";
import { computeCashSignalDetailed } from "../lib/cashSignal";
import { forecastLedgerBuildCount } from "../lib/forecastLedger";
import { ledgerShareStats, ledgerSharesInFlight } from "../lib/ledgerShare";
import {
  RICH_MONTH,
  RICH_NOW,
  RICH_TODAY,
  RICH_WEEK,
  cleanupRichHouseholds,
  seedRichHousehold,
  type RichHousehold,
} from "./_fixtures/richHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use("/api", fullRouter);

let server: Server;
let baseUrl = "";
let rich: RichHousehold;

async function get(path: string): Promise<unknown> {
  const r = await fetch(`${baseUrl}/api${path}`);
  const body = await r.json();
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

/** The dashboard's first eight requests. */
const PAGE_LOAD = (): Array<[string, string]> => [
  ["spine", "/spine"],
  ["position", "/money/position"],
  ["cashSignal90", "/forecast/cash-signal?horizonDays=90"],
  ["amexSummaryAll", `/amex/summary?accountId=all&from=${RICH_WEEK.from}&to=${RICH_WEEK.to}`],
  ["breakdownWeek", `/money/period-breakdown?period=week&start=${RICH_WEEK.from}&rowsPerGroup=50`],
  ["breakdownMonth", `/money/period-breakdown?period=month&start=${RICH_MONTH.from}&rowsPerGroup=50`],
  ["bankingReview", `/banking/review?from=${RICH_MONTH.from}&to=${RICH_TODAY}&rowsPerBucket=1`],
  ["categorizationReview", "/categorization/review?limit=20"],
];

/** The /amex page: one summary per band tile. */
const AMEX_PAGE = (): Array<[string, string]> => [
  ["all", `/amex/summary?accountId=all&from=${RICH_WEEK.from}&to=${RICH_WEEK.to}`],
  ["platinum", `/amex/summary?accountId=${rich.accounts.platinum}&from=${RICH_WEEK.from}&to=${RICH_WEEK.to}`],
  ["gold", `/amex/summary?accountId=${rich.accounts.gold}&from=${RICH_WEEK.from}&to=${RICH_WEEK.to}`],
  ["blue", `/amex/summary?accountId=${rich.accounts.blue}&from=${RICH_MONTH.from}&to=${RICH_MONTH.to}`],
];

async function together(reqs: Array<[string, string]>) {
  const before = forecastLedgerBuildCount();
  const bodies = await Promise.all(reqs.map(([, p]) => get(p)));
  return { builds: forecastLedgerBuildCount() - before, out: Object.fromEntries(reqs.map(([k], i) => [k, bodies[i]])) };
}

async function oneByOne(reqs: Array<[string, string]>) {
  const before = forecastLedgerBuildCount();
  const out: Record<string, unknown> = {};
  for (const [k, p] of reqs) out[k] = await get(p);
  return { builds: forecastLedgerBuildCount() - before, out };
}

async function unshared<T>(fn: () => Promise<T>): Promise<T> {
  process.env.LEDGER_SHARING = "off";
  try {
    return await fn();
  } finally {
    delete process.env.LEDGER_SHARING;
  }
}

beforeAll(async () => {
  vi.setSystemTime(RICH_NOW);
  rich = await seedRichHousehold(OWNER);
  HOUSEHOLD_ID = rich.householdId;
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // A first pass, so any row a read creates on first use (settings) exists before we compare.
  await oneByOne(PAGE_LOAD());
});

afterEach(() => {
  delete process.env.LEDGER_SHARING;
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.useRealTimers();
  if (server) await new Promise<void>((res) => server.close(() => res()));
  await cleanupRichHouseholds([OWNER]);
});

describe("in-flight sharing of the forecast ledger", () => {
  it("⭐ the dashboard's eight requests together build ONE ledger, and every response equals the unshared one", async () => {
    const alone = await unshared(() => oneByOne(PAGE_LOAD()));
    // Seven of the eight read the forecast ledger (the categorization queue does not).
    expect(alone.builds).toBe(7);

    const joined = ledgerShareStats.joined;
    const shared = await together(PAGE_LOAD());
    expect(shared.builds).toBe(1);
    expect(ledgerShareStats.joined - joined).toBe(6);
    expect(ledgerSharesInFlight()).toBe(0);

    for (const [k] of PAGE_LOAD()) expect(shared.out[k], k).toEqual(alone.out[k]);

    // The fixture holds the figures the pages show (not a household of zeros).
    const spine = shared.out.spine as { bank: { balance: string | null }; forecast: { lowPoint: string } };
    expect(spine.bank.balance).not.toBeNull();
    const sig = shared.out.cashSignal90 as { hookReserves?: unknown[]; daily: unknown[] };
    expect(sig.daily.length).toBe(91);
    expect(sig.hookReserves?.length ?? 0).toBeGreaterThan(0);
  });

  it("the same eight run together with sharing OFF build one ledger each, and still agree", async () => {
    const alone = await unshared(() => oneByOne(PAGE_LOAD()));
    const apart = await unshared(() => together(PAGE_LOAD()));
    expect(apart.builds).toBe(7);
    for (const [k] of PAGE_LOAD()) expect(apart.out[k], k).toEqual(alone.out[k]);
  });

  it("nothing is kept: one after the other with sharing on, each request builds its own ledger", async () => {
    const seq = await oneByOne(PAGE_LOAD());
    expect(seq.builds).toBe(7);
  });

  it("⭐ the /amex page's summaries (all + each card) build one ledger and equal the unshared answers", async () => {
    const alone = await unshared(() => oneByOne(AMEX_PAGE()));
    expect(alone.builds).toBe(4);
    const shared = await together(AMEX_PAGE());
    expect(shared.builds).toBe(1);
    for (const [k] of AMEX_PAGE()) expect(shared.out[k], k).toEqual(alone.out[k]);
  });

  it("different inputs never share: another horizon or another start builds its own ledger", async () => {
    const r = await together([
      ["h90", "/forecast/cash-signal?horizonDays=90"],
      ["h30", "/forecast/cash-signal?horizonDays=30"],
      ["from", `/forecast/cash-signal?horizonDays=90&fromDate=${RICH_WEEK.from}`],
    ]);
    expect(r.builds).toBe(3);
    const alone = await unshared(() =>
      oneByOne([
        ["h90", "/forecast/cash-signal?horizonDays=90"],
        ["h30", "/forecast/cash-signal?horizonDays=30"],
        ["from", `/forecast/cash-signal?horizonDays=90&fromDate=${RICH_WEEK.from}`],
      ]),
    );
    expect(r.out).toEqual(alone.out);
  });

  it("⭐ a failure inside a shared build rejects every waiter, and the next call builds again", async () => {
    const before = forecastLedgerBuildCount();
    const boom = new Error("database unavailable (test)");
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw boom;
    });
    const waiters = [0, 1, 2].map(() => computeCashSignalDetailed(HOUSEHOLD_ID, OWNER, { horizonDays: 90 }));
    for (const w of waiters) await expect(w).rejects.toBe(boom);
    expect(forecastLedgerBuildCount() - before).toBe(1);
    expect(ledgerSharesInFlight()).toBe(0);
    vi.restoreAllMocks();

    const next = await computeCashSignalDetailed(HOUSEHOLD_ID, OWNER, { horizonDays: 90 });
    expect(forecastLedgerBuildCount() - before).toBe(2);
    const alone = await unshared(() => computeCashSignalDetailed(HOUSEHOLD_ID, OWNER, { horizonDays: 90 }));
    expect(next.signal).toEqual(alone.signal);
  });

  it("the suite deep-freezes every result, so a consumer that writes to a shared one fails here", async () => {
    const { signal, ledger } = await computeCashSignalDetailed(HOUSEHOLD_ID, OWNER, { horizonDays: 90 });
    expect(Object.isFrozen(signal)).toBe(true);
    expect(Object.isFrozen(signal.daily)).toBe(true);
    expect(Object.isFrozen(ledger.items)).toBe(true);
    expect(Object.isFrozen(ledger.items[0])).toBe(true);
    expect(() => (ledger.items as unknown[]).push({})).toThrow(TypeError);
    expect(() => ledger.hookPayoffs.set("x", ledger.hookPayoffs.values().next().value!)).toThrow(TypeError);
    expect(() => ledger.remainderByPlanKey.clear()).toThrow(TypeError);
    expect(() => ledger.fromDateOnly.setDate(1)).toThrow(TypeError);
  });
});
