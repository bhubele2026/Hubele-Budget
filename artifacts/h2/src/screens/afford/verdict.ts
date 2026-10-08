import type { AffordResult } from "@workspace/api-client-react";
import type { StatusTone } from "@/kit/StatusWord";

/** The verdict as a word, which the Afford sheet and the wish list both show. Never colour alone. */
export const VERDICT: Record<AffordResult["verdict"], { word: string; tone: StatusTone }> = {
  fits: { word: "Fits", tone: "on" },
  tight: { word: "Tight", tone: "tight" },
  breaks_buffer: { word: "Would dip below your buffer", tone: "over" },
  breaks_zero: { word: "Would overdraw", tone: "over" },
};

const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" });

/** "2027-03" → "Mar 2027". */
export function monthWord(ym: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(ym ?? "");
  return m ? MONTH.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))) : null;
}
