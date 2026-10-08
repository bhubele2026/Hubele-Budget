// (AI-4a) Text rules shared by facts, template and validator: what may go into
// a text message at all. SMS is GSM-7: curly quotes, dashes and the like are
// folded to ASCII, and anything still outside printable ASCII is refused.

/** Phrases a recap never contains (compared case-insensitively on normalised text). */
export const FORBIDDEN_PHRASES: readonly string[] = [
  "should have",
  "shame",
  "bad job",
  "disappointing",
  "again?",
  "!",
];

const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
  " ": " ",
  " ": " ",
  " ": " ",
  "•": "-",
};

/** Fold typographic characters to ASCII and collapse runs of whitespace. */
export function toGsm(text: string): string {
  let out = "";
  for (const ch of text) out += FOLD[ch] ?? ch;
  return out.replace(/\s+/g, " ").trim();
}

/** True when every character is printable ASCII (a safe GSM-7 subset). */
export function isGsmSafe(text: string): boolean {
  return /^[\x20-\x7E]*$/.test(text);
}

export function findForbidden(text: string): string | null {
  const lower = text.toLowerCase();
  return FORBIDDEN_PHRASES.find((p) => lower.includes(p)) ?? null;
}

/**
 * A name that came from the household (a category, a bill) made safe to put in
 * a text and in front of a model: letters, spaces and a few marks only, so it
 * can carry no digit, no account number and no instruction-shaped punctuation.
 */
export function safeName(raw: string | null | undefined, fallback = "Other"): string {
  const folded = toGsm(raw ?? "")
    .replace(/[^A-Za-z &/'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20)
    .trim();
  if (!folded || findForbidden(folded)) return fallback;
  return folded;
}
