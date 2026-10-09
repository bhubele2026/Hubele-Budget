# WP7a — one account's rows, and a ledger for any bank account (API)

Branch `fin/wp7a-ledger-scope`, from `origin/main` 8b869e79. Lane 4 of the financial-consistency build (plan `ancient-swimming-book.md`, root cause 9, WP7 "API"). Not merged. Not deployed.

- **Implemented:** the two server changes below, the spec, the generated clients.
- **Tested:** API integration tests (new + extended), web suite in both time zones (no web code changed), build, entry graph, audit.
- **Deployed / enabled:** no / nothing.
- **Owner's OK used:** "any checking/savings account opens its own ledger" (2026-10-09).

## What changed

### 1. `GET /transactions?plaidAccountId=<external account_id>`
- `lib/api-spec/openapi.yaml` (listTransactions): new optional query `plaidAccountId`, `maxLength: 128`. CI-style codegen; `git status` clean after a re-run.
- `artifacts/api-server/src/routes/transactions.ts` (GET handler): one more condition beside the existing filters.
  - Exact match on `transactions.plaid_account_id`, inside the caller's household (the household condition is always first).
  - A row with no Plaid account (null, or `''`, which the sync and the ledger treat as none) never matches. An empty value matches nothing (`sql\`false\``), never every row.
  - A NUL byte is a 400 (Postgres refuses NUL in text, which was a 500). Over 128 characters is a 400 from the generated schema.
- Nothing calls it yet. WP7c points the embedded card view at it.

### 2. Any depository account opens its own ledger
- `artifacts/api-server/src/lib/bankLedger.ts`: `isChaseDepository` → `isDepository`. The kind test is unchanged (`subtype` checking or savings, or `type` depository, the same kinds `listCheckingAccounts` lists); the institution-name test (`includes("chase")`) is gone.
- Such an account lists its own rows and its mask twins' rows with `snapshotAccount: false`: every balance null, `balanceUnavailableReason: "not_snapshot_account"`, no manual rows, no cash-signal call. Unchanged from PR14 except for who qualifies.
- Still refused with 400 `account_not_ledger`: cards (`credit`), loans (`loan`), another household's account. A non-uuid is still `invalid_account`.
- The refusal message now says "not a checking or savings account of this household" (no client reads the message; clients read `code`).
- Spec description of the ledger's `account` parameter updated to match.

## Root cause (current tree, before this branch)
- `bankLedger.ts:320-329`: a depository account counted only when its institution's name contained "chase"; `:390-393` refused everything else.
- The account page embeds the Chase ledger for ANY checking account (`pages/next/Accounts.tsx:119-141`). For a credit-union checking account the server refused it, and the page fell back to the default account: the client's Chase-only filter (`pages/transactions.tsx:252-261`), its self-heal (`:418-441`) and its reset on refusal (`:571-577`). Result: the main Chase ledger and balances under the credit union's title. WP7c removes the client half when embedded.
- The card half: the embedded Amex page asks by the Amex source list (`pages/amex.tsx:129`, `:372-403`) and filters to the card in the browser (`:260-270`). A Chase Freedom (`source: "plaid:chase"`) is not in that list, so its page was empty. The new parameter lets WP7c ask for exactly the card's rows.

## Behaviour that changes (server)
| Request | Before | After |
|---|---|---|
| `/transactions/ledger?account=<credit-union checking>` | 400 `account_not_ledger` | 200: its rows + twins', balances null, `not_snapshot_account` |
| same for an Ally (non-Chase) savings account | 400 | 200, same shape |
| same for a PayPal account (Plaid `type: depository`, `subtype: paypal`) | 400 | 200, same shape. ⚠️ A consequence of "any depository": PayPal is offered by `listCheckingAccounts` already, so picker and server now agree. Restricting to checking/savings subtypes is a one-line change if the owner prefers |
| a card or a loan, at any bank | 400 | 400 (unchanged) |
| the snapshot's account (no `account`, or its id, or its twin's) | — | byte-identical (tested) |
| `/transactions?plaidAccountId=…` | parameter ignored (whole window) | that account's rows only |

## Figures that move on screen (fixture)
- **None.** This branch changes no web code. The fixture's depository accounts are Chase (checking ••5526, savings ••8801), which were already accepted, and the web app keeps its Chase-only client filter until WP7c. The generated `ListTransactionsParams` type gains an optional field; no caller passes it.
- No shots taken for this package for that reason.

## Tests
- **New** `api-server/src/__tests__/transactionsPlaidAccountFilter.integration.test.ts` (9): exact match (charges + refund, nothing else of the household); another card's id; look-alike ids (a longer id starting with it, the same id upper-cased, a prefix) never cross; empty value and unknown id list nothing; AND with range, source, amount, limit; the other household on the same id string sees only its own row and the owner never sees it; NUL and 129 characters are 400, 128 is allowed; stored rows untouched.
- **Extended** `ledgerOtherAccount.integration.test.ts` (10 → 12):
  - a credit union's checking account and its twin (institution name in another case): exactly their rows newest first; absence of every manual, A, B, PayPal, card, savings and loan row; twin row `not_bank`; totals by hand (1,200.00 in, 82.10 out); balances null; picked through the twin gives the same rows; `/transactions/balances` all null; no cash-signal call;
  - an Ally savings account: its one row;
  - the credit union's card (same institution and mask as the checking account, never its twin) and a loan: 400 on ledger, balances and bulk review; nothing written;
  - bulk review on the credit union's account: its posted rows and its twin's, never the pending one;
  - **the snapshot's account answers byte for byte as before** (raw `/transactions/ledger?limit=100` and `/transactions/balances` bodies, and the spine's bank balance) after adding the accounts, after reading them, after the bulk review, and after removing them;
  - PayPal moves from the refused list to its own accepted case.
- **Fails before:** with the old predicate the PayPal case and the credit-union case fail; with `eq` on an empty value the empty-id case fails (mutations run and reverted).
- `e2e/transactions-chase-account-stale.spec.ts`: its "not a ledger account" pick was an Ally savings account, which is a ledger account now; it uses an Ally credit card. (E2E needs Clerk keys; not run.)

## Gates (on d5967403; this note is the only later change)
- root `pnpm run typecheck`: clean.
- web vitest: UTC 1,871 passed / 3 skipped; America/Chicago 1,872 passed / 2 skipped (205 files). Same counts as main: no web code changed.
- API suite on `h2budget_test_fin_4`: 239 files, 2,586 passed, 2 todo.
- CI-style codegen re-run: `git status` clean.
- `pnpm run build` + `check-entry-graph`: OK, landing **621.8 KB** of 622 KB (unchanged).
- `pnpm audit --prod`: exit 0; 1 high, the already-ignored one.

## Unverified
- Real households: whether Brad has a non-Chase depository account or a PayPal link (read-only `/api/plaid/items` would say). If none, nothing changes for him until WP7c.
- E2E (Clerk keys).
