import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { getSmsProvider } from "../lib/sms";
import { applyStatusCallback, processInbound } from "../lib/sms/inbound";
import { phoneRef } from "../lib/sms/phone";
import { validateTwilioSignature } from "../lib/sms/twilio";

// (AI-4b) Twilio's two webhooks. Neither has a signed-in user; both are
// authenticated by X-Twilio-Signature, checked against
// SMS_WEBHOOK_BASE_URL + the request's original URL and the exact form
// parameters Twilio posted (app.ts parses these two paths as flat
// urlencoded). A bad or missing signature is 403 and nothing is read.
//
// With the console or fake provider the check is skipped, but only when
// NODE_ENV is not production: production always validates, and with no auth
// token configured that means every request is refused.

const router: IRouter = Router();

function signatureOk(req: Request): boolean {
  const name = getSmsProvider().name;
  if ((name === "console" || name === "fake") && process.env.NODE_ENV !== "production") return true;
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const base = process.env.SMS_WEBHOOK_BASE_URL?.trim().replace(/\/+$/, "");
  const signature = req.get("x-twilio-signature");
  if (!token || !base || !signature) return false;
  const params = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  return validateTwilioSignature(token, signature, `${base}${req.originalUrl}`, params);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

router.post("/sms/status", async (req: Request, res: Response): Promise<void> => {
  if (!signatureOk(req)) {
    res.status(403).json({ error: "Invalid signature" });
    return;
  }
  try {
    const sid = str(req.body?.MessageSid);
    const status = str(req.body?.MessageStatus);
    if (sid && status) {
      await applyStatusCallback({
        providerMessageId: sid,
        messageStatus: status,
        ...(str(req.body?.ErrorCode) ? { errorCode: str(req.body.ErrorCode) } : {}),
      });
    }
  } catch (err) {
    // Twilio does not retry status callbacks; log and acknowledge.
    logger.error({ err }, "sms status callback failed");
  }
  res.status(204).end();
});

router.post("/sms/inbound", async (req: Request, res: Response): Promise<void> => {
  if (!signatureOk(req)) {
    res.status(403).json({ error: "Invalid signature" });
    return;
  }
  const sid = str(req.body?.MessageSid);
  const from = str(req.body?.From);
  const body = str(req.body?.Body);
  try {
    if (sid && from) {
      const action = await processInbound({ providerMessageId: sid, fromE164: from, body });
      logger.info({ action, fromRef: phoneRef(from) }, "inbound sms handled");
    }
  } catch (err) {
    // A 5xx makes Twilio retry; processInbound is idempotent on the message sid.
    logger.error({ err }, "inbound sms failed");
    res.status(500).json({ error: "Could not process the message" });
    return;
  }
  // Empty TwiML: the reply (if any) was sent through sendSms, not as TwiML.
  res.status(200).type("text/xml").send("<Response></Response>");
});

export default router;
