import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { flagMalformedAccessTokens } from "../lib/plaidSync";
import {
  DEFAULT_ALERT_THRESHOLD,
  getAlertThreshold,
  maybeAlertOnMalformedTokenSpike,
  renderMalformedTokenAlert,
  resolveOperatorRecipient,
  type SendOperatorAlertFn,
} from "../lib/plaidMalformedTokenAlert";

const TEST_USER = `mtsa-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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
      itemId: externalItemId,
      accessToken,
      institutionName: institutionName ?? undefined,
      institutionSlug: institutionName?.toLowerCase() ?? undefined,
    })
    .returning();
  return { itemRowId: row!.id, itemId: externalItemId };
}

beforeEach(async () => {
  await cleanup();
  delete process.env.MALFORMED_TOKEN_ALERT_THRESHOLD;
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
