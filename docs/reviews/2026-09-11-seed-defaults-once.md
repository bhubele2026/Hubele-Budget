# Seed a household's defaults once (PR-A2)

- **Branch:** `fix/seed-defaults-once`, off `fix/deploy-safe-category-passes` (PR-A) at `96773647`, with PR-A's
  `4b4e00ad` (round 3 note, one unused constant) merged in.
- **Serves owner decision 3**, "repeated deployments must never delete user categories", extended: a deploy must
  never **re-create** a category, bill or rule the household deleted.
- **Source changed:** `artifacts/api-server/src/routes/budget.ts` and `routes/settings.ts` (one key added to the list).
  No OpenAPI, codegen, web, DDL or data change.
- **Tests:**
  - one new file, `seedDefaultsOnce.integration.test.ts` (12 tests);
  - two file snapshots of the base seed, written on `96773647`.
  - No existing test changed.

## Why

GET `/budget/categories` runs `ensureSeededDefaults` once per process. The in-process gate is empty after every
deploy, so it runs on the first category read after every deploy.

On `96773647` it called `seedDefaultsForUser` whenever **any** of the 27 seed category names was missing. That:
- re-inserted every missing category;
- re-inserted each seed bill whose name the household no longer has;
- re-inserted each seed mapping rule whose pattern it no longer has;
- re-inserted May 2026 lines.

**Reviewer's repro, reproduced here:** delete "Entertainment" and the "Weekly Spend" bill, deploy, GET
`/budget/categories`. Both come back, and Misc / Buffer's September plan goes from 678.03 back to **2478.03**.

**Second effect (R6, R7):**
- PR-A keeps a legacy-named category that is in use.
- The seed then created the V2 envelope beside it, and both planned money.

## What changed

### 1. `seedDefaultsOnce`: one decision per household, taken under the settings row lock

It opens a transaction with PR-A's `lockOwnerPreferences` (the `SELECT … FOR UPDATE` PUT `/settings` takes), then:

| Household | Result |
|---|---|
| marker `defaultsSeededAt` present | nothing |
| no marker, and **any** category it made, recurring item or mapping rule | writes the marker, seeds **nothing**, logs which kinds of data it found |
| no marker and none of those | the full seed, unchanged, then the marker |

- **The seed and the marker commit together.** A failed seed leaves no marker and no half-seeded rows.
- **A cheap unlocked read comes first.** Once the marker is written, the path is one settings select.
- **Which categories count as the household's own.** Categories the server makes by itself do not count, because a
  month read can make them in a brand-new household before its first category read:
  - Uncategorized, Transfer and Ignore;
  - Avalanche payment (`syncAvalanchePaymentCategory`, every month read);
  - any `auto_debts` row (`syncAutoDebtCategories`, one per active debt).

  Without this, a first month read that lands first would stop a new household's seed. A test covers it.
- **Every household seeded before this PR** has data and no marker. Its first category read after the deploy writes
  the marker and seeds nothing.

### 2. The marker

- **Key:** `preferences.defaultsSeededAt`, an ISO timestamp.
- **Write:** `jsonb_set(preferences, '{defaultsSeededAt}', to_jsonb(<iso>::text), true)` under the row lock, so only
  that key changes.
- **Kept by PUT `/settings`:** added to `SERVER_OWNED_PREFERENCE_KEYS`. PUT keeps the stored value and ignores one sent
  in the body. The source-scan guard in `settingsPreferencesServerKeys` sees the new write.

### 3. The seed body is unchanged

`seedDefaultsForUser` changed in exactly two lines:
- its signature takes the outer transaction;
- `db.transaction` became `outer.transaction`, a savepoint.

Every insert and every fill-by-name rule inside it is as on the base. `ensureSeededDefaults` lost its "all 27 names
present" check.

### 4. No V2 envelope beside a kept legacy category

Such a household already has data, so the seed never runs there. Same fixture as the reviewer's figures:
- legacy "Groceries ($425/wk × 4.33 wks)" with a May 2026 line of 1,840.25 and a mapping rule, so PR-A keeps it;
- "Restaurants & Bars" with only a May line of 300.75, so it merges into Dining & Coffee.

