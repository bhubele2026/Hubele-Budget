# PUT /settings kept deleting the preference keys the server writes

- **Fix:** branch `fix/settings-preferences-keep-server-keys` (`dbbc4ba`), merged to `main` as `7b922568`. One route
  changed, one test file added.
- **Follow-up:** branch `fix/settings-preferences-followups`, off `7b922568`. **Tests and this note only, no source
  change.** It covers the review's findings:
  - **M1:** the Amex consequences were wrong. They are rewritten below.
  - The budget consequences are now stated precisely.
  - **M2:** a lock test.
  - **L1:** a guard for the hand-kept key list.
  - **L2:** the missing cases.

No financial logic, no DDL, no data migration, no spec or web change in either branch.

## The bug

**Any preferences save from the web deleted four keys the server owns.**

- `settings.preferences` is one jsonb column (`lib/db/src/schema/index.ts` :665).
- PUT `/settings` validates the body with the generated `UpdateSettingsBody`, a plain zod 3 `object`. zod strips every
  key the spec does not list, then the route `.set({...parsed.data})` **replaced the whole column**.
- The server writes four preference keys that are **not in the OpenAPI `SettingsPreferences` schema**:

| Key | Written by | What it does |
|---|---|---|
| `amexAnchor` | POST/DELETE `/amex/anchor`; `lib/amexAnchor.ts` `refreshAmexAnchor` (see below: that path has not written in production since 2026-05-03) | Saved Amex balance, used by GET `/amex/anchor` |
| `amexCleanupDoneAt` | `routes/amex.ts` GET `/amex/anchor` | Stamp that the one-shot duplicate-account heal ran |
| `budgetCategoriesV2` | `routes/budget.ts` `migrateBudgetCategoriesV2` | Gate for the one-time category consolidation |
| `budgetMay2026AmountsV1` | `routes/budget.ts` `reconcileMay2026Amounts` (and `scripts/clear-budget-pinned-state.ts`) | Gate for the one-time May 2026 planned-amount reset |

- **How it was triggered.** Every web preferences save sends `{...prev, ...patch}` where `prev` is GET `/settings`'s
  preferences, which do carry the four keys. The spread did not help: the validator removed them before the write.
  - `pages/allowances.tsx` :712 and :741, a per-week allowance override (since `58a7c7c6`, 2026-06-12)
  - `components/avalanche-card-config.tsx` :102, card tier, cadence and name (since `ba09eac3`, 2026-06-27)
  - `pages/settings.tsx` :383 and :410, bucket labels and behaviour trackers
- These are the only four server-written keys. `me.ts` writes a different table. The guard test below now enforces the
  list.

**Reproduced on main.** The first test file run against `56596f36`'s route: **6 failed, 3 passed (9)**. The first test's
check that GET returns `amexAnchor` and `amexCleanupDoneAt` passed; it failed at the read after the PUT
(`expected undefined to deeply equal { balance: 4321.09, … }`).

## The consequence

### Amex: the anchor refresh has not run in production since 2026-05-03

> ⚠️ **Correction (M1).** The first version of this note said a lost `amexAnchor` let the next Amex refresh overwrite a
> hand-edited debt balance, and that the refresh rebuilt the anchor. **Both are false in production.** The refresh has
> thrown on every Amex Plaid sync since it was added, so it neither moves a debt nor writes an anchor.

