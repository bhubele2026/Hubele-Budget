/**
 * ⭐ PR4d — A RE-MINT ONLY ADOPTS A ROW WHOSE OLD PLAID ID IS GONE.
 *
 * The ±2-day re-mint check (#720) adopted any existing row on the same account
 * with the same amount and a date within two days. Two real charges look exactly
 * like that, so a second −$25 moved the first onto its id and date: one charge
 * vanished from the ledger, and the moved row kept its old `created_at`, so the
 * bank snapshot rule (PR4b) held it as "already in the balance" — cash overstated.
 *
 * Evidence now required:
 *   - cursor sync: Plaid removed the old id in this sync, or the sync started from
 *     a null cursor (full replay) and did not send the old id;
 *   - gap backfill: the old row's date is inside the window /transactions/get just
 *     returned in full, and its id is not in that list.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { addDaysISO } from "@workspace/avalanche-core";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const TEST_USER = `remint-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

type Txn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
  pending_transaction_id?: string | null;
  datetime?: string | null;
};

let nextSync: { added: Txn[]; modified: Txn[]; removed: { transaction_id: string }[] } = {
  added: [],
  modified: [],
  removed: [],
};
let nextGet: Txn[] = [];

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: { ...nextSync, next_cursor: "cursor-next", has_more: false },
      }),
      transactionsGet: async () => ({
        data: { transactions: nextGet, total_transactions: nextGet.length },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "item-default", consent_expiration_time: null } },
      }),
    }),
  };
});

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { runGapBackfillForItem, syncPlaidItem } from "../lib/plaidSync";
import { computeCashSignal } from "../lib/cashSignal";
import { householdTodayISO } from "../lib/householdClock";

async function cleanup(): Promise<void> {
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(async () => {
  await cleanup();
  nextSync = { added: [], modified: [], removed: [] };
  nextGet = [];
});

async function seedChase(cursor: string | null): Promise<{ itemRowId: string; ext: string; acctRowId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
      cursor,
    })
    .returning();
  const ext = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: ext,
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      firstSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  return { itemRowId: item!.id, ext, acctRowId: acct!.id };
}

async function ledgerRow(opts: {
  ext: string;
  ptid: string;
  date: string;
  amount?: string;
  createdAt?: Date;
  occurredAt?: string | null;
  pending?: boolean;
  occurredOnUserOverridden?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: opts.date,
      description: "PARKING GARAGE",
      amount: opts.amount ?? "-25.00",
      source: "plaid:chase",
      plaidTransactionId: opts.ptid,
      plaidAccountId: opts.ext,
      pending: opts.pending ?? false,
      occurredAt: opts.occurredAt ?? null,
      occurredOnUserOverridden: opts.occurredOnUserOverridden ?? false,
      createdAt: opts.createdAt ?? createdAtStartOfHouseholdDay(opts.date),
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

// Plaid sign: positive = money out, so 25 becomes our −25.00.
const plaidTxn = (ext: string, id: string, date: string, extra: Partial<Txn> = {}): Txn => ({
  transaction_id: id,
  account_id: ext,
  date,
  amount: 25,
  name: "PARKING GARAGE",
  ...extra,
});

const rowsFor = () => db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));

describe("(PR4d) cursor sync: re-mint needs evidence the old id is gone", () => {
  it("keeps both of two real −$25 charges a day apart on an incremental sync", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    const firstId = await ledgerRow({ ext, ptid: "A", date: "2026-09-10" });
    nextSync = { added: [plaidTxn(ext, "B", "2026-09-11")], modified: [], removed: [] };

    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await rowsFor();
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.id === firstId)!;
    expect(first.plaidTransactionId).toBe("A");
    expect(first.occurredOn).toBe("2026-09-10");
    expect(rows.find((r) => r.plaidTransactionId === "B")?.occurredOn).toBe("2026-09-11");
  });

  it("still adopts a genuine re-mint: Plaid removed the old id and sent a new one", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    const firstId = await ledgerRow({ ext, ptid: "A", date: "2026-09-10" });
    nextSync = { added: [plaidTxn(ext, "B", "2026-09-10")], modified: [], removed: [{ transaction_id: "A" }] };

    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstId);
    expect(rows[0].plaidTransactionId).toBe("B");
  });

  it("from a null cursor, keeps a row whose id Plaid replayed, and adopts one it did not", async () => {
    const { itemRowId, ext } = await seedChase(null);
    await ledgerRow({ ext, ptid: "A", date: "2026-09-10" });
    nextSync = {
      added: [plaidTxn(ext, "A", "2026-09-10"), plaidTxn(ext, "B", "2026-09-11")],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    expect((await rowsFor()).map((r) => r.plaidTransactionId).sort()).toEqual(["A", "B"]);

    await cleanup();
    const again = await seedChase(null);
    const staleId = await ledgerRow({ ext: again.ext, ptid: "OLD", date: "2026-09-10" });
    nextSync = { added: [plaidTxn(again.ext, "NEW", "2026-09-10")], modified: [], removed: [] };
    await syncPlaidItem(TEST_USER, again.itemRowId);
    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(staleId);
    expect(rows[0].plaidTransactionId).toBe("NEW");
  });

  it("a re-mint honours a manual date edit", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "A", date: "2026-09-09", occurredOnUserOverridden: true });
    nextSync = { added: [plaidTxn(ext, "B", "2026-09-10")], modified: [], removed: [{ transaction_id: "A" }] };

    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidTransactionId).toBe("B");
    expect(rows[0].occurredOn).toBe("2026-09-09");
  });
});

describe("(PR4d) the time first seen survives pending→posted and upserts", () => {
  const AUTH = "2026-09-10T14:12:34.000Z";
  const POSTED = "2026-09-10T20:45:10.000Z";
  const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);

  it("a posted row re-keyed onto its pending row keeps the authorisation time", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "P1", date: "2026-09-10", pending: true, occurredAt: AUTH });
    nextSync = {
      added: [plaidTxn(ext, "POST1", "2026-09-10", { amount: 27.5, pending_transaction_id: "P1", datetime: POSTED })],
      modified: [],
      removed: [{ transaction_id: "P1" }],
    };

    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidTransactionId).toBe("POST1");
    expect(rows[0].amount).toBe("-27.50");
    expect(iso(rows[0].occurredAt)).toBe(AUTH);
  });

  it("an update to the same id keeps a time on file, and fills one that was missing", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "S1", date: "2026-09-10", occurredAt: AUTH });
    await ledgerRow({ ext, ptid: "S2", date: "2026-09-12", amount: "-60.00", occurredAt: null });
    nextSync = {
      added: [],
      modified: [
        plaidTxn(ext, "S1", "2026-09-10", { datetime: POSTED }),
        plaidTxn(ext, "S2", "2026-09-12", { amount: 60, datetime: POSTED }),
      ],
      removed: [],
    };

    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await rowsFor();
    expect(iso(rows.find((r) => r.plaidTransactionId === "S1")?.occurredAt)).toBe(AUTH);
    expect(iso(rows.find((r) => r.plaidTransactionId === "S2")?.occurredAt)).toBe(POSTED);
  });

  it("a whole-hour time on file is a placeholder: a later real time replaces it", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "S3", date: "2026-09-10", occurredAt: "2026-09-10T15:00:00.000Z" });
    nextSync = { added: [], modified: [plaidTxn(ext, "S3", "2026-09-10", { datetime: POSTED })], removed: [] };

    await syncPlaidItem(TEST_USER, itemRowId);

    expect(iso((await rowsFor())[0].occurredAt)).toBe(POSTED);
  });
});

describe("(PR4d) gap backfill: re-mint only inside the window /transactions/get returned", () => {
  const TODAY = new Date("2026-09-12T15:00:00Z");

  it("keeps both charges when the full window lists both ids (stale-cursor overlap of one day)", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "A", date: "2026-09-10" });
    nextGet = [plaidTxn(ext, "A", "2026-09-10"), plaidTxn(ext, "B", "2026-09-11")];

    await runGapBackfillForItem(TEST_USER, itemRowId, { today: TODAY, overlapDays: 1 });

    expect((await rowsFor()).map((r) => r.plaidTransactionId).sort()).toEqual(["A", "B"]);
  });

  it("adopts a row inside the window whose id the full list no longer has", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    const oldId = await ledgerRow({ ext, ptid: "A", date: "2026-09-10" });
    nextGet = [plaidTxn(ext, "B", "2026-09-10")];

    await runGapBackfillForItem(TEST_USER, itemRowId, { today: TODAY, overlapDays: 1 });

    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(oldId);
    expect(rows[0].plaidTransactionId).toBe("B");
  });

  it("never adopts a row dated before the window (heal and reconcile start the day after the newest row)", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "A", date: "2026-09-10" });
    nextGet = [plaidTxn(ext, "B", "2026-09-11")];

    await runGapBackfillForItem(TEST_USER, itemRowId, { today: TODAY });

    const rows = await rowsFor();
    expect(rows.map((r) => r.plaidTransactionId).sort()).toEqual(["A", "B"]);
    expect(rows.find((r) => r.plaidTransactionId === "A")?.occurredOn).toBe("2026-09-10");
  });

  it("the PR4b reviewer's case: cash today is 975.00, not 1000.00", async () => {
    // Balance 1,000.00 read yesterday at 16:30 Chicago, already holding a −$25
    // charge from an hour earlier. A second real −$25 arrives today by backfill.
    const { itemRowId, ext, acctRowId } = await seedChase("cursor-prev");
    const { today, yesterday, readAt } = await snapshotReadYesterday(acctRowId);
    await ledgerRow({ ext, ptid: "A", date: yesterday, createdAt: new Date(readAt.getTime() - 3_600_000) });
    nextGet = [plaidTxn(ext, "B", today)];

    await runGapBackfillForItem(TEST_USER, itemRowId);

    const rows = await rowsFor();
    expect(rows.map((r) => r.plaidTransactionId).sort()).toEqual(["A", "B"]);
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 30 });
    expect(sig.bankToday).toBe("975.00");
  });
});

/** A 1,000.00 bank balance read yesterday at 16:30 Chicago, wired to the account. */
async function snapshotReadYesterday(acctRowId: string): Promise<{ today: string; yesterday: string; readAt: Date }> {
  const today = householdTodayISO();
  const yesterday = addDaysISO(today, -1);
  const readAt = new Date(createdAtStartOfHouseholdDay(yesterday).getTime() + 16.5 * 3_600_000);
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: readAt,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acctRowId,
  });
  return { today, yesterday, readAt };
}

