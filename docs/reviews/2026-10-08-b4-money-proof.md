# B4 — the complete Amex + checking scenario, proven on identical fixtures

Branch `restore/b4-money-proof` · base `origin/main` `070ebb1c` · test DB `h2budget_test_b4` · no migration.

**No source file changed.** Two files are added: the scenario test
`artifacts/api-server/src/__tests__/amexCheckingScenario.integration.test.ts` and its table
`artifacts/api-server/src/__tests__/_fixtures/amexCheckingScenario.ts`. The scenario found **three differences**
(D1–D3 below). Per the money law, none is fixed here. Each is pinned at the value the app reports today and listed
as an `it.todo` with the contract's value.

## The household

- **Chase checking ••1234** (institution "Chase"). Bank snapshot $2,500.00 at Sun 10/4 08:00 CT; cash buffer $500.
- **American Express ••1005** ("Platinum Card", weekly cadence).
- **Weekly cap:** an `allowance_plans` row for $300.
- **Weekly hook:** `everydayHooks.weekly` points at the Weekly Spend bill, as 0042 writes it. This puts the card payoff on the curve.
- **One income plan:** Paycheck, $2,000 on the 16th (Fri 10/16 is payday).
- **Amex debt with an anchor:**
  - A debts row named "American Express": $500.00 owed of a $1,000.00 original. `settings.amexAnchor` is also $500.00.
  - The card's history is one $500.00 August charge, so the anchor the sync recomputes starts where the debt does.
  - The debt is **named, not linked** (no `plaid_account_id`). A linked card leaves the payoff band (`amexAnchor.ts:457`, `bandCards`), and then its charges would never reach the forecast. See Q1.

## How each step is driven

These are the product's own paths. Raw inserts are used only for the starting state above.

- **Plaid rows:** the real `syncPlaidItem`, with a stubbed Plaid client. Syncs are webhook-driven, so no balance re-read happens. Plaid's sign convention is used.
- **Hand filing:** the real `PATCH /transactions/:id`.
- **Reads:** every figure is read back through the real routes:
  - `GET /transactions`, `/plaid/items`, `/transactions/ledger`, `/transactions/balances`
  - `/amex/anchor`, `/amex/weekly-payoff`
  - `/spine`, `/money/position`, `/forecast`, `/forecast/cash-signal`
  - `/categorization/review`
- **Checked at every step:**
  - `spine.position` equals `/money/position`.
  - `spine.debt` has exactly the five non-balance keys.
  - `/forecast`'s `cashSignal` deep-equals `/forecast/cash-signal`.
  - The Chase register's `balanceToday` equals the spine's cash.

**Account fields on `GET /transactions` today:** `plaidAccountId` (the external id), `source` (`plaid:chase` / `plaid:amex`), `pending` and `categoryLockedByUser`. There is **no** `institutionName`, `mask` or `accountName` (asserted). The client gets "Chase ••1234" / "American Express ••1005" by joining `plaidAccountId` to `GET /plaid/items` → `accounts[].accountId/mask` and `institutionName`, as the test does.

## Steps — expected (contract) → observed

