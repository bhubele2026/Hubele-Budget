# PR-D — the Budget page counts a pending purchase once

- **Base:** `main` = `df2adda`.
- **Branch:** `fix/budget-pending-once`.
- **Round 1:** `c35b3701`.
- **Round 2:** answers the PR-D review (REQUEST CHANGES: H1, M2, M3, L4, L5, NIT6). See **Review round 2**.
- **Merge:** `origin/main` at `1a0c1f71` (PR-A, deploy-safe category passes) merged in with no rebase.
  - The conflicts were imports only in `routes/budget.ts`: main's `gte` and `logger` imports were kept beside PR-D's.
  - Every gate below ran on the merged tree.
- **Owner decision 6:** "Budget should count pending purchases consistently with Spending: once. Show posted spending,
  pending spending, combined spending so far. Pending purchases consume available budget. When they post, replace the
  pending version and adjust for the final amount. Example: a $40 pending restaurant charge posts at $48 → spending
  becomes $48, not $88. Budget and Spending must use the same inclusion rules."
- **Owner decision 14 (applied in round 2):** reviewed and filing metadata carries to the posted replacement.

## The problem

`GET /budget/months/:m` summed rows in SQL. A pending row and the separate posted row that replaced it both counted:
- in each category's `actualAmount` and its `sourceBreakdown`;
- in the allowance card's sums.

PR7b fixed Spending and pinned the Budget page's gap as a KNOWN RESIDUAL (review M2): June "Eating out" read 134.40 on
the Budget page and 69.40 on Spending.

## What changed

**Pairing — `lib/supersededPending.ts`.**
- **Pairs, not just ids.** Every loader returns `replacedIds` and `replacedBy`: posted row id → the pending row it
  replaced, with that row's filing.
- **`findSupersededPendingForRange(household, from, to, reader?)`.** For every row dated in the range, it gives exactly
  the whole-ledger answer, reading only a window before the range.
  - **Skip:** no pending row dated in [from − 7, to] means no query and no pairing.
  - **Otherwise, one candidate read** for posted rows dated [from − 32, to + 8].
  - **Per Plaid account, a cut:** the latest day ≤ from − 7 that no pair `canSupersede` accepts crosses (pending before
    the cut, posted on or after it). Candidates from that cut onward are paired.
  - **Fallback:** the lookback doubles while some account has no clean day (up to 1024 days), then it answers from the
    whole ledger.
  - **Why it is exact:** accepted pairs span 0–7 days within one account, so an uncrossed day splits that account's
    pairing into independent halves. Posted rows after to + 7 cannot take a pending row in the range, and they pick
    after every posted row in it.
- **`findSupersededPending` (whole ledger)** is unchanged in answer. Habits and the Amex payoff still use it.
- **Readers take an optional transaction.**

**Filing — `lib/pendingFiling.ts effectiveFiling` (new, pure).** A posted row that replaced a pending row counts with
the pending row's filing wherever it lacks its own, following dedupe's `mergeStatePatch` (fill blanks, never
overwrite):
- **`categoryId`:** only when the posted row has none or sits in the system Uncategorized, and the pending row's is a
  real category;
- **the three allowance flags plus `weeklyBucket`:** only when the posted row has none of the three flags (its own
  bucket kept if set);
- **`reimbursable`:** true when either is;
- **`debtId`:** filled when the posted row has none.

Read time only: nothing is written (PR-I writes it at sync).

**Budget month — `routes/budget.ts` + `lib/budgetActuals.ts` (new, pure).**
- **One snapshot.** The pending-in-reach check, the pairing and the month's rows are read in one REPEATABLE READ,
  read-only transaction.
- **One pass over the month's rows** builds both the category actuals and the allowance's aggregate rows:
  - replaced pending rows skipped;
  - `effectiveFiling` applied;
  - the same spend/inflow arithmetic as the two SQL SUMs it replaces, in whole cents;
  - category actuals skip transfers only; the allowance applies `isCountableSpend` and unplanned > monthly > weekly.
- **The SQL could not stay.** A posted row's category now depends on another row's filing.
- **Per line:** `actualAmount` = posted + pending, and `sourceBreakdown` merges both halves per source. The allowance
  split flows through `buildAllowanceRollup`.

