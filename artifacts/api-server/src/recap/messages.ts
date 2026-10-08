// (AI-4b) Every fixed line the recap channel texts or shows. ASCII only
// (GSM-7), each under 160 characters, each naming how to stop.

export const CONSENT_TEXT_VERSION = "2026-10-v1";

/** Shown in the app next to the phone-number field; the member agrees to exactly this. */
export const CONSENT_TEXT =
  "I agree to get a daily H2 Budget recap text at this number, plus the occasional alert if I turn alerts on. " +
  "About one message a day. Message and data rates may apply. Reply STOP to opt out or HELP for help. " +
  "Agreeing is not a condition of using H2.";

export function verificationBody(code: string): string {
  return `H2 code ${code}. Enter it in H2 to confirm daily recap texts to this number. Msg&data rates may apply. Reply STOP to opt out.`;
}

/** The fixed test-send line, rendered with the member's own settings. */
export function testBody(sendTimeLocal: string, timezone: string): string {
  return `H2 test: your morning recap will arrive at ${sendTimeLocal} ${timezone}. Reply STOP to opt out.`;
}

export const STOP_REPLY = "H2: you are unsubscribed and will get no more texts. Reply START to turn them back on.";
export const START_REPLY =
  "H2: texts are back on for this number. Turn Daily Recap on in H2 settings. Reply STOP to opt out.";
export const HELP_REPLY =
  "H2 Budget: daily recap texts. Manage them in H2 settings. Reply STOP to opt out. Msg&data rates may apply.";
