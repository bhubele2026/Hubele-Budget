import twilio from "twilio";
import type { SmsMessage, SmsProvider } from "./types";

// (AI-4b) Twilio adapter. Uses `client.messages.create({ to, from |
// messagingServiceSid, body, statusCallback })` and
// `twilio.validateRequest(authToken, signature, url, params)` exactly as the
// installed twilio README / typings document them.

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Preferred: a Messaging Service (carries the A2P campaign and opt-out handling). */
  messagingServiceSid?: string;
  /** Fallback: a single sending number in E.164. */
  from?: string;
}

/** The slice of the Twilio client the adapter uses (so tests can inject a mock). */
export interface TwilioMessagesClient {
  messages: {
    create(params: {
      to: string;
      body: string;
      statusCallback?: string;
      messagingServiceSid?: string;
      from?: string;
    }): Promise<{ sid: string }>;
  };
}

export function createTwilioProvider(cfg: TwilioConfig, client?: TwilioMessagesClient): SmsProvider {
  if (!cfg.messagingServiceSid && !cfg.from) {
    throw new Error("twilio: set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM");
  }
  const c: TwilioMessagesClient =
    client ?? (twilio(cfg.accountSid, cfg.authToken, { timeout: 10_000, autoRetry: false }) as unknown as TwilioMessagesClient);
  return {
    name: "twilio",
    async send(msg: SmsMessage) {
      const created = await c.messages.create({
        to: msg.to,
        body: msg.body,
        ...(cfg.messagingServiceSid ? { messagingServiceSid: cfg.messagingServiceSid } : { from: cfg.from }),
        ...(msg.statusCallbackUrl ? { statusCallback: msg.statusCallbackUrl } : {}),
      });
      return { providerId: created.sid };
    },
  };
}

/** True when `signature` is Twilio's HMAC-SHA1 of `url` + the sorted POST params under `authToken`. */
export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, unknown>,
): boolean {
  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch {
    return false;
  }
}

/** Test helper: the signature Twilio would send for this url + params. */
export function signTwilioRequest(authToken: string, url: string, params: Record<string, unknown>): string {
  return twilio.getExpectedTwilioSignature(authToken, url, params);
}