**Spending — `lib/spendingFacts.ts`.**
- Reads `findSupersededPendingForRange` for its own range (the spine reads one range covering both windows).
- Every row is classified on its effective filing, from the same helper. Budget and Spending file a bare posted row
  alike.

**API (additive; spec + codegen, generated `src` and `dist` committed).**
- `BudgetLineWithActual`: `postedAmount`, `pendingAmount`, `combinedAmount` (= `actualAmount`).
- `BudgetAllowanceLine` and `BudgetAllowanceRollup`: `posted`, `pending`, `combined` (= `actual`).
- `BudgetMonthDetail.replacedPendingIds`: pending rows in the month a posted row replaced.
- `BudgetMonthDetail.inheritedCategories`: posted rows counted under a category they do not store.

**Web (Budget page, lazy route).**
- **Row:** "incl. $40.00 pending" in the strip below the figures, when pending > 0.
- **Popover:**
  - "Posted $X · Pending $Y" when pending > 0;
  - a pending row reads "· pending";
  - drops `replacedPendingIds`;
  - lists a bare posted row under its `inheritedCategories` category;
  - uses both only when the response's `monthStart` is the month on screen (L5).
- **Allowance card:** "incl. $X pending" in the head and under a bucket.
- **Foot copy:** a pending purchase counts once, at its final amount when it posts.

## Figures that move (before = `df2adda`)

Live, only where a pending row was replaced by a posted row (PR4c pairing: same account, posted within 7 days,
|pending| ≤ |posted| ≤ 1.30 × |pending| + $1, created later).

- **The replaced pending half leaves every total:**
  - category `actualAmount`;
  - `groups[].actualTotal`;
  - `summary.*.actual`;
  - `planBySource.*.actual` and `actualTotal` ("Spent so far", Income "in so far");
  - `sourceBreakdown`;
  - allowance per bucket, slices and total (the plan strip's allowance figure).
- **⚠️ A bare posted row now counts where its pending row was filed.**
  - On `df2adda` its amount counted in the posted row's own (empty) place, plus the pending half in the filed place.
  - Round 1 (`c35b3701`) dropped the charge from the filed envelope entirely (review H1).
  - Now: Eating out 48, weekly 48; on Spending, Eating out 48 and Uncategorized 0.
- **⚠️ When the two halves are filed differently, the posted row's own filing wins, and the WHOLE charge moves (review
  M2).** An envelope can lose a charge entirely while another gains it:
  - pending in Dining, posted in Groceries → Dining 40 → 0, Groceries +48;
  - pending unplanned, posted weekly → unplanned −40, weekly +48.
- **⚠️ Spending's totals move too** where the pending half was filed into something Spending excludes. Categories move
  from Uncategorized to the inherited one otherwise. The posted row inherits:
  - `reimbursable` (pinned: household spend 48 → 0, `excluded.reimbursable` +48);
  - a `debtId`;
  - an excluded, income or debt-linked category.
- **⚠️ A month's figure can fall after the month ends.** A pending charge on the 30th that posts on the 1st counts in the
  month it posted only. Spending already does this.
- **Income:** a replaced pending deposit no longer counts twice.

**Tests, measured (after = this head):**

| Case | `df2adda` | After |
|---|---|---|
| $40 pending then $48 posted, both filed (July) — category actual | 88.00 | **48.00** (posted 48 / pending 0) |
| The same, before it posts | 40.00 | **40.00** (posted 0 / pending 40) |
| Pending $20 + posted $40, too large to pair | 60.00 | **60.00** (posted 40 / pending 20) |
| Pair across 9/30 → 10/01, posted bare: September / October | 40.00 / 0.00 | **0.00 / 48.00** |
| Pending + posted $500 payroll deposit — income line | 1000.00 | **500.00** |
| Allowance, both halves filed weekly, plus $15 monthly pending — weekly / total | 88.00 / 103.00 | **48.00 / 63.00** |
| **H1:** $40 pending Eating out + weekly/dining, $48 posted bare — Eating out / weekly / Spending cat / Uncategorized | 40 / 40 / 0 / 48 | **48 / 48 / 48 / 0** |
| **M2:** pending Dining, posted Groceries — Dining / Groceries | 40 / 48 | **0 / 48** |
| **M2:** pending unplanned, posted weekly — unplanned / weekly | 40 / 48 | **0 / 48** |
| Pending monthly, posted bare — monthly | 20 | **22** |
| Pending reimbursable + weekly, posted bare — weekly / Spending household spend | 0 / 48 | **0 / 0** |
| Plan-pin month: $160 pending replaced by $175, plus $30 pending — Utilities | 365.00 | **205.00** |
| June "Eating out" (PR7b residual test): Budget / Spending | 134.40 / 69.40 | **69.40 / 69.40** |

