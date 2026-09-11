# PUT /settings kept deleting the preference keys the server writes

Base: `main` = `56596f36`. Branch `fix/settings-preferences-keep-server-keys`. One route changed, one test file added. No
financial logic, no DDL, no data migration, no spec or web change.

## The bug

**Any preferences save from the web deleted four keys the server owns.**

- `settings.preferences` is one jsonb column (`lib/db/src/schema/index.ts` :665).
- PUT `/settings` validates the body with the generated `UpdateSettingsBody`, a plain zod 3 `object`. zod strips every
  key the spec does not list, then the route `.set({...parsed.data})` **replaces the whole column**.
- The server writes four preference keys that are **not in the OpenAPI `SettingsPreferences` schema**:

| Key | Written by | What it does |
|---|---|---|
| `amexAnchor` | `lib/amexAnchor.ts` `refreshAmexAnchor`, POST/DELETE `/amex/anchor` | Saved Amex balance; its `lastAutoBalance` tells a hand edit from the refresh's own write |
| `amexCleanupDoneAt` | `routes/amex.ts` GET `/amex/anchor` | Stamp that the one-shot duplicate-account heal ran |
| `budgetCategoriesV2` | `routes/budget.ts` `migrateBudgetCategoriesV2` | Gate for the one-time category consolidation |
| `budgetMay2026AmountsV1` | `routes/budget.ts` `reconcileMay2026Amounts` (and `scripts/clear-budget-pinned-state.ts`) | Gate for the one-time May 2026 planned-amount reset |

- **How it was triggered.** Every web preferences save sends `{...prev, ...patch}` where `prev` is GET `/settings`'s
  preferences, which do carry the four keys. The spread did not help: the validator removed them before the write.
  - `pages/allowances.tsx` :712 and :741, a per-week allowance override (since `58a7c7c6`, 2026-06-12)
  - `components/avalanche-card-config.tsx` :102, card tier, cadence and name (since `ba09eac3`, 2026-06-27)
  - `pages/settings.tsx` :383 and :410, bucket labels and behaviour trackers
- A grep for writes to `preferences` found no other server-written key. `me.ts` writes a different table.

**Reproduced on main.** The new test file run against `56596f36`'s route: **6 failed, 3 passed (9)**. The first test's
check that GET returns `amexAnchor` and `amexCleanupDoneAt` passed; it failed at line 120, reading the row after the PUT:

```
× an allowance-override save keeps amexAnchor, amexCleanupDoneAt and the budget gates
    AssertionError: expected undefined to deeply equal { balance: 4321.09, …(2) }
× an amexCardCadence change keeps amexAnchor
× removing a week from weeklyAllowanceOverrides still removes it
× a user key left out of the body is still dropped      expected { weeklyAllowanceOverrides } to deeply equal { …(5) }
× a stale amexAnchor in the body never overwrites the stored one
× preferences: null clears the user's keys but keeps the server's      expected null to deeply equal { amexAnchor, … }
```

The 3 that passed on main describe behaviour kept on purpose (see Must not change).

## The consequence

**`amexAnchor` gone: the next Amex refresh overwrites a hand-edited Amex debt balance.**

- `refreshAmexAnchor(owner, db, { adopt: false })` runs after every Plaid sync of the Amex item (`plaidSync.ts` :2058)
  and again after a gap backfill (:2420). It sums the owner's `amex` + `plaid:amex` transactions into `balance`.
- It moves the matched Amex debt's `balance` to that sum only when the debt still equals `lastAutoBalance` (within half a
  cent), meaning nobody edited it since the last auto-write (`amexAnchor.ts` :144-157).
- With the anchor deleted, `priorAuto` is `undefined`, so `matchesAuto` is **true**. If the debt differs from the sum by
  $0.005 or more, the refresh **writes the sum over the hand-edited balance** and stamps `lastBalanceUpdate`. The edit
  is not kept anywhere.
- **The same call rebuilds the anchor** (`{ balance, asOf, lastAutoBalance: balance }`, :170-187). Protection is back
  after one refresh, measured from the overwritten value.
