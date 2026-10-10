# WP8b — batch-2 review fixes: split parts name their charge, any card runs on its own balance, the trend read's cap

Branch `fin/wp8b-review-fixes`, from `origin/fin/integration` e5501abb. Lane 4. Three findings from the batch-2 review of WP8. Not merged. Not deployed.

- **Implemented:** all three findings.
- **Tested:** API integration (new and extended), web component tests on the real account page, full gates, the harness on `normal+cards` and `missing` (after only).
- **Deployed / enabled:** no / nothing.

## 1. MAJOR — Split failed for a charge whose card connection was removed
**Root cause (e5501abb)**
- `split-transaction-dialog.tsx:128-129` sent the charge's `plaidAccountId`.
- `routes/transactions.ts:226-230` accepted it only if that id was still in `plaid_accounts`.
- `DELETE /plaid/items` deletes the account rows and keeps the transactions with their id; a dedupe that drops a re-linked twin does the same.
- So Split answered 400 `invalid_plaid_account` and "Couldn't split". On main it worked (as a manual row on checking).

**Fix**
- Spec: `CreateTransactionInput.splitOf` (nullable, max 64). Codegen CI-style; re-run is clean.
- `POST /transactions` with `splitOf`: the part takes the PARENT's `source` and `plaidAccountId`. The body's `source`/`plaidAccountId` are ignored. Not a household transaction (unknown, malformed, another household's): 400 `invalid_split_parent`, nothing written.
- A bare `plaidAccountId` (an older client) is also accepted when it is on one of the household's own transactions. Another household's id stays refused, even when their rows carry it.
- The dialog sends `splitOf: tx.id` and no source or account of its own.
- ⚠️ **Behaviour change:** a part of a statement-imported card row (`source "amex"`, no Plaid account) now keeps `amex`. It stays off the checking ledger, the same bug WP8 fixed for Plaid card rows. Under WP8 it became a manual checking row.
- No stored row changes.

**Tests** (`forecastNoDoubleCount.integration.test.ts`, new describe "WP8b")
- A charge on an account id that exists only on its rows: the part is `plaid:amex` on that id, `plaidTransactionId` null, and cash does not move. A WP8-style body naming that id is a 201 too.
- A statement row's part keeps `amex` (cash unchanged). A checking manual row's part stays manual (cash −35.00), even when the body names a card.
- `splitOf` random uuid / `not-a-uuid` / another household's row: 400 `invalid_split_parent`, the row count is unchanged.
- The other-household test now also gives that household a row carrying the id: still 400.
- Dialog: `splitOf` is sent, and no `source` or `plaidAccountId`.
- **Fails before:** the old route fails all 3 new tests. Dropping only the transactions check fails the WP8-style 201.

## 2. MAJOR — A non-Amex card's page ran "bal" and its chart up from $0
**Root cause (e5501abb)**
- `routes/amex.ts:121-129`: the per-card `GET /amex/anchor?accountId=` answered `missing` for any card outside the Amex set.
- `pages/amex.tsx:1005-1015` (tier 3) then anchored at $0 "Calculated".
- WP7c lists any card's rows, so a Chase Freedom showed "bal $0.00…" and a chart from $0, while its Summary showed $1,215.40.
- Also `routes/amex.ts:369-401`: a per-card answer could be a running sum of the card's rows from $0 (`computed`).

**Fix**
- **Server.** A per-card request takes any credit card of the household (`type = 'credit'`), Amex or not. It answers in this order:
  - Plaid's stored liability balance (`plaid`), the same column `GET /plaid/liability-accounts` serves;
  - the card's debt row (`debt`);
  - else `missing`.
  It never answers the saved combined anchor or `computed` per card. The combined answer is unchanged (Delta stays out of it; on its own page it reads its own figure).
- **Page.** A selected card runs on the card model's `creditorCurrent` (`cardOwedView`), with the Summary's inputs:
  - the card's debt row;
  - Plaid's figure from the per-card answer, when `needsLiability(debt)`.
  The debt row's established as-of is kept, so no figure moves for a card anchored on an active debt row.
  - ⚠️ An archived debt row that Plaid keeps current (`balanceSource "plaid"`) now reads Plaid's own figure when there is one, as the Summary does; it used to read the row's balance. The fixture has no such row.
- **No figure:** anchor null. That means no per-row "bal", no chart (`buildBalanceWindow` returns null and the chart renders nothing), and the pane says "No running balance or chart: this card has not reported a current balance yet."
  - A failed read says "The card's balance did not load, so there is no running balance or chart."
  - It waits for the debts read, so no other figure flashes first.
- **Plaid-anchored cards** get the WP3 note too: "Running balances start from the card's current balance, $X as of <day>."
- **Tests:**
  - `amexAnchorPerCard.integration.test.ts` (6): Freedom → plaid 512.34; Sapphire (debt row only) → debt 1450; Citi and Amex Blue with rows but no figure → missing; Platinum and Delta → their own Plaid figures; checking and an unknown id → missing; combined → 3842.98 (no Freedom, no Delta). The old route fails 4 of the 6.
  - `pages/next/accountCardAnchor.test.tsx` runs the real account page and embedded ledger on the fake household:
    - Freedom with a figure: Summary $512.34, rows "bal $512.34" / "bal $527.16", chart drawn, note.
    - Citi with none: no "bal", no chart, the words, no $0.00 in the Summary.
    - The old page fails both.

## 3. MINOR — the trend read's `limit: 5000` (CLAUDE.md §2)
- **Kept, justified in a comment (`TREND_LIMIT`, `amex.tsx`).**
  - The forward chart and the roll-forward to the selected month need EVERY row of the window, and no server aggregate of a card's balance by week exists.
  - The read is bounded by `from`/`to` and is not a list: no screen lists these rows.
  - Splitting it into monthly reads would fan every edit out to 12+ refetches, and would mean rewriting the 8 Amex test mocks that key on the trend's limit. A per-week net aggregate on the server is the follow-up that retires it.
- **Cap disclosed:**
  - When the read comes back full: "Only the most recent 5,000 rows feed the chart and earlier months' running balances."
  - The month list's existing `monthCapHit` was computed but never shown. It now says "Showing the most recent 1,000 rows of this month."
- Test: 5,000 earlier Freedom rows bring up the trend line; the month line stays off.

## Figures that move (fixture; "after" captured with the harness, "before" from the old code path on the same seed)
| Page | Before | After | Why |
|---|---|---|---|
| `normal+cards` Freedom ••4417 rows | bal $0.00 / $14.82 | **bal $1,215.40 / $1,230.22** | Anchors on the card's Plaid figure (= Summary) |
| `normal+cards` Freedom chart | from a $0 "Calculated" anchor | from $1,215.40 | Same |
| `normal+cards` Quicksilver ••3321 rows | bal $0.00 / $38.50 | **bal $842.66 / $881.16** | Same |
| `missing` Platinum ••1005 rows (week) | bal −$444.80 / −$132.40 (per-card `computed`) | **no bal** + words | No Plaid figure, no debt row: never a sum from $0 |
| `missing` Platinum chart | from −$444.80 | **none** | Same |
| `missing+archived` Platinum rows | bal from the archived row's $0.00 | **no bal** + words | The card model has no current balance for an archived manual row (the Summary shows —) |
| Blue, Platinum (`normal`) | bal $684.12… / $2,340.55… | unchanged | Same Plaid figure; a note now names it |
- Every other figure is unchanged: the all-cards view, debt-anchored cards (`fields`, `pending`, `zero`) and the forecast. Item 1 changes no stored row and no fixture figure. Item 3 only adds words when a cap is reached, which never happens on the fixture.

## Gates
- Root typecheck ✓.
- Web suite 217 files / 2,065 tests (UTC) and 2,066 (Chicago) ✓.
- API suite 253 files / 2,739 tests ✓.
- Build ✓. Landing JS 620.3 KB (cap 622) ✓.
- `pnpm audit --prod`: 1 high, ignored (as base).

## Unverified / for the lead
- "Before" fixture figures are derived from the old code on the fixture seed, not captured.
- Seen and not fixed (out of scope): on `missing`, the card band shows Platinum "$0.00 Card's current balance" (from `/amex/weekly-payoff`) while the Summary shows —. That is a missing figure printed as $0.
- The split path was not exercised in a browser.
