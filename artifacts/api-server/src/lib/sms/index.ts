import { logger } from "../logger";
import { consoleProvider } from "./console";
import { fakeProvider } from "./fake";
import { createTwilioProvider, type TwilioConfig } from "./twilio";
import type { SmsProvider, SmsProviderName } from "./types";

export type { SmsProvider, SmsProviderName, SmsMessage } from "./types";

// (AI-4b) Which provider sends, and what /api/healthz says about it.
//
// SMS_PROVIDER = twilio | console | fake (default console).
//  - console never sends; it logs a redacted line.
//  - twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, a sender
//    (TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM) and SMS_WEBHOOK_BASE_URL
//    (status callbacks and signature checks both need it). If any is missing
//    this NEVER throws: it logs one warning and sends through console instead,
//    and healthz reports { provider: "twilio", configured: false }.
//  - fake records to an array and exists for tests; outside tests it is
//    refused in production and falls back to console.

export interface SmsConfig {
  /** What SMS_PROVIDER asked for. */
  provider: SmsProviderName;
  /** True when that provider has everything it needs. Booleans only — never a value. */
  configured: boolean;
  /**
   * "live" only when Twilio is the provider AND every credential is present.
   * console and fake never put a text on a phone, so they are "preview".
   */
  mode: SmsMode;
}

export type SmsMode = "live" | "preview";

function requested(): SmsProviderName {
  const raw = process.env.SMS_PROVIDER?.trim().toLowerCase();
  return raw === "twilio" || raw === "fake" ? raw : "console";
}

export function readTwilioConfig(): (TwilioConfig & { webhookBaseUrl: string }) | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const from = process.env.TWILIO_FROM?.trim();
  const webhookBaseUrl = process.env.SMS_WEBHOOK_BASE_URL?.trim().replace(/\/+$/, "");
  if (!accountSid || !authToken || !(messagingServiceSid || from) || !webhookBaseUrl) return null;
  return {
    accountSid,
    authToken,
    ...(messagingServiceSid ? { messagingServiceSid } : {}),
    ...(from ? { from } : {}),
    webhookBaseUrl,
  };
}

export function getSmsConfig(): SmsConfig {
  const provider = requested();
  if (provider === "twilio") {
    const ok = readTwilioConfig() !== null;
    return { provider, configured: ok, mode: ok ? "live" : "preview" };
  }
  if (provider === "fake") return { provider, configured: process.env.NODE_ENV !== "production", mode: "preview" };
  // console is the provider that never sends: it is not "configured", it is a preview.
  return { provider, configured: false, mode: "preview" };
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn({ smsProvider: key }, msg);
}

let twilioCache: { key: string; provider: SmsProvider } | null = null;

export function _resetSmsProviderForTests(): void {
  twilioCache = null;
  warned.clear();
}

/** The provider that actually sends right now. Never throws. */
export function getSmsProvider(): SmsProvider {
  const want = requested();
  if (want === "fake") {
    if (process.env.NODE_ENV === "production") {
      warnOnce("fake-in-production", "SMS_PROVIDER=fake is refused in production; using console");
      return consoleProvider;
    }
    return fakeProvider;
  }
  if (want === "twilio") {
    const cfg = readTwilioConfig();
    if (!cfg) {
      warnOnce(
        "twilio-unconfigured",
        "SMS_PROVIDER=twilio but Twilio is not fully configured (account sid, auth token, sender, SMS_WEBHOOK_BASE_URL); using console",
      );
      return consoleProvider;
    }
    const key = [cfg.accountSid, cfg.authToken, cfg.messagingServiceSid ?? "", cfg.from ?? ""].join("|");
    if (twilioCache?.key !== key) {
      try {
        twilioCache = { key, provider: createTwilioProvider(cfg) };
      } catch (err) {
        warnOnce("twilio-init-failed", `Twilio client could not be created (${(err as Error).message}); using console`);
        return consoleProvider;
      }
    }
    return twilioCache.provider;
  }
  return consoleProvider;
}

/** Where Twilio posts per-message status; null when no public base URL is set. */
export function getStatusCallbackUrl(): string | null {
  const base = process.env.SMS_WEBHOOK_BASE_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/api/sms/status` : null;
}

export function getDailySendCap(): number {
  const raw = process.env.SMS_DAILY_SEND_CAP?.trim();
  if (!raw) return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
}