describe("(PR4d review) a pending id with a posted successor in the same batch is not gone", () => {
  // Balance 1,000.00 read yesterday, holding a pending −25 (P1). Plaid then sends
  // P1's posted row (POST1, pointing back at P1) and a separate −25 dated today.
  // The separate charge must not take P1's row: true cash today is 975.00.
  for (const order of ["separate charge first", "posted row first"] as const) {
    it(`cursor sync, ${order}: P1 is re-keyed by POST1, the separate charge is new — cash 975.00`, async () => {
      const { itemRowId, ext, acctRowId } = await seedChase("cursor-prev");
      const { today, yesterday, readAt } = await snapshotReadYesterday(acctRowId);
      const pendingRowId = await ledgerRow({
        ext,
        ptid: "P1",
        date: yesterday,
        pending: true,
        createdAt: new Date(readAt.getTime() - 3_600_000),
      });
      const separate = plaidTxn(ext, "B", today);
      const posted = plaidTxn(ext, "POST1", yesterday, { pending_transaction_id: "P1" });
      nextSync = {
        added: order === "separate charge first" ? [separate, posted] : [posted, separate],
        modified: [],
        removed: [{ transaction_id: "P1" }],
      };

      await syncPlaidItem(TEST_USER, itemRowId);

      const rows = await rowsFor();
      expect(rows.map((r) => r.plaidTransactionId).sort()).toEqual(["B", "POST1"]);
      expect(rows.find((r) => r.id === pendingRowId)?.plaidTransactionId).toBe("POST1");
      const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 30 });
      expect(sig.bankToday).toBe("975.00");
    });
  }

  it("gap backfill (the list is newest first): P1 is re-keyed by POST1, the separate charge is new — cash 975.00", async () => {
    const { itemRowId, ext, acctRowId } = await seedChase("cursor-prev");
    const { today, yesterday, readAt } = await snapshotReadYesterday(acctRowId);
    const pendingRowId = await ledgerRow({
      ext,
      ptid: "P1",
      date: yesterday,
      pending: true,
      createdAt: new Date(readAt.getTime() - 3_600_000),
    });
    nextGet = [plaidTxn(ext, "B", today), plaidTxn(ext, "POST1", yesterday, { pending_transaction_id: "P1" })];

    await runGapBackfillForItem(TEST_USER, itemRowId, { overlapDays: 1 });

    const rows = await rowsFor();
    expect(rows.map((r) => r.plaidTransactionId).sort()).toEqual(["B", "POST1"]);
    expect(rows.find((r) => r.id === pendingRowId)?.plaidTransactionId).toBe("POST1");
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 30 });
    expect(sig.bankToday).toBe("975.00");
  });
});

