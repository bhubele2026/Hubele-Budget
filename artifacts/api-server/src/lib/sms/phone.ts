import { createHash } from "node:crypto";

// US numbers only: A2P 10DLC (the registration this app uses) is US-only.
// +1, then a 10-digit NANP number whose area code and exchange start 2-9.
const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/** Normalise "(555) 555-0100" / "5555550100" / "+1 555 555 0100" to E.164, or null. */
export function normalizeUsPhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  let e164: string;
  if (trimmed.startsWith("+")) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return null;
  return US_E164.test(e164) ? e164 : null;
}

export function isUsE164(value: string): boolean {
  return US_E164.test(value);
}

export function last4(e164: string | null | undefined): string | null {
  return e164 ? e164.slice(-4) : null;
}

/** A short stable fingerprint for logs: lets two lines be tied together without printing the number. */
export function phoneRef(e164: string): string {
  return createHash("sha256").update(e164).digest("hex").slice(0, 10);
}

/** Strip anything that looks like a phone number out of a provider error before it is stored. */
export function scrubError(message: string): string {
  return message.replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]").slice(0, 300);
}
