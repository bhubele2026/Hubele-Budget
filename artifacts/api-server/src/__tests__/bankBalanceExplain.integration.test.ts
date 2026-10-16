import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

/**
 * The balance explainer. Its whole job is to answer, without production
 * credentials, the question that cost an afternoon: "I pressed Sync and the
 * number didn't move — why?"
 */

const TEST_USER = `bank-explain-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { GetForecastBankBalanceExplainResponse } from "@workspace/api-zod";
import bankBalanceExplainRouter from "../routes/bankBalanceExplain";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { householdTodayISO } from "../lib/householdClock";
import { addDaysISO } from "@workspace/avalanche-core";

const app = express();
app.use(express.json());
app.use("/api", bankBalanceExplainRouter);

let server: Server;
let baseUrl: string;

type ExplainRow = {
  id: string;
  date: string;
  description: string | null;
  amount: string;
  pending: boolean;
  accountExternalId: string | null;
  source: string | null;
  onAccount: boolean;
  counted: boolean;
  contribution: string;
  reason: string;
  replacedId: string | null;
};
type Explain = {
  displayed: { bankToday: string };
  snapshot: { balance: string | null; mask: string | null; storedAccountId: string | null };
  account: { resolvedExternalId: string | null; via: string };
  nextSync: { willRefreshBalance: boolean; whyNot: string | null };
  ledger: {
    anchorDay: string | null;
    sinceAnchor: { rowCount: number; net: string } | null;
    rows?: ExplainRow[] | null;
    recentRows: { date: string; description: string; amount: string }[];
  };
  accounts: { externalId: string; isSnapshotAccount: boolean }[];
};
const cents = (v: string) => Math.round(Number(v) * 100);
/** (Task 4) The rows' own sum: Σ contribution over the counted rows, in cents. */
const countedCents = (e: Explain) => (e.ledger.rows ?? []).filter((r) => r.counted).reduce((t, r) => t + cents(r.contribution), 0);
const verdicts = (e: Explain) => Object.fromEntries((e.ledger.rows ?? []).map((r) => [r.description ?? r.id, `${r.reason} ${r.counted ? "counted" : "left out"} ${r.contribution}`]));

async function explain(): Promise<Explain> {
  const res = await fetch(`${baseUrl}/api/forecast/bank-balance-explain`);
  expect(res.status).toBe(200);
  return (await res.json()) as Explain;
}

async function reset(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

async function seedAccount(opts: {
  externalId: string;
  mask: string | null;
  subtype?: string | null;
}): Promise<{ rowId: string; itemRowId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: opts.externalId,
      name: "TOTAL CHECKING",
      mask: opts.mask,
      type: "depository",
      subtype: opts.subtype ?? "checking",
    })
    .returning();
  return { rowId: acct!.id, itemRowId: item!.id };
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await reset();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await reset();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /forecast/bank-balance-explain", () => {
  it("shows the anchor, the rows stacked on it, and the figure they produce", async () => {
    await reset();
    const { rowId } = await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: rowId,
      bankSnapshotBalance: "4726.97",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-08-21",
      description: "HY-VEE",
      amount: "-442.91",
      plaidAccountId: "chase-5526",
      source: "plaid:chase",
      createdAt: createdAtStartOfHouseholdDay("2026-08-21"),
    });

    const e = await explain();
    expect(e.snapshot.balance).toBe("4726.97");
    expect(e.ledger.anchorDay).toBe("2026-08-20");
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 1, net: "-442.91" });
    // The arithmetic on screen, shown rather than asserted at the user.
    expect(e.displayed.bankToday).toBe("4284.06");
    expect(e.ledger.recentRows[0]!.description).toBe("HY-VEE");
    expect(e.account.via).toBe("pointer");
    expect(e.nextSync.willRefreshBalance).toBe(true);
  });

  it("⭐ (PR4e) the rows line is what the balance adds: snapshot + net = the balance, to the cent", async () => {
    // One snapshot read at 07:00 CT on 08-20, and a row of each kind the old
    // day sum got wrong. The old line read "4 rows, −561.60" beside a balance of
    // 4429.06, so the popover's "counted differently" note showed every time.
    await reset();
    const { rowId } = await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: rowId,
      bankSnapshotBalance: "4726.97",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });
    const base = {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      plaidAccountId: "chase-5526",
      source: "plaid:chase",
    };
    await db.insert(transactionsTable).values([
      // Counts: a charge after the read.
      { ...base, occurredOn: "2026-08-21", description: "HY-VEE", amount: "-442.91", createdAt: createdAtStartOfHouseholdDay("2026-08-21") },
      // Held: a snapshot-day charge the ledger had before the read.
      { ...base, occurredOn: "2026-08-20", description: "CASEY'S", amount: "-30.00", createdAt: new Date("2026-08-20T10:00:00Z") },
      // Held: a charge dated two days ahead that was already in the ledger at the read.
      { ...base, occurredOn: "2026-08-22", description: "NETFLIX", amount: "-15.49", createdAt: new Date("2026-08-20T11:00:00Z") },
      // An unlinked pending/posted pair: the charge counts once, at −55.00.
      { ...base, occurredOn: "2026-08-23", description: "TST* CORNER BISTRO", amount: "-48.20", pending: true, createdAt: createdAtStartOfHouseholdDay("2026-08-23") },
      { ...base, occurredOn: "2026-08-24", description: "CORNER BISTRO", amount: "-55.00", createdAt: createdAtStartOfHouseholdDay("2026-08-24") },
      // Counts: a manual row on the account.
      { ...base, plaidAccountId: null, source: "manual", occurredOn: "2026-08-25", description: "Cash deposit", amount: "200.00", createdAt: createdAtStartOfHouseholdDay("2026-08-25") },
    ]);

    const e = await explain();
    // HY-VEE −442.91, the posted −55.00, the manual +200.00.
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 3, net: "-297.91" });
    expect(e.displayed.bankToday).toBe("4429.06");
    expect(cents(e.snapshot.balance!) + cents(e.ledger.sinceAnchor!.net)).toBe(cents(e.displayed.bankToday));
    // ⭐ (Task 4) Every row the roll-forward read, with the rule's own verdict; the counted ones ARE the figure.
    expect(verdicts(e)).toEqual({
      "HY-VEE": "counted counted -442.91",
      "CASEY'S": "held left out 0.00",
      NETFLIX: "held left out 0.00",
      // ⭐ The pair counts once: the pending half is replaced, the posted half counts in full.
      "TST* CORNER BISTRO": "superseded left out 0.00",
      "CORNER BISTRO": "counted counted -55.00",
      "Cash deposit": "counted counted 200.00",
    });
    expect(countedCents(e)).toBe(cents(e.ledger.sinceAnchor!.net));
    expect(e.ledger.rows!.filter((r) => r.counted)).toHaveLength(e.ledger.sinceAnchor!.rowCount);
    const posted = e.ledger.rows!.find((r) => r.description === "CORNER BISTRO")!;
    expect(posted.replacedId).toBe(e.ledger.rows!.find((r) => r.description === "TST* CORNER BISTRO")!.id);
    // Each row as stored: signed amount, pending flag, its account (null for a manual row), newest first.
    expect(e.ledger.rows!.map((r) => r.date)).toEqual([...e.ledger.rows!.map((r) => r.date)].sort().reverse());
    expect(e.ledger.rows!.find((r) => r.description === "Cash deposit")).toMatchObject({ amount: "200.00", pending: false, accountExternalId: null, source: "manual", onAccount: true });
  });

  it("(review E) a typed (manual) snapshot ties the same way", async () => {
    // A balance typed in at 10:00 CT on 08-20. The rule does not care where the
    // anchor came from: a Plaid charge dated ahead that the ledger had before the
    // read is held; a later Plaid charge and a manual row count.
    await reset();
    const { rowId } = await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: rowId,
      bankSnapshotBalance: "2500.00",
      bankSnapshotAt: new Date("2026-08-20T15:00:00Z"),
      bankSnapshotSource: "manual",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });
    const base = { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, plaidAccountId: "chase-5526", source: "plaid:chase" };
    await db.insert(transactionsTable).values([
      { ...base, occurredOn: "2026-08-22", description: "NETFLIX", amount: "-40.00", createdAt: new Date("2026-08-20T14:00:00Z") },
      { ...base, occurredOn: "2026-08-21", description: "HY-VEE", amount: "-60.00", createdAt: createdAtStartOfHouseholdDay("2026-08-21") },
      { ...base, plaidAccountId: null, source: "manual", occurredOn: "2026-08-21", description: "Check 1043", amount: "-25.00", createdAt: createdAtStartOfHouseholdDay("2026-08-21") },
    ]);

    const e = await explain();
    expect(e.snapshot.balance).toBe("2500.00");
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 2, net: "-85.00" });
    expect(e.displayed.bankToday).toBe("2415.00");
    const cents = (v: string) => Math.round(Number(v) * 100);
    expect(cents(e.snapshot.balance!) + cents(e.ledger.sinceAnchor!.net)).toBe(cents(e.displayed.bankToday));
  });

  it("(review) a pair split across the today + 7 edge still ties: a posted row at exactly today + 7 replaces today's pending row", async () => {
    // The explain query reads through today + 7; the balance's 90-day ledger reads
    // further. Today's pending −30.00 is replaced by the posted −32.00 dated on the
    // bound itself, today + 7, so it adds nothing today. The posted −31.00 at
    // today + 8 is a decoy: a posted row replaces only a pending row dated at most
    // 7 days before it, so it can never take today's pending row (and it is past
    // explain's bound). Both reads therefore add only HY-VEE. (PR4e follow-up) The posted row sits ON the bound so a window ending
    // at today + 6 fails here: it misses the −32.00 and counts the −30.00.
    await reset();
    const { rowId } = await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: rowId,
      bankSnapshotBalance: "4726.97",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });
    const today = householdTodayISO();
    const plus7 = addDaysISO(today, 7);
    const plus8 = addDaysISO(today, 8);
    const base = { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, plaidAccountId: "chase-5526", source: "plaid:chase" };
    await db.insert(transactionsTable).values([
      { ...base, occurredOn: "2026-08-21", description: "HY-VEE", amount: "-442.91", createdAt: createdAtStartOfHouseholdDay("2026-08-21") },
      { ...base, occurredOn: today, description: "TST* CORNER BISTRO", amount: "-30.00", pending: true, createdAt: createdAtStartOfHouseholdDay(today) },
      { ...base, occurredOn: plus7, description: "CORNER BISTRO", amount: "-32.00", forecastFlag: true, createdAt: createdAtStartOfHouseholdDay(plus7) },
      { ...base, occurredOn: plus8, description: "CORNER BISTRO", amount: "-31.00", forecastFlag: true, createdAt: createdAtStartOfHouseholdDay(plus8) },
    ]);

    const e = await explain();
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 1, net: "-442.91" });
    expect(e.displayed.bankToday).toBe("4284.06");
  });

  it("(PR4e) an unresolved account still rolls its manual rows, and the rows line says so", async () => {
    // The balance on screen adds manual rows even when no Plaid account resolves;
    // the rows line used to be absent here, so the two could not be compared.
    await reset();
    await seedAccount({ externalId: "chase-a", mask: null });
    await seedAccount({ externalId: "chase-b", mask: null });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotBalance: "4284.06",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      cashBuffer: "0",
    });
    await db.insert(transactionsTable).values([
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: "2026-08-21", description: "Rent check", amount: "-84.06", source: "manual", createdAt: createdAtStartOfHouseholdDay("2026-08-21") },
      // Not on any resolved account: no Plaid row counts.
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: "2026-08-21", description: "KWIK TRIP", amount: "-10.00", plaidAccountId: "chase-a", source: "plaid:chase", createdAt: createdAtStartOfHouseholdDay("2026-08-21") },
    ]);

    const e = await explain();
    expect(e.account.via).toBe("unresolved");
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 1, net: "-84.06" });
    expect(e.displayed.bankToday).toBe("4200.00");
  });

  it("⭐ names why a Sync will not re-read the balance when nothing identifies the account", async () => {
    // Two checking accounts, no stored pointer, no mask on the snapshot: the
    // recovery ladder cannot pick one, so the balance is frozen. THIS is the
    // sentence that was missing all afternoon.
    await reset();
    await seedAccount({ externalId: "chase-a", mask: null });
    await seedAccount({ externalId: "chase-b", mask: null });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotBalance: "4284.06",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      cashBuffer: "0",
    });

    const e = await explain();
    expect(e.account.resolvedExternalId).toBeNull();
    expect(e.account.via).toBe("unresolved");
    expect(e.nextSync.willRefreshBalance).toBe(false);
    expect(e.nextSync.whyNot).toContain("does not resolve");
    // And the frozen figure is stated plainly beside the reason.
    expect(e.displayed.bankToday).toBe("4284.06");
  });

  it("reports the recovery when the stored pointer is dangling but the mask still names it", async () => {
    await reset();
    await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: randomUUID(), // points at nothing
      bankSnapshotBalance: "1000.00",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });

    const e = await explain();
    expect(e.account.resolvedExternalId).toBe("chase-5526");
    expect(e.account.via).toBe("snapshot mask");
    expect(e.nextSync.willRefreshBalance).toBe(true);
    expect(e.accounts.find((a) => a.externalId === "chase-5526")!.isSnapshotAccount).toBe(true);
  });

  it("returns the typed shape the spec promises, with the freshness verdict", async () => {
    // The response used to be an untyped object. It is now `BankBalanceExplain`
    // in the spec, and the page that explains the number reads it through the
    // generated client, so the route has to actually match it.
    await reset();
    const { rowId } = await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: rowId,
      bankSnapshotBalance: "4726.97",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-08-21",
      description: "HY-VEE",
      amount: "-442.91",
      plaidAccountId: "chase-5526",
      source: "plaid:chase",
      createdAt: createdAtStartOfHouseholdDay("2026-08-21"),
    });

    const res = await fetch(`${baseUrl}/api/forecast/bank-balance-explain`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = GetForecastBankBalanceExplainResponse.safeParse(body);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    // (Task 4) …with the rows behind the figure.
    expect((body as Explain).ledger.rows).toHaveLength(1);

    // A Plaid snapshot from Aug 20 whose item has never synced since: old, with
    // no contact and no failure on record.
    // (Round 3) `fetchedAt` is the confidence line's instant (spine.bankConfidence.fetchedAt): with no contact, the snapshot's own time.
    expect((body as { freshness: unknown }).freshness).toEqual({
      source: "plaid",
      lastContactAt: null,
      lastFailureAt: null,
      fetchedAt: "2026-08-20T12:00:00.000Z",
      stale: true,
      staleReason: "old",
    });
  });
});

// ⭐ (Task 4, D) THE ROWS BEHIND "CHECKING TODAY". The explain route lists every row
// the roll-forward read (anchor day − 7 through today) with `classifyCashRows`' own
// verdict — the one rule the balance uses — so the Details list is auditable.
describe("(Task 4) GET /forecast/bank-balance-explain — ledger.rows", () => {
  async function anchorAt(at: Date, balance: string): Promise<void> {
    const { rowId } = await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: rowId,
      bankSnapshotBalance: balance,
      bankSnapshotAt: at,
      bankSnapshotSource: "plaid",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });
  }
  const base = () => ({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, plaidAccountId: "chase-5526", source: "plaid:chase" });

  it("⭐ (zero-rows-today) a $0.00 reading yesterday at 4:19 PM and two PENDING rows dated today: both counted, flagged pending; Σ = Checking today − the reading", async () => {
    await reset();
    const today = householdTodayISO();
    const yesterday = addDaysISO(today, -1);
    // 16:19 Central yesterday (21:19Z in daylight time; the household day is what matters).
    const read = new Date(`${yesterday}T16:19:00-05:00`);
    await anchorAt(read, "0.00");
    await db.insert(transactionsTable).values([
      // A pending deposit after the reading: `available` never holds a pending deposit — it counts.
      { ...base(), occurredOn: today, description: "PAYROLL DEPOSIT", amount: "3500.00", pending: true, createdAt: new Date(read.getTime() + 60 * 60 * 1000) },
      // A pending charge dated after the reading's day, new to the ledger after the read: it counts.
      { ...base(), occurredOn: today, description: "HARDWARE DEPOT 0099", amount: "-125.40", pending: true, createdAt: new Date(read.getTime() + 2 * 60 * 60 * 1000) },
    ]);
    const e = await explain();
    expect(e.snapshot.balance).toBe("0.00");
    expect(e.ledger.rows!.map((r) => [r.description, r.pending, r.counted, r.reason, r.contribution])).toEqual([
      ["PAYROLL DEPOSIT", true, true, "counted", "3500.00"],
      ["HARDWARE DEPOT 0099", true, true, "counted", "-125.40"],
    ]);
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 2, net: "3374.60" });
    expect(e.displayed.bankToday).toBe("3374.60");
    expect(countedCents(e)).toBe(cents(e.displayed.bankToday) - cents(e.snapshot.balance!));
  });

  it("⭐ an anchor-day pending charge with evidence it was in the reading: its posting counts the tip only (adjusted)", async () => {
    await reset();
    const today = householdTodayISO();
    const day = addDaysISO(today, -2);
    const read = new Date(`${day}T12:00:00-05:00`);
    await anchorAt(read, "1000.00");
    await db.insert(transactionsTable).values([
      // On the reading's day, on the ledger before the read: the reading held it.
      { ...base(), occurredOn: day, description: "TST* CORNER BISTRO", amount: "-48.20", pending: true, createdAt: new Date(read.getTime() - 60 * 60 * 1000) },
      // Its posting, the next day, with the tip.
      { ...base(), occurredOn: addDaysISO(day, 1), description: "CORNER BISTRO", amount: "-55.00", createdAt: createdAtStartOfHouseholdDay(addDaysISO(day, 1)) },
    ]);
    const e = await explain();
    expect(verdicts(e)).toEqual({
      "TST* CORNER BISTRO": "held left out 0.00",
      "CORNER BISTRO": "adjusted counted -6.80",
    });
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 1, net: "-6.80" });
    expect(e.displayed.bankToday).toBe("993.20");
    expect(countedCents(e)).toBe(cents(e.displayed.bankToday) - cents(e.snapshot.balance!));
  });

  it("transfers: a checking-side transfer counts; the card's side of a payment, and every other account's row, adds 0 (not_bank); a row dated after today is not listed", async () => {
    await reset();
    const today = householdTodayISO();
    const day = addDaysISO(today, -3);
    await anchorAt(new Date(`${day}T08:00:00-05:00`), "2000.00");
    const card = { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, plaidAccountId: "amex-1001", source: "plaid:amex" };
    await db.insert(transactionsTable).values([
      { ...base(), occurredOn: addDaysISO(day, 1), description: "AMEX EPAYMENT ACH PMT", amount: "-150.00", isTransfer: true, createdAt: createdAtStartOfHouseholdDay(addDaysISO(day, 1)) },
      { ...base(), occurredOn: addDaysISO(day, 1), description: "TRANSFER TO SAVINGS", amount: "-40.00", isTransfer: true, createdAt: createdAtStartOfHouseholdDay(addDaysISO(day, 1)) },
      { ...card, occurredOn: addDaysISO(day, 2), description: "PAYMENT RECEIVED - THANK YOU", amount: "150.00", createdAt: createdAtStartOfHouseholdDay(addDaysISO(day, 2)) },
      { ...card, occurredOn: addDaysISO(day, 2), description: "GREEN GROCER", amount: "-60.00", createdAt: createdAtStartOfHouseholdDay(addDaysISO(day, 2)) },
      // A card row dated before the reading's day: the rule says "held" first — it is another account's all the same.
      { ...card, occurredOn: addDaysISO(day, -1), description: "FUEL STOP", amount: "-45.00", createdAt: createdAtStartOfHouseholdDay(addDaysISO(day, -1)) },
      // Flagged for the forecast, dated tomorrow: not in today's figure, not in the list.
      { ...base(), occurredOn: addDaysISO(today, 1), description: "RENT", amount: "-900.00", forecastFlag: true, createdAt: createdAtStartOfHouseholdDay(today) },
    ]);
    const e = await explain();
    expect(verdicts(e)).toEqual({
      "AMEX EPAYMENT ACH PMT": "counted counted -150.00",
      "TRANSFER TO SAVINGS": "counted counted -40.00",
      "PAYMENT RECEIVED - THANK YOU": "not_bank left out 0.00",
      "GREEN GROCER": "not_bank left out 0.00",
      "FUEL STOP": "held left out 0.00",
    });
    // `onAccount` is the rule's own `isBankRow`: the checking rows are the account's, the card's rows are not.
    expect(Object.fromEntries(e.ledger.rows!.map((r) => [r.description, r.onAccount]))).toEqual({
      "AMEX EPAYMENT ACH PMT": true,
      "TRANSFER TO SAVINGS": true,
      "PAYMENT RECEIVED - THANK YOU": false,
      "GREEN GROCER": false,
      "FUEL STOP": false,
    });
    expect(e.ledger.rows!.some((r) => r.description === "RENT")).toBe(false);
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 2, net: "-190.00" });
    expect(countedCents(e)).toBe(cents(e.displayed.bankToday) - cents(e.snapshot.balance!));
  });

  it("no read time: no roll-forward, rows null; the typed shape still parses", async () => {
    await reset();
    await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, cashBuffer: "0" });
    const res = await fetch(`${baseUrl}/api/forecast/bank-balance-explain`);
    const body = (await res.json()) as Explain;
    expect(body.ledger.sinceAnchor).toBeNull();
    expect(body.ledger.rows).toBeNull();
    expect(GetForecastBankBalanceExplainResponse.safeParse(body).success).toBe(true);
  });
});