The `df2adda` column is main's rule applied to each fixture. It was measured only where a base run reached the figure
(365.00, 134.40).

**Not measured:** production. It needs a read-only production query Brad approves.

## Must not change

- **The plan.**
  - `plannedAmount` and `planSource` on every line.
  - `planBySource.{income,bills,debts,unbacked}.planned` and `lineCount`.
  - `plannedTotal` and `net`.
  - The allowance caps.
  - Pinned before and after rows land ("MUST NOT CHANGE — the plan"). `budgetPlanBySource.integration.test.ts` passes
    unchanged.
- **Rows with no pair.** Same figures: the spend/inflow arithmetic, filters and bucket precedence are the SQL's, summed
  in whole cents.
- **Untouched:** cash, the forecast, `pairPendingWithPosted`, and the whole-ledger answer of `findSupersededPending`
  (its tests pass unchanged). Nothing is written; both rows stay in the ledger (asserted).

## Budget's category actuals vs Spending's rule (`classifyOutflow`) — NOT changed here

Only the pending pair and its filing were decided. Everything below differs and is a question for the owner.

**Category actuals:**
1. **Tagged rows count.** Budget counts a `debtId`-tagged row (rule 2) and an `isExternalCardPayment` row (rule 3) in
   its category.
2. **Debt categories count.** Budget counts rows in a debt-linked category (rule 4); auto_debts lines show payments as
   their actual.
3. **Excluded category names differ.** Budget hides only `exclude_from_budget` categories (Uncategorized, Transfer,
   Ignore). "Reimbursement", "Transfers in", "Transfers out" and "Uncategorized — transfer" show an actual (rule 5).
4. **Reimbursable rows count** in their category (rule 7).
5. **No pattern rules.** PFC card payments (rule 8), card-payment patterns (rule 9) and bank-noise patterns (9b) count.
6. **Income differs.** Budget income lines include manual-Amex credits; Spending's `realIncome` counts no Amex row.

**Allowance card:** excludes rules 1, 2, 3 and 7 only.

## Verification

**Fails-before, round 1** (new tests on `df2adda`):
- **`budgetPendingOnce.integration.test.ts` (round-1 version):** 6 of 6 failed, but only 5 on a figure. ⚠️ (review L4)
  The "too large to pair" case reads 60.00 on `df2adda` too; it failed only on the missing `postedAmount` /
  `pendingAmount` fields.
- **`budgetPendingOnce.test.tsx` (web):** 4 of 5 failed.
- **The flipped PR7b test:** failed (`expected '134.40' to be '69.40'`).

**Fails-before, round 2** (on `c35b3701`):
- **`budgetPendingOnce.integration.test.ts`:** 5 of 13 fail.
  - **On a figure:** month boundary with a bare posted row (October 0.00); H1 (Eating out 0.00); flags inherited only
    when the posted row has none (monthly 0.00); reimbursable pending (household spend 48, not 0).
  - **Only on the missing `inheritedCategories` field:** the M2 category case. Its figures (0 / 48) are the same on
    `c35b3701`.
  - **Pass on `c35b3701` by design (pins, not fixes):**
    - M2 flags (unplanned 0 / weekly 48);
    - "no pairing for a month with no pending row in reach";
    - "one pairing run for a month read";
    - the five round-1 cases.
- **`supersededPendingWindow.integration.test.ts`:** 4 of 4 fail (`findSupersededPendingForRange` did not exist).
- **`pendingFiling.test.ts`:** fails to load (module did not exist).
- **`budgetPendingOnce.test.tsx` (web):** the new H1 drill case fails; 5 pass.

**After:** all pass.

**Gates (worktree root, merged tree `603fd299` = round 3 + `origin/main` 6b355065):**
- **Merge:** `origin/main` 6b355065 (PR-A2, seed defaults once) merged in with no rebase. The only conflict was the
  drizzle import in `routes/budget.ts`; main's `ne` was kept beside PR-D's imports.
