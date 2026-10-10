# WP4 (labels half) — the debt tile names its scope and the cards it leaves out (lane 2)

Branch `fin/wp4-debt-labels`, from `origin/fin/integration` a1d2b4ff. Not merged. Not deployed. Nothing enabled.

## What changed
- **One population:** `remainingDebtTotal` / `remainingDebtScope` use `inPayoffPopulation` (active and anchored, `@workspace/avalanche-core/pendingDebt`), the rule % paid uses. GET /debts anchors every debt it returns, so only an active debt anchored at $0.00 leaves "$ left". % paid already left it out.
- **Debt tile (`SummaryRow` DebtCell):** "$X left on your payoff plan (A and B)". An off-plan line follows, linked to /avalanche: "<card> is paid in full weekly, not on the plan · Put it on the plan".
  - "Paid in full weekly" appears only when the weekly payoff bills every named card weekly (`useAmexQ`).
  - (WP3b correction) The weekly payoff is NOT already on the landing: it is one extra, bounded request (the Amex page's key), asked only when a card is off the plan. The cards, debts and Plaid figures are the landing's own reads.
  - Several cards share one sentence ("are … · Put them on the plan").
  - The line waits for Plaid's figures and the payoff (no late rewording).
- **`lib/debtBalance.ts`:** `offPlanCards` covers cards with no debt row or an archived one, using the card model. A $0.00 card is left out and an unknown balance is kept. It also has `offPlanWords`, and `joinNames` moved here.
- **Accounts row:** an off-plan or archived row ends with "· Add to the plan" → /avalanche.
- **"Rows add up":** the code comment went in WP3. The 2026-10-09 note gets a "superseded" line.
- **Bundle:** the pure Plaid re-auth helpers moved verbatim to `lib/plaidReauth.ts` (re-exported), so the Plaid Link button left the entry chunk.

## Figures that move (fixture)
- offplan: "$25,384.12 left across HELOC, Upstart personal loan and American Express ••1001" → "$25,384.12 left on your payoff plan (…)" + "American Express Platinum Card® ••1005 is paid in full weekly, not on the plan · Put it on the plan".
- archived: + "American Express Blue Cash Preferred® ••1001 and American Express Platinum Card® ••1005 are not on the plan · Put them on the plan".
- No amount moves.

## Gates (this branch)
- `pnpm run build`: clean.
- Web: UTC 1,982 / Chicago 1,983 passed.
- Entry graph: **619,191 B** (base 620,249).
- Audit: unchanged.
- Shots `l2-shots/wp4-after/{offplan,archived}`: 0 errors.
- API untouched.

## Unverified
- The card name comes from its Plaid identity ("American Express Platinum Card® ••1005"), not "Amex Platinum".
- CLAUDE.md §1's example still reads "left across".
