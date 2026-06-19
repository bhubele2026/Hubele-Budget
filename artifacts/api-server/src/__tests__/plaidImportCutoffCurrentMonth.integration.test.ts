import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `cutoff403-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

type AddedTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
};

let nextSyncResponse: {
  added: AddedTxn[];
  modified: AddedTxn[];
  removed: { transaction_id: string }[];
} = { added: [], modified: [], removed: [] };

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: {
          added: nextSyncResponse.added,
          modified: nextSyncResponse.modified,
          removed: nextSyncResponse.removed,
          next_cursor: "cursor-1",
          has_more: false,
        },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: {
          item: { item_id: "item-default", consent_expiration_time: null },
        },
      }),
    }),
  };
});

import {
  db,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  autoDetectCutoffsForItem,
  clampCutoffBeforeCurrentMonth,
} from "../lib/plaidImportCutoff";
import { syncPlaidItem } from "../lib/plaidSync";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});
afterAll(async () => {
  await cleanup();
});
// Pin "now" to mid-May 2026 so the current-month clamp is deterministic.
// `autoDetectCutoffsForItem` / `computeImportCutoffForAccount` read the
// real `new Date()` internally (no injectable clock on that path), so
// without this the May-2026 fixtures only pass when the suite happens to
// run during May 2026 — every other month the "prior month" rolls and the
// clamp ceiling moves, breaking the hardcoded 2026-04-30 expectations.
const PINNED_NOW = new Date("2026-05-07T12:00:00Z");

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedChaseChecking(opts: {
  manualDates?: string[];
  initialCutoff?: string | null;
  firstSyncCompletedAt?: Date | null;
}): Promise<{ itemRowId: string; acctRowId: string; externalAcctId: string }> {
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
  const externalAcctId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      importCutoffDate: opts.initialCutoff ?? null,
      firstSyncCompletedAt: opts.firstSyncCompletedAt ?? null,
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotAccountId: acct!.id,
  });
  for (const d of opts.manualDates ?? []) {
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: d,
      description: `manual ${d}`,
      amount: "-12.34",
      source: "manual",
    });
  }
  return { itemRowId: item!.id, acctRowId: acct!.id, externalAcctId };
}

describe("(#403) clampCutoffBeforeCurrentMonth", () => {
  it("returns null untouched", () => {
    expect(
      clampCutoffBeforeCurrentMonth(null, new Date("2026-05-07T00:00:00Z")),
    ).toBeNull();
  });
  it("leaves a cutoff in a prior month alone", () => {
    expect(
      clampCutoffBeforeCurrentMonth(
        "2026-04-15",
        new Date("2026-05-07T00:00:00Z"),
      ),
    ).toBe("2026-04-15");
  });
  it("clamps a current-month cutoff back to the last day of the prior month", () => {
    expect(
      clampCutoffBeforeCurrentMonth(
        "2026-05-03",
        new Date("2026-05-07T00:00:00Z"),
      ),
    ).toBe("2026-04-30");
  });
  it("clamps a future-month cutoff back to the last day of the prior month", () => {
    expect(
      clampCutoffBeforeCurrentMonth(
        "2026-06-15",
        new Date("2026-05-07T00:00:00Z"),
      ),
    ).toBe("2026-04-30");
  });
  it("handles January (clamps back into the prior year)", () => {
    expect(
      clampCutoffBeforeCurrentMonth(
        "2027-01-15",
        new Date("2027-01-07T00:00:00Z"),
      ),
    ).toBe("2026-12-31");
  });
});

describe("(#403) autoDetectCutoffsForItem refreshes a stale cutoff on re-link", () => {
  it("clears a stale cutoff that sits in the current month when no manual rows justify it", async () => {
    const { itemRowId, acctRowId } = await seedChaseChecking({
      // Stale value from a prior run that over-shot into the current
      // month — exactly the symptom from the seed Chase account.
      initialCutoff: "2026-05-03",
      manualDates: [],
    });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "chase");
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    // No manual rows → no overlap → cutoff should be cleared.
    expect(acct.importCutoffDate).toBeNull();
  });

  it("does NOT recompute once first sync has completed", async () => {
    const { itemRowId, acctRowId } = await seedChaseChecking({
      initialCutoff: "2026-05-03",
      firstSyncCompletedAt: new Date("2026-05-01T00:00:00Z"),
    });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "chase");
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(acct.importCutoffDate).toBe("2026-05-03");
  });
});

describe("(#403) first sync always lands current-month rows", () => {
  it("keeps May rows even when manual history extends into May", async () => {
    // The user's manual entry for early May would, pre-#403, have set
    // the cutoff to 2026-05-02 and silently dropped every Plaid row up
    // to that date — that is exactly the "May activity is missing"
    // bug. Clamping forces the cutoff back to 2026-04-30.
    const { itemRowId, acctRowId, externalAcctId } = await seedChaseChecking({
      manualDates: ["2026-04-20", "2026-05-02"],
    });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "chase");
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(acct.importCutoffDate).toBe("2026-04-30");

    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-pre-may",
          account_id: externalAcctId,
          date: "2026-04-15",
          amount: 10,
          name: "Pre-May, before cutoff — skipped",
        },
        {
          transaction_id: "plaid-may-1",
          account_id: externalAcctId,
          date: "2026-05-01",
          amount: 20,
          name: "May 1 — must land",
        },
        {
          transaction_id: "plaid-may-3",
          account_id: externalAcctId,
          date: "2026-05-03",
          amount: 30,
          name: "May 3 — must land even though user has a manual May 2 row",
        },
      ],
      modified: [],
      removed: [],
    };
    const result = await syncPlaidItem(TEST_USER, itemRowId);
    const plaidIds = (
      await db
        .select()
        .from(transactionsTable)
        .where(eq(transactionsTable.userId, TEST_USER))
    )
      .map((t) => t.plaidTransactionId)
      .filter((x): x is string => x !== null)
      .sort();
    expect(plaidIds).toEqual(["plaid-may-1", "plaid-may-3"]);
    // Sync result surfaces the inserted-rows window for the post-link
    // panel caption.
    expect(result.importedDateRange).toEqual({
      min: "2026-05-01",
      max: "2026-05-03",
    });
  });
});
