import { describe, it, expect } from "vitest";
import type { RecapHistoryItem, RecapSettings } from "@workspace/api-client-react/features";
import {
  TIMEZONES,
  clockWords,
  historyWords,
  isClock,
  isListedZone,
  isSixDigits,
  ladderRows,
  maskedPhone,
  scheduleWords,
  statusLabel,
  testsLeft,
  toE164,
} from "./recapWords";

// (F9) Ported from h2's `recap/recap.test.tsx` "recapWords", plus the ladder
// and history cases that test only these words.

const hist = (over: Partial<RecapHistoryItem> = {}): RecapHistoryItem => ({
  id: "h",
  forDate: "2026-10-07",
  text: "t",
  source: "template",
  status: "sent",
  generatedAt: "2026-10-07T12:00:00Z",
  delivery: { status: "sent", provider: "twilio", createdAt: "2026-10-07T12:30:00Z" },
  ...over,
});
const LIVE: RecapSettings["delivery"] = {
  mode: "live",
  providerConfigured: true,
  phoneVerified: true,
  scheduled: true,
  sendTimeLocal: "07:00",
  timezone: "America/Chicago",
  lastDelivery: null,
};

describe("recapWords", () => {
  it("US numbers become E.164; anything else is null", () => {
    expect(toE164("(555) 555-0100")).toBe("+15555550100");
    expect(toE164("1 555 555 0100")).toBe("+15555550100");
    expect(toE164("+1 (555) 555-0100")).toBe("+15555550100");
    expect(toE164("555-0100")).toBeNull();
    expect(toE164("+44 20 7946 0958")).toBeNull();
  });

  it("mask, clock, six digits, zones", () => {
    expect(maskedPhone("0100")).toBe("•••• 0100");
    expect(maskedPhone(null)).toBe("A number on file");
    expect(clockWords("07:00")).toBe("7:00 AM");
    expect(clockWords("00:15")).toBe("12:15 AM");
    expect(clockWords("13:05")).toBe("1:05 PM");
    expect(isClock("24:00")).toBe(false);
    expect(isSixDigits(" 123456 ")).toBe(true);
    expect(isSixDigits("12345")).toBe(false);
    expect(TIMEZONES.map((z) => z.value)).toEqual([
      "America/Chicago",
      "America/New_York",
      "America/Denver",
      "America/Los_Angeles",
      "America/Phoenix",
    ]);
    expect(isListedZone("Europe/London")).toBe(false);
    expect(scheduleWords("07:00", "America/Los_Angeles")).toBe("7:00 AM Los Angeles");
  });

  it("tests left counts only test texts in the last 24 hours", () => {
    const now = new Date("2026-10-07T15:00:00Z");
    expect(testsLeft(undefined)).toBeNull();
    expect(
      testsLeft(
        [
          { id: "1", kind: "test", forDate: null, status: "sent", provider: "twilio", createdAt: "2026-10-07T13:00:00Z" },
          { id: "2", kind: "scheduled", forDate: "2026-10-07", status: "sent", provider: "twilio", createdAt: "2026-10-07T12:00:00Z" },
          { id: "3", kind: "test", forDate: null, status: "sent", provider: "twilio", createdAt: "2026-10-05T13:00:00Z" },
        ],
        now,
      ),
    ).toBe(2);
  });

  it("history words: a console delivery is never Sent; failures say why", () => {
    expect(historyWords(hist({ status: "drafted", delivery: null })).status).toBe("drafted");
    expect(historyWords(hist({ delivery: { status: "sent", provider: "console", createdAt: "x" } })).status).toBe("previewed");
    expect(historyWords(hist({ delivery: { status: "undelivered", provider: "twilio", createdAt: "x" } }))).toEqual({
      status: "failed",
      source: "Template",
      problem: "The carrier did not deliver it.",
    });
    expect(historyWords(hist({ status: "failed", delivery: null })).problem).toBe("It could not be sent.");
    expect(historyWords(hist({ source: "model", status: "skipped", delivery: null }))).toEqual({
      status: "skipped",
      source: "Written by the model",
      problem: null,
    });
    expect(statusLabel("previewed")).toBe("Preview — not sent");
    expect(statusLabel("delivered")).toBe("Delivered");
  });

  it("the ladder: preview mode first; live rows; a failed text reads Failed", () => {
    expect(ladderRows({ ...LIVE, mode: "preview", providerConfigured: false }, "0100").map((r) => r.key)).toEqual([
      "preview",
      "provider",
      "phone",
      "scheduled",
      "accepted",
      "delivered",
    ]);
    const live = ladderRows(
      { ...LIVE, lastDelivery: { status: "delivered", provider: "twilio", at: "2026-10-07T12:00:00Z" } },
      "0100",
    );
    expect(live.map((r) => `${r.label}:${r.word}`)).toEqual([
      "Provider configured:Yes",
      "Phone verified — •••• 0100:Yes",
      "Scheduled — 7:00 AM Chicago:Yes",
      "Accepted by carrier:Yes",
      "Delivered:Yes",
    ]);
    const failed = ladderRows(
      { ...LIVE, lastDelivery: { status: "undelivered", provider: "twilio", at: "x" } },
      "0100",
    );
    expect(failed.at(-1)).toMatchObject({ label: "Failed", word: "Yes", tone: "over" });
    const off = ladderRows({ ...LIVE, scheduled: false }, null);
    expect(off.find((r) => r.key === "scheduled")).toMatchObject({ label: "Scheduled", word: "Off" });
  });
});
