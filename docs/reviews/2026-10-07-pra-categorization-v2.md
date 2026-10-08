# PR-A — categorization engine v2

Branch `reinvent/pra-categorization-v2` · base `origin/main` 5bee6756 (PR-0 merged) · migration `0020_categorization_v2.sql`.

## The owner's decision

- Code computes every figure; a model may classify, but its output is validated by code and **locked rows never move** (CLAUDE.md §1, 2026-10-07).
- Transfers are never written automatically (#666).
- `mapping_rules` become **user-authored only**: the 2-token auto-rule that `PATCH /transactions/:id` used to create (and the silent repoint of matching rules) is removed. Corrections teach `merchant_memory` instead; past rows move only on an explicit request.
- The MODEL stage is an interface here (`ModelStage`, `NullModelStage`). AI-1 plugs it in. Model answers are clamped to the provisional band (≤ 0.899) until the owner flips `modelAutoCategorize`.

## The pipeline

| # | Stage | Evidence | Confidence | Band |
|---|---|---|---|---|
| 1 | locked | `category_locked_by_user` | — | skipped entirely; no decision row (round 2: the flag is the audit) |
| 2 | memory | `merchant_memory` by `merchantSignature`; merchant_amount > merchant_account > merchant; only memory learned before the row arrived | 0.92 (count ≥ 3) · 0.75 | auto · provisional |
| 3 | rule | household `mapping_rules`; order priority ↓, pattern length ↓, created_at ↑, id | 0.95 (≥ 2 words) · 0.85 (1 word) | auto · provisional |
| 4 | recurring | active `recurring_items`, `descriptionsFuzzyEqual` name, amount within max($25, 25%) | 0.90 (within max($1, 1%)) · 0.70 | auto · provisional |
| 5 | inherited | posted row paired with a replaced pending row (`pairPendingWithPosted`) → `effectiveFiling` written | 0.95 | auto |
| 6 | heuristic / refund | card payment (rules 8/9), transfer / bank noise (9b, PFC TRANSFER_*), refund (same signature, ≤ 60 days, ≤ the outflow) | 0.50 / 0.55 | queue only; `is_transfer` never written |
| 7 | model | `ModelStage` (AI-1) over `ambiguous` | ≤ 0.899 | provisional · queue |

Bands: auto ≥ 0.9 writes `category_id`; provisional 0.6–0.9 writes it, sets `category_provisional` and queues; < 0.6 writes nothing and queues.

**What the engine may write** (`engineMayWrite`, tested): never a locked row; a row with no category; a row this sync just inserted (its category is the sync's own insert-time rule fill — detected with `xmax = 0` on the upsert's `RETURNING`); or a row whose current category came from an engine decision that nobody accepted and that is more than 30 days old. A category with no decision on record (pre-PR-0 hand pick, import, legacy rule fill) is never moved — we cannot tell who chose it.

**Round 2 order: memory before rule.** A memory row exists only because a person corrected or confirmed that merchant, so it is the more specific, more recent signal; a rule is a broad pattern. Memory keeps its gate: it applies only to rows that arrived after it was learned.

**Inherited order.** `inherited` runs fifth but overrides an earlier automatic pick exactly where the read-time `effectiveFiling` would (a hand-filed pending row beats a rule — owner decision 14). This keeps stored = counted (test: write ≡ read). It writes the filing (category, allowance flags, bucket, reimbursable, debt) but never `is_transfer`; the read-time helper stays.

**Idempotent.** `input_hash = sha256(description|amount|account|pfc_primary|pfc_detailed|pending|locked|rulesVersion|memoryVersion|recurringVersion|replaced filing)`, unique `(transaction_id, input_hash)` + `ON CONFLICT DO NOTHING`, and a decision identical to the row's latest live one is not re-recorded. Versions are content hashes (an in-place rule edit has no `updated_at` to bump).

## What changed

- **Tables** (`lib/db/src/schema/categorization.ts` = `0020`): `category_decisions`, `merchant_memory`, `transaction_splits`; `transactions.{category_provisional, refund_of_txn_id, plaid_removed_at, splits_invalid}`. The four columns sit in `transactionsTable` (schema/index.ts) — drizzle cannot add columns from another file.
- **Engine** `artifacts/api-server/src/lib/categorizer/` (`index.ts` batch + `applyDecision`, `decide.ts`, `stages/*`, `context.ts`, `memory.ts`, `userDecisions.ts`, `review.ts`, `splits.ts`, `modelStage.ts`).
- **Sync** (`plaidSync.ts`): after dedupe and `removed`, `reconcileSplitsAfterSync` + `runCategorizationBatch` over every id the upsert returned (all accounts), deterministic only, non-fatal. `removed` delete also spares locked and split rows; any removed id still on file is stamped `plaid_removed_at` and queued "The bank removed this charge."
- **Routes**: `POST /categorization/run` (owner), `GET /categorization/review`, `POST /categorization/review/:id/{accept,skip,correct}`, `POST /category-decisions/:id/undo`, `GET|PATCH|DELETE /learned-rules[/:id]`, `POST /learned-rules/:id/apply-retroactively`, `GET|POST|DELETE /transactions/:id/splits`. OpenAPI + codegen committed.
- **Writers**: PATCH/POST/bulk-update/recategorize-by-pattern/uncategorize-by-ids record `user` decisions; PATCH also learns memory and returns `retroactiveCandidates` (never applied). `repointedRules`/`ruleAction` stay in the PATCH response, always empty — the classic toasts do not fire.
- **Fixes folded in**: `isTransferCategory`/`isExcludedCategory` scope by household (a member's pick of the owner's Transfer category now flips `isTransfer`); deterministic rule tie-break (`compareRules`, also used by `loadUserRules`, so the sync's insert-time fill agrees with the rule stage); dedupe merge and the pending→posted filing carry `category_locked_by_user` with a carried category (PR-0 residual); dedupe moves a loser's splits to a survivor that has none; `uncategorize-by-ids` resets the lock (PR-0, confirmed) and now `category_provisional` too.
- **Splits**: replace-all; Σ = parent to the cent, same sign, 2–20 parts; parent keeps its category and is locked. After a sync: drift < $1 → proportional rescale (exact to the cent), ≥ $1 → `splits_invalid` + queued; the parent counts whole meanwhile. Readers: `expandSplits` feeds `buildSpendingFacts.byCategory`/`monthlyTrends` and `aggregateBudgetMonth.byCategory` only. The classic split dialog is untouched.

## Figures that move

- **Uncategorized shrinks only for unlocked rows with no category** that a stage fills. On the synthetic fixture (62 rows, 60 uncategorized): 25 filled in the auto band, 13 in the provisional band (category written + queued), 12 queued with no write, 10 untouched. Rows the sync already filled by rule at insert are unchanged in value; 1-word-rule rows additionally carry `category_provisional = true` and appear in the queue (a flag, no figure).
- **Inherited writes move no figure**: readers already counted the pending filing at read time; the test pins write ≡ read.
- **Splits move category totals only, only for rows that have splits** (none exist until the new app or a test creates them). Every other figure — real spend, counts, allowance rows — is unchanged (test compares the whole facts object minus `byCategory`/`monthlyTrends`).

## Must not change

- Locked rows (skipped by the batch; property test: 40 random steps of PATCH / run / undo / apply-retroactively / queue-correct; every locked row keeps its category). `applyDecision` refuses a locked row; the row UPDATE also carries `category_locked_by_user = false`.
- Spine spend totals and the golden ledger: `spineParity` and `forecastLedger.golden` green under `CI=true` (no splits, no memory in their fixtures; the engine never moves a legacy category).
- `is_transfer`: never written by the engine.

## Writer audit — every writer of `transactions.category_id`

| Writer | Decision emitted | Flags set |
|---|---|---|
| `PATCH /transactions/:id` (category in body) | `user` (+ merchant memory, retroactive candidates reported) | lock = pick ≠ null; provisional false; `isTransferUserOverridden` (unchanged rule) |
| `POST /transactions` with `categoryId` | `user` | lock true |
| `POST /transactions` without `categoryId` (rule auto-fill) | none — residual | — |
| `POST /transactions/bulk-update` (category) | `user` per row | lock = pick; provisional false |
| `POST /transactions/recategorize-by-pattern` | `user` per row | lock (relock semantics unchanged); provisional false |
| `POST /transactions/uncategorize-by-ids` | `user` (category null) | lock false; provisional false |
| `POST /categorization/review/:id/accept·correct` | `user` + resolution on the answered decision | lock true; provisional false; `isTransferUserOverridden` true (PATCH semantics) |
| `POST /category-decisions/:id/undo` | stamps `undone_at` | provisional false; lock restored for a `user` undo |
| `POST /learned-rules/:id/apply-retroactively` | `user` per row | lock true; provisional false |
| Engine `applyDecision` (sync end, `POST /categorization/run`) | rule / memory / recurring / inherited / model | provisional per band; inherited carries the pending lock |
| Plaid sync insert (`values.categoryId` = rule) | engine decision at end of the same sync | — |
| Plaid gap backfill insert (`runGapBackfillForItem`) | none — residual (next run/job) | — |
| Dedupe merge (`mergeStatePatch`) | none (carries an existing filing) | carries lock with the category |
| Workbook importer / import-snapshot restore | none — residual | importer locks Target rows (PR-0) |
| `routes/budget.ts` debt-payment backfill; category merge re-point | none (bookkeeping) — residual | — |
| `POST /transactions/:id/splits` | none (category unchanged) | lock true; `splits_invalid` false |

## Tests

New: `categorizerEngine.integration.test.ts` (18: bands, correction beats rule (round 2), tie-break pure + DB order, band writes, idempotency, `applyDecision` refuses locked, 30-day / legacy rule, refund linking, inherited write ≡ read, PATCH → user decision + memory + retroactive-never-implicit + explicit apply, memory scope evolution, undo exact, accept/skip/409, locked-never-move property, household isolation 404, member corrects / owner-only run, household-scoped system categories), `transactionSplits.integration.test.ts` (6), `categorizerEval.test.ts` (1, prints the confusion table), `categorizerCarries.test.ts` (4), two new cases in `plaidSyncPreservesManualWork` (removed guard: stamp + queue, split parent kept, idempotent notice; end-of-sync engine: rule + memory). Changed: `categorization.integration.test.ts` — the nine tests that pinned the removed auto-learn flow are replaced by three (no rule created or repointed; #479 transfer flag still clears; recategorize-by-pattern still bulk-flips); `supersededPendingWindow` (filing now carries `categoryLockedByUser`); `schemaMigrations` / `bootMigrations` (scratch copies keep indexes so 0020's FKs resolve; new columns listed; file list read from disk).

**Fails before (parent 5bee6756):** every new file imports modules that do not exist on the parent. Behaviourally: the PATCH no-rule test fails (parent inserts/repoints a rule); the member Transfer test fails (parent looks the category up by actor → `isTransfer` stays false); the DB tie-break test fails (parent sorts by priority only → insertion order); the removed-guard split test fails (parent deletes a split parent with no category); `supersededPendingWindow` fails on this branch's code without its updated expectation.

**Eval (synthetic, 62 rows, 5 injection-looking):** precision 0.975 (39/40 decided), queue-rather-than-wrong 0.984. The one miss is honest: a 1-word rule `PIZZA` files "PIZZA STONE SUPPLY" as Dining (provisional, so it is queued).

## Mutants (targeted test file run per mutant)

| Mutant | Result |
|---|---|
| M1 auto band 0.9 → 0.85 | killed |
| M2 `applyDecision` ignores the lock | killed |
| M3 memory applies to rows older than it (implicit retroactive) | killed |
| M4 inherited never overrides an earlier stage | killed |
| M5 refund window 60 → 180 days | killed |
| M6 tie-break drops pattern length | killed |
| M7 split Σ tolerance $1 | killed |
| M8 rescale any drift | killed |
| M9 `removed` guard forgets splits | killed |
| M10 system-category lookup by actor | killed |
| M11 undo keeps the created memory | killed |
| M12 accept does not lock | killed |
| M13 engine may move legacy categories | killed |
| M14 split expansion ignores Σ | killed |
| M15 heuristic confidence 0.95 (writes) | killed |
| M16 input hash includes the clock | survives — equivalent by design: the "identical to latest live decision" guard still makes the second run a no-op |

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | green (round 2) |
| codegen (`pnpm --filter @workspace/api-spec run codegen`) | no drift (round 2) |
| classic web suite | 140 files passed, 1 skipped · 1248 tests passed, 4 skipped |
| API suite on `h2budget_test_pra`, serial, `CI=true` | 160 files · 1663 passed, 7 todo, 0 failed (round 2) |
| golden + spine parity + classifier parity (`CI=true`) | 3 files · 42 passed (round 2) |
| `pnpm run build` + `check-entry-graph.mjs` | green · classic landing 575.7 KB / 580 KB; no new hook reaches the classic dist |
| `pnpm audit --prod` | **3 pre-existing advisories** (critical `proxy-addr` via express, high `braces` via http-proxy-middleware, high `compression`); this branch changes no dependency or lockfile — needs its own override PR |

## Residuals

- Gap-backfill inserts, workbook import, snapshot restore, `POST /transactions` rule auto-fill and the budget debt-payment backfill write categories without a decision; the engine treats those rows as legacy (never moved). AI-1's nightly job can record `rule` decisions for them.
- The vanished-pending sweep and the orphan prune (plaidSync, out of this package's scope) still delete an uncategorized pending row that has only splits.
- Undo of a correction that re-pointed an existing memory row disables that row rather than restoring its old category.
- `effectiveFiling` still decides hand-vs-automatic from `isTransferUserOverridden`; a posted row locked by the importer but never overridden could, in theory, read a hand-filed pending category while storing its own (no Plaid twins come from the importer).
- The review flags read up to 20 signature scans per page (fine at `limit ≤ 100`).

## Round 2 (coordinator's routine decisions; the owner was unavailable)

- **Q1 → a correction beats a rule.** Precedence is now locked → memory → rule → recurring → inherited → heuristic → model (`decide.ts`). Memory's "rows that arrived after it was learned" gate is unchanged. New test: after a person files "MOSS CAFE" as Coffee, the next MOSS CAFE row is a `memory` decision (Coffee, provisional) despite the 1-word rule `MOSS` → Dining; the rule still files other merchants, and the older row of the merchant stays where it was.
- **Q2 → no date gate on rules.** `POST /categorization/run` filling older uncategorized rows from newer rules is what a person asks for when they run it. Kept as built.
- **Q3 → locked rows are skipped entirely.** No `locked` decision rows; the flag is the audit. The idempotency test now asserts a locked row has zero decisions. (`'locked'` stays in the `source` check constraint, unused, so a later package can use it without a migration.)

**Figures that moved on the fixture.** One case was added to exercise Q1 ("PIZZA OVEN SUPPLY", which the household corrected to Shopping once, so memory count is 1). Under the round-1 order it would have been a second miss (1-word rule → Dining). Locked rows are now left out of scoring: they are the person's filing, not the engine's.

| | Round 1 | Round 2 |
|---|---|---|
| rows / scored (locked skipped) | 62 / 62 | 63 / 61 (2) |
| decided · correct · wrong | 40 · 39 · 1 | 39 · 38 · 1 |
| precision | 0.975 | 0.974 |
| queue rather than wrong | 0.984 | 0.984 |
| uncategorized filled auto · provisional | 25 · 13 | 25 · 14 |
| queued · untouched | 12 · 10 | 12 · 10 |

The remaining miss is the same honest one: "PIZZA STONE SUPPLY" (no correction yet) → Dining by the 1-word rule, provisional and queued. No production figure moves differently: memory exists only after a person's correction, and it still never moves a row that arrived before it.

## Questions for the owner (answered in round 2 by the coordinator)

1. ~~Should a correction beat a rule?~~ Yes — memory runs before rule.
2. ~~Gate rules by date?~~ No.
3. ~~Keep `locked` decision rows?~~ No — skipped entirely.
