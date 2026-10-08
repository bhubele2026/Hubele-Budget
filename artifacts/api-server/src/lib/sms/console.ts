import { createHash } from "node:crypto";
import { logger } from "../logger";
import type { SmsMessage, SmsProvider } from "./types";

// (AI-4b) Nothing is sent: the message is logged under the `sms` key, whose
// `to` and `body` are redacted by lib/logger.ts (LOG_REDACT_PATHS), so even
// this provider never writes a phone number or message text to the logs.
export const consoleProvider: SmsProvider = {
  name: "console",
  async send(msg: SmsMessage) {
    logger.info(
      { sms: { to: msg.to, body: msg.body, idempotencyKey: msg.idempotencyKey } },
      "sms (console provider): not sent",
    );
    return { providerId: `console_${createHash("sha256").update(msg.idempotencyKey).digest("hex").slice(0, 24)}` };
  },
};
