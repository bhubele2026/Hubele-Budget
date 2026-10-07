import { createHash } from "node:crypto";
import { logger } from "../lib/logger";

// (AI-0) What may leave the process, and how.
//
// - `ref(kind, id)` gives logs and prompts a short, stable, non-reversible
//   handle for a row (`txn:3f9a1c07be`) instead of its id.
// - `untrusted(label, text)` wraps text that came from outside our code (a
//   bank description, an SMS body, a receipt line) so a model reads it as
//   data, never as instructions: markup and control characters are escaped,
//   so the text cannot close the wrapper or forge a new one, and it is capped
//   at 200 characters.
// Pino's redact paths (lib/logger.ts) are the third leg: anything logged
// under ai.description / ai.text / ai.body / ai.messages / ai.phone /
// sms.to / sms.body prints as [Redacted].

export const UNTRUSTED_MAX_CHARS = 200;

let warnedNoSalt = false;

export function ref(kind: string, id: string | number | null | undefined): string {
  const salt = process.env.AI_REF_SALT ?? "";
  if (!salt && process.env.NODE_ENV === "production" && !warnedNoSalt) {
    warnedNoSalt = true;
    logger.warn("AI_REF_SALT is not set — hashed references are unsalted");
  }
  const safeKind = kind.replace(/[^a-z0-9_]/gi, "").slice(0, 16) || "ref";
  if (id === null || id === undefined || id === "") return `${safeKind}:none`;
  const hex = createHash("sha256").update(`${String(id)}${salt}`).digest("hex");
  return `${safeKind}:${hex.slice(0, 10)}`;
}

function escapeUntrusted(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

/**
 * Wrap outside text for a prompt. The cap counts characters of the ORIGINAL
 * text (code points), so escaping never cuts an escape sequence in half; a
 * cut text ends in "…".
 */
export function untrusted(label: string, text: string | null | undefined): string {
  const safeLabel = label.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 32) || "data";
  const chars = Array.from(text ?? "");
  const cut = chars.length > UNTRUSTED_MAX_CHARS;
  const body = escapeUntrusted(chars.slice(0, UNTRUSTED_MAX_CHARS).join("")) + (cut ? "…" : "");
  return `<untrusted source="${safeLabel}">${body}</untrusted>`;
}
