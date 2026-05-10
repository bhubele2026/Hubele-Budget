import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestHousehold } from "./_helpers/testHousehold";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  plaidMalformedTokenAlertsSentTable,
  transactionsTable,
} from "@workspace/db";
import { flagMalformedAccessTokens } from "../lib/plaidSync";
import {
  computeAlertDigest,
  DEFAULT_ALERT_THRESHOLD,
  DEFAULT_GROWTH_ABSOLUTE,
  DEFAULT_GROWTH_PERCENT,
  getAlertThreshold,
  getGrowthAbsolute,
  getGrowthPercent,
  maybeAlertOnMalformedTokenSpike,
  renderMalformedTokenAlert,
  resolveOperatorRecipient,
  shouldSuppressDuplicateAlert,
  type LoadLastAlertFn,
  type RecordAlertFn,
  type SendOperatorAlertFn,
} from "../lib/plaidMalformedTokenAlert";

const TEST_USER = `mtsa-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

async function seedItem(
  accessToken: string,
  institutionName: string | null,
): Promise<{ itemRowId: string; itemId: string }> {
  const externalItemId = `item-${randomUUID()}`;
  const [row] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: externalItemId,
      accessToken,
      institutionName: institutionName ?? undefined,
      institutionSlug: institutionName?.toLowerCase() ?? undefined,
    })
    .returning();
  return { itemRowId: row!.id, itemId: externalItemId };
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
});
beforeEach(async () => {
  await cleanup();
  // (#396) Wipe the de-dup table so the read-most-recent suppress
  // check starts each test from a known-empty state regardless of
  // what the prior integration test wrote. Other tests in this file
  // still pass `loadLastAlert: null` to opt out, but we belt-and-
  // suspenders this so a lingering row from a parallel suite can't
  // silently mute an assertion.
  await db.delete(plaidMalformedTokenAlertsSentTable);
  delete process.env.MALFORMED_TOKEN_ALERT_THRESHOLD;
  delete process.env.MALFORMED_TOKEN_ALERT_GROWTH_ABSOLUTE;
  delete process.env.MALFORMED_TOKEN_ALERT_GROWTH_PERCENT;
  delete process.env.OPS_ALERT_EMAIL;
  delete process.env.OWNER_EMAIL;
});

afterAll(cleanup);

describe("(#371) operator alert on daily malformed-token sweep spike", () => {
  it("renderMalformedTokenAlert includes the count, threshold, and a sample of institutions", () => {
    const rendered = renderMalformedTokenAlert({
      scanned: 25,
      flagged: 4,
      threshold: 3,
      flaggedItems: [
        { itemRowId: "r1", itemId: "ext-1", institutionName: "Chase" },
        { itemRowId: "r2", itemId: "ext-2", institutionName: "Amex" },
        { itemRowId: "r3", itemId: "ext-3", institutionName: null },
        { itemRowId: "r4", itemId: "ext-4", institutionName: "Capital One" },
      ],
      now: new Date("2026-05-06T03:02:00Z"),
    });
    expect(rendered.subject).toMatch(/4 Plaid items/);
    expect(rendered.subject).toMatch(/2026-05-06/);
    expect(rendered.text).toMatch(/threshold: 3/);
    expect(rendered.text).toMatch(/Chase/);
    expect(rendered.text).toMatch(/Amex/);
    expect(rendered.text).toMatch(/Capital One/);
    expect(rendered.text).toMatch(/\(unknown institution\)/);
    expect(rendered.html).toMatch(/<strong>4<\/strong>/);
    expect(rendered.html).toMatch(/<li>/);
  });

  it("renderMalformedTokenAlert truncates long lists to a sample with overflow note", () => {
    const flaggedItems = Array.from({ length: 15 }, (_, i) => ({
      itemRowId: `r${i}`,
      itemId: `ext-${i}`,
      institutionName: `Bank ${i}`,
    }));
    const rendered = renderMalformedTokenAlert({
      scanned: 50,
      flagged: 15,
      threshold: 3,
      flaggedItems,
    });
    expect(rendered.text).toMatch(/Bank 0/);
    expect(rendered.text).toMatch(/Bank 9/);
    expect(rendered.text).not.toMatch(/Bank 10/);
    expect(rendered.text).toMatch(/…and 5 more/);
    expect(rendered.html).toMatch(/…and 5 more/);
  });

  it("getAlertThreshold honors the env override and rejects garbage", () => {
    expect(getAlertThreshold()).toBe(DEFAULT_ALERT_THRESHOLD);
    process.env.MALFORMED_TOKEN_ALERT_THRESHOLD = "10";
    expect(getAlertThreshold()).toBe(10);
    process.env.MALFORMED_TOKEN_ALERT_THRESHOLD = "not-a-number";
    expect(getAlertThreshold()).toBe(DEFAULT_ALERT_THRESHOLD);
    process.env.MALFORMED_TOKEN_ALERT_THRESHOLD = "0";
    expect(getAlertThreshold()).toBe(DEFAULT_ALERT_THRESHOLD);
  });

  it("resolveOperatorRecipient prefers OPS_ALERT_EMAIL over OWNER_EMAIL", () => {
    expect(resolveOperatorRecipient()).toBeNull();
    process.env.OWNER_EMAIL = "owner@example.com";
    expect(resolveOperatorRecipient()).toBe("owner@example.com");
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    expect(resolveOperatorRecipient()).toBe("ops@example.com");
  });

  it("stays silent when flagged count is below the threshold", async () => {
    const send = vi.fn(async () => ({
      ok: true as const,
      channel: "email" as const,
      error: null,
    }));
    const result = await maybeAlertOnMalformedTokenSpike(
      {
        scanned: 10,
        flagged: 1,
        flaggedItems: [
          { itemRowId: "r1", itemId: "ext-1", institutionName: "Chase" },
        ],
      },
      { send, threshold: 3, recipient: "ops@example.com" },
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "skipped",
      reason: "below-threshold",
      recipient: null,
      error: null,
    });
  });

  it("dispatches the alert when flagged >= threshold with a recipient", async () => {
    const send = vi.fn<SendOperatorAlertFn>(async () => ({
      ok: true,
      channel: "email",
      error: null,
    }));
    const result = await maybeAlertOnMalformedTokenSpike(
      {
        scanned: 50,
        flagged: 7,
        flaggedItems: Array.from({ length: 7 }, (_, i) => ({
          itemRowId: `r${i}`,
          itemId: `ext-${i}`,
          institutionName: `Bank ${i}`,
        })),
      },
      { send, threshold: 3, recipient: "ops@example.com" },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0];
    expect(call?.to).toBe("ops@example.com");
    expect(call?.subject).toMatch(/7 Plaid items/);
    expect(call?.text).toMatch(/Bank 0/);
    expect(result.channel).toBe("email");
    expect(result.recipient).toBe("ops@example.com");
    expect(result.error).toBeNull();
  });

  it("logs and skips when the threshold is crossed but no recipient is configured", async () => {
    const send = vi.fn(async () => ({
      ok: true as const,
      channel: "email" as const,
      error: null,
    }));
    const result = await maybeAlertOnMalformedTokenSpike(
      {
        scanned: 5,
        flagged: 5,
        flaggedItems: [
          { itemRowId: "r1", itemId: "ext-1", institutionName: "Chase" },
        ],
      },
      { send, threshold: 3, recipient: null },
    );
    expect(send).not.toHaveBeenCalled();
    expect(result.channel).toBe("skipped");
    expect(result.reason).toBe("no-recipient");
  });

  it("captures transport errors without throwing so the cron stays healthy", async () => {
    const send = vi.fn(async () => ({
      ok: false as const,
      channel: "email" as const,
      error: "SendGrid 500",
    }));
    const result = await maybeAlertOnMalformedTokenSpike(
      {
        scanned: 5,
        flagged: 4,
        flaggedItems: [
          { itemRowId: "r1", itemId: "ext-1", institutionName: "Chase" },
        ],
      },
      { send, threshold: 3, recipient: "ops@example.com" },
    );
    expect(result.channel).toBe("email");
    expect(result.error).toBe("SendGrid 500");
  });

  describe("(#396) day-over-day de-dup", () => {
    it("getGrowthAbsolute / getGrowthPercent honor env overrides", () => {
      expect(getGrowthAbsolute()).toBe(DEFAULT_GROWTH_ABSOLUTE);
      expect(getGrowthPercent()).toBe(DEFAULT_GROWTH_PERCENT);
      process.env.MALFORMED_TOKEN_ALERT_GROWTH_ABSOLUTE = "5";
      process.env.MALFORMED_TOKEN_ALERT_GROWTH_PERCENT = "50";
      expect(getGrowthAbsolute()).toBe(5);
      expect(getGrowthPercent()).toBe(50);
      process.env.MALFORMED_TOKEN_ALERT_GROWTH_ABSOLUTE = "garbage";
      process.env.MALFORMED_TOKEN_ALERT_GROWTH_PERCENT = "0";
      expect(getGrowthAbsolute()).toBe(DEFAULT_GROWTH_ABSOLUTE);
      expect(getGrowthPercent()).toBe(DEFAULT_GROWTH_PERCENT);
    });

    it("computeAlertDigest is order-independent and changes with set membership", () => {
      const a = computeAlertDigest([
        { itemRowId: "r1", itemId: "ext-1", institutionName: "A" },
        { itemRowId: "r2", itemId: "ext-2", institutionName: "B" },
      ]);
      const b = computeAlertDigest([
        { itemRowId: "r2", itemId: "ext-2", institutionName: "B" },
        { itemRowId: "r1", itemId: "ext-1", institutionName: "A" },
      ]);
      expect(a).toBe(b);
      const c = computeAlertDigest([
        { itemRowId: "r1", itemId: "ext-1", institutionName: "A" },
        { itemRowId: "r3", itemId: "ext-3", institutionName: "C" },
      ]);
      expect(c).not.toBe(a);
    });

    it("shouldSuppressDuplicateAlert: identical digest is suppressed", () => {
      const reason = shouldSuppressDuplicateAlert({
        current: { digest: "d", flaggedItemRowIds: ["r1", "r2"], flagged: 2 },
        last: {
          digest: "d",
          flaggedItemRowIds: ["r1", "r2"],
          flagged: 2,
          sentAt: new Date(),
        },
        growthAbsolute: 2,
        growthPercent: 25,
      });
      expect(reason).toBe("duplicate-of-prior-alert");
    });

    it("shouldSuppressDuplicateAlert: any new flagged item re-arms even if count is flat", () => {
      const reason = shouldSuppressDuplicateAlert({
        current: { digest: "x", flaggedItemRowIds: ["r1", "r3"], flagged: 2 },
        last: {
          digest: "y",
          flaggedItemRowIds: ["r1", "r2"],
          flagged: 2,
          sentAt: new Date(),
        },
        growthAbsolute: 2,
        growthPercent: 25,
      });
      expect(reason).toBeNull();
    });

    it("shouldSuppressDuplicateAlert: subset growth below thresholds stays suppressed", () => {
      const reason = shouldSuppressDuplicateAlert({
        current: {
          digest: "x",
          flaggedItemRowIds: ["r1", "r2"],
          flagged: 2,
        },
        last: {
          digest: "y",
          flaggedItemRowIds: ["r1", "r2", "r3"],
          flagged: 3,
          sentAt: new Date(),
        },
        growthAbsolute: 2,
        growthPercent: 25,
      });
      // Cleanup is happening (3 → 2, no new items) — definitely don't re-page.
      expect(reason).toBe("duplicate-of-prior-alert");
    });

    it("shouldSuppressDuplicateAlert: absolute-growth threshold re-arms", () => {
      const reason = shouldSuppressDuplicateAlert({
        current: {
          digest: "x",
          flaggedItemRowIds: ["r1", "r2", "r3", "r4", "r5"],
          flagged: 5,
        },
        last: {
          digest: "y",
          flaggedItemRowIds: ["r1", "r2", "r3"],
          flagged: 3,
          sentAt: new Date(),
        },
        growthAbsolute: 2,
        growthPercent: 99,
      });
      expect(reason).toBeNull();
    });

    it("shouldSuppressDuplicateAlert: percent-growth threshold re-arms even if absolute is below", () => {
      const reason = shouldSuppressDuplicateAlert({
        current: {
          digest: "x",
          flaggedItemRowIds: Array.from({ length: 26 }, (_, i) => `r${i}`),
          flagged: 26,
        },
        last: {
          digest: "y",
          flaggedItemRowIds: Array.from({ length: 20 }, (_, i) => `r${i}`),
          flagged: 20,
          sentAt: new Date(),
        },
        growthAbsolute: 100, // intentionally unreachable so percent rule is the trigger
        growthPercent: 25,
      });
      expect(reason).toBeNull();
    });

    it("end-to-end with in-memory hooks: second identical day is suppressed, third with new item re-fires", async () => {
      const itemsDay1: import("../lib/plaidSync").FlaggedMalformedItem[] = [
        { itemRowId: "r1", itemId: "ext-1", institutionName: "Chase" },
        { itemRowId: "r2", itemId: "ext-2", institutionName: "Amex" },
        { itemRowId: "r3", itemId: "ext-3", institutionName: "Capital One" },
      ];

      let lastAlert: import("../lib/plaidMalformedTokenAlert").LastAlertSnapshot | null =
        null;
      const loadLastAlert: LoadLastAlertFn = async () => lastAlert;
      const recordAlert: RecordAlertFn = async (rec) => {
        lastAlert = {
          digest: rec.digest,
          flaggedItemRowIds: rec.flaggedItemRowIds,
          flagged: rec.flagged,
          sentAt: new Date(),
        };
      };
      const send = vi.fn<SendOperatorAlertFn>(async () => ({
        ok: true,
        channel: "email",
        error: null,
      }));

      const day1 = await maybeAlertOnMalformedTokenSpike(
        { scanned: 10, flagged: 3, flaggedItems: itemsDay1 },
        {
          send,
          threshold: 3,
          recipient: "ops@example.com",
          loadLastAlert,
          recordAlert,
          growthAbsolute: 2,
          growthPercent: 25,
        },
      );
      expect(day1.channel).toBe("email");
      expect(send).toHaveBeenCalledTimes(1);
      expect(lastAlert).not.toBeNull();

      // Day 2: same exact set — must be silent.
      const day2 = await maybeAlertOnMalformedTokenSpike(
        { scanned: 10, flagged: 3, flaggedItems: itemsDay1 },
        {
          send,
          threshold: 3,
          recipient: "ops@example.com",
          loadLastAlert,
          recordAlert,
          growthAbsolute: 2,
          growthPercent: 25,
        },
      );
      expect(day2.channel).toBe("skipped");
      expect(day2.reason).toBe("duplicate-of-prior-alert");
      expect(day2.recipient).toBe("ops@example.com");
      expect(send).toHaveBeenCalledTimes(1);

      // Day 3: a new bank broke (r4) — must re-fire even though
      // count grew by only +1 (below the absolute threshold).
      const itemsDay3 = [
        ...itemsDay1,
        { itemRowId: "r4", itemId: "ext-4", institutionName: "Citi" },
      ];
      const day3 = await maybeAlertOnMalformedTokenSpike(
        { scanned: 10, flagged: 4, flaggedItems: itemsDay3 },
        {
          send,
          threshold: 3,
          recipient: "ops@example.com",
          loadLastAlert,
          recordAlert,
          growthAbsolute: 2,
          growthPercent: 25,
        },
      );
      expect(day3.channel).toBe("email");
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("DB-backed default: two consecutive sweeps with the same flagged set page operators only once", async () => {
      const items: import("../lib/plaidSync").FlaggedMalformedItem[] = [
        { itemRowId: "r1", itemId: "ext-1", institutionName: "Chase" },
        { itemRowId: "r2", itemId: "ext-2", institutionName: "Amex" },
        { itemRowId: "r3", itemId: "ext-3", institutionName: "Capital One" },
      ];
      const send = vi.fn<SendOperatorAlertFn>(async () => ({
        ok: true,
        channel: "email",
        error: null,
      }));
      // First call: DB is empty (beforeEach truncated), so the alert
      // fires and a row is written via the default `recordAlertToDb`.
      const first = await maybeAlertOnMalformedTokenSpike(
        { scanned: 10, flagged: 3, flaggedItems: items },
        { send, threshold: 3, recipient: "ops@example.com" },
      );
      expect(first.channel).toBe("email");

      const persisted = await db
        .select()
        .from(plaidMalformedTokenAlertsSentTable);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.flagged).toBe(3);
      expect(persisted[0]!.digest).toBe(computeAlertDigest(items));

      // Second call with the same items: dedup row exists in DB now,
      // so this must be suppressed without invoking the transport again.
      const second = await maybeAlertOnMalformedTokenSpike(
        { scanned: 10, flagged: 3, flaggedItems: items },
        { send, threshold: 3, recipient: "ops@example.com" },
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(second.channel).toBe("skipped");
      expect(second.reason).toBe("duplicate-of-prior-alert");
    });

    it("a failed send does NOT persist the de-dup row, so the next sweep retries", async () => {
      const items: import("../lib/plaidSync").FlaggedMalformedItem[] = [
        { itemRowId: "r1", itemId: "ext-1", institutionName: "Chase" },
        { itemRowId: "r2", itemId: "ext-2", institutionName: "Amex" },
        { itemRowId: "r3", itemId: "ext-3", institutionName: "Capital One" },
      ];
      const failingSend = vi.fn<SendOperatorAlertFn>(async () => ({
        ok: false,
        channel: "email",
        error: "SendGrid 500",
      }));
      const failed = await maybeAlertOnMalformedTokenSpike(
        { scanned: 10, flagged: 3, flaggedItems: items },
        { send: failingSend, threshold: 3, recipient: "ops@example.com" },
      );
      expect(failed.error).toBe("SendGrid 500");

      const persisted = await db
        .select()
        .from(plaidMalformedTokenAlertsSentTable);
      expect(persisted).toHaveLength(0);

      const okSend = vi.fn<SendOperatorAlertFn>(async () => ({
        ok: true,
        channel: "email",
        error: null,
      }));
      const retried = await maybeAlertOnMalformedTokenSpike(
        { scanned: 10, flagged: 3, flaggedItems: items },
        { send: okSend, threshold: 3, recipient: "ops@example.com" },
      );
      expect(okSend).toHaveBeenCalledTimes(1);
      expect(retried.channel).toBe("email");
    });
  });

  it("end-to-end: a sweep that flags many items produces an alert with the real institution sample", async () => {
    const seeded: string[] = [];
    for (const name of ["Chase", "Amex", "Capital One"]) {
      const { itemRowId } = await seedItem("legacy-bad-row", name);
      seeded.push(itemRowId);
    }
    // One well-formed item that must NOT show up in the sample.
    await seedItem(`access-sandbox-${randomUUID()}`, "GoodBank");

    try {
      const summary = await flagMalformedAccessTokens();
      // Filter to just our seeded rows so other test data in shared DB
      // doesn't make the assertion brittle.
      const ours = summary.flaggedItems.filter((it) =>
        seeded.includes(it.itemRowId),
      );
      expect(ours.length).toBe(3);
      const names = ours.map((it) => it.institutionName).sort();
      expect(names).toEqual(["Amex", "Capital One", "Chase"]);

      const send = vi.fn<SendOperatorAlertFn>(async () => ({
        ok: true,
        channel: "email",
        error: null,
      }));
      const result = await maybeAlertOnMalformedTokenSpike(
        {
          scanned: ours.length,
          flagged: ours.length,
          flaggedItems: ours,
        },
        { send, threshold: 3, recipient: "ops@example.com" },
      );
      expect(send).toHaveBeenCalledTimes(1);
      const body = send.mock.calls[0]?.[0]?.text ?? "";
      expect(body).toMatch(/Chase/);
      expect(body).toMatch(/Amex/);
      expect(body).toMatch(/Capital One/);
      expect(body).not.toMatch(/GoodBank/);
      expect(result.channel).toBe("email");
    } finally {
      if (seeded.length > 0) {
        await db
          .delete(plaidItemsTable)
          .where(inArray(plaidItemsTable.id, seeded));
      }
    }
  });
});
