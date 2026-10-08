# V1 — categorization automation: settings API + stable eligibility

Branch `finish/v1-categorization` · base `origin/main` 2b664f6c · migration `0111_category_decisions_resolved_via.sql`.

## What the reviewer found

- The only auto-filing switch in the new app writes `/me/ui-preferences` (per user). The server never read it.
- `modelAutoCategorize` had no writer and no screen.
- Nothing reported progress toward eligibility.
- The gate ("50 accepted in the last 30 days") could never open for a household whose rules and memory file most charges.

## Why the old gate could never open

- The model only sees what the deterministic stages leave: a few charges a week once rules and memory are trained.
- 50 accepted model answers had to land inside ONE 30-day window. Old judgments expired.
- Only queue accepts counted. A suggestion left standing (the person agreed by not touching it) never counted.

## The new rules, in plain words

- **Judged** = a model suggestion (not undone) that was accepted or corrected — through the queue, by hand, or silently.
- **Warm-up:** 30 judged, lifetime. It never expires. (`MODEL_AUTO_MIN_JUDGED = 30`)
- **Accuracy:** 9 in 10 accepted among the last 50 judged. (`MODEL_AUTO_MIN_ACCEPT_RATE = 0.9`)
- **Hysteresis:** once open, it stays open while the last 20 hold 8 in 10. (`MODEL_AUTO_FLOOR_RATE = 0.8`)
- Below that it closes. It reopens only at 9 in 10 among the last 20 (and the two rules above).
- **Silent acceptance:** a provisional model suggestion standing 14 days, its row still carrying it, not locked → accepted, `resolved_via = 'silent'`. (`SILENT_ACCEPT_DAYS = 14`)
  - Nothing else moves: no row write, no lock, no merchant memory (memory stays a person's act).
  - Runs at the start of every categorize job and in the nightly `monitor.household` pass. Idempotent.
- **Mode:** `off` (AI off, or `autoCategorize` false) · `suggest` (answers stay provisional) · `auto` (owner's switch on AND eligible).

## How "was it open?" is derived

- No new table. `replayGate` walks the judged record oldest first and applies the rules after every judgment.
- Same rows → same answer. An undo removes a judgment from the record, and the replay follows.
- The job and `GET /categorization/settings` both call `evaluateModelGate`. They cannot disagree.

## What changed

- `lib/categorizer/modelGate.ts` — `evaluateModelGate`, `replayGate`, `modeFor`, `requirementsFor`, constants. `loadModelGate` keeps its shape (`autoAllowed = mode === "auto"`).
- `lib/categorizer/review.ts` — `settleSilentAcceptances`, `openReviewCount`, `undoRefusal` (one undo rule for `undoDecision` and the view's `undoable`); skip stamps `resolved_via = 'user'`.
- `lib/categorizer/userDecisions.ts` — hand filings and the answered queue item stamp `'user'`.
- `jobs/handlers/categorize.ts` — settles first, then `evaluateModelGate`.
- `jobs/handlers/monitor.ts` — settles before each household's monitor pass.
- `routes/categorizationSettings.ts` (new) + two lines in `routes/index.ts`:
  - `GET /categorization/settings` — any member. Switches, AI status, engine counts, model mode / requirements / accuracy, last 20 decisions, review count.
  - `PUT /categorization/settings` — household owner only (`403 { error: "owner_only" }`). Writes the owner's `settings.preferences`; creates the row; `jsonb_set` on the sent keys only.
- `lib/db` — `category_decisions.resolved_via text NULL CHECK IN ('user','silent')`; backfill = past person resolutions → `'user'`.
- `openapi.yaml` — the block above; `UiPreferences.autoCategorize` / `modelAutoCategorize` deprecated. Clients regenerated.

### Outside the brief's file list (two lines)

- `routes/settings.ts` — `autoCategorize`, `modelAutoCategorize` added to `SERVER_OWNED_PREFERENCE_KEYS`. Without it a classic `PUT /settings` (zod strips unlisted keys) drops both switches.
- `lib/categorizer/splits.ts` — the split path that closes a notice stamps `resolved_via = 'user'`, like every other person path.

### Departures from the brief

- Column is `resolved_via`, not `resolved_by`: `resolved_by` already exists and holds the actor's user id (or `'system'`).
- PUT checks the HOUSEHOLD owner (as `POST /categorization/run`, `agent.ts`, `money.ts`), not the `requireOwner` middleware: that one checks the app owner's email and answers `"Forbidden: owner only"`, not `owner_only`.

## Tests

| File | Cases |
|---|---|
| `categorizationEligibility.integration.test.ts` (new) | 16: constants; 29/30; 44/50 vs 45/50; window slides; 16/20 holds, 15/20 closes; 17/20 stays closed, 18/20 reopens; hysteresis vs never-opened; modes; row filters (undone, skipped, non-model, future, other household); requirement rows + fifth row; AI/pref modes; silent 14-day boundary; locked / changed / cleared / queue / non-model / other household never settled; idempotent; job settles; monitor settles |
| `categorizationSettingsRoute.integration.test.ts` (new) | 8: member GET + spec shape + defaults; engine counts scoped; recent (newest first, ≤ 20, other household never, undoable, resolvedBy); member PUT 403; body 400s; row created then merged; classic PUT keeps switches; screen and job agree (suggest → provisional, auto → auto, off → provisional) |
| `categorizationJourney.integration.test.ts` (new) | 1, counts at every step: sync → rule + 3 ambiguous → `txn.arrived` → `categorize.batch` → 3 provisional → queue 3 → 3 corrections → memory count 1/2/3 → next charge memory/auto → re-sent rows unchanged → pending posts, keeps locked filing → re-run adds 0 decisions, 1 model call total → undo memory (back to none) and undo a correction (back to the suggestion, unlocked) |
| `categorizeModelStage.integration.test.ts` (changed) | gate block rewritten for the cumulative rule (old window test removed) |

## Fails-before

New tests on the parent's sources (2b664f6c): **4 of 4 files fail** (18 failed, 17 passed; the route file cannot load its router). On this branch: 4 of 4 pass (43 tests).

## Mutants (16 / 16 killed)

| # | Mutation | Killed by |
|---|---|---|
| M1 | warm-up `>=` → `>` | 29/30 table, agree test |
| M2 | accuracy window never slides | window slides, reopen |
| M3 | floor read on the last 50 | floor table |
| M4 | no hysteresis on reopen | 17/20 stays closed |
| M5 | undone decisions count as judged | row filters, model-stage gate |
| M6 | owner's switch ignored in mode | modes, agree test |
| M7 | silent settles a locked row | never-settled case |
| M8 | silent ignores the 14 days | boundary case |
| M9 | silent ignores a changed category | never-settled case |
| M10 | job does not settle | job settles |
| M11 | monitor does not settle | monitor settles |
| M12 | job uses the switch alone, not `mode` | agree test (switch on, 29 judged) |
| M13 | PUT not owner-gated | member PUT 403 |
| M14 | PUT replaces preferences | merge keeps other keys |
| M15 | `undoable` ignores the lock | recent list |
| M16 | correction not stamped `'user'` | journey |

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | green |
| codegen (CI style) | no drift |
| API suite, `h2budget_test_v1`, serial, `CI=true` | 223 files · 2416 passed, 2 todo, 0 failed |
| golden `forecastLedger.golden` under `CI=true` | 12 passed, snapshots unchanged |
| h2 web | 30 files passed, 1 skipped · 475 passed, 4 skipped |
| classic web | 140 files passed, 1 skipped · 1248 passed, 4 skipped |
| `pnpm run build` + entry graphs | green · classic 576.1 / 580 KB · h2 399.9 / 400 KB |
| `pnpm audit --prod` | 1 high (1 ignored by repo config); no dependency or lockfile change |

## Figures that move

- **Money: none.** No amount, total, balance or budget is read or written differently.
- Decisions that may newly auto-file: only after the owner turns `modelAutoCategorize` on AND the record is eligible. Before this package no route could write it (PUT /settings strips it).
- What moves without the switch: provisional model suggestions older than 14 days leave the review queue as silently accepted (their rows keep the category, the provisional flag and no lock). The engine already never re-decides an accepted row.

## Open questions

- Silent acceptances now count as "accepted" priors in `modelPriors.ts` (it reads `resolution = 'accepted'`). The model can learn from its own unchallenged guesses. Exclude `resolved_via = 'silent'` there? (Outside this package's files.)
- Should a silent acceptance also clear `category_provisional` on the row? Left alone here (the brief names the decision fields only).
- The accuracy requirement row shows the opening condition. While hysteresis holds the gate open it can read "not met" with `eligible: true`.
