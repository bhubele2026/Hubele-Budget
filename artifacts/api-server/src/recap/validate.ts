import type { RecapFacts } from "./facts";
import { findForbidden, isGsmSafe, toGsm } from "./text";

// (AI-4a) The code that decides whether a model's recap may be sent.
//
//   (a) every number in the text is one the facts contain — a `$` number must
//       match a money figure (rounded, truncated or to the cent), any other
//       number a count, day, weekday date or percentage from the facts;
//   (b) no forbidden phrase;
//   (c) typographic characters are folded to ASCII (GSM-7), and the text must
//       then be plain ASCII;
//   (d) `factsUsed` names only keys the facts object has;
//   (e) text + link fits in 300 characters.
// The deterministic template passes this same check (property-tested), so a
// fallback is never rejected by the rule that sent us to it.

export const MAX_TEXT_CHARS = 240;
export const MAX_MESSAGE_CHARS = 300;
export const NUMBER_RE = /\$?\d[\d,]*(\.\d{1,2})?/g;

const key = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

export interface AllowedNumbers {
  /** Values a `$` figure may take. */
  amounts: Set<string>;
  /** Values a bare number may take. */
  counts: Set<string>;
}

function collect(value: unknown, path: string, out: AllowedNumbers): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    const v = Math.abs(value);
    out.amounts.add(key(v));
    out.amounts.add(key(Math.round(v)));
    out.amounts.add(key(Math.floor(v)));
    out.counts.add(key(v));
    return;
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      // A date allows its day of the month ("Oct 9"), and nothing else of it.
      out.counts.add(key(Number(value.slice(8, 10))));
      return;
    }
    // Free text built by code (a finding summary): its own numbers are allowed.
    for (const m of value.matchAll(NUMBER_RE)) {
      const n = Number(m[0].replace(/[$,]/g, ""));
      if (Number.isFinite(n)) {
        (m[0].startsWith("$") ? out.amounts : out.counts).add(key(n));
        if (m[0].startsWith("$")) out.counts.add(key(n));
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collect(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "id") continue;
      collect(v, `${path}.${k}`, out);
    }
  }
}

export function allowedNumbers(facts: RecapFacts): AllowedNumbers {
  const out: AllowedNumbers = { amounts: new Set(), counts: new Set() };
  collect(facts, "facts", out);
  return out;
}

export interface Draft {
  text: string;
  factsUsed: string[];
}

export interface ValidateOptions {
  /** The link that code appends after the text. */
  link: string;
}

/** The text exactly as it will be sent (folded to ASCII), without the link. */
export function normalizeDraftText(text: string): string {
  return toGsm(text);
}

/** null when the draft may be sent; otherwise one sentence a model can act on. */
export function validateRecapDraft(draft: Draft, facts: RecapFacts, opts: ValidateOptions): string | null {
  const text = normalizeDraftText(draft.text);
  if (!text) return "The text is empty.";
  if (!isGsmSafe(text)) return "The text has characters that cannot be sent by SMS. Use plain ASCII only.";

  const bad = findForbidden(text);
  if (bad) return `The text contains "${bad}". Remove it; use a calm, plain tone with no exclamation marks.`;

  const allowed = allowedNumbers(facts);
  for (const m of text.matchAll(NUMBER_RE)) {
    const token = m[0];
    const n = Number(token.replace(/[$,]/g, ""));
    if (!Number.isFinite(n)) return `"${token}" is not a number.`;
    const pool = token.startsWith("$") ? allowed.amounts : allowed.counts;
    if (!pool.has(key(n))) {
      return `The number "${token}" is not in the facts. Use only figures from the facts, exactly as given.`;
    }
  }

  const keys = new Set(Object.keys(facts));
  const stray = draft.factsUsed.find((k) => !keys.has(k));
  if (stray) return `factsUsed names "${stray}", which is not a key of the facts.`;

  if (text.length > MAX_TEXT_CHARS) {
    return `The text is ${text.length} characters; keep it under ${MAX_TEXT_CHARS}.`;
  }
  const total = text.length + 1 + opts.link.length;
  if (total > MAX_MESSAGE_CHARS) {
    return `The text plus the link is ${total} characters; keep it under ${MAX_MESSAGE_CHARS} (the text itself under ${MAX_TEXT_CHARS}).`;
  }
  return null;
}

/** The longest text that still fits with this link. */
export function maxTextFor(link: string): number {
  return Math.min(MAX_TEXT_CHARS, MAX_MESSAGE_CHARS - 1 - link.length);
}
