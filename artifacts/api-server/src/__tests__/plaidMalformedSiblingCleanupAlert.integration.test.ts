import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestHousehold } from "./_helpers/testHousehold";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { backfillMalformedTokenSiblings } from "../lib/plaidMalformedSiblingCleanup";
import {
  maybeAlertOnSiblingCleanup,
  renderSiblingCleanupAlert,
} from "../lib/plaidMalformedSiblingCleanupAlert";
import type { SendOperatorAlertFn } from "../lib/plaidMalformedTokenAlert";

const TEST_USER = `mscup-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
});
beforeEach(async () => {
  await cleanup();
  delete process.env.OPS_ALERT_EMAIL;
  delete process.env.OWNER_EMAIL;
});
afterAll(cleanup);

describe("(#551) operator alert on boot-time duplicate-bank cleanup", () => {
  it("renderSiblingCleanupAlert includes counts, affected user count, and a sample of cleaned rows", () => {
    const rendered = renderSiblingCleanupAlert({
      scannedMalformed: 7,
      cleanedSiblings: 5,
      skippedNoHealthySibling: 2,
      cleanedDetails: [
        {
          userId: "user-a",
          itemRowId: "row-a",
          itemId: "item-ext-a",
          institutionName: "Chase",
        },
        {
          userId: "user-b",
          itemRowId: "row-b",
          itemId: "item-ext-b",
          institutionName: "Bank of America",
        },
      ],
      now: new Date("2026-05-09T12:00:00Z"),
    });
    expect(rendered.subject).toContain("5 duplicate Plaid item");
    expect(rendered.subject).toContain("2026-05-09");
    expect(rendered.text).toContain("scannedMalformed: 7");
    expect(rendered.text).toContain("cleanedSiblings: 5");
    expect(rendered.text).toContain("skippedNoHealthySibling: 2");
    expect(rendered.text).toContain("Chase");
    expect(rendered.text).toContain("item-ext-a");
    expect(rendered.text).toContain("user-a");
    expect(rendered.text).toContain("Bank of America");
    expect(rendered.text).toContain("2 user");
    expect(rendered.html).toContain("<strong>5</strong>");
    expect(rendered.html).toContain("Chase");
  });

  it("collapses the overflow when more than the sample limit are cleaned", () => {
    const details = Array.from({ length: 15 }, (_, i) => ({
      userId: `user-${i}`,
      itemRowId: `row-${i}`,
      itemId: `item-ext-${i}`,
      institutionName: `Bank ${i}`,
    }));
    const rendered = renderSiblingCleanupAlert({
      scannedMalformed: 15,
      cleanedSiblings: 15,
      skippedNoHealthySibling: 0,
      cleanedDetails: details,
      now: new Date("2026-05-09T12:00:00Z"),
    });
    expect(rendered.text).toContain("…and 5 more");
    expect(rendered.html).toContain("…and 5 more");
  });

  it("stays silent when cleanedSiblings is 0 (no boot sweep work happened)", async () => {
    const send = vi.fn<SendOperatorAlertFn>(async () => ({
      ok: true,
      channel: "email",
      error: null,
    }));
    const result = await maybeAlertOnSiblingCleanup(
      {
        scannedMalformed: 3,
        cleanedSiblings: 0,
        skippedNoHealthySibling: 3,
        cleanedDetails: [],
      },
      { send, recipient: "ops@example.com" },
    );
    expect(result.channel).toBe("skipped");
    expect(result.reason).toBe("nothing-cleaned");
    expect(send).not.toHaveBeenCalled();
  });

  it("skips with no-recipient when OPS_ALERT_EMAIL/OWNER_EMAIL are unset", async () => {
    const send = vi.fn<SendOperatorAlertFn>(async () => ({
      ok: true,
      channel: "email",
      error: null,
    }));
    const result = await maybeAlertOnSiblingCleanup(
      {
        scannedMalformed: 1,
        cleanedSiblings: 1,
        skippedNoHealthySibling: 0,
        cleanedDetails: [
          {
            userId: "user-a",
            itemRowId: "row-a",
            itemId: "item-ext-a",
            institutionName: "Chase",
          },
        ],
      },
      { send },
    );
    expect(result.channel).toBe("skipped");
    expect(result.reason).toBe("no-recipient");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends through the supplied transport when cleanedSiblings > 0 and a recipient is configured", async () => {
    const send = vi.fn<SendOperatorAlertFn>(async () => ({
      ok: true,
      channel: "email",
      error: null,
    }));
    const result = await maybeAlertOnSiblingCleanup(
      {
        scannedMalformed: 2,
        cleanedSiblings: 2,
        skippedNoHealthySibling: 0,
        cleanedDetails: [
          {
            userId: "user-a",
            itemRowId: "row-a",
            itemId: "item-ext-a",
            institutionName: "Chase",
          },
          {
            userId: "user-b",
            itemRowId: "row-b",
            itemId: "item-ext-b",
            institutionName: "Chase",
          },
        ],
      },
      { send, recipient: "ops@example.com", now: new Date("2026-05-09T12:00:00Z") },
    );
    expect(result.channel).toBe("email");
    expect(result.recipient).toBe("ops@example.com");
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]![0];
    expect(call.to).toBe("ops@example.com");
    expect(call.subject).toContain("2 duplicate Plaid item");
    expect(call.text).toContain("Chase");
    expect(call.text).toContain("user-a");
  });

  it("end-to-end: backfill that cleans a real row produces a non-skipped alert with that institution in the body", async () => {
    await db.insert(plaidItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `healthy-${randomUUID().slice(0, 8)}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_56",
      institutionName: "Chase",
      institutionSlug: "chase",
    });
    const [stale] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `stale-${randomUUID().slice(0, 8)}`,
        accessToken: "broken-token-no-prefix",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();

    const summary = await backfillMalformedTokenSiblings();
    expect(summary.cleanedSiblings).toBeGreaterThanOrEqual(1);
    const ourCleaned = summary.cleanedDetails.filter(
      (d) => d.userId === TEST_USER,
    );
    expect(ourCleaned.length).toBeGreaterThanOrEqual(1);
    expect(ourCleaned[0]!.itemRowId).toBe(stale.id);
    expect(ourCleaned[0]!.institutionName).toBe("Chase");

    const send = vi.fn<SendOperatorAlertFn>(async () => ({
      ok: true,
      channel: "email",
      error: null,
    }));
    const result = await maybeAlertOnSiblingCleanup(summary, {
      send,
      recipient: "ops@example.com",
    });
    expect(result.channel).toBe("email");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].text).toContain("Chase");
    expect(send.mock.calls[0]![0].text).toContain(TEST_USER);
  });

  it("returns skipped/exception when the transport throws (boot path stays silent-safe)", async () => {
    const send = vi.fn<SendOperatorAlertFn>(async () => {
      throw new Error("boom");
    });
    const result = await maybeAlertOnSiblingCleanup(
      {
        scannedMalformed: 1,
        cleanedSiblings: 1,
        skippedNoHealthySibling: 0,
        cleanedDetails: [
          {
            userId: "user-a",
            itemRowId: "row-a",
            itemId: "item-ext-a",
            institutionName: "Chase",
          },
        ],
      },
      { send, recipient: "ops@example.com" },
    );
    expect(result.channel).toBe("skipped");
    expect(result.reason).toBe("exception");
    expect(result.error).toBe("boom");
  });
});
