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
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `reminder-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `reminder-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

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

// Force the email transport to fall back to "log" by clearing
// SENDGRID_* env vars before the module under test loads its
// `sendReminderEmail` closure. Tests inject their own `send` via the
// SweepOptions.send hook, so this is mostly a safety belt against
// accidental real-network sends if a test forgets to inject.
delete process.env.SENDGRID_API_KEY;
delete process.env.SENDGRID_FROM_EMAIL;

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      // Default: every user has a primary email of `<userId>@example.com`.
      // Individual tests can override via `clerkUserGetMock`.
      getUser: (id: string) => clerkUserGetMock(id),
    },
  },
}));

let clerkUserGetMock: (id: string) => Promise<unknown> = async (id) => ({
  primaryEmailAddressId: "pe-1",
  emailAddresses: [{ id: "pe-1", emailAddress: `${id}@example.com` }],
});

import {
  db,
  plaidConsentRemindersSentTable,
  plaidItemsTable,
  profilesTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import {
  buildReconnectUrl,
  computeReminderWindow,
  findItemsDueForReminder,
  isItemEligibleForReminder,
  REMINDER_DAYS_BEFORE,
  renderDisconnectReminder,
  sendExpirationRemindersForAllUsers,
  sendExpirationRemindersForUser,
  type ReminderResult,
  type SendReminderEmailFn,
} from "../lib/plaidExpirationReminder";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(plaidRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  // plaid_consent_reminders_sent rows cascade away with their parent
  // plaid_items, but explicit cleanup keeps the test resilient if the
  // FK ever loosens.
  for (const u of [TEST_USER, OTHER_USER]) {
    await db
      .delete(plaidConsentRemindersSentTable)
      .where(eq(plaidConsentRemindersSentTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
    await db.delete(profilesTable).where(eq(profilesTable.id, u));
  }
}

beforeAll(async () => {
  const _h1 = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h1.householdId;
  const _h2 = await createTestHousehold(OTHER_USER);
  OTHER_HOUSEHOLD_ID = _h2.householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(async () => {
  await cleanup();
  clerkUserGetMock = async (id) => ({
    primaryEmailAddressId: "pe-1",
    emailAddresses: [{ id: "pe-1", emailAddress: `${id}@example.com` }],
  });
});

async function seedItem(opts: {
  userId?: string;
  consentExpirationAt?: Date | null;
  institutionName?: string;
  lastSyncErrorCode?: string | null;
}): Promise<{ itemRowId: string; itemId: string }> {
  const externalItemId = `item-${randomUUID()}`;
  const userId = opts.userId ?? TEST_USER;
  const householdId = userId === TEST_USER ? TEST_HOUSEHOLD_ID : OTHER_HOUSEHOLD_ID;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId,
      householdId,
      itemId: externalItemId,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: opts.institutionName ?? "Chase",
      institutionSlug: "chase",
      consentExpirationAt: opts.consentExpirationAt ?? null,
      lastSyncErrorCode: opts.lastSyncErrorCode ?? null,
    })
    .returning();
  return { itemRowId: item!.id, itemId: externalItemId };
}

function makeSendStub(): {
  send: SendReminderEmailFn;
  calls: Array<{ to: string; subject: string; text: string; html: string }>;
} {
  const calls: Array<{
    to: string;
    subject: string;
    text: string;
    html: string;
  }> = [];
  const send: SendReminderEmailFn = async (args) => {
    calls.push(args);
    return { ok: true, channel: "email", error: null };
  };
  return { send, calls };
}

describe("(#262) computeReminderWindow / isItemEligibleForReminder", () => {
  const NOW = new Date("2026-05-04T12:00:00.000Z");

  it("includes items with a cutoff inside the next REMINDER_DAYS_BEFORE window", () => {
    const inWindow = new Date("2026-05-06T12:00:00.000Z"); // 2 days out
    expect(
      isItemEligibleForReminder(
        {
          ...stubItem(),
          consentExpirationAt: inWindow,
          lastSyncErrorCode: null,
        } as Parameters<typeof isItemEligibleForReminder>[0],
        NOW,
      ),
    ).toBe(true);
  });

  it("excludes items farther out than the window", () => {
    const farOut = new Date("2026-06-01T00:00:00.000Z");
    expect(
      isItemEligibleForReminder(
        {
          ...stubItem(),
          consentExpirationAt: farOut,
          lastSyncErrorCode: null,
        } as Parameters<typeof isItemEligibleForReminder>[0],
        NOW,
      ),
    ).toBe(false);
  });

  it("excludes items already in a re-auth code (covered by the in-app banner)", () => {
    const inWindow = new Date("2026-05-06T12:00:00.000Z");
    expect(
      isItemEligibleForReminder(
        {
          ...stubItem(),
          consentExpirationAt: inWindow,
          lastSyncErrorCode: "PENDING_DISCONNECT",
        } as Parameters<typeof isItemEligibleForReminder>[0],
        NOW,
      ),
    ).toBe(false);
  });

  it("includes a cutoff that just slipped to yesterday (1-day grace)", () => {
    const yesterday = new Date("2026-05-03T12:00:00.000Z");
    expect(
      isItemEligibleForReminder(
        {
          ...stubItem(),
          consentExpirationAt: yesterday,
          lastSyncErrorCode: null,
        } as Parameters<typeof isItemEligibleForReminder>[0],
        NOW,
      ),
    ).toBe(true);
  });

  it("computeReminderWindow respects a custom withinDays", () => {
    const { earliest, latest } = computeReminderWindow(NOW, 7);
    expect(latest.getTime() - NOW.getTime()).toBe(7 * 86_400_000);
    expect(NOW.getTime() - earliest.getTime()).toBe(86_400_000);
  });
});

describe("(#262) renderDisconnectReminder", () => {
  it("names the bank and the cutoff date and embeds the reconnect URL", () => {
    const r = renderDisconnectReminder({
      institutionName: "Chase",
      consentExpirationAt: new Date("2026-05-21T12:00:00.000Z"),
      reconnectUrl: "https://app.example.com/settings",
      now: new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(r.subject).toContain("Chase");
    expect(r.subject).toContain("May 21");
    expect(r.text).toContain("Chase");
    expect(r.text).toContain("May 21");
    expect(r.text).toContain("https://app.example.com/settings");
    expect(r.text).toContain("in 17 days");
    expect(r.html).toContain("Chase");
    expect(r.html).toContain("https://app.example.com/settings");
  });

  it("falls back to a generic name when the institution is null", () => {
    const r = renderDisconnectReminder({
      institutionName: null,
      consentExpirationAt: new Date("2026-05-06T12:00:00.000Z"),
      reconnectUrl: "/settings",
      now: new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(r.subject).toContain("Your bank");
    expect(r.text).toContain("Your bank");
  });

  it("uses 'tomorrow' / 'today' for tight cutoffs", () => {
    const today = renderDisconnectReminder({
      institutionName: "Chase",
      consentExpirationAt: new Date("2026-05-04T18:00:00.000Z"),
      reconnectUrl: "/settings",
      now: new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(today.text).toContain("today");
    const tomorrow = renderDisconnectReminder({
      institutionName: "Chase",
      consentExpirationAt: new Date("2026-05-05T12:00:00.000Z"),
      reconnectUrl: "/settings",
      now: new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(tomorrow.text).toContain("tomorrow");
  });

  it("escapes user-controlled values in HTML to prevent injection", () => {
    const r = renderDisconnectReminder({
      institutionName: 'Evil <script>alert("x")</script>',
      consentExpirationAt: new Date("2026-05-06T12:00:00.000Z"),
      reconnectUrl: "https://x.test/?a=1&b=2",
      now: new Date("2026-05-04T12:00:00.000Z"),
    });
    expect(r.html).not.toContain("<script>alert");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain("a=1&amp;b=2");
  });
});

describe("(#262) findItemsDueForReminder", () => {
  it("returns items in the window and skips items in a re-auth code", async () => {
    const NOW = new Date();
    const inWindow = await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 30 * 86_400_000),
      institutionName: "BofA-far",
    });
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 1 * 86_400_000),
      institutionName: "WF-reauth",
      lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
    });

    const items = await findItemsDueForReminder({ userId: TEST_USER, now: NOW });
    expect(items.map((i) => i.id)).toEqual([inWindow.itemRowId]);
  });
});

describe("(#262) sendExpirationRemindersForUser (manual trigger code path)", () => {
  it("sends one reminder per eligible item and records each in plaid_consent_reminders_sent", async () => {
    const NOW = new Date();
    const item = await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    const { send, calls } = makeSendStub();

    const results = await sendExpirationRemindersForUser(TEST_USER, {
      now: NOW,
      send,
    });
    expect(results).toHaveLength(1);
    expect(results[0].channel).toBe("email");
    expect(results[0].institutionName).toBe("Chase");
    expect(results[0].recipient).toBe(`${TEST_USER}@example.com`);
    expect(results[0].error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(`${TEST_USER}@example.com`);
    expect(calls[0].subject).toContain("Chase");

    const rows = await db
      .select()
      .from(plaidConsentRemindersSentTable)
      .where(eq(plaidConsentRemindersSentTable.plaidItemId, item.itemRowId));
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("email");
    expect(rows[0].recipient).toBe(`${TEST_USER}@example.com`);
  });

  it("does NOT re-send for the same cutoff on the next sweep (de-dup contract)", async () => {
    const NOW = new Date();
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    const { send, calls } = makeSendStub();

    await sendExpirationRemindersForUser(TEST_USER, { now: NOW, send });
    const second = await sendExpirationRemindersForUser(TEST_USER, {
      now: NOW,
      send,
    });
    expect(calls).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].channel).toBe("skipped");
    expect(second[0].reason).toBe("already-sent-for-this-cutoff");
  });

  it("DOES send a fresh reminder when Plaid rolls the cutoff forward (re-consent silences naturally because the new cutoff falls outside the window — but if Plaid moves it inside the window again, we notify)", async () => {
    const NOW = new Date();
    const item = await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    const { send, calls } = makeSendStub();

    await sendExpirationRemindersForUser(TEST_USER, { now: NOW, send });
    expect(calls).toHaveLength(1);

    // Simulate Plaid rolling the cutoff to a *new* date that is also
    // inside the alert window (e.g. partial re-consent). The new
    // cutoff is a different key in plaid_consent_reminders_sent so a
    // second reminder is allowed.
    const rolled = new Date(NOW.getTime() + 1 * 86_400_000);
    await db
      .update(plaidItemsTable)
      .set({ consentExpirationAt: rolled })
      .where(eq(plaidItemsTable.id, item.itemRowId));

    const second = await sendExpirationRemindersForUser(TEST_USER, {
      now: NOW,
      send,
    });
    expect(calls).toHaveLength(2);
    expect(second[0].channel).toBe("email");
  });

  it("re-consenting silences future reminders by pushing the cutoff outside the alert window", async () => {
    const NOW = new Date();
    const item = await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    const { send, calls } = makeSendStub();
    await sendExpirationRemindersForUser(TEST_USER, { now: NOW, send });
    expect(calls).toHaveLength(1);

    // Successful re-consent rolls the cutoff months out — well outside
    // the 3-day alert window. The next sweep must find zero items.
    await db
      .update(plaidItemsTable)
      .set({
        consentExpirationAt: new Date(NOW.getTime() + 180 * 86_400_000),
      })
      .where(eq(plaidItemsTable.id, item.itemRowId));

    const second = await sendExpirationRemindersForUser(TEST_USER, {
      now: NOW,
      send,
    });
    expect(second).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("skips items whose owner has no email on file", async () => {
    const NOW = new Date();
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    clerkUserGetMock = async () => ({
      primaryEmailAddressId: null,
      emailAddresses: [],
    });
    const { send, calls } = makeSendStub();

    const results = await sendExpirationRemindersForUser(TEST_USER, {
      now: NOW,
      send,
    });
    expect(calls).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(results[0].channel).toBe("skipped");
    expect(results[0].reason).toBe("no-email-on-file");
    // Important: NO row in plaid_consent_reminders_sent — we must
    // retry on the next sweep once the user adds an email.
    const rows = await db
      .select()
      .from(plaidConsentRemindersSentTable)
      .where(eq(plaidConsentRemindersSentTable.userId, TEST_USER));
    expect(rows).toHaveLength(0);
  });

  it("falls back to the cached profiles.email when Clerk fails", async () => {
    const NOW = new Date();
    await db
      .insert(profilesTable)
      .values({ id: TEST_USER, email: "fallback@example.com" })
      .onConflictDoUpdate({
        target: profilesTable.id,
        set: { email: "fallback@example.com" },
      });
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    clerkUserGetMock = async () => {
      throw new Error("clerk down");
    };
    const { send, calls } = makeSendStub();

    const results = await sendExpirationRemindersForUser(TEST_USER, {
      now: NOW,
      send,
    });
    expect(results[0].channel).toBe("email");
    expect(calls[0].to).toBe("fallback@example.com");
  });

  it("does NOT mark the reminder as sent when the email transport fails (so the next sweep retries)", async () => {
    const NOW = new Date();
    const item = await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    const failing: SendReminderEmailFn = async () => ({
      ok: false,
      channel: "email",
      error: "SendGrid 500",
    });

    const results = await sendExpirationRemindersForUser(TEST_USER, {
      now: NOW,
      send: failing,
    });
    expect(results[0].error).toMatch(/SendGrid 500/);
    const rows = await db
      .select()
      .from(plaidConsentRemindersSentTable)
      .where(eq(plaidConsentRemindersSentTable.plaidItemId, item.itemRowId));
    expect(rows).toHaveLength(0);

    // Now the next sweep with a working transport should send.
    const { send, calls } = makeSendStub();
    await sendExpirationRemindersForUser(TEST_USER, { now: NOW, send });
    expect(calls).toHaveLength(1);
  });
});

describe("(#262) production safety: no APP_URL configured", () => {
  it("skips items with reason=no-app-url-configured and does NOT mark sent (so a later config fix retries)", async () => {
    const NOW = new Date();
    const item = await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    const prevAppUrl = process.env.APP_URL;
    const prevInvitationUrl = process.env.INVITATION_REDIRECT_URL;
    const prevNodeEnv = process.env.NODE_ENV;
    delete process.env.APP_URL;
    delete process.env.INVITATION_REDIRECT_URL;
    process.env.NODE_ENV = "production";
    try {
      const { send, calls } = makeSendStub();
      const results = await sendExpirationRemindersForUser(TEST_USER, {
        now: NOW,
        send,
      });
      expect(calls).toHaveLength(0);
      expect(results[0].channel).toBe("skipped");
      expect(results[0].reason).toBe("no-app-url-configured");
      const rows = await db
        .select()
        .from(plaidConsentRemindersSentTable)
        .where(eq(plaidConsentRemindersSentTable.plaidItemId, item.itemRowId));
      expect(rows).toHaveLength(0);
    } finally {
      if (prevAppUrl !== undefined) process.env.APP_URL = prevAppUrl;
      if (prevInvitationUrl !== undefined)
        process.env.INVITATION_REDIRECT_URL = prevInvitationUrl;
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
    }
  });

  it("buildReconnectUrl returns null when no env is configured and an absolute URL when APP_URL is set", () => {
    const prev = process.env.APP_URL;
    const prevInv = process.env.INVITATION_REDIRECT_URL;
    delete process.env.APP_URL;
    delete process.env.INVITATION_REDIRECT_URL;
    try {
      expect(buildReconnectUrl()).toBeNull();
      process.env.APP_URL = "https://h2budget.example";
      expect(buildReconnectUrl()).toBe("https://h2budget.example/settings");
    } finally {
      if (prev !== undefined) process.env.APP_URL = prev;
      else delete process.env.APP_URL;
      if (prevInv !== undefined) process.env.INVITATION_REDIRECT_URL = prevInv;
      else delete process.env.INVITATION_REDIRECT_URL;
    }
  });
});

describe("(#262) recipient cache reuses one Clerk lookup across a user's items", () => {
  it("only calls Clerk once per user even when the user has multiple items in the window", async () => {
    const NOW = new Date();
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 1 * 86_400_000),
      institutionName: "Chase",
    });
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "BofA",
    });
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 3 * 86_400_000),
      institutionName: "Citi",
    });

    let clerkCalls = 0;
    clerkUserGetMock = async (id) => {
      clerkCalls++;
      return {
        primaryEmailAddressId: "pe-1",
        emailAddresses: [{ id: "pe-1", emailAddress: `${id}@example.com` }],
      };
    };
    const { send, calls } = makeSendStub();
    await sendExpirationRemindersForUser(TEST_USER, { now: NOW, send });
    expect(calls).toHaveLength(3);
    expect(clerkCalls).toBe(1);
  });
});

