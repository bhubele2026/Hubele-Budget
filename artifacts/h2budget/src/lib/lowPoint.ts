import { formatCurrency } from "@/lib/utils";
import { shortDate } from "@/lib/dates";

// (Bundle) Deliberately not `@/lib/money`: this file is on the landing path
// (CashPanel), and importing that module there pulled all of it into the entry
// chunk. `formatCurrency` is already in it; a value is only formatted here once
// `num` has said it is a real number, so its "$0.00" fallback is never reached.
const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * ⭐ THE PROJECTED LOW POINT, IN WORDS — one pure reading of `spine.forecast`
 * for every surface that shows it.
 *
 * The server's verdict (`computeCashSignal().status`, api-server
 * lib/cashSignal.ts) is the only judge of where the low point sits:
 *   - `no_data`  no bank balance, so no projection at all;
 *   - `ready`    the low point is at least $200 over the buffer;
 *   - `tight`    it is over the buffer by less than $200;
 *   - `not_yet`  it is UNDER the buffer.
 * Only `no_data` hides the figure. `not_yet` is the case that most needs
 * showing: the dashboard used to treat it as "no forecast" and printed "—" on
 * exactly the days the household was heading under its floor.
 *
 * Code computes nothing new here: the value, date and buffer are the spine's
 * own; this only picks words and a tone. A negative low point carries the bad
 * tone. A stale bank balance never blanks the figure; the words say so.
 */
export type LowPointKind = "none" | "ok" | "tight" | "below";

export interface LowPointForecast {
  lowPoint: string | number | null;
  lowPointDate: string | null;
  status: "ready" | "tight" | "not_yet" | "no_data" | string;
  cashBuffer?: string | number | null;
}

export interface LowPointView {
  kind: LowPointKind;
  /** The low point in dollars; null only when there is no projection. */
  value: number | null;
  /** YYYY-MM-DD, or null. */
  date: string | null;
  /** One plain phrase: "below your $500 buffer". */
  words: string;
  /** "bad" when the low point is under zero. */
  tone: "bad" | "neutral";
  /** The bank balance behind the projection is out of date. */
  stale: boolean;
  /**
   * ⭐ (T2) The one status word for the low point, the same on every surface:
   * "Below zero on Oct 22" (rust — the only alarm) · "Under the $500 buffer"
   * (quiet: at or above $0) · "Near buffer" · "Above buffer" (ok). Null with no
   * projection. A real $0.00 is never rust.
   */
  chip: { word: string; tone: "bad" | "neutral" | "ok" } | null;
}

const KIND: Readonly<Record<string, LowPointKind>> = {
  ready: "ok",
  tight: "tight",
  not_yet: "below",
};

export function lowPointView(
  forecast: LowPointForecast | null | undefined,
  opts: { buffer?: string | number | null; stale?: boolean } = {},
): LowPointView {
  const stale = opts.stale === true;
  const value = num(forecast?.lowPoint);
  const kind: LowPointKind =
    !forecast || forecast.status === "no_data" || value == null ? "none" : (KIND[forecast.status] ?? "none");
  if (kind === "none") {
    return { kind, value: null, date: null, words: "No bank balance yet, so no forecast", tone: "neutral", stale, chip: null };
  }
  const buffer = num(opts.buffer ?? forecast?.cashBuffer);
  const bufferText = buffer == null ? null : formatCurrency(buffer).replace(/\.00$/, "");
  const yours = bufferText == null ? "your buffer" : `your ${bufferText} buffer`;
  const phrase = kind === "below" ? `below ${yours}` : kind === "tight" ? `just above ${yours}` : `above ${yours}`;
  const date = forecast?.lowPointDate ?? null;
  const chip: LowPointView["chip"] =
    value! < 0
      ? { word: `Below zero${date ? ` on ${shortDate(date.slice(0, 10))}` : ""}`, tone: "bad" }
      : kind === "below"
        ? { word: bufferText ? `Under the ${bufferText} buffer` : "Under the buffer", tone: "neutral" }
        : kind === "tight"
          ? { word: "Near buffer", tone: "neutral" }
          : { word: "Above buffer", tone: "ok" };
  return {
    kind,
    value,
    date,
    words: stale ? `${phrase}, from an out-of-date bank balance` : phrase,
    tone: value! < 0 ? "bad" : "neutral",
    stale,
    chip,
  };
}