| Step (CT) | Event | Expected | Observed |
|---|---|---|---|
| S0 Sun 10/4 12:00 | none | cash 2,500.00 · spent wk/mo 0.00 · remaining 300.00 · payoff Sat 10/10 −300.00 · curve 10/10 2,200.00, 10/16 4,200.00 · lowest 2,200.00 @10/10 · available 1,700.00 · safe 300.00 · Amex 500.00 (debt) · % paid 50.000 | = |
| S1 Mon 10/5 12:00 | Amex KROGER #442 $86.33 **pending** | spent 86.33 · remaining 213.67 · payoff holds −300.00 (86.33 charged + 213.67 left) · Amex page 0.00 (charge not filed) · **Amex 586.33 · % paid 41.367** | = except **Amex 500.00 · 50.000 (D3)** |
| S2 Mon 10/5 15:00 | Chase KROGER #442 $42.10 posted | cash 2,457.90 · register 1 row, out 42.10 · spent 128.43 · remaining 171.57 · payoff −257.90 (86.33 + 171.57) · curve 10/10 still 2,200.00 · review count 1 | = (D3 as S1) |
| S3a Tue 10/6 12:00 | PATCH the pending Amex row → Groceries | locked, not provisional · Amex page 86.33 (1 charge) · no other figure moves | = (D3) |
| S3b Wed 10/7 12:00 | Amex posts: new id, `pending_transaction_id`, dated 10/6 | the same row re-keyed · Groceries and the lock kept · old id gone · 3 rows, nothing moves | = (D3) |
| S4 Thu 10/8 12:00 | Amex KROGER #442 REFUND $20.00 | not filed · **queued as a refund** · **spent 108.43 · remaining 191.57 · safe 191.57 · Amex page 66.33** · payoff −257.90 (66.33 + 191.57) · **Amex 566.33 · 43.367** | not filed ✓ · payoff −257.90 ✓ · **queue empty (D2)** · **spent 128.43 · remaining 171.57 · safe 171.57 · Amex page 86.33 (D1)** · **Amex 500.00 · 50.000 (D3)** |
| S5 Mon 10/12 12:00 | Chase −$100.00 "AMERICAN EXPRESS ACH PMT"; Amex +$100.00 "ONLINE PAYMENT - THANK YOU" | cash 2,357.90 · register out 142.10 · spent this week 0.00 · month unchanged · the closed week's payoff (**−66.33**) paid by the $100 → off the curve · next payoff −300.00 on 10/17 · curve 10/16 4,357.90 · lowest 2,357.90 @10/12 · available 1,857.90 · safe 300.00 · Chase payment queued "card payment" · **Amex 466.33 · 53.367** | = except **closed-week payoff −86.33 (D1)** (still paid, so the curve is unchanged) · **month 128.43 (D1)** · **Amex 500.00 · 50.000 (D3)** |

`debt.paidDownMtd`, `confirmedPaymentsMtd` and `newChargesMtd` read 0.00, and `nextMilestone` reads null, at every step. That is expected: see the third point under "Intentional differences" and Q1.

### What the steps prove

1. **No double count of a purchase and its card payment.**
   - The Amex charge moves money from "left" to "charged": the payoff holds at S1.
   - The checking charge shrinks the payoff by exactly its debit: 300.00 → 257.90 at S2.
   - The $100 payment counts once, in cash today. It pays the closed week (`overdueAssumedPaid`), so that payoff leaves the curve.
   - The forecast carries no other expense event, so no purchase or payment ever appears as a second expense.
   - The payment is not spending: this week's spend is 0.00, the month's is unchanged, and the Chase row is classed as a card payment.
2. **Pending → posted keeps the category.** S3b re-keys the same row. The category and `category_locked_by_user` are kept, nothing is counted twice, and every figure is identical to S3a.
3. **The register, the spine and the forecast agree.** At every step: Chase `balanceToday` = spine cash = `cash-signal.bankToday`, and the end-of-day balances step 2,500.00 → 2,457.90 → 2,357.90.

### Intentional differences (by design, explained)

- **The Amex page reads 0.00 at S1 and S2 while spend and the payoff count $86.33.** The page counts filed charges only (`isRealSpend`, the M9 rule in the PR-B2 note). The payoff counts every charge, filed or not (`allCoverages`).
- **The pending charge counts at S1.** It is owed, it is household spending, and it is in the payoff. Posting moves nothing (S3b).
- **The `debt.*` flows read 0.00.** A card that is a debt only by name has no `debtId` on its rows, and `newChargesThisMonth` reads Plaid rows only on a debt-linked account (`debtPlan.ts:318`). The payment pays the weekly hook, not a `debt:` plan item, so it is not a confirmed debt payment. `payoffPct` is meant to move through the anchored balance instead (blocked by D3).
- **Timing of the payment.** The payment is dated Mon 10/12, after the week closed. That is the contract's evidence window: from the Saturday occurrence up to the next one. A payment made *before* the Saturday would leave the open week's payoff on the curve beside the debit, reading low until Review confirms it. This is residual 2 of the PR-B2 note; this test does not exercise it.

## Differences

### D1 — a refund does not net

