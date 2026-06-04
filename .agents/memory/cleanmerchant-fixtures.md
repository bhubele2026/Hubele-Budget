---
name: cleanMerchant fixture quirks
description: Two in-file cleanMerchant TEST_CASES are known-inaccurate; why not to casually "fix" the helpers.
---

In `artifacts/api-server/src/lib/merchantNameExtract.ts`, running the in-file `TEST_CASES`
through `cleanMerchant()` produces 2 mismatches against their documented `out`:

- `"TRADER JOE'S #455 03/30"` → `"Trader Joe'S #455"` (expected `"Trader Joe's #455"`).
  `titleCaseSmart` treats the apostrophe as a word boundary and upcases the trailing `s`.
- `"Replit Inc."` → `"Replit Inc"` (expected `"Replit Inc."`).
  `stripNoise`'s trailing-punctuation strip removes the final period.

**Why:** These are pre-existing inaccuracies in the #850 spending-overhaul helper, NOT in
`merchantSignature` (all 6 SIGNATURE_TEST_CASES pass). The "Merchant rename & learn" work
left them untouched on purpose.

**How to apply:** Don't treat these fixture failures as a regression introduced by signature/
rename work. If you do decide to fix `titleCaseSmart`/`stripNoise`, remember `cleanMerchant`
also powers Spending/behavior grouping (spendingFacts.ts, behaviorFacts.ts) and merchant
display fallback — changing its output reshuffles those groupings, so weigh the ripple first.
