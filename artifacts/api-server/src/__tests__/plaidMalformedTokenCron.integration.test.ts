import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// (#372) This test pins the daily bank-login health check cron registered
// in `index.ts`: the 03:02 UTC slot, the explicit UTC timezone, the
// error-swallowing `.catch`, and its ordering before the 03:17 consent
// refresh. Mocks `node-cron` so cron.schedule calls are captured instead
// of actually scheduling, mocks `./app` so no HTTP server is started, and
// mocks every cron-target module so nothing real fires.

type ScheduleCall = {
  expression: string;
  handler: () => void;
  options: { timezone?: string } | undefined;
};

const scheduleCalls: ScheduleCall[] = [];
const flagMalformedAccessTokensSpy = vi.fn(async () => ({
  scanned: 0,
  flagged: 0,
  items: [],
}));
const refreshConsentExpirationForAllItemsSpy = vi.fn(async () => ({}));
const syncAllForAllUsersSpy = vi.fn(async () => {});
const sendExpirationRemindersForAllUsersSpy = vi.fn(async () => ({
  scanned: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
}));
const maybeAlertOnMalformedTokenSpikeSpy = vi.fn(async () => ({
  channel: "skipped" as const,
}));
const prunePlaidSyncAttemptsSpy = vi.fn(async () => 0);
const loggerErrorSpy = vi.fn();
const loggerInfoSpy = vi.fn();
const loggerWarnSpy = vi.fn();

vi.mock("node-cron", () => ({
  default: {
    schedule: (
      expression: string,
      handler: () => void,
      options?: { timezone?: string },
    ) => {
      scheduleCalls.push({ expression, handler, options });
      return { stop: () => {} };
    },
  },
}));

vi.mock("../app", () => ({
  default: {
    listen: (_port: number, cb: (err?: Error) => void) => {
      // Invoke the listen callback synchronously so the cron registrations
      // inside it run during `import("../index")`.
      cb();
      return { close: () => {} };
    },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfoSpy(...args),
    warn: (...args: unknown[]) => loggerWarnSpy(...args),
    error: (...args: unknown[]) => loggerErrorSpy(...args),
    debug: () => {},
  },
}));

vi.mock("../lib/plaidSync", () => ({
  flagMalformedAccessTokens: flagMalformedAccessTokensSpy,
  refreshConsentExpirationForAllItems: refreshConsentExpirationForAllItemsSpy,
  syncAllForAllUsers: syncAllForAllUsersSpy,
}));

vi.mock("../lib/plaidExpirationReminder", () => ({
  sendExpirationRemindersForAllUsers: sendExpirationRemindersForAllUsersSpy,
}));

vi.mock("../lib/plaidMalformedTokenAlert", () => ({
  maybeAlertOnMalformedTokenSpike: maybeAlertOnMalformedTokenSpikeSpy,
}));

vi.mock("../lib/plaidSyncAttempts", () => ({
  prunePlaidSyncAttempts: prunePlaidSyncAttemptsSpy,
}));

vi.mock("../lib/plaidMalformedSiblingCleanup", () => ({
  backfillMalformedTokenSiblings: vi.fn(async () => ({
    scannedMalformed: 0,
    cleanedSiblings: 0,
    skippedNoHealthySibling: 0,
  })),
}));

const ORIGINAL_ENV = { ...process.env };

beforeAll(async () => {
  process.env.NODE_ENV = "development";
  process.env.PORT = "3999";
  process.env.PLAID_CLIENT_ID = "test-client-id";
  process.env.PLAID_SECRET = "test-secret";
  process.env.PLAID_ENV = "sandbox";
  delete process.env.PLAID_REDIRECT_URI;

  await import("../index");
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("(#372) daily bank-login health check cron registration", () => {
  it("registers a cron at 03:02 UTC that calls flagMalformedAccessTokens", () => {
    const malformed = scheduleCalls.find((c) => c.expression === "2 3 * * *");
    expect(malformed, "expected a cron registered at '2 3 * * *'").toBeDefined();
    expect(malformed!.options?.timezone).toBe("UTC");
  });

  it("is registered as a top-level daily cron, independent of the auto-sync kill-switch", () => {
    // The daily malformed-token sweep is a pure read/flag pass that makes
    // NO billable Plaid pull, so it lives OUTSIDE the `if (autoSyncEnabled)`
    // block — it must keep running even though the hard cost kill-switch
    // (AUTO_SYNC_HARD_DISABLED) gates off the hourly sync, the forced-
    // refresh loop, AND the daily consent refresh. The consent refresh
    // ("17 3 * * *") makes billable /item/get calls, so it now sits inside
    // the kill-switched block and is NOT registered in the default
    // configuration this suite boots under.
    const malformedIdx = scheduleCalls.findIndex(
      (c) => c.expression === "2 3 * * *",
    );
    const consentIdx = scheduleCalls.findIndex(
      (c) => c.expression === "17 3 * * *",
    );
    expect(malformedIdx).toBeGreaterThanOrEqual(0);
    // Consent refresh is gated off by the billing kill-switch.
    expect(consentIdx).toBe(-1);
    // The sweep keeps its documented 03:02 UTC slot.
    const [malformedMin, malformedHour] = malformed_parts(
      scheduleCalls[malformedIdx]!.expression,
    );
    expect(malformedHour).toBe(3);
    expect(malformedMin).toBe(2);
  });

  it("invoking the handler calls flagMalformedAccessTokens exactly once", async () => {
    flagMalformedAccessTokensSpy.mockClear();
    const malformed = scheduleCalls.find((c) => c.expression === "2 3 * * *")!;
    malformed.handler();
    // Drain microtasks so the .then/.catch chain settles.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(flagMalformedAccessTokensSpy).toHaveBeenCalledTimes(1);
  });

  it("a thrown error from flagMalformedAccessTokens is logged but not re-thrown", async () => {
    flagMalformedAccessTokensSpy.mockClear();
    loggerErrorSpy.mockClear();
    flagMalformedAccessTokensSpy.mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const malformed = scheduleCalls.find((c) => c.expression === "2 3 * * *")!;
    // The cron callback is synchronous (it kicks off a promise chain). It
    // must not throw — node-cron's tick loop would otherwise crash the
    // process / silence subsequent ticks.
    expect(() => malformed.handler()).not.toThrow();

    // Drain microtasks so the .catch fires.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const loggedSweepFailure = loggerErrorSpy.mock.calls.some((call) => {
      const msg = call[1];
      return (
        typeof msg === "string" &&
        msg.includes("Daily Plaid malformed access_token sweep failed")
      );
    });
    expect(loggedSweepFailure).toBe(true);
  });
});

function malformed_parts(expr: string): number[] {
  return expr.split(" ").map((p) => Number.parseInt(p, 10));
}
