// ⭐ (PERF) THE LEDGER CACHE IS KEPT HONEST BY THE DATABASE'S DATA REVISION.
//
// lib/ledgerCache.ts serves a computed ledger / weekly plan again only at the
// household's revision it was built at; triggers (migration 0251) move the
// revision on every write. These tests apply the migration to the test
// database, then check: a repeat at the same revision builds nothing; every
// kind of write — a route, a direct write with no request around it (a job, a
// script) — makes the next read build again and show it; two households never
// share; a write during a build leaves nothing cached; a new day is a new key;
// the kill switch and a database without triggers both mean "no cache".

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";

const A = `perf-cache-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const B = `perf-cache-b-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, string> = {};
let ACTOR = A;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = ACTOR;
    req.actualUserId = ACTOR;
    req.householdId = HH[ACTOR];
    req.householdOwnerId = ACTOR;
    next();
  },
}));

import { pool } from "@workspace/db";
import fullRouter from "../routes";
import { instrumentPool, requestTiming } from "../lib/requestTiming";
import {
  _resetLedgerCacheForTests,
  cachedLedgerRead,
  ledgerCacheSize,
  ledgerCacheStats,
  readHouseholdRevision,
  revisionTriggersReady,
} from "../lib/ledgerCache";
import { findMigrationsDir } from "../lib/migrationsDir";
import { RICH_NOW, cleanupRichHouseholds, seedRichHousehold } from "./_fixtures/richHousehold";

