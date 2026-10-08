// (AI-2) The code check on an answer: every dollar amount the model wrote must
// be a number one of this run's tool results (or the person's own message)
// contained. A figure that is not there was not read from the app: the answer
// is kept, a line says so, and the run records it.

export const UNVERIFIED_LINE = "Some figures could not be verified.";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
const UNTRUSTED = /<untrusted[^>]*>[\s\S]*?<\/untrusted>/g;
const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;
// $1,234 · $1234 · $1,234.56 · $ 12.5
const DOLLARS = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;

export interface KnownFigures {
  /** Exact amounts in cents. */
  cents: Set<number>;
  /** Whole-dollar readings (round and floor) of every known figure. */
  wholes: Set<number>;
}

/** Numbers in a tool result's text, without ids, dates or outside strings. */
export function collectFigures(texts: readonly string[], into: KnownFigures = { cents: new Set(), wholes: new Set() }): KnownFigures {
  for (const raw of texts) {
    const t = raw.replace(UNTRUSTED, " ").replace(UUID, " ").replace(ISO_DATE, " ");
    for (const m of t.matchAll(NUMBER)) {
      const v = Math.abs(Number(m[0].replace(/,/g, "")));
      if (!Number.isFinite(v)) continue;
      into.cents.add(Math.round(v * 100));
      into.wholes.add(Math.round(v));
      into.wholes.add(Math.floor(v));
    }
  }
  return into;
}

export interface GroundingResult {
  ok: boolean;
  /** The `$` amounts (as written) that no tool result contained. */
  ungrounded: string[];
}

export function checkGrounding(answer: string, known: KnownFigures): GroundingResult {
  const ungrounded: string[] = [];
  for (const m of answer.matchAll(DOLLARS)) {
    const whole = Number(m[1]!.replace(/,/g, ""));
    const frac = m[2];
    const ok = frac !== undefined ? known.cents.has(whole * 100 + Number(frac.padEnd(2, "0"))) : known.wholes.has(whole);
    if (!ok) ungrounded.push(m[0]);
  }
  return { ok: ungrounded.length === 0, ungrounded };
}

export function withGroundingCaveat(answer: string, g: GroundingResult): string {
  return g.ok ? answer : `${answer.trimEnd()}\n\n${UNVERIFIED_LINE}`;
}