- `pnpm run typecheck` green.
- Budget-related API files (16, including `seedDefaultsOnce`, `deploySafeCategoryPasses` and May 2026): 128 passed.
- Web: `TZ=UTC` 136 files, 1118 passed / 3 skipped; `TZ=America/Chicago` 136 files, 1119 passed / 2 skipped.
- Full API suite (`caffeinate -i`, own test DB, run in the foreground): 143 files, 1361 passed / 7 todo.
- `pnpm run build` + `check-entry-graph`: 574.4 KB of 580 (unchanged; the Budget page is lazy).
- Codegen re-run: byte-identical.

**Not done:** a browser check against real data (no production access).

## Performance (review M3)

**Fixture:** one household on the test Postgres; 20,000 rows over 24 months, 4 cards, 60 merchants. It holds 400
pending→posted pairs and 100 lone pending rows. The whole ledger holds 3,773 loose candidate pairs over 3,894 rows.
June is measured with a median of 7 or 9 runs. "Stale" means straight after the bulk insert; "analyzed" means after
`ANALYZE transactions`.

| Read | Stale stats | Analyzed |
|---|---|---|
| `c35b3701` month read: whole-ledger pairing | 1,072.8 ms | 214.1 ms |
| First windowed attempt (start moved back whenever a LOOSE candidate crossed it): 23 reads for June | 3,966.0 ms | 250.4 ms |
| **This head:** windowed, per-account cut on ACCEPTED pairs, 1 read, 285 candidates / 287 rows | **122.8 ms** | **7.2 ms** |
| **This head:** month with no pending row in reach (skip) | — | **0.2 ms** |
| **This head:** whole `GET /budget/months/2026-06-01` | — | **14.5 ms** |

- **The first attempt was rejected.** Loose candidates (no description test) cross almost every day, so its start
  walked back 8 days at a time. Judging crossings on pairs `canSupersede` accepts, per account, found a clean cut in the
  first read.
- **The whole route on `c35b3701` was not timed directly.** Its pairing step alone was 214 ms analyzed.
- **Where pairing now runs.** Landing → Budget reads pairing in the Budget month (current month and prefetched
  neighbours), the spine (one read for both windows) and `/reports/spending-facts`. Each is now one windowed read, or
  none.
- **Chose windowing over a per-household cache.** The windowed read is exact, so no cache and no invalidation.

## Review round 2 — one line per finding

- **H1 (bare posted row lost the charge):** fixed at read time — `effectiveFiling` in Budget category actuals, the
  allowance and `buildSpendingFacts`; H1, own-category, flags-only-when-none and reimbursable tests.
- **M2 (halves filed differently):** the posted row's own filing wins; both cases tested; stated under "Figures that
  move".
- **M3 (perf):** exact windowed pairing (per-account clean cut) + skip when no pending row is in reach; randomized
  equivalence over 44 ranges; 214 → 7.2 ms analyzed, 1,073 → 123 ms stale.
- **L4 (overstated fails-before):** corrected above.
- **L5 (drill from two caches):** the drill uses `replacedPendingIds` / `inheritedCategories` only from the response for
  the month on screen. A sync landing between the month read and the transactions read can still show a stale list;
  disclosed below.
- **NIT6 (not one snapshot):** pending check, pairing and month rows run in one REPEATABLE READ read-only transaction.
  The plan side (categories, lines, bills) is read outside it, as before.

## Review round 3

- **M1 (a rule's category on the posted row beat a hand filing on the pending row):** fixed.
  - **The rule:** the posted row's category counts as its own only when it differs from its rule category. When it
    equals its rule category and the pending row's category is not that row's rule category (a hand filing), the
    pending row's category wins.
  - **Cost:** the rules (`loadRuleCategoryCheck` = `loadUserRules` + `findMatchedRuleId`) are read only when a pair
    carries two real, different categories — at most once per Budget month read.
  - **For PR-I:** the full rule is written out in `lib/pendingFiling.ts`.
  - **Costco repro:** Auto 0 / Groceries 45 → **Auto 45 / Groceries 0**, on Budget and Spending (`df2adda`: Auto 40 +
    Groceries 45). A posted row filed by hand away from its rule keeps its own; with no rules the behaviour is
    unchanged.
- **L2 (transfer flag):** inherited — `isTransfer` is true when either row's is, as in `mergeStatePatch` (which carries
  no override flag).
  - **Zelle repro:** Spending Uncategorized 48 → **0**, `excluded.transfersTotal` +48, and the weekly allowance drops
    the row.
