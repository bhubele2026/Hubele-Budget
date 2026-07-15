// (#45) Auto-refresh of forecast_settings.bankSnapshotBalance during the
// hourly Plaid sync (syncAllForAllUsers -> syncPlaidItem).
//
// Verifies that:
//   1. Happy path — when a user has a Plaid-linked checking account
//      configured as their bank snapshot, syncing the OWNING item
//      pulls a fresh balance via accountsBalanceGet and writes it to
//      forecast_settings.
//   2. Multi-item scoping — when the snapshot account belongs to a
//      different Plaid item than the one currently being synced,
//      accountsBalanceGet is NOT called and no error chip is written
//      to the non-owning item. (Without the bankSnapshotBelongsToThisItem
//      guard, every Amex/etc. sync would error out with INVALID_ACCOUNT_ID
//      on the wrong access_token and surface a misleading "balance
//      refresh failed" badge on those items.)
//   3. No bank snapshot configured — sync runs cleanly, no balance call.
//   4. Plaid balance error — surfaces via plaid_items.lastSyncError /
//      lastSyncErrorCode without breaking the sync result.
//   5. End-to-end through syncAllForAllUsers (the real cron entry point).

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const TEST_USER = `bank-refresh-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
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

type AccountsBalanceGetFn = (args: {
  access_token: string;
  options?: { account_ids?: string[] };
}) => Promise<{ data: { accounts: Array<{ account_id: string; balances: { available: number | null; current: number | null } }> } }>;

let accountsBalanceGetMock: AccountsBalanceGetFn = async () => ({
  data: { accounts: [] },
});
let accountsBalanceGetCalls: Parameters<AccountsBalanceGetFn>[0][] = [];

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "",
          has_more: false,
        },
      }),
      accountsBalanceGet: (args: Parameters<AccountsBalanceGetFn>[0]) => {
        accountsBalanceGetCalls.push(args);
        return accountsBalanceGetMock(args);
      },
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
import { syncAllForAllUsers, syncPlaidItem } from "../lib/plaidSync";
import { logger } from "../lib/logger";
import { createTestHousehold } from "./_helpers/testHousehold";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  accountsBalanceGetCalls = [];
  accountsBalanceGetMock = async () => ({ data: { accounts: [] } });
});

async function seedItemAndCheckingAccount(opts: {
  institutionName: string;
  accountId?: string;
}): Promise<{ itemRowId: string; plaidAccountRowId: string; externalAccountId: string }> {
  const externalAccountId = opts.accountId ?? `acct-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${opts.institutionName}-${randomUUID()}`,
      accessToken: `access-sandbox-${opts.institutionName}-${randomUUID()}`,
      institutionName: opts.institutionName,
      institutionSlug: opts.institutionName.toLowerCase(),
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAccountId,
      name: `${opts.institutionName} Checking`,
      mask: "1234",
      type: "depository",
      subtype: "checking",
    })
    .returning();
  return {
    itemRowId: item!.id,
    plaidAccountRowId: acct!.id,
    externalAccountId,
  };
}

async function configureSnapshot(plaidAccountRowId: string, name: string): Promise<void> {
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotAccountId: plaidAccountRowId,
    bankSnapshotName: name,
    bankSnapshotMask: "1234",
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: new Date("2026-01-01T00:00:00Z"),
    bankSnapshotSource: "manual",
  });
}

describe("(#45) bank snapshot auto-refresh on hourly Plaid sync", () => {
  it("happy path: refreshes the snapshot when syncing the item that owns the checking account", async () => {
    const { itemRowId, plaidAccountRowId, externalAccountId } =
      await seedItemAndCheckingAccount({ institutionName: "Chase" });
    await configureSnapshot(plaidAccountRowId, "Chase Checking");

    accountsBalanceGetMock = async () => ({
      data: {
        accounts: [
          {
            account_id: externalAccountId,
            balances: { available: 4321.0, current: 4500.0 },
          },
        ],
      },
    });

    const before = new Date();
    // (#723) Auto-balance is now gated to syncOrigin:"manual" (the
    // user-clicked Sync button). Pass it explicitly here so the
    // long-standing happy-path assertion below — that a Plaid balance
    // call lands and rewrites the snapshot — continues to exercise
    // the real production manual-sync path. Without this, the call is
    // skipped (as it should be for cron/webhook callers).
    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      syncOrigin: "manual",
    });

    expect(result.error ?? null).toBeNull();
    expect(accountsBalanceGetCalls).toHaveLength(1);
    expect(accountsBalanceGetCalls[0]?.options?.account_ids).toEqual([
      externalAccountId,
    ]);

    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(settings).toBeDefined();
    // (#balance) Prefers `current` (posted) over `available`. Pending charges
    // are in the ledger, so anchoring on `available` (pending pre-subtracted)
    // would double-count them; `current` matches the bank's posted balance.
    expect(settings!.bankSnapshotBalance).toBe("4500.00");
    expect(settings!.bankSnapshotSource).toBe("plaid");
    expect(settings!.bankSnapshotAt).toBeInstanceOf(Date);
    expect(settings!.bankSnapshotAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
  });

  it("falls back to `current` when `available` is null", async () => {
    const { itemRowId, plaidAccountRowId, externalAccountId } =
      await seedItemAndCheckingAccount({ institutionName: "Chase" });
    await configureSnapshot(plaidAccountRowId, "Chase Checking");

    accountsBalanceGetMock = async () => ({
      data: {
        accounts: [
          {
            account_id: externalAccountId,
            balances: { available: null, current: 2222.5 },
          },
        ],
      },
    });

    await syncPlaidItem(TEST_USER, itemRowId, { syncOrigin: "manual" });
    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(settings!.bankSnapshotBalance).toBe("2222.50");
    expect(settings!.bankSnapshotSource).toBe("plaid");
  });

  it("multi-item scoping: syncing the NON-owning item does not call balanceGet and does not write an error chip", async () => {
    // Chase owns the checking account configured as the bank snapshot.
    const { plaidAccountRowId } = await seedItemAndCheckingAccount({
      institutionName: "Chase",
    });
    // Amex is a separate Plaid item with no relation to the snapshot.
    const { itemRowId: amexItemRowId } = await seedItemAndCheckingAccount({
      institutionName: "Amex",
    });
    await configureSnapshot(plaidAccountRowId, "Chase Checking");

    // If the guard regresses, Plaid throws INVALID_ACCOUNT_ID here because
    // the account_id doesn't belong to the Amex access_token. We force a
    // throw so a regression would also fail this test loudly.
    accountsBalanceGetMock = async () => {
      throw new Error("should not be called for non-owning item");
    };

    const result = await syncPlaidItem(TEST_USER, amexItemRowId, {
      syncOrigin: "manual",
    });
    expect(result.error ?? null).toBeNull();
    expect(accountsBalanceGetCalls).toHaveLength(0);

    const [amexItem] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, amexItemRowId));
    expect(amexItem!.lastSyncError).toBeNull();
    expect(amexItem!.lastSyncErrorCode).toBeNull();
  });

  it("no bank snapshot configured: sync runs cleanly without calling balanceGet", async () => {
    const { itemRowId } = await seedItemAndCheckingAccount({
      institutionName: "Chase",
    });
    // No forecast_settings row inserted.

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      syncOrigin: "manual",
    });
    expect(result.error ?? null).toBeNull();
    expect(accountsBalanceGetCalls).toHaveLength(0);
  });

  it("plaid balance error: logs + writes lastSyncError on the item but the sync result still succeeds", async () => {
    const { itemRowId, plaidAccountRowId } = await seedItemAndCheckingAccount({
      institutionName: "Chase",
    });
    await configureSnapshot(plaidAccountRowId, "Chase Checking");

    accountsBalanceGetMock = async () => {
      const err = new Error("plaid threw") as Error & {
        response?: { data: { error_code: string; error_message: string } };
      };
      err.response = {
        data: {
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message: "the login details have changed",
        },
      };
      throw err;
    };

    // Spy on logger.warn so we confirm the catch block emits a
    // structured log with the user/item/institution/Plaid code context
    // — persistence-only would leave support blind when the chip
    // turns over before anyone notices.
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const result = await syncPlaidItem(TEST_USER, itemRowId, {
        syncOrigin: "manual",
      });
      // Sync still produced a result — the failed balance refresh is
      // surfaced via result.error and the persisted lastSyncError chip,
      // not by throwing or skipping the rest of the sync.
      expect(result.itemId).toBeTruthy();
      expect(result.error).toMatch(/Balance refresh failed/);

      const [item] = await db
        .select()
        .from(plaidItemsTable)
        .where(eq(plaidItemsTable.id, itemRowId));
      expect(item!.lastSyncError).toMatch(/Balance refresh failed/);
      expect(item!.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");

      // Forecast settings still hold the seeded manual value — the failed
      // refresh did not corrupt the snapshot.
      const [settings] = await db
        .select()
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, TEST_USER));
      expect(settings!.bankSnapshotBalance).toBe("1000.00");
      expect(settings!.bankSnapshotSource).toBe("manual");

      // Find the bank-snapshot-specific warn call (other parts of
      // syncPlaidItem may also warn — filter by the message).
      const balanceWarn = warnSpy.mock.calls.find(
        (c) => c[1] === "Plaid bank-snapshot balance refresh failed",
      );
      expect(balanceWarn).toBeDefined();
      const ctx = balanceWarn![0] as Record<string, unknown>;
      expect(ctx.userId).toBe(TEST_USER);
      expect(ctx.itemRowId).toBe(itemRowId);
      expect(ctx.institutionName).toBe("Chase");
      expect(ctx.code).toBe("ITEM_LOGIN_REQUIRED");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // (#286) Regression: a stale "Balance refresh failed: …" chip from a
  // previous failing hourly sync must be cleared by the next *healthy*
  // sync. Otherwise a red badge lingers in the Sync header long after the
  // underlying issue resolved (e.g. the user reconnected the bank). The
  // success path in syncPlaidItem already nulls lastSyncError /
  // lastSyncErrorCode before the balance refresh attempt, and a
  // succeeding refresh leaves those cleared values in place — this test
  // pins that behavior so a future refactor can't regress it.
  it("(#286) clears a stale 'Balance refresh failed' chip after a healthy sync", async () => {
    const { itemRowId, plaidAccountRowId, externalAccountId } =
      await seedItemAndCheckingAccount({ institutionName: "Chase" });
    await configureSnapshot(plaidAccountRowId, "Chase Checking");

    // Seed a stale failure chip from a hypothetical earlier hourly sync.
    await db
      .update(plaidItemsTable)
      .set({
        lastSyncError:
          "Balance refresh failed: the login details have changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      })
      .where(eq(plaidItemsTable.id, itemRowId));

    accountsBalanceGetMock = async () => ({
      data: {
        accounts: [
          {
            account_id: externalAccountId,
            balances: { available: 5555.55, current: 5600.0 },
          },
        ],
      },
    });

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      syncOrigin: "manual",
    });
    expect(result.error ?? null).toBeNull();

    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(item!.lastSyncError).toBeNull();
    expect(item!.lastSyncErrorCode).toBeNull();
  });

  // (#723) Inverted from its pre-#723 form. Before this commit, the
  // hourly cron (syncAllForAllUsers) auto-fired /accounts/balance/get
  // for every linked Plaid item that owned the bank snapshot — even
  // though no one had clicked Sync. That auto-call billed Plaid on a
  // schedule, contributed to the ~100/day balance-call count observed
  // in prod, and routinely tripped the per-item BALANCE_LIMIT 429.
  // The auto-refresh is now gated to syncOrigin:"manual". This test
  // pins the new contract: the cron path NEVER calls
  // accountsBalanceGet, and the persisted snapshot keeps its previous
  // value/source until the user clicks Sync.
  it("(#723) end-to-end via syncAllForAllUsers (cron) does NOT auto-refresh the snapshot anymore", async () => {
    const { plaidAccountRowId, externalAccountId } =
      await seedItemAndCheckingAccount({ institutionName: "Chase" });
    // Second item for the same user; should not double-call the balance
    // endpoint, and should not write any error chip.
    await seedItemAndCheckingAccount({ institutionName: "Amex" });
    await configureSnapshot(plaidAccountRowId, "Chase Checking");

    accountsBalanceGetMock = async () => ({
      data: {
        accounts: [
          {
            account_id: externalAccountId,
            balances: { available: 9876.54, current: 9999.99 },
          },
        ],
      },
    });

    await syncAllForAllUsers();

    // (#723) Scope to the Chase external account_id we own (other test
    // files may leak unrelated balance calls into the shared counter)
    // and assert ZERO — the cron path is no longer allowed to bill
    // Plaid for a balance refresh that the user didn't ask for.
    const callsForOurAccount = accountsBalanceGetCalls.filter(
      (c) => c.options?.account_ids?.[0] === externalAccountId,
    );
    expect(callsForOurAccount).toHaveLength(0);
    // Persisted snapshot stays at the seeded manual value — the cron
    // run did not rewrite it.
    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(settings!.bankSnapshotBalance).toBe("1000.00");
    expect(settings!.bankSnapshotSource).toBe("manual");
  });

  // (#723) Direct regression for the gate itself: a sync triggered by
  // the webhook coalescer / LOGIN_REPAIRED path / nightly cron (i.e.
  // any non-manual syncOrigin) must NOT call accountsBalanceGet, even
  // when every other precondition is satisfied (snapshot configured,
  // owning item, healthy balance response staged). Before #723 every
  // such sync auto-billed Plaid; after the gate, only the user-clicked
  // Sync button does.
  it.each(["webhook", "cron", "internal"] as const)(
    "(#723) does NOT call accountsBalanceGet when syncOrigin=%s",
    async (origin) => {
      const { itemRowId, plaidAccountRowId, externalAccountId } =
        await seedItemAndCheckingAccount({ institutionName: "Chase" });
      await configureSnapshot(plaidAccountRowId, "Chase Checking");

      // Stage a healthy balance response so a regression that drops the
      // gate would *succeed* in calling Plaid — and trip the
      // toHaveLength(0) assertion below. Without staging this, a
      // regression could also pass by silently failing.
      accountsBalanceGetMock = async () => ({
        data: {
          accounts: [
            {
              account_id: externalAccountId,
              balances: { available: 7777.0, current: 7800.0 },
            },
          ],
        },
      });

      const result = await syncPlaidItem(TEST_USER, itemRowId, {
        syncOrigin: origin,
      });
      expect(result.error ?? null).toBeNull();
      expect(accountsBalanceGetCalls).toHaveLength(0);

      // Snapshot stays at the seeded manual value.
      const [settings] = await db
        .select()
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, TEST_USER));
      expect(settings!.bankSnapshotBalance).toBe("1000.00");
      expect(settings!.bankSnapshotSource).toBe("manual");
    },
  );
});