describe("(PR4d review) an incoming id already on file is an update, never a re-mint", () => {
  const TODAY = new Date("2026-09-12T15:00:00Z");

  it("cursor sync: no unique-index failure, the cursor advances, the removed pending goes", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "A", date: "2026-09-10", pending: true });
    await ledgerRow({ ext, ptid: "B", date: "2026-09-11" });
    nextSync = { added: [], modified: [plaidTxn(ext, "B", "2026-09-11")], removed: [{ transaction_id: "A" }] };

    await syncPlaidItem(TEST_USER, itemRowId);

    const [item] = await db.select().from(plaidItemsTable).where(eq(plaidItemsTable.id, itemRowId));
    expect(item!.cursor).toBe("cursor-next");
    expect((await rowsFor()).map((r) => r.plaidTransactionId)).toEqual(["B"]);
  });

  it("gap backfill: the account's rows after it still land (no unique-index failure)", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "OLD", date: "2026-09-10" });
    await ledgerRow({ ext, ptid: "NEW", date: "2026-09-11" });
    nextGet = [
      plaidTxn(ext, "NEW", "2026-09-11"),
      plaidTxn(ext, "COFFEE1", "2026-09-12", { amount: 12, name: "CORNER COFFEE" }),
    ];

    const result = await runGapBackfillForItem(TEST_USER, itemRowId, { today: TODAY, overlapDays: 1 });

    expect(result.added).toBe(1);
    expect((await rowsFor()).map((r) => r.plaidTransactionId).sort()).toEqual(["COFFEE1", "NEW", "OLD"]);
  });

  it("gap backfill: a row whose date the user moved is never treated as gone", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "A", date: "2026-09-10", occurredOnUserOverridden: true });
    nextGet = [plaidTxn(ext, "B", "2026-09-11")];

    await runGapBackfillForItem(TEST_USER, itemRowId, { today: TODAY, overlapDays: 1 });

    expect((await rowsFor()).map((r) => r.plaidTransactionId).sort()).toEqual(["A", "B"]);
  });
});