**Why it throws.**
- `refreshAmexAnchor` finds the Amex debt with `` sql`${debtsTable.plaidAccountId}::text = ANY(${amexPlaidAccountIds})` ``
  (`amexAnchor.ts` :113, since `6a5dd722`, Task #140, 2026-05-03).
- The query only runs when some owner Amex transaction has a `plaid_account_id`. Drizzle binds each element of the JS
  array as its own parameter, so Postgres gets `ANY(($2))` or `ANY(($2, $3))`, not an array.
- Reproduced here with a throwaway test, not committed. Debt balance 10.00, then `refreshAmexAnchor(owner, db, { adopt:
  false })`:

| Owner's Amex transactions | Result | Debt after | Anchor after |
|---|---|---|---|
| one `plaid:amex` row, one account id | **throws 22P02** `malformed array literal: "ext-acct-a"` | 10.00 | none |
| two rows, two account ids | **throws 42809** `op ANY/ALL (array) requires array on right side` | 10.00 | none |
| one legacy `amex` row plus one `plaid:amex` row | **throws 22P02** | 10.00 | none |
| one legacy `amex` row, no account id | no throw | **100.00** | written, from the sum |

**Why nobody saw it.**
- Plaid sync always stores the account id (`plaidAccountId: t.account_id`, `plaidSync.ts` :1560, :1734, :3645, :3667).
- Both sync callers wrap the refresh in an empty `catch` (`plaidSync.ts` :2058-2061 and :2419-2423).
- So on a Plaid-linked Amex household **the refresh fails on every sync, silently**.

**So, for an `amexAnchor` lost to a PUT:**
- **It is gone for good.** Nothing rebuilds it: the refresh throws before its write. In production an anchor can only
  have come from POST `/amex/anchor`, or from a refresh that ran before any Plaid Amex rows existed.
- **No debt balance is overwritten**, hand-edited or not. That claim in the first note was wrong.
- **The real effects are in GET `/amex/anchor`,** which answers from the Plaid liability balance first. Only when Plaid
  has none:
  - with a debt row, `asOf` can no longer advance past `debt.updatedAt`;
  - with no debt row either, the answer falls from the saved anchor to `computed` (the transaction sum);
  - **a balance the user pinned with POST `/amex/anchor` is lost** and can only be re-entered by hand.

**The legacy name-fallback path is an existing bug (review H1). This fix does not change it.**
- It runs only when no owner Amex transaction has an account id: legacy workbook `amex` rows only.
- It then matches the first debt whose name matches `/amex|american express/` and writes the **all-card** transaction sum
  into it (the last row of the table above: 10.00 became 100.00).
- It **ignores a POST pin**. A pin is `{ balance, asOf }` with no `lastAutoBalance`, so `priorAuto` is undefined and the
  hand-edit check passes. It overwrites both the debt and the pin.
- **Workbook re-import (inferred from the code, not run).** `workbookImporter.ts` :600 calls
  `refreshAmexAnchor(userId, tx, { adopt: true })` inside its transaction with no `catch`. A re-import for a household
  that has Plaid Amex rows would therefore hit the same throw and **abort the whole import**.

> ⚠️ **Do not fix only the throw.** Correcting the `ANY(...)` binding switches this writer on for every Plaid Amex
> household at the next sync. Every row whose anchor was lost to a PUT, or holds a POST pin (no `lastAutoBalance`), has
> `priorAuto` undefined. **The first sync would overwrite that household's Amex debt balance with the all-card
> transaction sum**, hand edits included. That change needs Brad's decision first.

### Budget: the two gates re-run one-time passes that rewrite data

The reviewer reproduced both through the real routes on main's code. The May 2026 one is reproduced again here by the
end-to-end test (test 16), run with the fix removed.

**`budgetMay2026AmountsV1` lost: the next May 2026 read resets hand-edited May planned lines.**
- **What the reset did.** After one web allowance save, the next read of May 2026 reset a hand-edited **Misc / Buffer**
  line from **$999.00 to $237.58**. Test 16 without the fix failed on exactly that line.
- `reconcileMay2026Amounts` writes the hard-coded amounts for the 24 listed categories: always for manual categories,
  and for auto ones unless already equal (`budget.ts` :762-845).
- **It also re-pins May 2026** (`budget_months.pinned = true`, :841), undoing `scripts/clear-budget-pinned-state.ts`
  (#777).
- **Nobody has to open May.** Opening the Budget page on April or June 2026 is enough: the page prefetches the months
  on either side (`pages/budget.tsx` :290-306).

**`budgetCategoriesV2` lost: every deploy re-runs the category consolidation.**
- **What a re-run did.** After a simulated restart the reviewer saw:
  - Groceries' `sortOrder` went from **7 back to 309**;
  - a user-created **"Gaming subs"** category was **deleted**, and its **$50.00** September line moved into
    **Subscriptions**.
- **Any category named like a legacy name is merged and deleted.** The map has 44 names
  (`BUDGET_CATEGORY_MIGRATION_MAP`, `lib/budgetSeed.ts` :385), and "Gaming subs" is one of them. The merge re-points
  the category's transactions, mapping rules, recurring items and Avalanche extra category, and sums its budget lines
  into the target.
- **The re-run also resets group and order** on every seed-named category.
- **Why every deploy.** The run is gated only by a once-per-process set (`oneTimeEnsuresDone`, `budget.ts` :279,
  :1621). That set is empty after every Render deploy, and the landing warmup prefetches the current budget month
  (`hooks/useLandingWarmup.ts` :90-94). **Once the key is lost, every deploy re-runs the migration** on the first page
  load.

**`amexCleanupDoneAt` lost:** the next GET `/amex/anchor` runs `dedupePlaidAccountsForUser` again, then re-stamps. It was
built to repeat; on a clean household it finds nothing.

## The fix (merged, unchanged here)

**The route keeps the stored value of every server-owned key and never takes one from the request**
(`artifacts/api-server/src/routes/settings.ts`).

- The keys live in one named, commented constant, `SERVER_OWNED_PREFERENCE_KEYS`.
- `keepServerOwnedPreferences(stored, incoming)`:
  - starts from the request's preferences exactly as sent;
  - drops any server-owned key the request carries;
  - copies each server-owned key the row holds.
- Only these four keys are merged. Nested maps are still replaced, and user keys left out of the body are still dropped.
- **Only when the body has `preferences`**, the PUT reads the row `FOR UPDATE` inside a transaction, then writes. A
  server write still in flight makes the PUT wait, so the PUT writes the server's new value rather than the one it read
  before (test 15 fails without the lock).
- **`preferences: null` or `{}`** clears the user's keys and keeps the server's. The column stays `null` only when the
  row held no server key. No web caller sends either.

**Why this option, not adding the keys to the spec as optional:**
- **A stale browser copy would win.** `{...prev}` would write back whatever anchor or gate values the page loaded with.
- **Any client could plant or clear the budget gates**, re-running or skipping a one-time data pass.
- **A client that sends only part of the preferences** (no spread) would still delete the keys.
- **Server internals would leak** into the generated zod and React client types.
- The route change touches one file. POST/DELETE `/amex/anchor`, unchanged, remain how a client sets or clears the
  anchor.

## Figures that move

**None.** No number is computed in PUT `/settings`, and the follow-up changes no source. From the merge on, a settings
save no longer re-arms the May 2026 reset or the category consolidation.

## Must not change

- **A PUT without `preferences` leaves the column alone** (behaviour on main; tested).
- **Nested maps are replaced, not merged.** Removing a week from `weeklyAllowanceOverrides` removes it (tested).
- **User keys stay replace-on-PUT.** A user key the body leaves out is dropped (tested). This is not a general merge.
- **A client cannot plant a server key** the row does not hold, and cannot clear one by sending `null` or `false`
  (tested).
- Non-object `preferences` is a 400 (tested). The response is still the updated row.
- `refreshAmexAnchor`, POST/DELETE `/amex/anchor`, the heal and both budget gates are untouched. **In particular, the
  `ANY(...)` throw is left as it is** (see the warning above).
- No spec, codegen, web, DDL or data change.

## Residuals

1. **Keys already lost in production stay lost.** No backfill, by design.
   - A lost `amexAnchor` or POST pin is not rebuilt by anything.
   - If `budgetCategoriesV2` is already gone, **every deploy until someone restores the key** re-runs the category
     consolidation.
   - If `budgetMay2026AmountsV1` is gone, the next April, May or June 2026 budget view resets May.
   - This fix stops new losses. It does not re-arm the gates.
2. **Proposed read-only production check.** Not run: no production access on this task. It shows which households are
   exposed now:

   ```sql
   -- which of the four server-owned keys each settings row still holds
   select user_id,
          preferences ? 'amexAnchor'                        as has_amex_anchor,
          (preferences -> 'amexAnchor') ? 'lastAutoBalance' as anchor_from_refresh,
          preferences ? 'amexCleanupDoneAt'                 as has_cleanup_stamp,
          preferences ? 'budgetCategoriesV2'                as has_categories_gate,
          preferences ? 'budgetMay2026AmountsV1'            as has_may_gate
     from settings;

   -- whether May 2026 has been re-pinned since clear-budget-pinned-state (#777)
   select household_id, pinned
     from budget_months
    where month_start = '2026-05-01';
   ```

   - A missing gate means the matching budget pass is armed.
   - `has_amex_anchor` with no `anchor_from_refresh` is a POST pin, which the warning above says a query fix would
     overwrite.
3. **`refreshAmexAnchor` is broken for every Plaid Amex household** (22P02 / 42809, swallowed), and **workbook re-import
   probably aborts** for such a household (inferred). Existing bugs, not changed; fixing them needs Brad's decision per
   the warning.
4. **The server writers themselves read, modify and write without a lock.** That covers the refresh, the heal,
   POST/DELETE anchor and both gates. A server write that read the row before a PUT committed can still write the PUT's
   user change away. The race predates the fix; the PUT's own lock (test 15) covers only the other direction.
5. **The guard sees writers of today's shapes only** (a `*prefs` spread with added keys, `delete (<…prefs>).key`,
   `jsonb_set(preferences, '{key}', …)`). A writer shaped otherwise is not seen. The guard's first test fails if it
   stops seeing a writer it sees today.
6. The spec lists four user keys (`amexExcludedTxnIds`, `dismissedDetectedSubs`, `recurringReviewSince`,
   `recurringChargeReview`) that no web or server code writes today. Nothing to do.

## Tests

`artifacts/api-server/src/__tests__/settingsPreferencesServerKeys.integration.test.ts`, through the real settings and
budget routers (`createTestApp`, mocked auth, real Postgres). Rows are seeded the way the server writes them. The
web-style saves do GET `/settings`, then PUT `{...prev, ...patch}`.

Columns:
- **fix removed:** this branch's route with the one `keepServerOwnedPreferences(...)` call replaced by the raw
  `preferences`, which is main's behaviour before the merge.
- **lock removed:** `.for("update")` deleted.
- **fix:** the merged route.

| # | Test | fix removed | lock removed | fix |
|---|---|---|---|---|
| 1 | allowance-override save keeps `amexAnchor`, `amexCleanupDoneAt`, both gates (and GET returns them) | fail | pass | pass |
| 2 | `amexCardCadence` change keeps `amexAnchor` | fail | pass | pass |
| 3 | removing a week from `weeklyAllowanceOverrides` removes it | fail¹ | pass | pass |
| 4 | a user key left out of the body is dropped; server keys kept | fail | pass | pass |
| 5 | PUT without `preferences` leaves preferences untouched | pass | pass | pass |
| 6 | a stale `amexAnchor` / `amexCleanupDoneAt` in the body never overwrites the stored one | fail | pass | pass |
| 7 | server keys sent as `null` / `false` are ignored | fail | pass | pass |
| 8 | a server key the row does not hold cannot be planted | pass | pass | pass |
| 9 | `preferences: {}` clears user keys, keeps server keys | fail | pass | pass |
| 10 | `preferences: null` clears user keys, keeps server keys | fail | pass | pass |
| 11 | `preferences: null` on a row with no server keys stores `null` | pass | pass | pass |
| 12 | first PUT with no settings row creates it with the preferences sent | pass | pass | pass |
| 13 | array, string or number `preferences` → 400, nothing changes | pass | pass | pass |
| 14 | a raw-JSON `__proto__` key is stripped, never stored (checked with `preferences ? '__proto__'`) | fail¹ | pass | pass |
| 15 | **row lock:** an uncommitted server anchor write makes the PUT wait (not settled after 400 ms); after commit the row holds the server's new anchor **and** the PUT's user change | fail | **fail²** | pass |
| 16 | **end to end:** seed, May 2026 read, hand-edit Misc / Buffer to 999.00 and unpin May, web allowance save, May read again: every May line and the pin unchanged | **fail³** | pass | pass |
| 17 | guard: the scan still sees a write of each server-owned key | pass | pass | pass |
| 18 | guard: every preference key the server writes is server-owned or in the spec | pass | pass | pass |
| 19 | guard: no key is both server-owned and in the spec | pass | pass | pass |

1. Tests 3 and 14 failed only on their server-key assertion. The week removal and the `__proto__` strip themselves work
   without the fix.
2. With the lock removed, the PUT read the old anchor before the server write committed, waited on the row at its
   update, then wrote the old anchor back: `expected { balance: 5000.5, … }`, received `{ balance: 4321.09, … }`.
3. Without the fix, Misc / Buffer's May line came back as `237.58` instead of `999.00`.

**Guard checked against a planted writer.** A throwaway `src/lib/zzGuardProbe.ts` built
`{ ...(prefs ?? {}), someNewServerFlag: true }`. Test 18 failed with
`src/lib/zzGuardProbe.ts:3 writes preferences.someNewServerFlag`; tests 17 and 19 passed. The probe was removed.

## Verification

The follow-up ran in a worktree off `origin/main` (`7b922568`), against a private test database.

| Gate | Result |
|---|---|
| Test file, fix in place | **19 passed (19)** |
| Test file, fix removed | **11 failed, 8 passed (19)** |
| Test file, lock removed | **1 failed (test 15), 18 passed (19)** |
| Guard, planted unlisted writer | test 18 failed naming the file and key; 2 passed |
| `pnpm run typecheck` | exit 0 |
| Full API suite (`vitest run`, `TZ=UTC`) | **130 files passed; 1123 passed, 7 todo (1130)** |

- **Not re-run for the follow-up:** web suite, build and entry graph, codegen. No source, web or spec file changed. On
  the first branch they were: web **119 files, 933 passed**; build exit 0; landing **572.5 KB** of 580 KB; codegen
  clean.
- **Not verified:** production. No production read or write was made (see Residual 2). The workbook-import abort is
  inferred from the code, not run.
