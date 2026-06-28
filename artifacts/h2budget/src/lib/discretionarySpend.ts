import type { Transaction } from "@workspace/api-client-react";

// Bank-noise / bill / payment description tokens that signal a transfer, debt
// payment, or recurring bill rather than a discretionary purchase. Mirrors the
// server's TRANSFER_PAYMENT_PATTERNS (spendingFilter.ts) plus loan / mortgage /
// insurance bill words. Tested against the RAW lowercased description.
const NOISE: ReadonlyArray<string> = [
  // generic payment / transfer bank-noise — catches any "… PMT … WEB ID …"
  " pmt",
  "pmt ",
  "payment",
  "web id:",
  "web id ",
  "ppd id",
  "transfer",
  "xfer",
  "autopay",
  "auto pay",
  "epay",
  "e-payment",
  "bill pay",
  "billpay",
  "ach ",
  "ach debit",
  // debt / loan / mortgage
  "loan",
  "servicing",
  "mortgage",
  "mtg ",
  // insurance / recurring bill words
  "ins prem",
  "insurance",
  "premium",
  // common card issuers paying themselves
  "capital one",
  "american express",
  "amex epayment",
  "chase credit",
  "bk of amer",
  "discover e-payment",
  "wells fargo card",
];

function matchesNoise(desc: string): boolean {
  const d = (desc ?? "").toLowerCase();
  return NOISE.some((p) => d.includes(p));
}

const norm = (s: string) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Build a matcher from the household's recurring-item names. A transaction is
 * "recurring" if its description contains a recurring item's normalized name or
 * any distinctive (5+ char) word from it — e.g. "Lakeview" matches "Lakeview
 * Loan Servicing", "Netflix" matches "NETFLIX.COM".
 */
export function makeRecurringMatcher(
  names: string[],
): (desc: string) => boolean {
  const whole = names.map(norm).filter((s) => s.length >= 4);
  const words = Array.from(
    new Set(
      names
        .flatMap((n) => norm(n).split(" "))
        .filter((w) => w.length >= 5),
    ),
  );
  return (desc: string) => {
    const d = norm(desc);
    if (!d) return false;
    return whole.some((w) => d.includes(w)) || words.some((w) => d.includes(w));
  };
}

/**
 * A stable-ish merchant key from a raw description — lowercased, id/number
 * tokens dropped, first few words kept. "UPSTART NETWORK 12345" and "Upstart"
 * collapse to "upstart"; "SHORTSTORY BOX" -> "shortstory box".
 */
export function merchantKey(desc: string): string {
  return (desc ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^\d+$/.test(w) && !(w.length >= 5 && /\d/.test(w)))
    .slice(0, 3)
    .join(" ")
    .trim();
}

/**
 * Detect recurring/"monthly" merchants straight from the transaction history:
 * any merchant whose charges land in `minMonths`+ distinct calendar months is
 * a subscription / loan / bill (Upstart, a box subscription, etc.) — not a
 * one-off splurge. Built over the full fetched window (~90 days), so it works
 * even when the merchant was never set up as a recurring item.
 */
export function recurringMerchantsFrom(
  txns: Transaction[],
  minMonths = 2,
): Set<string> {
  const months = new Map<string, Set<string>>();
  for (const t of txns ?? []) {
    if (!t.occurredOn) continue;
    const key = merchantKey(t.description ?? "");
    if (key.length < 3) continue;
    let s = months.get(key);
    if (!s) {
      s = new Set<string>();
      months.set(key, s);
    }
    s.add(t.occurredOn.slice(0, 7));
  }
  const out = new Set<string>();
  for (const [k, s] of months) if (s.size >= minMonths) out.add(k);
  return out;
}

/**
 * A real, discretionary, NON-recurring outflow — the kind actually worth
 * roasting. Excludes income, reimbursements, transfers, external card payments,
 * debt payments, bill/payment bank-noise, and anything matching a known
 * recurring item. (Mortgage, Capital One / Amex payments etc. all drop out.)
 */
export function isSplurge(
  t: Transaction,
  recurringMatch: (desc: string) => boolean,
): boolean {
  const a = Number(t.amount) || 0;
  if (a >= 0) return false;
  if (t.reimbursable) return false;
  if (t.isTransfer) return false;
  if (t.isExternalCardPayment) return false;
  if (t.debtId) return false;
  const desc = t.description ?? "";
  if (matchesNoise(desc)) return false;
  if (recurringMatch(desc)) return false;
  return true;
}