- **NIT3 (debt tag):** an inherited `debtId` fires rule 2 before the card-payment rules. A card payment therefore moves
  from `excluded.cardPayments` to `excluded.debtPaymentsTotal`. Real spend is 0 either way, and that bucket move is its
  only effect on Spending. The allowance card already skipped debt-tagged rows, and debt payoff reads stored tags, not
  this.
- **NIT4 (slice):** a posted row with its own weekly flag and no slice takes the pending row's slice when the pending
  row was weekly too. $40 pending weekly/dining → $48 posted weekly with no slice: misc 48 → **dining 48**.
- **Spine:** it reads its two spend windows through `buildSpendingFacts`, so when a pair needs them the rules are read
  once per window.

**Fails-before, round 3 (on `8f79df4e`):**
- **`budgetPendingOnce.integration.test.ts`:** 3 of 4 new tests fail on a figure:
  - M1 Costco (Auto 0.00);
  - L2 (Uncategorized 48);
  - NIT4 (misc 48, no dining).

  "A posted row filed by hand away from its rule keeps its own" passes on `8f79df4e`: it is a pin.
- **`pendingFiling.test.ts`:** 14 of 17 fail.
  - Most fail on the new context signature (`uncategorizedIds.has is not a function`), not on a figure.
  - The L2 and NIT4 cases fail on their assertions.
  - The figure-level proof for M1 is the integration test.

## Review round 4

The independent review of round 3 found two HIGH regressions, both reproduced on real routes.

- **H1 (rule re-read misjudges hand-vs-automatic in both directions):** round 3 decided "hand vs rule filing" by
  re-reading the household's CURRENT mapping rules. `PATCH /transactions/:id` repoints every matching rule onto
  whatever category the user just picked (routes/transactions.ts, the auto-relearn block), so by the time the check
  ran, the rule and the user's pick were often the same thing.
  - Real repro: rule COSTCO WHSE → Groceries; pending $100 and posted $110 both Groceries by rule, no overrides. PATCH
    the POSTED row to Auto → the rule gets repointed to Auto too, and round 3's rule-re-read misread the row as still
    "automatic," so Budget/Spending kept showing Groceries 110 / Auto 0 (should be Auto 110). Same wrong outcome
    PATCHing the PENDING row instead.
  - Also wrong with no PATCH at all: deleting or repointing the rule after sync changed what a stored, unchanged pair
    counted as, even though nobody touched either row.
