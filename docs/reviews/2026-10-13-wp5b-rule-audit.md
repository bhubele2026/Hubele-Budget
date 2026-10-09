# WP5b — mapping-rule audit trail

Branch `fin/wp5b-rule-audit`, from `origin/main` 8b869e79, with `origin/fin/integration` (WP7a, e94016de) merged in. Plan: `ancient-swimming-book.md`, root cause 6, WP5b.

- **Implemented:** everything below, on the branch.
- **Tested:** API integration, web component tests, fixture preview shots (1280×800, 390×844).
- **Deployed:** no.
- **Enabled:** nothing is behind a flag. No AI, SMS, sync or automation setting changed.

## Root cause (base tree, 8b869e79)
- `mapping_rules` had no `updated_at` and no history (`lib/db/src/schema/index.ts:673-691`).
- Every rule write left no trace:
  - `routes/mapping.ts:73` POST, `:429` PATCH, `:456` DELETE, `:187-200` reorder.
  - `routes/budget.ts:1271` the seed loop, `:609` the legacy category merge.
  - `routes/transactions.ts:608` the recategorize-by-pattern `ruleId` re-point.
  - `lib/workbookImporter.ts:249` wipe, `:392` and `:432` re-insert.
  - `lib/importSnapshot.ts:163-176` the restore (wipe + re-insert).
  - `scripts/src/recategorize.ts:425` through `lib/db/src/mappingRuleUpsert.ts:40`.
- So when the seeded "EXACT SCIENCES → Hannah's paycheck" rule (`lib/mappingSeed.ts:8`) was most likely re-pointed to Dining by the pre-3df2aa68 hand-filing flow, nothing could say when, by what, or from where.

## What changed

### Database (migration `0170_mapping_rule_history.sql`, README row 0170s)
- `mapping_rules.updated_at timestamptz` (nullable; NULL = not edited since history began). No backfill.
- `mapping_rule_history`: `id, household_id (FK, cascade), rule_id, action, actor, previous jsonb, next jsonb, note, created_at`.
  - `action` CHECK: created, updated, deleted, reordered, seeded.
  - `rule_id` has no FK on purpose: a deleted rule keeps its history.
  - Index `(household_id, rule_id, created_at)`.
- Drizzle: `mappingRulesTable.updatedAt`; `mappingRuleHistoryTable` in `schema/categorization.ts`.
- `schemaMigrations.integration.test.ts` replays 0170 on a pre-migration `mapping_rules` copy (added to `ADDED_COLUMNS`).

### The audit module (`artifacts/api-server/src/lib/mappingRuleAudit.ts`)
- `recordRuleChange(exec, …)` / `recordRuleChanges(exec, …)`: one row per changed rule, in the caller's transaction.
- Refuses a change that does not fit its action (a "created" with a previous state, a "deleted" with a next one, an edit missing a side, no actor).
- `actor`: the user id, `seed`, `script:<name>`, or `system`.
- `listRuleHistory`: newest first, at most 100, `truncated` when there were more.