describe("(PR4d second look) a genuine re-mint and a separate same-amount charge in one batch", () => {
  // Balance 1,000.00 read yesterday, already holding a posted −25 (OLD). Plaid
  // re-mints OLD as NEW (dated yesterday) and a separate −25 (B) happens today.
  // B is listed first. NEW must take OLD's row; B is new: true cash is 975.00.
  async function seed(cursor: string | null) {
    const { itemRowId, ext, acctRowId } = await seedChase(cursor);
    const { today, yesterday, readAt } = await snapshotReadYesterday(acctRowId);
    const oldRowId = await ledgerRow({
      ext,
      ptid: "OLD",
      date: yesterday,
      createdAt: new Date(readAt.getTime() - 3_600_000),
    });
    return { itemRowId, ext, today, yesterday, oldRowId };
  }
  async function expectResult(oldRowId: string) {
    const rows = await rowsFor();
    expect(rows.map((r) => r.plaidTransactionId).sort()).toEqual(["B", "NEW"]);
    expect(rows.find((r) => r.id === oldRowId)?.plaidTransactionId).toBe("NEW");
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 30 });
    expect(sig.bankToday).toBe("975.00");
  }

  it("gap backfill (newest first): the re-mint takes the old row, the separate charge is new — cash 975.00", async () => {
    const { itemRowId, ext, today, yesterday, oldRowId } = await seed("cursor-prev");
    nextGet = [plaidTxn(ext, "B", today), plaidTxn(ext, "NEW", yesterday)];
    await runGapBackfillForItem(TEST_USER, itemRowId, { overlapDays: 1 });
    await expectResult(oldRowId);
  });

  it("cursor sync with OLD removed: the same", async () => {
    const { itemRowId, ext, today, yesterday, oldRowId } = await seed("cursor-prev");
    nextSync = {
      added: [plaidTxn(ext, "B", today), plaidTxn(ext, "NEW", yesterday)],
      modified: [],
      removed: [{ transaction_id: "OLD" }],
    };
    await syncPlaidItem(TEST_USER, itemRowId);
    await expectResult(oldRowId);
  });

  it("null-cursor replay without OLD: the same", async () => {
    const { itemRowId, ext, today, yesterday, oldRowId } = await seed(null);
    nextSync = { added: [plaidTxn(ext, "B", today), plaidTxn(ext, "NEW", yesterday)], modified: [], removed: [] };
    await syncPlaidItem(TEST_USER, itemRowId);
    await expectResult(oldRowId);
  });
});