- If the owner has no Amex transactions, the refresh returns early. It neither touches the debt nor rebuilds the anchor.
- Workbook re-import runs with `adopt: true`, which re-anchors whatever the prior anchor was. It is unaffected.
- **Between the loss and the next refresh**, the hand-edited balance is untouched. GET `/amex/anchor` answers from the
  Plaid liability balance first, so it changes only in its fallbacks when Plaid has none:
  - With a debt row, `asOf` can no longer advance past `debt.updatedAt`.
  - With no Plaid liability and no debt row, it falls from `anchor` to `computed` (the transaction sum).
  - A balance the user pinned with POST `/amex/anchor` is lost for good. The next refresh stores the computed sum, not the
    pin.

**`budgetMay2026AmountsV1` gone:** the next read of the May 2026 budget re-runs `reconcileMay2026Amounts`.
- It sets the planned amount of the 24 listed categories for 2026-05-01 back to the hard-coded values: always for manual
  categories, and for auto ones unless already equal.
- It pins May 2026 and re-syncs the managed Avalanche payment line.
- A later hand edit to those May 2026 planned lines is reset.

**`budgetCategoriesV2` gone:** on the first budget read after a restart, `migrateBudgetCategoriesV2` runs again.
- It merges any category that still carries a legacy name into its target and deletes it.
- It resets `group_name`/`sort_order` on every seed-named category, so a group or order change the user made since is
  reverted.

**`amexCleanupDoneAt` gone:** the next GET `/amex/anchor` runs `dedupePlaidAccountsForUser` again, then re-stamps. It was
built to repeat safely; on a clean household it finds nothing.

## The fix

**The route keeps the stored value of every server-owned key and never takes one from the request**
(`artifacts/api-server/src/routes/settings.ts`).

- The keys live in one named, commented constant, `SERVER_OWNED_PREFERENCE_KEYS`.
- `keepServerOwnedPreferences(stored, incoming)`:
  - starts from the request's preferences exactly as sent;
  - drops any server-owned key the request carries;
  - copies each server-owned key the row holds.
- Only these four keys are merged. Nested maps are still replaced, and user keys left out of the body are still dropped.
- **Only when the body has `preferences`**, the PUT reads the row `FOR UPDATE` inside a transaction, then writes. A
  server write that commits between the read and the write therefore waits rather than being written over.
- **`preferences: null`** used to wipe the column. It now clears the user's keys and keeps the server's; the column
  stays `null` only when the row held no server key. No web caller sends `null`.

**Why this option, not adding the keys to the spec as optional:**

- **A stale browser copy would win.** If the page loaded before a Plaid sync, `{...prev}` writes the old `amexAnchor`
  back.
  - The next refresh then compares the debt, which the sync moved, against the old `lastAutoBalance`. It reads its own
    write as a hand edit and leaves the debt alone.
  - It re-anchors to the new sum, which the debt never took, so every later refresh also mismatches.
  - **Auto-updates of the Amex debt would stop for good after one stale save.**
- **Any client could plant or clear the budget gates** and re-run or skip a one-time data pass.
- **A client that sends only part of the preferences** (no spread) would still delete the keys.
- Server internals would leak into the generated zod and React client types, and the change would take codegen plus
  review of generated output. The route change touches one file.
- Always keeping the server's stored value covers the stale-client case the spec option opens. A client that needs to
  set or clear the anchor already has POST/DELETE `/amex/anchor`, which are unchanged.

## Figures that move

**None.** No number is computed in PUT `/settings`. The change decides only which jsonb keys survive a save. Totals,
the spine and every financial query are unchanged; the full API suite, spine parity included, is green.

## Must not change

- **A PUT without `preferences` leaves the column alone** (behaviour on main; tested).
- **Nested maps are replaced, not merged.** Removing a week from `weeklyAllowanceOverrides` removes it (tested).
- **User keys stay replace-on-PUT.** A user key the body leaves out is dropped (tested). This is not a general merge.
- **A client cannot plant a server key** the row does not hold (behaviour on main; tested).
- The response is still the updated row.
- `refreshAmexAnchor`, POST/DELETE `/amex/anchor`, the heal and both budget gates are untouched.
- No spec, codegen, web, DDL or data change.