**Expected (the reviewer's rule).** The $20.00 refund nets the $86.33 charge:

| Figure | Expected | Observed |
|---|---|---|
| Spend this week (S4) | 108.43 | 128.43 |
| Spend this month (S4, S5) | 108.43 | 128.43 |
| Allowance left / safe to spend (S4) | 191.57 | 171.57 |
| Needs classification (S4) | 108.43 | 128.43 |
| Amex page `weekCharges` / `combinedWeekCharges` | 66.33 | 86.33 |
| Closed week's payoff (S5) | −66.33 | −86.33 |

**Why.**
- `classifyOutflow` returns `not_outflow` for any inflow (`spendingRule.ts:533`).
- `buildSpendingFacts` then ignores it deliberately (`spendingFacts.ts:306`).
- `computeWeeklyPayoff` counts only outflows (`amexAnchor.ts:402`).
- `classifyMovement` files it `excluded` (`householdMoney.ts:207`).

**Effect.** The figures read $20.00 low, never high: low-never-high holds. The open week's payoff is unchanged either way (257.90). The S5 payment still pays the week because $100 ≥ $86.33.

### D2 — the refund is not queued

**Expected:** a `refund` decision in the review queue that suggests Groceries and points back to the Kroger charge.

**Observed:** no decision is made, so the queue is empty. The row stays uncategorized and is handed to the model stage.

**Why.** `heuristicStage` → `findRefundOf` (`stages/heuristic.ts:24`) looks up outflows by `merchantSignature`. "KROGER #442 REFUND" gives the signature `kroger refund`, but the charge's signature is `kroger`. The stage then returns null for an inflow (`:55`). The part of the rule that says "not auto-filed as groceries" holds.

### D3 — the Amex anchor never moves after a Plaid sync

| | Amex ending balance (`/amex/anchor`, source `debt`) | `spine.debt.payoffPct` |
|---|---|---|
| Expected | 586.33 → 566.33 → 466.33 | 41.367 → 43.367 → 53.367 |
| Observed | 500.00 at every step | 50.000 at every step |

**Why.** `refreshAmexAnchor` (`amexAnchor.ts:131`) runs `debts.plaid_account_id::text = ANY(${amexPlaidAccountIds})`. Drizzle expands the JS array into `ANY(($2))`, and Postgres answers `malformed array literal`. This was reproduced directly against the test DB.

**Effect.**
- The query fails whenever any Amex row carries a `plaid_account_id`, which is every Plaid-synced row.
- The sync swallows the error (`plaidSync.ts:2117`, and `:2479` on backfill). So `settings.amexAnchor` and the auto-anchored debt balance never update from a Plaid sync.
- The existing `amexAnchor.integration` tests insert Amex rows without `plaid_account_id`, so they never reach this branch.
- Even when it runs, that comparison sets the internal uuid against the external Plaid id, so it could never match. The name fallback is what finds the debt.
- In production, a card with a Plaid liability balance shows the `plaid` source on the Amex page. But `payoffPct` reads the debt row, which stays frozen.

## Questions for the owner

1. **A card as a debt.** A pay-in-full card on the weekly hook can be a debt only by name.
   - If it is linked, the card leaves the payoff band and its charges leave the forecast.
   - If it is not linked, the `debt.*` flows never see its charges or payments.
   - Which one is intended?
2. **D1.** Should a refund net spend, the allowance and the card's charges? The code says no on purpose today.
3. **D2.** Should the refund signature drop "REFUND"/"RETURN"/"CREDIT"? Should an inflow with no linked charge be queued anyway?
4. **D3.** This needs a fix package: the `ANY(...)` binding, and the uuid-vs-external-id comparison.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | exit 0 |
| The new file alone | 7 passed, 3 todo (D1–D3) |
| Full API suite (serial, `h2budget_test_b4`, `CI=true`, `JOBS_MODE=off`) | 231 files · 2,499 passed · 0 failed · 5 todo (2 existing + 3 new) · exit 0 |
| Golden (`forecastLedger.golden`) under `CI=true` | 12 / 12. Snapshot untouched: no source changed, no file written |
| `pnpm audit --prod` | exit 0: 1 high, which is the repo's existing ignore |
