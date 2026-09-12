# Deploy-safe category passes (PR-A)

- **Branch:** `fix/deploy-safe-category-passes`, off `origin/main` `df2adda`.
- **Implements owner decision 3:** "repeated deployments must never delete user categories; don't blindly set a
  completed flag; make the migration safe to rerun."
- **Source changed:** `artifacts/api-server/src/routes/budget.ts` only. No OpenAPI, codegen, web, DDL or data change.
- **Tests:** one new file (`deploySafeCategoryPasses.integration.test.ts`, 8 tests). Two existing files had their
  expectations changed, because they asserted the overwrite this PR removes (see "Existing tests changed").

## Why

GET `/budget/months/:m` runs three passes once per process. The in-process gate is empty after every Render deploy,
and the landing warmup reads the current month, so **every deploy runs them on the first page load.**

| Pass | Gate before | What a run did on `df2adda` |
|---|---|---|
| `migrateBudgetCategoriesV2` | `prefs.budgetCategoriesV2` only | Merged and **deleted** any category named like one of the 44 legacy names, re-pointed its transactions, rules, bills and Avalanche extra category, summed its lines, **reset group and order** on every seed-named category, then wrote the gate by spreading preferences read before the transaction |
| `healLegacyRecurringBillLinks` | none | For each `auto_bills` expense category with no active bill (a past one-time bill counts as none): **deleted its lines and rules, set its transactions' category to NULL, deleted the category** |
| `reconcileMay2026Amounts` | `prefs.budgetMay2026AmountsV1` | **Overwrote 24 May 2026 lines** with hard-coded amounts, pinned auto lines, **pinned May 2026** (undoing #777), then wrote the gate by spreading stale preferences |

A gate had already been lost this way once (PUT `/settings` stripped it; fixed in `7b922568`). Once a gate is gone,
the data passes run on every deploy.

## What changed

### 1. Category consolidation: decided from the data

- **"Already on V2"** = the household has **any of the 17 V2-only target names**, or **no legacy source name at all**.
  In that case the pass writes the gate, logs, and changes **nothing else**: no merge, no delete, no group or order
  reset.
  - The 17 names are the map's targets, minus names that are also map sources, minus the 7 names the legacy seed already
    had and V2 kept. That list was read from `budgetSeed.ts` at `4676c214^` (the commit before #65).
  - **"Misc / Buffer" is excluded on purpose.** It is both a legacy seed row and a target, so "any target exists"
    would have skipped a genuinely legacy household.
  - A legacy-named category in a V2 household is taken to be the user's own. "Gaming subs" is both a legacy seed name
    and a plausible user category.
- **Genuinely pre-migration household** (legacy names present, no V2-only target): migrated exactly as before, with one
  exception. A legacy category that has a budget line in or after **2026-06-01** (the first month after #65 shipped,
  2026-05-03) is **left in place with its references** and logged.
- **The bias is deliberate.** A wrong "already on V2" leaves legacy rows unmerged (cosmetic). A wrong "pre-migration"
  deletes user categories.

### 2. Bill-category heal: never deletes anything referenced

- Step 1 (relink the known bill names to their manual category) is unchanged.
- **Step 2 now only deletes a category nothing points at.** That means no transaction, mapping rule, budget line,
  recurring item (active or not) or Avalanche extra category references it.
  - No line or rule is deleted, and no transaction's category is set to NULL.
  - The reference check is a set of `NOT EXISTS` clauses inside the `DELETE` itself.
- **Unreferenced orphans are still removed.** They are legacy per-bill shells: no bill, no transactions, no rules, no
  lines, so nothing on screen draws from them. Keeping the removal keeps the heal's original purpose (no empty
  "Recurring Bills" rows) without touching data.
- Kept and removed names are logged.
- **Why a linked inactive or past bill also counts as a reference:** deleting the category would leave that bill with a
  dangling `category_id`, so a reactivated bill would roll into nothing.

### 3. May 2026 reset: never overwrites, never pins

- **Nothing in the data model can tell a user's edit apart.** `budget_lines` has no `updated_at`, no history and no
  "set by" column. The line upsert (POST `/budget/lines`) stores only amount and note.
- **The canonical amounts are identical to the seed's May 2026 amounts** (all 24 checked). The old reset could
  therefore only ever change lines someone had already changed.
- **Now:**
  - **The household has a May 2026 `budget_months` row, or any budget line in or before May 2026:** write the gate,
    log, stop.
  - **Neither exists:** insert the canonical amount only for **plain manual envelopes** found by name (no recurring
    item linked).
    - The insert is `ON CONFLICT DO NOTHING`, and **pins nothing**.
    - Auto and bill-backed categories are skipped. Their planned amount comes from Bills or Debts unless pinned, and a
      stored line would only shadow a later pin snapshot (which is also insert-only).
- The trailing `syncAvalanchePaymentCategory` call is removed. It re-synced the `manualExtra` the reset stopped writing
  long ago, and the GET calls it for the same month right after.

### 4. Gate writes: locked, one key

- Both passes open their transaction with `lockOwnerPreferences`:
  - insert the settings row if missing;
  - `SELECT … FOR UPDATE`, the same lock PUT `/settings` takes;
  - re-check the gate, since another process may have just finished.
- **The gate is written with `jsonb_set(preferences, '{<key>}', 'true')`.** Only that key changes; the whole-object
  spread is gone.
- A null column is normalised to `{}` first, because `jsonb_set` on null yields null.
- The key stays literal in the SQL, so the `SERVER_OWNED_PREFERENCE_KEYS` guard still sees both writes (test 17 passes).

### Test hook

- `_resetBudgetOneTimePassGatesForTests()` clears the eight in-process gates in `budget.ts`. That is what a deploy does.
- It follows the existing `_reset…ForTests` convention (`requireAuth.ts`, `plaidSync`).

## Figures that move

**Only where a gate is missing, and only in the direction of not deleting and not overwriting.** A household whose
gates are intact runs none of the gated passes, so nothing moves for it; the heal changes only what it deletes. Figures
from the tests, on `df2adda` → on this branch:

| Case | Before | After |
|---|---|---|
| V2 household, gate lost, user's "Gaming subs" ($50.00 Sept line, 1 transaction, 1 rule) | category deleted, line merged into Subscriptions, transaction and rule moved; categories 26 → 25 | untouched; 26 → 26 over two deploys |
| same, Groceries moved to sort order 7 | reset to the seed order | stays 7 |
| expired one-time bill's `auto_bills` category with 3 × $25.00 transactions | deleted; transactions uncategorized | kept; transactions still in it |
| unlinked `auto_bills` category held only by transactions / a rule / an Aug $40.00 line | deleted; transactions uncategorized, rule and line deleted | kept |
| unlinked `auto_bills` category with no reference | deleted | deleted (unchanged) |
| seeded household, May gate lost, Groceries May edited to $512.34 | reset to $460.00, May pinned | $512.34, not pinned |
| same, Misc / Buffer May edited to $999.00 | reset to $237.58 | $999.00 |
| household with only an April 2026 Groceries line of $300.00 | May planned $460.00 | $300.00 (carry-forward, as for any month) |
| household with no data through May 2026 | canonical on all 24 names, auto lines and May pinned | $460.00 / $0.00 on plain envelopes only, unpinned |
| legacy household, Streaming category with a July 2026 line | merged into Subscriptions | left in place |
| gate written while a settings write is in flight | in-flight `amexAnchor` lost | kept |

**One on-screen consequence to know.** When the May gate was lost, the old reset re-pinned May 2026, and the page showed
the stored lines for auto and bill-backed categories. That pin is no longer restored, so those May rows show the Bills
or Debts derivation, as every other unpinned month does and as #777 intended.

## Existing tests changed

- **`budgetCategoryMigration`:** Utilities May planned **774.24 → 684.02**. 684.02 is the migration's own sum
  (241 + 101.02 + 342). 774.24 was the May reset overwriting it; that household already had May lines. Everything else
  in the test is unchanged and passes.
- **`may2026BudgetAmounts`:** rewritten to the new contract.
  - Seed, then edit Misc / Buffer and Groceries.
  - After the May read: every May line is unchanged, none is pinned, May is not pinned.
  - Plain envelopes show their stored line; Avalanche `manualExtra` is untouched; the gate is set; a later edit survives.
  - The old version asserted that the reset forced edited lines back, which is exactly what decision 3 forbids.
- **`settingsPreferencesServerKeys` is unchanged** and passes (23/23), including the end-to-end May test and the guard.

## Must not change

- A genuinely pre-migration household is merged, re-pointed, summed and re-grouped as before (`budgetCategoryMigration`).
- The heal's step 1 relink.
- Income `auto_bills` categories and `syncAutoBillsFromRecurring`.
- Nothing ever pins a month or a line except the user's pin endpoints.
- PUT `/settings`, `SERVER_OWNED_PREFERENCE_KEYS`, and every key other than the gate being written.
- No spec, codegen, web, DDL or data change.

## Verification

Worktree off `df2adda`, own database `h2budget_test_pra`.

| Gate | Result |
|---|---|
| New file + the two changed files, **on `df2adda`'s `budget.ts`** (only the test hook appended) | **10 failed (10)** |
| Same three files on this branch | **10 passed (10)** |
| Four affected files (the three above + `settingsPreferencesServerKeys`) | **33 passed (33)** |
| `pnpm run typecheck` | exit 0 |
| Full API suite (`TZ=UTC`, serial) | **139 files passed; 1310 passed, 7 todo (1317)** |
| Web suite `TZ=UTC` / `TZ=America/Chicago` | **135 files passed** each; 1112 passed, 3 skipped / 1113 passed, 2 skipped (1115) |
| `pnpm run build` + `check-entry-graph` | exit 0; landing **574.4 KB** of 580 KB (unchanged: no web change) |
| Codegen | not run: `lib/api-spec` unchanged |

Fails-before, per test on `df2adda`:
- migrated household: categories 26 → 25;
- legacy household: Streaming merged;
- both lock tests: `amexAnchor` undefined after the gate write;
- heal: the expired one-time bill's category deleted;
- May edited: lines reset;
- May empty: a line stored for the bill-backed Utilities;
- May with April: $460.00 instead of $300.00;
- existing May test: Groceries $460.00 instead of $512.34;
- existing migration test: 774.24.

## Residuals

1. **Nothing already lost is restored.** Categories deleted, transactions uncategorized, or May lines overwritten by
   earlier deploys stay as they are. Proposed read-only production check (not run; no production access on this task):

   ```sql
   select user_id,
          preferences ? 'budgetCategoriesV2'     as has_categories_gate,
          preferences ? 'budgetMay2026AmountsV1' as has_may_gate
     from settings;
   select household_id, pinned from budget_months where month_start = '2026-05-01';
   -- auto_bills expense categories the old heal would have deleted next deploy
   select c.household_id, c.name
     from budget_categories c
    where c.source_kind = 'auto_bills' and c.kind = 'expense';
   ```
2. **The V2 signature is name-based.** A pre-migration household where the user created a V2-only name (e.g.
   "Utilities") by hand is treated as migrated, so its legacy rows stay unmerged. That is cosmetic, and it is the chosen
   bias.
3. **Post-era detection looks only at budget lines in or after 2026-06-01.** In the genuine path, a legacy category
   whose only recent sign is transactions or rules is still merged (Plaid mapping moves transactions without the user,
   so they are not evidence). `created_at` is not used: fixtures and the workbook import recreate rows with fresh
   timestamps, so it proves nothing.
4. **The heal's check runs under READ COMMITTED.** A reference written by a transaction not yet committed when the
   `DELETE` runs is not seen; the window is one statement. No `category_id` column has a foreign key.
5. **`scripts/clear-budget-pinned-state.ts` still writes its gate with read-then-spread.** It is operator-run, not run
   on deploy; not changed here.
6. **A settings save waits while a genuine migration runs.** The migration holds the settings row lock for the whole
   pass. A migrated household only writes the gate, so its hold is a few milliseconds.
7. **Logs are pino `info` lines only;** nothing surfaces them.