| Case | `96773647` | This branch |
|---|---|---|
| **R6:** month read first (migration), then the category read | May Food **2,601.00** (a V2 Groceries seeded at 460.00 beside the kept one) | **2,141.00**, over two deploys |
| **R7:** category read first (seed), then the month read | May Food **3,061.00** (V2 Groceries and Dining & Coffee seeded at 460.00 each; the migration then sees V2 names and merges nothing) | **2,141.00**: the migration merges as on the full path |

## Every call site and every other seeding path

| Path | `96773647` | This branch |
|---|---|---|
| GET `/budget/categories` → `ensureSeededDefaults` (the web's first category read; e2e specs rely on it for a fresh user) | full seed whenever any seed name was missing | `seedDefaultsOnce` |
| POST `/budget/seed-defaults` (`budget.tsx` calls it when the list holds no non-excluded category; many API tests) | `seedDefaultsForUser`, always | `seedDefaultsOnce`. Response shape unchanged: `alreadySeeded: true` with zero counts when nothing is seeded, so the web shows no "Loaded default budget" toast. |
| `seedDefaultsForUser` | two callers above | one caller: `seedDefaultsOnce` |
| POST `/budget/seed-bills` | tops up seed bills by name and their missing categories | **unchanged.** Not in the OpenAPI spec, no web caller, never run by a page load or deploy; an explicit hand-run top-up. It still re-adds a deleted "Weekly Spend" if someone calls it (residual 1). |
| Workbook import (POST `/import/workbook`, `lib/workbookImporter.ts`) and snapshot restore | wipe and replace categories, lines, bills and rules from the workbook; never call the seed | **unchanged.** It does not re-seed on purpose. What changes: on `96773647` the next deploy's lazy seed added the missing seed names on top of an imported budget; now that household has data, so it gets the marker only. |
| Onboarding | no server onboarding path seeds (`grep -i onboard`: none in the API or web source) | n/a |
| `migrateBudgetCategoriesV2` `ensureCategory` | creates the target of a merged legacy category | unchanged: this is the migration, not the seed |
| `scripts/src/*.ts` | none calls the seed | n/a |
| `scripts/seed_bills_user_3DBrWZkCKIzrkYoLS6N9tIMcdso.sql`, invoked from `scripts/post-merge.sh` | skip-by-name insert of the 18 seed bills for one user | **unchanged.** `post-merge.sh` is the dormant Replit hook: Render's `buildCommand` is `pnpm install` and `pnpm run build` only. Run by hand, it re-adds a deleted bill (residual 2). |

## Figures that move

| Case | `96773647` | This branch |
|---|---|---|
| Seeded household deletes Entertainment and Weekly Spend, then two deploys (round 1 with the marker removed, as every current household has) | both back; Misc / Buffer September **2478.03** | both stay deleted; **678.03**; every category, bill, rule, line and month row identical |
| Household with only a category it made ("Birthday gifts") / only a bill ("Gym") / only a mapping rule, no marker | full seed on top of it | marker only; no row inserted, from the category read and from POST `/budget/seed-defaults` |
| R6 / R7 legacy household, May Food | 2,601.00 / 3,061.00 | 2,141.00 / 2,141.00 |
| A pre-migration household's missing V2 envelopes | created by the seed on the first category read, with May 2026 lines at seed amounts | only the migration's merge targets exist |
| A new household that adds a bill, rule or category before its first budget read | seeded on top | not seeded (residual 3) |

## Must not change

- **A brand-new empty household's seed.** Two file snapshots, written by this test file running against `96773647`'s
  `budget.ts` and `settings.ts`, are compared on this branch:
  - `__snapshots__/seedDefaultsOnce.lazy-seed.base.json`: seeded by GET `/budget/categories`;
  - `__snapshots__/seedDefaultsOnce.post-seed.base.json`: seeded by POST `/budget/seed-defaults`.

  Each holds, without ids or timestamps:
  - every category, bill, mapping rule, budget line and month row, straight after the seed and again after the May and
    September reads;
  - the May 2026 and September 2026 group totals and lines (planned amount, plan source, pinned);
  - the summary budgets and `planBySource`.

  Headline figures in both:

  | Figure | Value |
  |---|---|
  | Rows seeded | 27 categories, 21 bills, 52 rules, 24 May lines |
  | POST response | `{27, 24, 52, alreadySeeded: false}` |
  | May `plannedTotal` | 8,466.70 |
  | September `plannedTotal` | 8,016.70 |
  | May groups | Income 33,387.98 · Housing & Utilities 3,405.08 · Insurance & Health 345.13 · Food 920.00 · Transportation 1,724.35 · Kids & Pets 80.00 · Lifestyle & Shopping 2,965.99 · others 0.00 |

  The two seeded states are identical to each other.
- **A new household is still seeded when a month read runs first**, with the three system rows, Avalanche payment and a
  debt's `auto_debts` row already there.
- **The three system categories** keep their own ensure passes, unchanged.
- **PR-A's three passes**, PUT `/settings` and every other preference key. The marker write keeps `amexAnchor`,
  `weeklyAllowanceOverrides` and `dismissedDetectedSubs`, including when an `amexAnchor` write is in flight.
- No spec, codegen, web, DDL or data change.

## Verification

Worktree `/private/tmp/claude-501/build-pra2`, own database `h2budget_test_pra2`.

| Gate | Result |
|---|---|
| New file on this branch | **12 passed (12)** |
| New file on **`96773647`'s** `budget.ts` and `settings.ts` | **10 failed, 2 passed (12)**. The 2 are the base snapshots, which pin figures rather than test the fix. |
| `pnpm run typecheck` | exit 0 |
| Full API suite (`TZ=UTC`, serial) | **140 files passed; 1323 passed, 7 todo (1330)**. That is PR-A's 139 files and 1311 tests, plus this file. |
| Web suite `TZ=UTC` | 135 files passed; 1112 passed, 3 skipped (1115) |
| Web suite `TZ=America/Chicago` | 135 files passed; 1113 passed, 2 skipped (1115) |
| `pnpm run build` + `check-entry-graph` | build exit 0; guard OK; landing **574.4 KB** of 580 KB (unchanged: no web change) |
| Codegen | not run: `lib/api-spec` unchanged |

**Fails-before on `96773647`:**
- deleted Entertainment and Weekly Spend: round 1, Entertainment back in the category list;
- data but no marker, each of the three cases: seed rows inserted;
- in-flight settings write: the category read never waited on the settings lock;
- new household marker / month-read-first / PUT `/settings`: no `defaultsSeededAt`;
- R6: May Food 2601.00; R7: 3061.00.

## Residuals

1. **POST `/budget/seed-bills` still re-adds deleted seed bills** by name, and their missing categories. Nothing calls
   it except by hand. Not changed; see question 1.
2. **`scripts/seed_bills_user_3DBrWZkCKIzrkYoLS6N9tIMcdso.sql` re-adds deleted bills** for that one user when run.
   - It is wired into `scripts/post-merge.sh`, the dormant Replit hook, not the Render build.
   - If Replit is ever revived as a rollback, it would run after every merge. Not changed: it is operator SQL against
     production data.
3. **A new household that creates data before its first budget read gets no defaults.** For example, it adds a bill on
   the Bills page first.
   - The web's POST `/budget/seed-defaults` call is skipped too once the list holds a non-excluded category (the bill's
     `auto_bills` envelope).
   - There is no button to seed later. See question 2.