describe("(#262) sendExpirationRemindersForAllUsers (cron entry point)", () => {
  it("walks every user and returns aggregate scanned/sent/skipped/failed counts", async () => {
    const NOW = new Date();
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    await seedItem({
      userId: OTHER_USER,
      consentExpirationAt: new Date(NOW.getTime() + 1 * 86_400_000),
      institutionName: "Citi",
    });
    // Out of window — must NOT be scanned.
    await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 30 * 86_400_000),
      institutionName: "BofA",
    });

    const { send, calls } = makeSendStub();
    const summary = await sendExpirationRemindersForAllUsers({
      now: NOW,
      send,
    });
    // Other vitest files share the DB; assert at-least counts that
    // reflect the two items this test seeded inside the window.
    expect(summary.scanned).toBeGreaterThanOrEqual(2);
    expect(summary.sent).toBeGreaterThanOrEqual(2);
    const recipients = calls.map((c) => c.to).sort();
    expect(recipients).toContain(`${TEST_USER}@example.com`);
    expect(recipients).toContain(`${OTHER_USER}@example.com`);
  });
});

describe("(#262) POST /plaid/send-expiration-reminders (manual trigger endpoint)", () => {
  it("only sweeps the caller's items and returns a per-item summary", async () => {
    const NOW = new Date();
    const mine = await seedItem({
      consentExpirationAt: new Date(NOW.getTime() + 2 * 86_400_000),
      institutionName: "Chase",
    });
    await seedItem({
      userId: OTHER_USER,
      consentExpirationAt: new Date(NOW.getTime() + 1 * 86_400_000),
      institutionName: "Citi",
    });

    const res = await fetch(`${baseUrl}/plaid/send-expiration-reminders`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scanned: number;
      sent: number;
      skipped: number;
      failed: number;
      items: ReminderResult[];
    };
    expect(body.scanned).toBe(1);
    expect(body.items[0].itemRowId).toBe(mine.itemRowId);
    // The transport falls back to "log" channel here because no
    // SENDGRID_API_KEY is set in the test env, so `sent` is still 1
    // and `failed` is 0 (the fallback returns ok: true).
    expect(body.failed).toBe(0);
    expect(body.skipped + body.sent).toBe(1);
  });
});

// Minimal placeholder row used by the eligibility-helper tests above —
// avoids having to fill every column of the live Drizzle row type when
// only a couple of fields drive the helper's decision.
function stubItem() {
  const now = new Date();
  return {
    id: "00000000-0000-0000-0000-000000000000",
    userId: TEST_USER,
    itemId: "stub",
    accessToken: "access-sandbox-stub",
    institutionId: null,
    institutionName: "Chase",
    institutionSlug: "chase",
    cursor: null,
    lastSyncedAt: null,
    lastSyncError: null,
    lastSyncErrorCode: null,
    stillPreparingSince: null,
    consentExpirationAt: null,
    consentExpirationLastRefreshedAt: null,
    createdAt: now,
  };
}

// Silence the "REMINDER_DAYS_BEFORE only used in comments" warning if
// vitest's TS checker decides the import is unused — keep the symbol
// alive so the eligibility tests can import it without separate paths.
void REMINDER_DAYS_BEFORE;
