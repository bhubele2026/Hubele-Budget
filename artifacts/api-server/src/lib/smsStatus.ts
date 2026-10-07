// (AI-0) What /api/healthz says about SMS before the SMS package lands.
// SMS_PROVIDER=twilio|console|fake (default console: messages are written to
// the log, nothing is sent). `configured` = the chosen provider has what it
// needs; for twilio that is the three TWILIO_* values. Booleans only — never
// a value.

export type SmsProviderName = "twilio" | "console" | "fake";

export function getSmsStatus(): { provider: SmsProviderName; configured: boolean } {
  const raw = process.env.SMS_PROVIDER?.trim().toLowerCase();
  const provider: SmsProviderName = raw === "twilio" || raw === "fake" ? raw : "console";
  const configured =
    provider !== "twilio" ||
    !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_MESSAGING_SERVICE_SID
    );
  return { provider, configured };
}