type Metric = { dur?: number; n: number };
function timing(v: string | null): Record<string, Metric> {
  const out: Record<string, Metric> = {};
  for (const part of (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [name, ...ps] = part.split(";");
    const m: Metric = { n: NaN };
    for (const p of ps) {
      const [k, raw] = p.split("=");
      if (k === "dur") m.dur = Number(raw);
      if (k === "desc") m.n = Number(raw!.replace(/"/g, "").split(" ")[0]);
    }
    out[name!] = m;
  }
  return out;
}

let server: Server;
let base = "";
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, t: timing(r.headers.get("server-timing")) };
}
const get = async (p: string) => {
  const r = await call("GET", p);
  expect(r.status, `${p} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
  return r;
};

beforeAll(async () => {
  vi.setSystemTime(RICH_NOW);
  // The revision table and triggers, as production gets them (idempotent; the suite's schema comes from drizzle push).
  const sql = await readFile(path.join(findMigrationsDir(import.meta.url), "0251_household_data_revisions.sql"), "utf8");
  await pool.query(sql);
  HH[A] = (await seedRichHousehold(A, { scale: 1, weekly: true })).householdId;
  HH[B] = (await seedRichHousehold(B, { scale: 1, weekly: true, manualExtra: "900" })).householdId;
  instrumentPool(pool);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", requestTiming());
  app.use("/api", fullRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}/api`;
}, 120_000);

afterAll(async () => {
  delete process.env.LEDGER_CACHE;
  await new Promise<void>((res) => server.close(() => res()));
  vi.useRealTimers();
  await cleanupRichHouseholds([A, B]);
});

beforeEach(() => {
  ACTOR = A;
  delete process.env.LEDGER_CACHE;
  vi.setSystemTime(RICH_NOW);
  _resetLedgerCacheForTests();
});

describe("(PERF) the household data revision", () => {
  it("is in place on every table the cached builds read, and moves on a write", async () => {
    expect(await revisionTriggersReady()).toBe(true);
    const r0 = await readHouseholdRevision(HH[A]!);
    await pool.query("UPDATE recurring_items SET name = name || '.' WHERE household_id = $1", [HH[A]]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 1);
    // One statement over many rows moves it once; another household's write does not move it.
    await pool.query("UPDATE transactions SET description = description || '.' WHERE household_id = $1", [HH[A]]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2);
    const rb = await readHouseholdRevision(HH[B]!);
    await pool.query("UPDATE debts SET name = name || '.' WHERE household_id = $1", [HH[B]]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2);
    expect(await readHouseholdRevision(HH[B]!)).toBe(rb + 1);
    // A write that puts the same values back (a read keeping a row in sync) moves nothing.
    await pool.query("UPDATE debts SET name = name WHERE household_id = $1", [HH[A]]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2);
    // A rolled-back write leaves it where it was.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE debts SET name = name || '.' WHERE household_id = $1", [HH[A]]);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2);
  });
});

describe("(PERF) the weekly avalanche plan and its 400-day base, cached", () => {
  it("a repeat at the same revision prices the plan once; a write makes the next read price it again", async () => {
    const first = await get("/avalanche/weekly");
    expect(first.t.base400!.n).toBe(1);
    const again = await get("/avalanche/weekly");
    expect(again.t.base400!.n).toBe(0);
    expect(again.t.cache!.n).toBeGreaterThanOrEqual(1);
    expect(again.body).toEqual(first.body);
    // A direct write, with no request around it (a job, a script): the next read builds again.
    await pool.query("UPDATE avalanche_settings SET manual_extra = '1200' WHERE user_id = $1", [A]);
    const after = await get("/avalanche/weekly");
    expect(after.t.base400!.n).toBe(1);
    expect(after.body).not.toEqual(first.body);
  });

  it("never crosses households", async () => {
    const a = await get("/avalanche/weekly");
    ACTOR = B;
    const b = await get("/avalanche/weekly");
    expect(b.t.base400!.n).toBe(1);
    expect(b.body).not.toEqual(a.body);
  });

  it("a new household day is a new key", async () => {
    await get("/avalanche/weekly");
    vi.setSystemTime(new Date(RICH_NOW.getTime() + 24 * 3600_000));
    const next = await get("/avalanche/weekly");
    expect(next.t.base400!.n).toBe(1);
  });

  it("LEDGER_CACHE=off builds every time", async () => {
    process.env.LEDGER_CACHE = "off";
    await get("/avalanche/weekly");
    const again = await get("/avalanche/weekly");
    expect(again.t.base400!.n).toBe(1);
    expect(ledgerCacheSize()).toBe(0);
  });
});

describe("(PERF) cachedLedgerRead", () => {
  it("keeps nothing when the household was written while it built, and serves only the revision it was built at", async () => {
    let builds = 0;
    const build = async () => {
      builds += 1;
      // A write lands while this build runs.
      await pool.query("UPDATE recurring_items SET name = name || '.' WHERE household_id = $1", [HH[A]]);
      return { n: builds };
    };
    await cachedLedgerRead("probe", HH[A]!, "k", build);
    expect(ledgerCacheSize()).toBe(0);
    expect(ledgerCacheStats.discarded).toBe(1);
    const quiet = async () => ({ n: ++builds });
    const v1 = await cachedLedgerRead("probe", HH[A]!, "k", quiet);
    const v2 = await cachedLedgerRead("probe", HH[A]!, "k", quiet);
    expect(v2).toBe(v1);
    await pool.query("UPDATE forecast_settings SET cash_buffer = cash_buffer + 1 WHERE user_id = $1", [A]);
    const v3 = await cachedLedgerRead("probe", HH[A]!, "k", quiet);
    expect(v3).not.toBe(v1);
    // Same key text, other household: its own entry.
    const vb = await cachedLedgerRead("probe", HH[B]!, "k", quiet);
    expect(vb).not.toBe(v3);
  });

  it("with the triggers gone, nothing is cached", async () => {
    await pool.query("ALTER TABLE debts DISABLE TRIGGER h2_data_rev_row");
    try {
      _resetLedgerCacheForTests();
      expect(await revisionTriggersReady()).toBe(false);
      let n = 0;
      await cachedLedgerRead("probe", HH[A]!, "k", async () => ++n);
      await cachedLedgerRead("probe", HH[A]!, "k", async () => ++n);
      expect(n).toBe(2);
    } finally {
      await pool.query("ALTER TABLE debts ENABLE TRIGGER h2_data_rev_row");
      _resetLedgerCacheForTests();
    }
  });
});

/** The spine as a page sees it, without the instant it was computed. */
const view = (b: Record<string, unknown>) => {
  const { asOf: _a, dataAsOf, ...rest } = b as { asOf?: unknown; dataAsOf?: { computedAt?: unknown } };
  return { ...rest, dataAsOf: { ...(dataAsOf ?? {}), computedAt: null } };
};
/** The spine now, with the cache, and as built from scratch: they must agree. */
/** Drop every "as of now" stamp (computedAt, asOf) anywhere in an answer: they name the moment, not a figure. */
const stamps = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stamps)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "asOf" && k !== "computedAt").map(([k, x]) => [k, stamps(x)]))
      : v;
/** (PERF) The other pages whose reads are cached too: Banking (review + Needs you) and the Amex summary. */
const PAGES = [
  "/banking/needs-you",
  "/banking/review?from=2026-10-01&to=2026-10-14&rowsPerBucket=25",
  "/amex/summary?accountId=all&from=2026-10-11&to=2026-10-17&rowsPerGroup=50",
  "/reports/spending-facts?from=2026-09-15&to=2026-10-14",
];
async function spineAgrees() {
  const cached = await get("/spine");
  const pages = [];
  for (const p of PAGES) pages.push((await get(p)).body);
  process.env.LEDGER_CACHE = "off";
  const fresh = await get("/spine");
  const freshPages = [];
  for (const p of PAGES) freshPages.push((await get(p)).body);
  delete process.env.LEDGER_CACHE;
  expect(view(cached.body)).toEqual(view(fresh.body));
  for (const [i, p] of PAGES.entries()) expect(stamps(pages[i]), p).toEqual(stamps(freshPages[i]));
  return cached;
}

