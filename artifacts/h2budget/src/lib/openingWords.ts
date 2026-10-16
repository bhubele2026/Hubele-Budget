import { formatCurrency } from "@/lib/utils";
import { NO_READING_WORDS, readingLine, dayTimeOf, rowsWords, type ReadingLike, type SinceLike } from "@/lib/checkingWords";

/** (C2) The chart's first point in words. Kept out of checkingWords.ts: that file is on the landing path; this one is the chart's. */

/**
 * ⭐ (C2) The chart's first point, in two short lines:
 *   "Oct 16 · opens $0.00 · closes $2,614.20"
 *   "Bank read $0.00 Oct 15, 7:02 AM · +2 rows since"
 * Missing opening/close/reading are "—", never $0.00.
 */
export function openingCaption(args: {
  dateLabel: string | null;
  opens: string | number | null | undefined;
  closes: string | number | null | undefined;
  hasReading: boolean;
}): string {
  const face = (v: string | number | null | undefined) => {
    if (v == null || v === "") return "—";
    const n = Number(v);
    return Number.isFinite(n) ? formatCurrency(n) : "—";
  };
  return [
    args.dateLabel,
    `opens ${args.hasReading ? face(args.opens) : "—"}`,
    `closes ${args.hasReading ? face(args.closes) : "—"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function bankReadCaption(
  reading: ReadingLike | null | undefined,
  since: SinceLike | null | undefined,
): string {
  if (!reading || reading.balance == null || reading.balance === "" || !reading.at) return NO_READING_WORDS;
  const n = Number(reading.balance);
  if (!Number.isFinite(n)) return NO_READING_WORDS;
  if (reading.source === "manual") return readingLine(reading) ?? NO_READING_WORDS;
  return [`Bank read ${formatCurrency(n)} ${dayTimeOf(reading.at) ?? ""}`.trim(), rowsWords(since)].filter(Boolean).join(" · ");
}
