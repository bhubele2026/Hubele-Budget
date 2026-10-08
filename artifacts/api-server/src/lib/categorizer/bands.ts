// (PR-A) Confidence bands. auto ≥ 0.9 writes the category; provisional
// 0.6–0.9 writes it, flags `category_provisional` and queues it; below 0.6 the
// category is left alone and the decision is queued.
import type { Band } from "./types";

export const AUTO_MIN = 0.9;
export const PROVISIONAL_MIN = 0.6;
/** An automatic category older than this may be re-decided (never a locked or accepted one). */
export const REDECIDE_AFTER_DAYS = 30;

export function bandFor(confidence: number): Band {
  if (confidence >= AUTO_MIN) return "auto";
  if (confidence >= PROVISIONAL_MIN) return "provisional";
  return "queue";
}