### Every writer now records, in the same transaction as the write
| Writer | Action | Stamps `updated_at` |
|---|---|---|
| POST /mapping-rules | created (with the body's `note`) | no |
| PATCH /mapping-rules/:id | updated (with `note`) | yes |
| DELETE /mapping-rules/:id | deleted | n/a |
| PUT /mapping-rules/reorder | reordered, only rules whose priority moved | **no** |
| recategorize-by-pattern `ruleId` | updated, note "Re-pointed together with a bulk move of past charges." | yes |
| Seed loop | seeded, actor `seed` | no |
| Legacy category merge | updated, actor `system` (unreachable today, see below) | yes |
| Workbook import | deleted (wipe) + created (re-insert, new ids) | no |
| Snapshot restore | the difference: deleted / created (original ids) / updated | keeps the snapshot's value |
| `scripts/src/recategorize.ts` | created / updated, actor `script:recategorize` | yes on update (in `upsertMappingRule`) |

- **Why a reorder is not an edit:** the first reorder rewrites every priority (STEP 10 from a new base). Stamping it would mark every rule "edited" after one arrow click and bury the one re-pointed rule. It is still recorded.
- **What an edit is:** a change to the rule's pattern, match type, category or priority made to that rule directly.
- PATCH and the re-point lock the rule (`FOR UPDATE`) while comparing. Reorder locks the household's rules and reads them inside its transaction.

### Spec + codegen
- `MappingRuleInput.note` (optional, nullable, ≤ 500): kept in the history, never on the rule.
- `MappingRule.updatedAt` (optional, nullable, date-time).
- `GET /mapping-rules/{id}/history` → `MappingRuleHistory {ruleId, entries[], truncated}`. Tagged `mapping, features`: the page imports the hook from `/features`, never the main module.
- CI-style codegen; a second run leaves `git status` clean.

### Mapping Rules page (lazy route)
- "edited <date>" on an edited rule, on the household calendar (`shortDateOfInstant`).
- A History control on every rule. Desktop: an icon chip beside the category. Phone: a "History" chip on a third line, so the pattern and category keep their width.
- The popover: the query mounts only while open (`staleTime: 0`). It reads in words:
  - who: you / another household member / H2's starter rules / a maintenance script / H2;
  - what: before → after per field; a create shows the state; a delete shows "Was: …";
  - a category that no longer exists reads "a deleted category";
  - the note in quotes.
- Empty, loading, failed (with Retry) and capped states say so.
- The edit row gains "Why (optional) — kept in the rule's history", sent as the PATCH `note` only when filled in.

## Behaviour that changes (no money moves)
- POST, PATCH and DELETE now run in a transaction with their history row.
- A PATCH that changes nothing no longer issues an UPDATE. Same response; no stamp, no row.
- Reorder writes only the rules whose priority moves. Same resulting priorities and response.
- The `ruleId` re-point skips a rule already on the target. Same end state.

## Figures that move
- **None.** No amount, total, category outcome or categorization input changes.
- Categorization reads no new column. The rule writes are the same writes; history rows are extra.
- On screen: "edited <date>" on rules edited after deploy (none at deploy: `updated_at` starts NULL), and a History control per rule.

## Tests
- `mappingRuleHistory.integration.test.ts` (23 cases) drives every writer above except the category merge, plus:
  - same transaction proven by Postgres: history `created_at` = the rule's `created_at` (POST) / `updated_at` (PATCH, re-point);
  - no-op PATCH, omitted vs explicit-null fields, foreign rule 404, rejected (excluded category, 501-char note) writes nothing;
  - reorder records only the moved rule and stamps nothing; a repeat records nothing;
  - history read: newest first, `byYou` per viewer, another household sees none, non-uuid 400, cap at 100 with `truncated`;
  - import then restore reads as one story under the original id;
  - `upsertMappingRule` hands back before/after; the DB CHECK refuses an unknown action.
- Mutation check: removing the reorder skip and the PATCH stamp fails 3 cases.
- `mappingRulesHistory.test.tsx` (9): edited date on the household calendar (03:30 UTC Oct 13 reads Oct 12), popover fetches nothing closed and that rule's history when open, the words, empty/failed/loading/capped, the note in the PATCH body only when filled in.
- Gates (merged tree): root typecheck ✓; API suite 240 files, 2609 passed, 2 todo; web 206 files, UTC 1880 + 3 skipped, Chicago 1881 + 2 skipped; build ✓; landing JS 621.8 KB (unchanged, cap 622); `pnpm audit --prod` 0 unignored high (the known ignored `braces` advisory).

## Fixture preview
- `normal` scenario; three rules made through the fixture API, one edited with a note, then a reorder.
- Shots: `<lead scratchpad>/dash-shots/wp5b-after/normal-mapping-rules/` (desktop/phone × rules/history + `report.json`).
- Geometry: no horizontal scroll at 390 or 1280; the popover stays inside the viewport with a 12 px gutter; no console errors.
- The first phone shot showed the pattern squeezed to one letter by the extra icon chip; fixed by moving the control into the pattern column (commit c15abd79).

## For the owner (WP5a table 2, if the seed rule is flagged)
- Mapping rules → the EXACT SCIENCES rule → Edit → category back to the paycheck → "Why (optional)" → Save.
- History then shows: Edited by you · Category: Dining & Coffee → Hannah's paycheck (Exact) · the note.
- This fixes future filings only. Past rows stay Brad's one-at-a-time "Set category" (WP5a table 1).

## Not verified
- The migration on production: replayed only in the test (scratch schema) and pushed to test DBs.
- The historical re-point itself: history starts empty; the WP5a SQL is the only evidence for the past.
- The legacy category merge: recorded, but unreachable (a rule on the old category keeps that category in place), so no test.
- `scripts/src/recategorize.ts` end to end (a CLI); its helper's contract is tested.
- Concurrency of the `FOR UPDATE` paths under load.