describe("(PR4d second look) the pending→posted re-key never moves a row onto an id already on file", () => {
  const TODAY = new Date("2026-09-12T15:00:00Z");

  it("gap backfill: pending P and posted S (naming P) both on file — the account's later rows still land", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "P", date: "2026-09-10", pending: true });
    await ledgerRow({ ext, ptid: "S", date: "2026-09-11" });
    nextGet = [
      plaidTxn(ext, "S", "2026-09-11", { pending_transaction_id: "P" }),
      plaidTxn(ext, "COFFEE1", "2026-09-12", { amount: 12, name: "CORNER COFFEE" }),
    ];

    const result = await runGapBackfillForItem(TEST_USER, itemRowId, { today: TODAY, overlapDays: 1 });

    expect(result.added).toBe(1);
    // P is no longer listed, so the vanished-pending sweep removes it.
    expect((await rowsFor()).map((r) => r.plaidTransactionId).sort()).toEqual(["COFFEE1", "S"]);
  });

  it("cursor sync: S (naming P) modified with P removed — no failure, the cursor advances", async () => {
    const { itemRowId, ext } = await seedChase("cursor-prev");
    await ledgerRow({ ext, ptid: "P", date: "2026-09-10", pending: true });
    await ledgerRow({ ext, ptid: "S", date: "2026-09-11" });
    nextSync = {
      added: [],
      modified: [plaidTxn(ext, "S", "2026-09-11", { pending_transaction_id: "P" })],
      removed: [{ transaction_id: "P" }],
    };

    await syncPlaidItem(TEST_USER, itemRowId);

    const [item] = await db.select().from(plaidItemsTable).where(eq(plaidItemsTable.id, itemRowId));
    expect(item!.cursor).toBe("cursor-next");
    expect((await rowsFor()).map((r) => r.plaidTransactionId)).toEqual(["S"]);
  });
});

