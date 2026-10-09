/**
 * (F10) The words and the one presentation threshold on Settings › AI cost.
 * Ported from the frozen h2 app (`screens/household/AiCost.tsx` `capOf`,
 * `CAP_WORDS`; `screens/ask/askWords.ts` `taskWord`, `RUN_STATUS_WORD`, `usd`,
 * `percent`; `kit/Meter.tsx` `meterStatus`, `TIGHT_AT`), with
 * their tests; never imported from it. Nothing here works out a figure the
 * server sent — it formats one, or compares two to pick a word.
 */

/** The AI work that costs money, in plain words. */
export const TASK_WORD: Record<string, string> = {
  chat: "Ask",
  categorize: "Filing charges",
  monitor: "Watching for changes",
  recap: "Morning recap",
  receipt: "Receipts",
  sms_question: "Text questions",
};
export const taskWord = (task: string): string => TASK_WORD[task] ?? task.replace(/[_-]+/g, " ");

export const RUN_STATUS_WORD: Record<string, string> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  refused: "Declined",
  budget_exceeded: "Over the cap",
};

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** AI cost in dollars and cents ("$0.04"): these are small amounts. */
export const usd = (n: number): string => USD.format(n);
const PCT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
export const percent = (ratio: number): string => PCT.format(ratio);

/** A dollar box → a number for the server, or null when it is not an amount. */
export function capOf(raw: string): number | null {
  const s = raw.replace(/[$,\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : null;
}

export type MeterStatus = "on" | "tight" | "over";

/**
 * The share of the limit at which a meter reads "Tight". A presentation
 * threshold only — it moves no figure.
 */
export const TIGHT_AT = 0.85;

/** Within / close to / over, from the two figures the meter already shows. */
export function meterStatus(spent: number, limit: number): MeterStatus {
  if (limit <= 0) return spent > 0 ? "over" : "on";
  if (spent > limit) return "over";
  if (spent >= limit * TIGHT_AT) return "tight";
  return "on";
}

/** What a cap meter says, in h2's words (the meter's word on this page). */
export const CAP_WORDS: Record<MeterStatus, string> = {
  on: "Within the cap",
  tight: "Close to the cap",
  over: "Over the cap",
};
