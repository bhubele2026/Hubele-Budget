#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Task #150 — ensure Playwright's chromium browser is present so the
# registered `e2e` validation step (artifacts/h2budget e2e suite) can run
# on a fresh checkout / CI environment.
pnpm --filter @workspace/h2budget exec playwright install chromium
pnpm --filter db push
# Task #623 — backfill the households + household_members tables and
# stamp household_id on every user-scoped row. Idempotent; no-op once
# the data is converged.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/backfill_households.sql"
# Task #56 — keep generated API types fresh after every merge.
# Step 1: nuke any stale build outputs / tsbuildinfo so `tsc --build`
# can't incorrectly skip the rebuild. (Stale dist + new openapi.yaml
# is the exact pattern that has broken api-server typecheck multiple
# times on fresh branches.) lib/db is included because api-zod /
# api-server / scripts all reference it as a composite project, and a
# stale lib/db/dist can mask schema changes the same way.
rm -rf \
  lib/db/dist lib/db/tsconfig.tsbuildinfo \
  lib/api-zod/dist lib/api-zod/tsconfig.tsbuildinfo \
  lib/api-client-react/dist lib/api-client-react/tsconfig.tsbuildinfo
# Step 2: regenerate sources from openapi.yaml AND rebuild every
# composite lib (`@workspace/api-spec`'s `codegen` script ends with
# `pnpm -w run typecheck:libs`, which is `tsc --build` of the root
# tsconfig — and that root references lib/db, lib/api-zod, and
# lib/api-client-react). Combined with step 1 nuking the cache, this
# guarantees `dist/` + tsbuildinfo for all three libs are freshly
# emitted from the current openapi.yaml + lib/db schema before any
# consumer typechecks.
pnpm --filter @workspace/api-spec run codegen
# NOTE on the api-server `prebuild` / `pretypecheck` workaround
# (`tsc -b ../../lib/db ../../lib/api-zod` in artifacts/api-server/
# package.json): we INTENTIONALLY keep it as a belt-and-suspenders
# safety net even though this script is now authoritative after
# merges. Rationale: post-merge handles the merge / fresh-checkout
# case, but during day-to-day local dev someone may edit
# `lib/db/src/schema` or `lib/api-zod/src` directly (no openapi.yaml
# change, so no codegen needed) and then run api-server's typecheck
# in isolation. api-server's `tsc -p ... --noEmit` does not walk
# project references and rebuild them, so it would otherwise read
# stale `.d.ts` from those libs' `dist/`. The pretypecheck step
# rebuilds them on demand. It is a no-op when post-merge has already
# run, so the redundancy is free.

# Task #63 — seed the user's 18 recurring bills (idempotent; safe to re-run).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/seed_bills_user_3DBrWZkCKIzrkYoLS6N9tIMcdso.sql"

# Migrate any legacy percentage-form APRs to decimal form
# (idempotent; skips rows already < 1.0).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/migrate_debt_apr_to_decimal.sql"

# Task #654 — flag any plaid_items row whose stored access_token was
# minted in a different Plaid environment than the live server (the
# user's two Chase rows hit this exact case). Stamps lastSyncErrorCode
# = INVALID_ACCESS_TOKEN so the Reconnect button shows on next page
# load instead of waiting for the next failed sync to re-stamp it.
# Idempotent — no-op once the user reconnects with a matching-env token.
PLAID_TARGET_ENV="${PLAID_ENV:-production}"
PLAID_TARGET_ENV_LOWER="$(echo "$PLAID_TARGET_ENV" | tr '[:upper:]' '[:lower:]')"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "SET plaid.target_env = '${PLAID_TARGET_ENV_LOWER}';" \
  -f "$(dirname "$0")/remediate_plaid_env_mismatch.sql"