- **H2 (auto-tagged transfer flag overrides real spending):** round 3 inherited `isTransfer` unconditionally ("true
  when either row's is"). Plaid sync auto-flags Venmo/Zelle/PayPal and PFC `TRANSFER_OUT` rows as transfers with no
  user in the loop. A pending row auto-flagged that way could carry the flag onto a posted row the household had
  filed as real spending.
  - d1: pending "VENMO *JOES PIZZA" auto-flagged transfer (no override); posted filed Dining by rule, weekly/dining
    (no override) → round 3 showed Dining 0, weekly 0, `transfersTotal` +34 instead of real spending.
  - d2: pending "VENMO *SITTER ANNA" auto-flagged transfer; the user filed the posted row Dining, explicitly
    `isTransfer: false` with `isTransferUserOverridden: true` → round 3 still showed Dining 0, spend 0,
    `transfersTotal` +60, overruling the household's own hand filing.

**The decided fix.** Stop re-reading mapping rules entirely. Use the one signal already stored on every row —
`transactions.is_transfer_user_overridden` — which is set whenever a person picks a category or sets `isTransfer`
through `PATCH /transactions/:id`, or creates a row, and is never set by Plaid sync:

- **`categoryId`**, both real and different: P (posted) keeps its own unless P is NOT overridden and Q (the replaced
  pending row) IS — i.e. only a hand filing on one side, and it's Q's, can move the category. P overridden (either
  way), or neither overridden, or only P overridden → P's own stands. This makes the outcome depend on who last
  touched which row, never on the mapping rules' current shape.
- **`isTransfer`**: inherited only when Q's flag was user-set (`isTransferUserOverridden`) AND P itself was never
  overridden either way. A posted row the user explicitly filed — transfer or not — is never re-flagged by an
  auto-tagged pending row.
- Every other field (allowance flags, `weeklyBucket`, `reimbursable`, `debtId`) is unchanged from round 3.

**Plumbing.** `Filing` gained `isTransferUserOverridden: boolean`. `supersedeCandidatesQuery` now selects
`pIsTransferUserOverridden` for the pending row and `pairCandidates` carries it into `filingById`. Posted-row readers
(`routes/budget.ts` month rows, `spendingFacts.ts` txns) now select the column too. `needsRuleCheck`,
`FilingContext.isRuleCategory` and `autoCategorize.ts`'s `loadRuleCategoryCheck` are deleted — nothing calls them
(confirmed by grep) and the household's mapping rules are no longer read anywhere in this path.

**Every setter of `isTransferUserOverridden` (as of round 5 — see the round 5 audit table for the full writer list):**
- `PATCH /transactions/:id` (routes/transactions.ts ~352-373) — a user picks a category or sets `isTransfer`.
- `POST /transactions` create (routes/transactions.ts ~278-288) — only the explicit system-Transfer-category pick;
  moot for pairing otherwise (a manually created row never carries a `plaidAccountId`, so it can never be paired).
- `POST /transactions/recategorize-by-pattern` (routes/transactions.ts ~915-960, round 4) — every row it moves.
- `POST /transactions/bulk-update` (routes/transactions.ts, round 5 H1) — when the patch carries a non-null
  `categoryId` or an `isTransfer` key.
- `dedupeTransactions.ts` `mergeStatePatch` (round 5 M) — carries a loser's `true` onto a blank survivor, alongside
  the category/isTransfer carry it already did.

**Bulk re-file side effect.** `POST /transactions/recategorize-by-pattern` — the route the client's "apply to past
charges?" and bulk-recategorize-by-pattern flows post to — now sets `isTransferUserOverridden: true` on every row it
moves, the same as a one-off `PATCH`, since it is equally a user action. This also means those rows keep their
picked category/flags across a future Plaid re-mint: `plaidSync.ts` (~1802, ~3864) already preserves flags on an
overridden row, so this was a one-line addition, not a new mechanism.

**Fails-before, round 4 (on `8643c682`, source-only stash; tests as of this head):**
- **`pendingFiling.test.ts`:** 4 of 23 fail — the two category-override cases ("Q overridden beats P" and its PATCH-
  the-pending-row mirror) and the two H2 cases (an un-overridden auto-transfer never inherits; an overridden P is
  never re-flagged).
- **`budgetPendingOnce.integration.test.ts`:** 5 of 22 fail on a figure — both real-route H1 repros (b1, b2: Auto
  0.00 instead of 110.00), both H2 repros (d1, d2: Dining 0.00 instead of 34.00 / 60.00), and the bulk re-file test
  (`isTransferUserOverridden` stayed `false`).
- Total: **9 of 45 new/changed tests fail on `8643c682`**, all on a figure or a stored value, none only on a missing
  field.

**Gates (worktree root, this head):**
- `pnpm run typecheck`: green.
- Web: `TZ=UTC` 136 files, 1118 passed / 3 skipped; `TZ=America/Chicago` 136 files, 1119 passed / 2 skipped (one run
  under `TZ=America/Chicago` hit vitest worker timeouts from an unrelated, heavily loaded Mac — load average ~30 from
  long-lived dev servers in other project directories; a clean re-run with the machine otherwise idle passed in full).
- Full API suite (`caffeinate -i`, own test DB `h2budget_test_prd`, run in the foreground): 143 files, 1372 passed /
  7 todo (one pre-existing test, `supersededPendingWindow.integration.test.ts`, had its expected `filing` object
  updated to include the new `isTransferUserOverridden: false` field — a shape change, not a behavior change).
- `pnpm run build` + `check-entry-graph`: 574.4 KB of 580 KB cap (unchanged; no `lib/api-spec` change, no codegen
  needed).

## Review round 5

The round 4 review found the premise "`isTransferUserOverridden` is set whenever a person picks a category" had a
hole: one more user-facing write path never set it.

- **H1 (bulk-update never sets the flag):** `POST /transactions/bulk-update` (routes/transactions.ts, wired to the
  Amex page's `bulkSetCategory` and the Chase review inbox's bulk actions) writes `categoryId`/`isTransfer` straight
  to the DB — `BulkUpdateTransactionsBody`'s own description calls it an explicit user action, same as a one-off
  `PATCH` — but never derived `isTransferUserOverridden` from the patch.
  - Repro: rule COSTCO PROBE → Groceries; a pending $100 Groceries row (by rule) bulk-recategorized to Auto via
    bulk-update — the flag stayed `false`. Plaid posts $110, Groceries by rule → Budget showed Groceries 110 / Auto 0
    (should be Auto 110, since the bulk pick was a hand filing).
  - Mirror: pending hand-filed via PATCH (override true) to one category, then the POSTED row bulk-recategorized to
    another — since the bulk write never marked P overridden, `effectiveFiling` read P as automatic and Q's stale
    override won, discarding the household's most recent pick.
  - **Fix:** in the bulk-update handler, when the patch (post `rememberPattern` strip) has an own `isTransfer` key,
    or a `categoryId` key whose value is not null/undefined, also set `isTransferUserOverridden: true` in the same
    `.set()` — the same `bodyHasIsTransfer` / `pickingCategory` derivation `PATCH /transactions/:id` already uses.
- **M (dedupe never carries the flag):** `dedupeTransactions.ts`'s `mergeStatePatch` already carried a blank
  survivor's `categoryId` and `isTransfer` up from a loser row, but never the override flag that explains WHY —
  so a dedupe merge could hand a survivor a hand-filed category/transfer-flag pair that then read as automatic to
  `effectiveFiling`. **Fix:** `if (!survivor.isTransferUserOverridden && loser.isTransferUserOverridden) patch.isTransferUserOverridden = true;`
  alongside the existing category/isTransfer lines.
- **LOW, disclosed, not changed:** `POST /transactions/uncategorize-by-ids` clears `categoryId` to `null` without
  resetting `isTransferUserOverridden`. A row uncategorized this way keeps reading as user-overridden until the
  household re-touches it, so it cannot inherit a pending row's `isTransfer` flag in the meantime. Listed as
  residual 9 below; not touched per the coordinator's instruction.

**Writer audit (`categoryId` / `isTransfer` writers on `transactions`, `grep -rn "categoryId" --include='*.ts' artifacts/api-server/src/routes` plus a walk of every `.update(transactionsTable)` / `.insert(transactionsTable)` call):**

| Writer | Is it a person choosing? | Sets `isTransferUserOverridden`? |
|---|---|---|
| `PATCH /transactions/:id` (~352-373) | Yes | Yes — pre-existing |
| `POST /transactions` create, explicit Transfer-category pick (~278-288) | Yes | Yes — pre-existing |
| `POST /transactions` create, explicit non-Transfer `categoryId` | Yes, but moot | No — but a manually created row has no `plaidAccountId`, so `supersedeCandidatesQuery` can never pair it either side; does not affect `effectiveFiling` |
| `POST /transactions/recategorize-by-pattern` (~915-960) | Yes | Yes — round 4 |
| `POST /transactions/bulk-update` | Yes | **Yes — fixed round 5 (H1)** |
| `dedupeTransactions.ts` `mergeStatePatch` (carry onto a blank survivor) | Yes (carries a person's earlier pick forward) | **Yes — fixed round 5 (M)** |
| `POST /transactions/uncategorize-by-ids` (clears `categoryId`) | Yes | No — disclosed as residual 9, not changed |
| `POST /transactions/:id/clear-transfer-override` | Yes, but its whole job is clearing the flag | Explicitly clears it — by design, unrelated to this bug class |
| `POST /transactions/bulk-set-forecast-flag` | Yes | N/A — writes only `forecastFlag` |
| `POST /transactions/send-to-review` / `unsend-from-review` | Yes | N/A — writes only `sentToReviewAt` |
| `lib/bankLedger.ts` `bulkReviewMatching` (Chase ledger bulk-review) | Yes | N/A — writes only `reviewed` |
| Plaid sync insert (`plaidSync.ts` fresh row, `categoryId: cat.categoryId` from `categorize()`) | No — automatic (mapping rules) | Correctly never sets it |
| Plaid sync pending→posted re-key / re-mint updates (`plaidSync.ts` several sites) | No — automatic | Correctly never touches `categoryId`/`isTransfer`/any `*UserOverridden` flag (comment-documented "preserved") |
| `routes/budget.ts` debt-payment backfill (~223-232, fills only `categoryId IS NULL` rows by description pattern) | No — automatic | Correctly never sets it |
| `routes/budget.ts` category-consolidation migration (~757-785, re-points a legacy category id to its V2 replacement) | No — a deploy-time system migration | Correctly never sets it |
| `workbookImporter.ts` (XLSX import via `categorize()`/rules) | No — automatic | Correctly never sets it |
| `dedupePlaidAccounts.ts` (account-merge repoint) | No — automatic, and never touches `categoryId`/`isTransfer` at all (only `plaidAccountId`/`debtId`) | N/A |
| `routes/mapping.ts` (mapping-rule CRUD) | N/A | Never writes `transactionsTable` directly |
| `routes/avalanche.ts` (debt-tracker category refs) | N/A | Never writes `transactionsTable`; all `categoryId` there is `budget_categories`/`budget_lines` |

**Fails-before, round 5 (on `6e7b77bd` before this round's two source edits; tests as of this head):**
- **`budgetPendingOnce.integration.test.ts`** (new "PR-D round 5, review H1" describe): 2 of 3 fail on a figure — the
  reproduced case (Groceries 110 / Auto 0 instead of Auto 110 / Groceries 0) and the mirror case (the posted row's
  bulk pick lost to the pending row's stale filing). The allowance-only case passes unchanged on both sides (bulk-
  update with no `categoryId`/`isTransfer` key never touched the flag either way).
- **`dedupeTransactions.integration.test.ts`** (new "round 5, review M" describe): 1 of 2 fail on a figure — the
  hand-filed-loser case (survivor's `isTransferUserOverridden` stayed `false`). The already-overridden-survivor case
  passes unchanged on both sides (nothing to carry).
- Total: **3 of 5 new tests fail before the round 5 fix**, all on a stored value.

**Gates (worktree root, this head):** see the top-level report; typecheck, both web TZs, full API suite, build +
entry graph and codegen all re-ran clean on the merged tree after these two edits.

## Residuals

1. **The Allowances page and the Banking strip still sum raw rows** in the browser (`bucketSpend.ts`): no pairing and no
   inheritance. Where a pair is in a bucket they can differ from the Budget card.
2. **Reports → Budget does neither.** `lib/budgetFacts.ts` (`GET /reports/budget-facts`) duplicates the old Budget SQL,
   with no pairing and no inheritance.
3. **Habits (`buildBehaviorFacts`) and the Amex weekly payoff pair but do not inherit filing.** They use
   `loadSupersededPendingIds`, so a bare posted row keeps its stored category there.
4. **⚠️ Spending's Uncategorized popover list vs its banner.** The popover lists stored-null rows
   (`/transactions?uncategorized=true`). The banner (`uncategorized.total`) no longer counts a bare posted row that
   inherited a category, so the list can show a row the banner does not count. PR-I (writing the filing at sync) closes
   it. The Budget page's inline "N matches" suggestions still offer such a row too.
5. **Drill vs a sync between reads (L5).** The month response and the transaction list are separate cached queries.
6. **The "Delete this envelope?" prompt's count omits a replaced pending row.**
7. **The actuals drill is capped at 200 month rows** (pre-existing).
8. **Proposed DDL still waits.** The (household_id, plaid_account_id, occurred_on) index would speed the candidate
   join; it needs Brad's go.
9. **(round 5 LOW) `POST /transactions/uncategorize-by-ids` doesn't reset `isTransferUserOverridden`.** A row
   uncategorized this way keeps reading as user-overridden — harmless for `categoryId` (it's null, never real) but it
   means the row still can't inherit a pending row's `isTransfer` flag until the household re-touches it by hand.
   Disclosed, not changed.

## Owner decisions needed

- **The six rule differences above:** adopt Spending's full rule on Budget category actuals?
- **Residuals 1–3:** should the Allowances page, the Banking strip, Reports → Budget, Habits and the Amex payoff adopt
  pairing and inheritance next?