4. **A household with no categories, bills or rules and no marker still gets the full seed once.** This includes one
   that deleted everything before this deploy. Transactions and debts alone do not count as data, as on the base.
5. **Rows earlier deploys already re-created stay.** A category or bill the household deleted and a deploy brought back
   is still there. Read-only production check (not run; no production access):

   ```sql
   select user_id, preferences ? 'defaultsSeededAt' as has_marker from settings;
   ```

6. **Possible deadlock, empty household only.**
   - The seed holds the settings lock while it inserts categories.
   - PR-A's L5 describes the workbook import taking row locks before settings.
   - A brand-new household importing a workbook during its very first category read could deadlock. Postgres aborts one
     side: a lazy seed failure is caught (60 s cooldown); POST `/budget/seed-defaults` would answer 500.
7. **PR-A's M2 writers can still drop the marker.** The unlocked read-spread-write preference writes in `routes/amex.ts`
   and `lib/amexAnchor.ts` can still remove a server-owned key. Losing the marker now costs one locked check: the
   household has data, so it is only rewritten.

## Questions for the owner

1. Should POST `/budget/seed-bills` and the per-user bill-seed SQL follow the same once-only rule, or be retired?
2. Should a household that starts on the Bills page (data before its first budget read) still get the default
   categories and rules?