describe("(PERF) the 90-day cash signal, cached — every kind of write is seen", () => {
  it("a repeat at the same revision builds no ledger at all", async () => {
    const first = await get("/spine");
    expect(first.t.ledger!.n).toBe(1);
    const again = await get("/spine");
    expect(again.t.ledger!.n).toBe(0);
    expect(again.t.base400!.n).toBe(0);
    expect(view(again.body)).toEqual(view(first.body));
    // The other 90-day readers of the page read the same build.
    for (const p of ["/forecast/cash-signal?horizonDays=90", "/money/position", "/forecast?days=90"]) {
      expect((await get(p)).t.ledger!.n, p).toBe(0);
    }
  });

  const txnOf = async (household: string) =>
    (
      await pool.query<{ id: string; amount: string }>(
        "SELECT id, amount FROM transactions WHERE household_id = $1 AND source = 'plaid:lakeside' AND occurred_on >= '2026-10-01' ORDER BY occurred_on DESC LIMIT 1",
        [household],
      )
    ).rows[0]!;
  const planOf = async (household: string, name: string) =>
    (await pool.query<{ id: string }>("SELECT id FROM recurring_items WHERE household_id = $1 AND name LIKE $2 || '%' ORDER BY name LIMIT 1", [household, name])).rows[0]!.id;
  const debtOf = async (household: string, name: string) =>
    (await pool.query<{ id: string }>("SELECT id FROM debts WHERE household_id = $1 AND name LIKE $2 || '%' ORDER BY name LIMIT 1", [household, name])).rows[0]!.id;

  const WRITES: Array<[string, () => Promise<void>]> = [
    ["a transaction edited (PATCH /transactions/:id)", async () => {
      const t = await txnOf(HH[A]!);
      const r = await call("PATCH", `/transactions/${t.id}`, { amount: (Number(t.amount) - 7).toFixed(2) });
      expect(r.status).toBe(200);
    }],
    ["an answer written (POST /forecast/resolutions)", async () => {
      const r = await call("POST", "/forecast/resolutions", { recurringItemId: await planOf(HH[A]!, "Auto loan"), occurrenceDate: "2026-10-20", status: "skipped" });
      expect(r.status).toBeLessThan(300);
    }],
    ["a bill edited (PATCH /recurring-items/:id)", async () => {
      const r = await call("PATCH", `/recurring-items/${await planOf(HH[A]!, "Internet")}`, { name: "Internet bill", amount: "95.00" });
      expect(r.status).toBe(200);
    }],
    ["a debt edited (PATCH /debts/:id)", async () => {
      const r = await call("PATCH", `/debts/${await debtOf(HH[A]!, "HELOC")}`, { minPayment: "190.00" });
      expect(r.status).toBe(200);
    }],
    ["the forecast settings changed (PUT /forecast/settings)", async () => {
      const r = await call("PUT", "/forecast/settings", { cashBuffer: "750.00" });
      expect(r.status).toBe(200);
    }],
    ["rows imported in bulk, as a sync or an import writes them (no request around it)", async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, household_id, occurred_on, description, amount, plaid_account_id, source, plaid_transaction_id)
         SELECT $1, $2, DATE '2026-10-14', 'PERF IMPORTED ROW ' || g, '-12.00', p.account_id, 'plaid:lakeside', 'perf-import-' || $2 || '-' || g
           FROM generate_series(1, 3) g, (SELECT account_id FROM plaid_accounts WHERE household_id = $2 AND subtype = 'checking' LIMIT 1) p`,
        [A, HH[A]],
      );
    }],
    ["a background job's direct write (no request around it)", async () => {
      await pool.query("UPDATE forecast_settings SET bank_snapshot_balance = bank_snapshot_balance + 25 WHERE user_id = $1", [A]);
    }],
  ];
  for (const [what, write] of WRITES) {
    it(`${what}: the next spine builds again and equals a build from scratch`, async () => {
      const before = await spineAgrees();
      expect((await get("/spine")).t.ledger!.n).toBe(0); // cached
      await write();
      const after = await get("/spine");
      expect(after.t.ledger!.n).toBe(1);
      await spineAgrees();
      void before;
    });
  }

  it("the settings write shows: the buffer the spine quotes is the new one", async () => {
    await get("/spine");
    await call("PUT", "/forecast/settings", { cashBuffer: "640.00" });
    expect((await get("/spine")).body.forecast.cashBuffer).toBe("640.00");
  });

  it("two households never share a ledger", async () => {
    const a = await get("/spine");
    ACTOR = B;
    const b = await get("/spine");
    expect(b.t.ledger!.n).toBe(1);
    expect(view(b.body)).not.toEqual(view(a.body));
    ACTOR = A;
    expect((await get("/spine")).t.ledger!.n).toBe(0);
  });

  it("a new household day builds again", async () => {
    await get("/spine");
    vi.setSystemTime(new Date(RICH_NOW.getTime() + 24 * 3600_000));
    expect((await get("/spine")).t.ledger!.n).toBe(1);
  });

  it("a write inside the very request that reads afterwards is never answered from before it", async () => {
    // A GET that heals the snapshot pointer writes forecast_settings, then reads: the request's revision memo is
    // dropped by its own write, so its read is keyed on the new revision.
    await get("/spine");
    const rev = await readHouseholdRevision(HH[A]!);
    await pool.query("UPDATE forecast_settings SET bank_snapshot_mask = coalesce(bank_snapshot_mask, '') || '.' WHERE user_id = $1", [A]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(rev + 1);
    expect((await get("/spine")).t.ledger!.n).toBe(1);
  });
});

describe("(PERF) the revision moves at COMMIT — no lock held through a transaction, no deadlock", () => {
  it("a job writing several statements and a person editing a row the job needs next both commit, and the revision rises after", async () => {
    const r0 = await readHouseholdRevision(HH[A]!);
    const plan = (await pool.query<{ id: string }>("SELECT id FROM recurring_items WHERE household_id = $1 LIMIT 1", [HH[A]])).rows[0]!.id;
    const txn = (await pool.query<{ id: string }>("SELECT id FROM transactions WHERE household_id = $1 LIMIT 1", [HH[A]])).rows[0]!.id;
    const job = await pool.connect();
    const person = await pool.connect();
    try {
      await job.query("BEGIN");
      await job.query("UPDATE recurring_items SET amount = amount + 1 WHERE id = $1", [plan]); // the job's first write
      await person.query("BEGIN");
      await person.query("UPDATE transactions SET description = description || '!' WHERE id = $1", [txn]); // the person holds row Y
      // Nothing is visible, and nothing is locked on the revision, while both are open.
      expect(await readHouseholdRevision(HH[A]!)).toBe(r0);
      const jobNeedsY = job.query("UPDATE transactions SET description = description || '?' WHERE id = $1", [txn]); // waits for the person
      await person.query("COMMIT"); // an immediate trigger would wait here on the job's revision lock: a deadlock
      await jobNeedsY;
      await job.query("COMMIT");
    } finally {
      job.release();
      person.release();
    }
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2); // one bump per committed transaction
  });

  it("a build that started before a transaction committed is not kept", async () => {
    const tx = await pool.connect();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    try {
      await tx.query("BEGIN");
      await tx.query("UPDATE debts SET name = name || '#' WHERE household_id = $1", [HH[A]]);
      const pending = cachedLedgerRead("probe-commit", HH[A]!, "k", async () => {
        await gate;
        return { built: true };
      });
      await new Promise((r) => setTimeout(r, 20)); // the read has its revision (the uncommitted write unseen)
      await tx.query("COMMIT");
      release();
      await pending;
    } finally {
      tx.release();
    }
    expect(ledgerCacheSize()).toBe(0);
    expect(ledgerCacheStats.discarded).toBe(1);
  });

  it("a statement over many rows bumps once", async () => {
    const r0 = await readHouseholdRevision(HH[A]!);
    await pool.query(
      `INSERT INTO forecast_closed_months (user_id, household_id, month_key)
       SELECT $1, $2, to_char(DATE '2020-01-01' + (g || ' months')::interval, 'YYYY-MM') FROM generate_series(0, 49) g
       ON CONFLICT DO NOTHING`,
      [A, HH[A]],
    );
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 1);
    await pool.query("DELETE FROM forecast_closed_months WHERE household_id = $1 AND month_key < '2025-01'", [HH[A]]);
    expect(await readHouseholdRevision(HH[A]!)).toBe(r0 + 2);
  });

  it("cached results are frozen (outside the test suite's own freeze too)", async () => {
    const prev = process.env.LEDGER_SHARING_FREEZE;
    delete process.env.LEDGER_SHARING_FREEZE;
    try {
      const v = await cachedLedgerRead("probe-freeze", HH[A]!, "k", async () => ({ rows: [{ n: 1 }], at: new Date(0), m: new Map([["a", 1]]) }));
      expect(Object.isFrozen(v)).toBe(true);
      expect(() => {
        (v.rows as Array<{ n: number }>)[0]!.n = 2;
      }).toThrow();
      expect(() => v.m.set("b", 2)).toThrow();
      expect(() => v.at.setTime(5)).toThrow();
    } finally {
      if (prev !== undefined) process.env.LEDGER_SHARING_FREEZE = prev;
    }
  });
});