## Residuals

1. **Keys already lost in production stay lost.** No backfill, by design.
   - The anchor is rebuilt on the next Amex Plaid sync that finds Amex transactions.
   - If a row lacks `amexAnchor` when this deploys and the Amex debt was hand-edited, **that first refresh still
     overwrites the edit**. This fix stops future losses; it does not protect a row that has already lost its anchor.
   - A read-only look at production `settings.preferences` (which of the four keys are present) would say whether that
     is live. Not done here: no production access on this task.
2. **Whether a gate re-run already happened** in production cannot be seen from here. Either would already have reset
   May 2026 planned lines or reverted category group/order.
3. **The server writers themselves read, modify and write without a lock**: the refresh, the heal, POST/DELETE anchor and
   both gates. A server write that read the row before a PUT committed can still write the PUT's user change away. The
   window is narrow, the race predates this change, and it is not addressed here.
4. **Observed while reading, not verified or changed.** `refreshAmexAnchor` matches its debt first by
   `debts.plaid_account_id::text = ANY(<transactions.plaid_account_id>)`. Elsewhere the first holds the internal
   `plaid_accounts.id` and the second the external Plaid `account_id` (see `computeWeeklyPayoff`). So the account match
   likely never hits, and the debt it moves is the first one whose name matches `/amex|american express/`, set to the
   **all-card** Amex transaction sum.
5. The spec lists four user keys (`amexExcludedTxnIds`, `dismissedDetectedSubs`, `recurringReviewSince`,
   `recurringChargeReview`) that no web or server code writes today. Nothing to do; noted because a future writer that
   is not in the spec would be stripped the same way.

## Tests

`artifacts/api-server/src/__tests__/settingsPreferencesServerKeys.integration.test.ts`, through the real settings router
(`createTestApp`, mocked auth, real Postgres). Rows are seeded the way the server writes them. The web-style saves do GET
`/settings`, then PUT `{...prev, ...patch}`.

| # | Test | main | fix |
|---|---|---|---|
| 1 | allowance-override save keeps `amexAnchor`, `amexCleanupDoneAt`, both gates (and GET returns them) | fail | pass |
| 2 | `amexCardCadence` change keeps `amexAnchor` | fail | pass |
| 3 | removing a week from `weeklyAllowanceOverrides` removes it | fail | pass |
| 4 | a user key left out of the body is dropped; server keys kept | fail | pass |
| 5 | PUT without `preferences` leaves preferences untouched | pass | pass |
| 6 | a stale `amexAnchor` / `amexCleanupDoneAt` in the body never overwrites the stored one | fail | pass |
| 7 | a server key the row does not hold cannot be planted | pass | pass |
| 8 | `preferences: null` clears user keys, keeps server keys | fail | pass |
| 9 | `preferences: null` on a row with no server keys stores `null` | pass | pass |

Test 3 failed on main only because its anchor assertion failed; the week removal itself already worked.

## Verification

All run in a worktree off `origin/main` (`56596f36`), against a private test database.

| Gate | Result |
|---|---|
| New test file on main's route | **6 failed, 3 passed (9)** |
| New test file with the fix | **9 passed (9)** |
| `pnpm run typecheck` | exit 0 |
| Full API suite (`vitest run`, `TZ=UTC`) | **126 files passed; 1045 passed, 7 todo (1052)**, spine parity included |
| Web suite (`TZ=UTC CI=true pnpm --filter h2budget exec vitest run`) | **119 files passed; 933 passed (933)** |
| `pnpm run build` | exit 0 |
| `node scripts/check-entry-graph.mjs` | OK: landing **572.5 KB** raw (172.6 KB gz), budget 580.0 KB |
| `pnpm --filter @workspace/api-spec run codegen` | clean: no change to generated output |

Not verified: production. No production read or write was made; see Residuals 1 and 2.
