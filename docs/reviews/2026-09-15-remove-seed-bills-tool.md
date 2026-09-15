# Remove the seed-bills tool

**Branch:** `chore/remove-seed-bills-tool` (from main `2731077`)
**Owner decision (2026-09-15):** remove it. This answers question 1 in `2026-09-11-seed-defaults-once.md`.

## Why

PR-A2 made the starter defaults seed exactly once per household (`seedDefaultsOnce`, marker `defaultsSeededAt`). Two
older paths still re-added bills by name, and PR-A2's note lists both as open residuals (items 1 and 2):

1. `POST /budget/seed-bills` topped up the seed bills and their missing categories, skipping by name. A bill the
   household had deleted has no name to skip, so a call put it back.
2. `scripts/seed_bills_user_<id>.sql`, run from `scripts/post-merge.sh`, did the same for one user.

## What changed

| Path | Before | After |
|---|---|---|
| `POST /budget/seed-bills` (`routes/budget.ts`) | re-adds deleted seed bills and their categories | removed; the router answers 404 |
| `scripts/post-merge.sh` | ran the per-user bill-seed SQL after every merge | step removed; a comment says why |
| `scripts/seed_bills_user_<id>.sql` | the per-user bill seed | deleted (it stays in git history; no force-push) |

Unchanged: `POST /budget/seed-defaults` and the lazy seed. Both still go through `seedDefaultsOnce`. The
`SEED_CATEGORIES`, `SEED_GROUP_ORDER` and `SEED_RECURRING_ITEMS` imports in `routes/budget.ts` stay, because other
code there still uses them.

## Callers

None. The route was never in the OpenAPI spec, and no web code, test or e2e spec called it. A repo-wide search found
only the route, the post-merge step and older review notes. `post-merge.sh` is the dormant Replit hook; Render does not
run it.

## Money and data

- No financial calculation changes.
- No schema change, and no write to production.
- The only behaviour removed is re-adding bills.

## Test

`seedDefaultsOnce.integration.test.ts` gains one test in "a deleted seed category or bill after a deploy". It covers a
newly seeded household that deletes its Weekly Spend bill:

- `POST /budget/seed-bills` answers 404;
- the bill list does not contain Weekly Spend;
- the household's rows are unchanged.

**Fails before, passes after.** With the route file restored, the new test fails with `expected 200 to be 404`. With
the change applied, the file passes 13/13.

## Gates

- Typecheck: ok.
- Web tests: 139 files, 1,148 passed and 3 skipped (TZ=UTC); 1,149 passed and 2 skipped (TZ=America/Chicago).
- API suite: 145 files, 1,475 passed, 7 todo.
- Build and `check-entry-graph`: landing 574.4 KB of the 580 KB budget, unchanged.
