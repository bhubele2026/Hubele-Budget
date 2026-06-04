---
name: Merchant signature contract
description: How merchant rename/aliasing keys are derived and scoped.
---

`merchantSignature(raw)` (artifacts/api-server/src/lib/merchantNameExtract.ts) is the
cross-month-STABLE key used by the "Merchant rename & learn" feature. Rows that differ only by
volatile trailing tokens (ORIG/IND/WEB/PPD/CCD IDs, trace/transaction #, dates, SEC codes, long
digit runs) must collapse to the SAME signature so one rename sticks for all current+future rows.

**Why:** A user renames a merchant once and expects every same-payee transaction (and future
ones) to follow. Drift between client and server signature derivation would silently scatter
aliases.

**How to apply:**
- The SERVER owns signature derivation. Endpoints take a raw `description` and compute the
  signature themselves — never accept a client-computed signature for writes.
- Aliases live in `merchant_aliases`, household-scoped, unique on `(householdId, signature)`.
- Read precedence in the transactions list: `displayName = aliasBySignature(sig) ?? cleanMerchant(description)`.
- `DELETE /transactions/merchant-alias` (fixed path) must stay declared BEFORE
  `DELETE /transactions/:id` or Express's parameterized route shadows it.
