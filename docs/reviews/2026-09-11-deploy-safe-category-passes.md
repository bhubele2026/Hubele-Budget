# Deploy-safe category passes (PR-A)

- **Branch:** `fix/deploy-safe-category-passes`, off `origin/main` `df2adda`.
  - **Round 1:** `5916bef5`.
  - **Round 2:** review fixes L1, L3, the log nit and the group-total nit, plus these note corrections.
  - **Round 3:** second look **APPROVED the code in `96773647`**. Note-only corrections applied here, plus removal of the
    unused `MAY_2026_AVALANCHE_MANUAL_EXTRA` constant.
- **Implements owner decision 3:** "repeated deployments must never delete user categories; don't blindly set a
  completed flag; make the migration safe to rerun."
- **Source changed:** `artifacts/api-server/src/routes/budget.ts` only. No OpenAPI, codegen, web, DDL or data change.
- **Tests:**
  - one new file, `deploySafeCategoryPasses.integration.test.ts` (9 tests);
  - two existing files had their expectations changed, because they asserted behaviour this PR removes (see "Existing
    tests changed").

## Why

GET `/budget/months/:m` runs three passes once per process. The in-process gate is empty after every Render deploy, and
the landing warmup reads the current month, so **every deploy runs them on the first page load.**

| Pass | Gate on `df2adda` | What a run did |
|---|---|---|
| `migrateBudgetCategoriesV2` | `prefs.budgetCategoriesV2` only | Merged and **deleted** any category named like one of the 44 legacy names; re-pointed its transactions, rules, bills and Avalanche extra category; summed its lines; **reset group and order** on every seed-named category. It then wrote the gate by spreading preferences read before the transaction. |
| `healLegacyRecurringBillLinks` | none | For each `auto_bills` expense category with no active bill (a past one-time bill counts as none): **deleted its lines and rules, set its transactions' category to NULL, deleted the category**. |
| `reconcileMay2026Amounts` | `prefs.budgetMay2026AmountsV1` | **Overwrote 24 May 2026 lines** with hard-coded amounts, pinned auto lines, **pinned May 2026** (undoing #777), then wrote the gate by spreading stale preferences. |

**How a gate gets lost:**
- **PUT `/settings`** used to strip both gates on every web preferences save. That was fixed in `7b922568`.
- **It is not the only route (M2, below).** Other preference writers still read, spread and write without a lock, and
  can still drop a gate that another writer set in between.
- **Once a gate is gone, the data passes run on every deploy.**

## What changed

### 1. Category consolidation: decided from the data, and it never takes a category the user is using

**Already on V2.** A household counts as already on V2 when it has **any of the 17 V2-only target names**, or **no
legacy source name at all**. The pass then writes the gate, logs, and changes **nothing else**: no merge, no delete, no
group or order reset.
- **How the 17 names were chosen.** They are the map's targets, minus names that are also map sources, minus the 7 names
  the legacy seed already had and V2 kept. That list was read from `budgetSeed.ts` at `4676c214^`.
- **"Misc / Buffer" is excluded on purpose.** It is both a legacy seed row and a target.

**Otherwise (the full-migration path).** The household is migrated as before, with one exception. **A legacy-named
category is left in place, never merged or deleted, when any of these holds:**
- a mapping rule points at it (any rule, any date);
- it has a transaction dated **2026-06-01** or later;
- it has a budget line for **2026-06-01** or later.

2026-06-01 is the first month after #65 shipped (2026-05-03). Kept names and the reason are logged.

- **Reviewer's case (L1, fixed):** no V2-only name, lost gate, "Gaming subs" with 2 transactions Aug–Sept, 1 rule and
  no line. It **was deleted** and its rows moved to Subscriptions on `df2adda` and `5916bef5`. It is **kept** now, with
  its transactions and rule.
- **The bias is deliberate.** A wrong "keep" leaves a legacy row unmerged. Once `ensureSeededDefaults` creates the V2
  envelope beside it, both plan the money (see the next bullet), until PR-A2. A wrong "merge" deletes a user category.
- **Consequence of "any rule" for a genuinely legacy household.** The legacy mapping seed (`mappingSeed.ts` at
  `4676c214^`) pointed rules at about 25 legacy names: Streaming, Phone, Water/Sewer, MGE, Groceries ($425/wk),
  DoorDash, Coffee, Walmart / Target, Toyota Lease and others.
  - On a seeded legacy household, those categories are now kept, so the migration merges only the rule-less, pre-June
    ones. **Not cosmetic:** when `ensureSeededDefaults` next runs it creates each V2 envelope beside the kept legacy one,
    with its own May line, and both count.
    - Reproduced: a kept "Groceries ($425/wk)" (May 1,841.00) plus the seeded "Groceries" (460.00) puts May Food at
      **2,601.00** instead of 2,141.00 merged, **+$460** on the plan.
    - PR-A2 fixes this.
  - `mapping_rules.created_at` exists. Keeping only categories with a rule created on or after 2026-06-01 is a
    possible alternative. "Any rule" is kept because, on the only path that reaches it, deleting a user's category is
    worse than a temporary double plan.

### 2. Bill-category heal: never deletes anything referenced

- **Step 1 is unchanged:** relink the known bill names to their manual category.
- **Step 2 now only deletes a category nothing points at:** no transaction, mapping rule, budget line, recurring item
  (active or not) or Avalanche extra category.
  - No line or rule is deleted, and no transaction's category is set to NULL.
  - The reference check is a set of `NOT EXISTS` clauses inside the `DELETE` itself.
- **Unreferenced orphans are still removed.** They are legacy per-bill shells with nothing drawing on them.
- **A linked inactive or past bill counts as a reference.** Deleting the category would leave that bill with a dangling
  `category_id`.
- **Logging:** kept names and removed names are logged separately, each only when non-empty (round 2).

### 3. May 2026 reset: retired; with the gate missing it only writes the gate

- **What it does now (round 2, L3):** writes the gate under the lock, logs, and **changes no budget data**. No line is
  written, overwritten or pinned, and no month is pinned. The canonical-amount table is gone.
- **Why no data write is safe to keep:**
  - **Edits cannot be detected.** `budget_lines` has no `updated_at`, no history and no "set by" column, and
    POST `/budget/lines` stores only amount and note.
  - **Seeding already writes the same amounts.** The seed's May 2026 amounts are identical to the 24 canonical amounts.
- **Why round 1's insert-only path was dropped.** It stored the canonical amount on plain envelopes when the household
  had no data through May. The reviewer reproduced the harm:
  - Groceries held only a Sept $300 line.
  - Reading May inserted $460.
  - July then carried $460 forward.
- The trailing `syncAvalanchePaymentCategory` call is gone. The GET calls it for the same month right after.

### 4. Gate writes: locked, one key

- **Lock first.** Both passes open their transaction with `lockOwnerPreferences`:
  - insert the settings row if missing;
  - `SELECT … FOR UPDATE`, the same lock PUT `/settings` takes;
  - re-check the gate.
- **One key.** The gate is written with `jsonb_set(preferences, '{<key>}', 'true')`, so only that key changes. A null
  column becomes `{}` first.
- **Guard still sees both writes.** The key stays literal in the SQL, so the `SERVER_OWNED_PREFERENCE_KEYS` guard still
  sees both.
- **Scope.** This fixes the writes of these two passes only (see M2).

### Test hook

`_resetBudgetOneTimePassGatesForTests()` clears the eight in-process gates in `budget.ts`, which is what a deploy does.

## Figures that move

**Only where a gate is missing, or where the heal would have deleted a referenced category.** Figures come from the
tests. Where round 1 differed from both, it is shown in brackets.

| Case | `df2adda` | This branch |
|---|---|---|
| V2 household, gate lost, user's "Gaming subs" ($50.00 Sept line, 1 transaction, 1 rule) | deleted; line merged into Subscriptions; transaction and rule moved; categories 26 → 25 | untouched; 26 → 26 over two deploys |
| same, Groceries moved to sort order 7 | reset to the seed order | stays 7 |
| **no V2-only name, gate lost, "Gaming subs" with 2 × $18.98 transactions Aug–Sept, 1 rule, no line** | deleted; transactions and rule moved to Subscriptions [round 1: same] | kept with both transactions and the rule |
| same, legacy "Coffee" with one 2026-06-05 transaction / "Home & Menards" with only a rule | merged and deleted [round 1: same] | kept |
| `budgetCategoryMigration` fixture: Water/Sewer ($101.02 May line, 1 rule) | merged; Utilities May planned 774.24 after the reset [round 1: 684.02] | Water/Sewer kept with its line and rule; Utilities **583.00** (MGE 241 + Phone 342) |
| legacy "Streaming" with a July 2026 line and a rule | merged | kept |
| expired one-time bill's `auto_bills` category with 3 × $25.00 transactions | deleted; transactions uncategorized | kept; transactions still in it |
| unlinked `auto_bills` category held only by transactions / a rule / an Aug $40.00 line | deleted; rule and line deleted; transactions uncategorized | kept |
| **the Aug $40.00 line on that kept category (L4)** | gone, adds $0 | counts toward August's planned total: **+$40.00** (an `auto_bills` category with no derived bill amount shows its stored line, `budget.ts` planned-amount selection) |
| unlinked `auto_bills` category with no reference | deleted | deleted (unchanged) |
| seeded household, May gate lost, Groceries May edited to $512.34 / Misc / Buffer to $999.00 | reset to $460.00 / $237.58; May pinned | unchanged; not pinned |
| **Groceries with only a Sept 2026 $300 line, May gate lost** | May line $460.00 stored, May pinned; July carries $460.00 [round 1: May $460.00 unpinned; July $460.00] | no May line, no July line; Sept $300.00 |
| household with only an April 2026 Groceries line of $300.00 | May planned $460.00 | $300.00 (normal carry-forward) |
| household with no budget data | canonical on all 24 names; auto lines and May pinned [round 1: canonical on plain envelopes] | nothing stored |
| gate written while a settings write is in flight | in-flight `amexAnchor` lost | kept |

**On-screen consequence.** When the May gate was lost, the old reset re-pinned May 2026, and the page showed stored lines
for auto and bill-backed rows. It no longer does. Those May rows show the Bills or Debts derivation, as any unpinned
month does and as #777 intended. The pinned May group totals for an unpinned seeded household are in the test (below).

## Existing tests changed

- **`budgetCategoryMigration`:**
  - Water/Sewer has a mapping rule, so it is now **kept** with its rule and line.
  - MGE and Phone still merge, and their transaction is re-pointed.
  - Utilities May planned: `df2adda` **774.24** (the reset's overwrite) → round 1 **684.02** → now **583.00** (241 + 342).
  - The rule now stays on Water/Sewer.
  - The title says so.
- **`may2026BudgetAmounts`:** rewritten to the new contract.
  - Every May line is unchanged after the read; none is pinned; May is not pinned.
  - Plain envelopes show their stored line; Avalanche `manualExtra` is untouched; a later edit survives.
  - **Round 2 pins May's group totals for this unpinned seeded household**, each derived in a comment from
    `SEED_RECURRING_ITEMS`:

    | Group | Total |
    |---|---|
    | Income | 33,387.98 |
    | Housing & Utilities | 3,405.08 |
    | Insurance & Health | 345.13 |
    | Food | 972.34 |
    | Transportation | 1,724.35 |
    | Kids & Pets | 80.00 |
    | Lifestyle & Shopping | 2,965.99 |
    | Savings & Debt Payoff | 0.00 |
    | Avalanche | 0.00 |

- **`settingsPreferencesServerKeys` is unchanged** and passes, including the end-to-end May test and the guard.

## Must not change

- **On the full-migration path, a legacy category with no rule and no activity since June 2026 is merged as before:**
  re-pointed, summed and re-grouped.
  - This depends on request order (L2). If GET `/budget/categories` runs first after a deploy, `ensureSeededDefaults`
    creates the V2 names.
  - The check then says "already on V2", and the legacy rows are never merged. Unlike `df2adda`, which merged them even
    after seeding, both the legacy and the seeded V2 envelopes now plan money.
    - Reproduced: May Food **3,061.00** instead of 2,141.00 (**+$920**: seeded Groceries 460.00 and Dining & Coffee
      460.00).
    - PR-A2 fixes this.
- The heal's step 1 relink.
- Income `auto_bills` categories and `syncAutoBillsFromRecurring`.
- Nothing pins a month or a line except the user's pin endpoints.
- PUT `/settings`, `SERVER_OWNED_PREFERENCE_KEYS`, and every preference key other than the gate being written.
- No spec, codegen, web, DDL or data change.

## Verification

Worktree off `df2adda`, own database `h2budget_test_pra`. Round 2 numbers.

| Gate | Result |
|---|---|
| New file + the two changed files on this branch | **11 passed (11)** |
| Same three files on **`5916bef5`'s** `budget.ts` (round 1) | **3 failed, 8 passed (11)** |
| Same three files on **`df2adda`'s** `budget.ts` (only the test hook appended) | **11 failed (11)** |
| Four affected files (+ `settingsPreferencesServerKeys`) | **34 passed (34)** |
| `pnpm run typecheck` | exit 0 |
| Full API suite (`TZ=UTC`, serial) | **139 files passed; 1311 passed, 7 todo (1318)** |
| Web suite `TZ=UTC` / `TZ=America/Chicago` | **135 files passed** each; 1112 passed, 3 skipped / 1113 passed, 2 skipped (1115) |
| `pnpm run build` + `check-entry-graph` | exit 0; landing **574.4 KB** of 580 KB (unchanged: no web change) |
| Codegen | not run: `lib/api-spec` unchanged |

**Fails-before on `5916bef5`** (the round 2 fixes):
- the no-V2-names test: "Gaming subs" merged away;
- the Sept-only test: a May Groceries line of $460.00 stored;
- `budgetCategoryMigration`: Water/Sewer merged, no category left.

The pinned May group totals pass there too. They pin the figures; they do not test a fix.

**Fails-before on `df2adda`, all 11 tests:**
- migrated household: categories 26 → 25;
- legacy household: Streaming merged;
- no-V2-names: "Gaming subs" merged;
- both lock tests: `amexAnchor` undefined after the gate write;
- heal: the expired one-time bill's category deleted;
- May edited: lines reset;
- Sept-only: May $460.00 stored;
- April-only: $460.00 instead of $300.00;
- `budgetCategoryMigration`: Water/Sewer merged;
- `may2026BudgetAmounts`: Groceries $460.00 instead of $512.34.

## Residuals

1. **M1: `ensureSeededDefaults` re-seeds on every deploy.** This is outside this diff; follow-up PR-A2.
   - **What it does.** GET `/budget/categories` calls `seedDefaultsForUser` whenever any seed category name is missing
     (`budget.ts` `ensureSeededDefaults`). That re-inserts missing categories, bills matched by name, mapping rules and
     May lines.
   - **Reproduced by the reviewer:** delete "Entertainment" and the "Weekly Spend" bill, deploy, GET
     `/budget/categories`. Both come back, and Misc / Buffer's Sept plan goes **678.03 → 2478.03**.
   - `df2adda` does the same. **A user cannot delete a seed category or bill for good until PR-A2.**
2. **M2: other preference writers can still drop a gate.** They read, spread and write without a lock:
   - `routes/amex.ts` around :84-91: the `amexCleanupDoneAt` heal, with a slow dedupe between the read and the write;
   - `routes/amex.ts` around :518-525 and :563-567: anchor save and clear;
   - `lib/amexAnchor.ts` around :171-178: `refreshAmexAnchor`, which PR-E is rewriting to a locked merge.

   **The gate-loss route is not fully fixed; only PUT `/settings` was.** A gate lost that way now costs nothing on the
   data (every pass is safe to rerun), but the gate itself can still disappear.
3. **L5: possible deadlock, full-migration path only.**
   - The migration holds the settings row lock while it updates transactions, rules and lines.
   - The workbook import takes transaction locks, then settings.
   - Postgres would abort one side with a deadlock error. If it aborts the migration, its transaction rolls back, that
     GET answers 500, and the in-process gate is not set, so the pass runs again on the next budget-month read.
   - Rare: only a pre-migration household importing a workbook during its first budget read. The already-on-V2 path
     takes no transaction locks.
4. **Nothing already lost is restored.** Categories deleted, transactions uncategorized or May lines overwritten by
   earlier deploys stay as they are. Proposed read-only production check (not run; no production access):

   ```sql
   select user_id,
          preferences ? 'budgetCategoriesV2'     as has_categories_gate,
          preferences ? 'budgetMay2026AmountsV1' as has_may_gate
     from settings;
   select household_id, pinned from budget_months where month_start = '2026-05-01';
   select c.household_id, c.name
     from budget_categories c
    where c.source_kind = 'auto_bills' and c.kind = 'expense';
   ```
5. **The V2 signature is name-based.** A pre-migration household where the user made a V2-only name by hand is treated
   as migrated, so its legacy rows stay unmerged, and the seed adds the missing V2 envelopes beside them. That is the
   same double plan as the L2 case (May Food 3,061.00 against 2,141.00). PR-A2 fixes this.
6. **The heal's check runs under READ COMMITTED.** A reference written by a transaction not yet committed when the
   `DELETE` runs is not seen; the window is one statement. No `category_id` column has a foreign key.
7. **`scripts/clear-budget-pinned-state.ts` still writes its gate with read-then-spread.** It is operator-run, not run on
   deploy; not changed.
8. **Logs are pino `info` lines only;** nothing surfaces them.
