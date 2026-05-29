// (#850 — Spending overhaul, Phase 1) Pure merchant-name normalizer.
//
// Bank/Plaid transaction descriptions are full of ACH noise (ORIG CO NAME,
// WEB ID, transaction numbers, trailing dates) and processor prefixes
// (PAYPAL *, SQ *, TST*). cleanMerchant() strips that down to a human
// merchant label so the Spending tab can group by real merchant instead of
// by raw bank string. Pure + regex-driven; no I/O.

function titleCaseSmart(s: string): string {
  const t = s.trim();
  if (!t) return t;
  // Only re-case strings that are SHOUTING (no lowercase at all); leave
  // already-mixed-case merchant names ("Netflix", "Replit Inc.") untouched.
  if (/[a-z]/.test(t)) return t;
  return t
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .trim();
}

function stripNoise(s: string): string {
  return s
    .replace(/transaction\s*#:?\s*\d+/gi, "") // "transaction#: 28602049437"
    .replace(/\b(?:ppd|ccd|web|orig)\s*id:.*$/gi, "") // trailing ACH id fields
    .replace(/\bco\s+entry\s+descr:.*$/gi, "")
    .replace(/\b\d{6,}\b/g, "") // long id/account number runs
    .replace(/\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*$/g, "") // trailing " 03/30"
    .replace(/\s{2,}/g, " ")
    .replace(/[\s*#:.\-]+$/g, "")
    .trim();
}

export function cleanMerchant(rawDescription: string): string {
  if (!rawDescription) return "";
  const s = rawDescription.trim();

  // Internal account transfers (to/from your own accounts).
  if (/online\s+transfer/i.test(s)) return "Internal transfer";

  // Named card-issuer ACH payment.
  if (/american\s+express\s+ach\s+pmt/i.test(s)) return "American Express payment";

  // Zelle.
  let m = s.match(/zelle[^a-z0-9]*(?:to|payment\s+to)\s+(.+)/i);
  if (m) return `Zelle: ${titleCaseSmart(stripNoise(m[1]))}`;
  m = s.match(/zelle[^a-z0-9]*from\s+(.+)/i);
  if (m) return `Zelle from ${titleCaseSmart(stripNoise(m[1]))}`;

  // Payment-processor prefixes -> "<Merchant> (via X)".
  m = s.match(/paypal\s*\*\s*(.+)/i);
  if (m) return `${titleCaseSmart(stripNoise(m[1]))} (via PayPal)`;
  m = s.match(/\bsq\s*\*\s*(.+)/i);
  if (m) return `${titleCaseSmart(stripNoise(m[1]))} (Square)`;
  m = s.match(/\btst\s*\*\s*(.+)/i);
  if (m) return `${titleCaseSmart(stripNoise(m[1]))} (Toast)`;

  // ACH "ORIG CO NAME:<merchant> ORIG ID:..." -> keep just the co name.
  m = s.match(
    /orig\s+co\s+name:\s*(.+?)(?:\s+(?:orig\s+id|co\s+entry|web\s+id|ppd\s+id|ccd\s+id|sec:|desc\s+date|id:)\b.*)?$/i,
  );
  let out = m ? m[1] : s;

  // Strip any remaining trailing ACH id field.
  out = out.replace(/\bweb\s+id:.*$/i, "");

  return titleCaseSmart(stripNoise(out));
}

// Inline documentation of the patterns this normalizer is expected to handle.
// (Per personal-app policy we keep these as in-file fixtures rather than a
// separate jest spec.) Each `out` is the expected cleanMerchant(input).
export const TEST_CASES: ReadonlyArray<{ in: string; out: string }> = [
  { in: "Online Transfer to SAV ...9128 transaction#: 28602049437 03/30", out: "Internal transfer" },
  { in: "Online Transfer from CHK ...4471", out: "Internal transfer" },
  { in: "AMERICAN EXPRESS ACH PMT W1234567", out: "American Express payment" },
  { in: "ZELLE TO JANE DOE 05/08", out: "Zelle: Jane Doe" },
  { in: "Zelle payment to Plumber Joe", out: "Zelle: Plumber Joe" },
  { in: "ZELLE FROM JOHN SMITH", out: "Zelle from John Smith" },
  { in: "PAYPAL *STEAMGAMES", out: "Steamgames (via PayPal)" },
  { in: "SQ *BLUE BOTTLE COFFEE", out: "Blue Bottle Coffee (Square)" },
  { in: "TST* THE LOCAL DINER", out: "The Local Diner (Toast)" },
  { in: "ORIG CO NAME:NETFLIX ORIG ID:1234567890 WEB ID: 99887766", out: "Netflix" },
  { in: "ORIG CO NAME:COSTCO WHSE CO ENTRY DESCR:PURCHASE", out: "Costco Whse" },
  { in: "TRADER JOE'S #455 03/30", out: "Trader Joe's #455" },
  { in: "Replit Inc.", out: "Replit Inc." },
  { in: "STARBUCKS 0123456789", out: "Starbucks" },
];