describe("(PR4d-2) re-mint ties and the first-sync merge guard", () => {
  it("backfill, an exact tie: the earlier-dated re-mint takes the old row, not the later separate charge — cash 975.00", async () => {
    // OLD (−25) is dated the snapshot day and was on file before the read. Plaid
    // re-mints it as NEW dated a day earlier; a separate −25 X is dated a day later.
    // Both are one day from OLD and X is listed first (newest first).
    const { itemRowId, ext, acctRowId } = await seedChase("cursor-prev");
    const { today, yesterday, readAt } = await snapshotReadYesterday(acctRowId);
    const twoDaysAgo = addDaysISO(today, -2);
    const oldRowId = await ledgerRow({
      ext,
      ptid: "OLD",
      date: yesterday,
      createdAt: new Date(readAt.getTime() - 3_600_000),
    });
    nextGet = [plaidTxn(ext, "X", today), plaidTxn(ext, "NEW", twoDaysAgo)];

    await runGapBackfillForItem(TEST_USER, itemRowId, { overlapDays: 1 });

    const rows = await rowsFor();
    expect(rows.map((r) => r.plaidTransactionId).sort()).toEqual(["NEW", "X"]);
    expect(rows.find((r) => r.id === oldRowId)?.plaidTransactionId).toBe("NEW");
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 30 });
    expect(sig.bankToday).toBe("975.00");
  });

  async function seedFirstSyncChase(): Promise<{ itemRowId: string; ext: string; manualRowId: string }> {
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `item-${randomUUID()}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionName: "Chase",
        institutionSlug: "chase",
        cursor: "cursor-prev",
      })
      .returning();
    const ext = `acct-${randomUUID()}`;
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: ext,
        name: "Chase Checking",
        type: "depository",
        subtype: "checking",
        firstSyncCompletedAt: null,
        importCutoffDate: "2026-09-10",
      })
      .returning();
    // The checking account the forecast uses, so the first-sync merge looks at manual bank rows.
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      daysAhead: 90,
      startingBalance: "0",
      cashBuffer: "0",
      bankSnapshotAccountId: acct!.id,
    });
    const [manual] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-09-08",
        description: "PARKING GARAGE",
        amount: "-25.00",
        source: "manual",
      })
      .returning({ id: transactionsTable.id });
    return { itemRowId: item!.id, ext, manualRowId: manual!.id };
  }

  it("first sync: a manual row still merges with a Plaid id that is not on file (control)", async () => {
    const { itemRowId, ext, manualRowId } = await seedFirstSyncChase();
    nextSync = { added: [plaidTxn(ext, "S", "2026-09-08")], modified: [], removed: [] };

    await syncPlaidItem(TEST_USER, itemRowId);

    const [manual] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, manualRowId));
    expect(manual!.plaidTransactionId).toBe("S");
  });

  it("first sync: a Plaid id already on file is never merged onto a manual row — no failure, the cursor advances", async () => {
    const { itemRowId, ext, manualRowId } = await seedFirstSyncChase();
    await ledgerRow({ ext, ptid: "S", date: "2026-09-08" });
    nextSync = { added: [plaidTxn(ext, "S", "2026-09-08")], modified: [], removed: [] };

    await syncPlaidItem(TEST_USER, itemRowId);

    const [item] = await db.select().from(plaidItemsTable).where(eq(plaidItemsTable.id, itemRowId));
    expect(item!.cursor).toBe("cursor-next");
    const [manual] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, manualRowId));
    expect(manual!.plaidTransactionId).toBeNull();
  });
});
