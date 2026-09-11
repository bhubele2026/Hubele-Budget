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
    const today = householdTodayISO();
    const yesterday = addDaysISO(today, -1);
    const readAt = new Date(createdAtStartOfHouseholdDay(yesterday).getTime() + 16.5 * 3_600_000);
    const { itemRowId, ext, acctRowId } = await seedChase("cursor-prev");
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
    await ledgerRow({ ext, ptid: "A", date: yesterday, createdAt: new Date(readAt.getTime() - 3_600_000) });
    nextGet = [plaidTxn(ext, "B", today)];

    await runGapBackfillForItem(TEST_USER, itemRowId);

    const rows = await rowsFor();
    expect(rows.map((r) => r.plaidTransactionId).sort()).toEqual(["A", "B"]);
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, { horizonDays: 30 });
    expect(sig.bankToday).toBe("975.00");
  });
});
