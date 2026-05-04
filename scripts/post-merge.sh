#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Task #150 — ensure Playwright's chromium browser is present so the
# registered `e2e` validation step (artifacts/h2budget e2e suite) can run
# on a fresh checkout / CI environment.
pnpm --filter @workspace/h2budget exec playwright install chromium
pnpm --filter db push
# Task #56 — keep generated API types fresh after every merge.
# Step 1: nuke any stale build outputs / tsbuildinfo so `tsc --build`
# can't incorrectly skip the rebuild. (Stale dist + new openapi.yaml
# is the exact pattern that has broken api-server typecheck multiple
# times on fresh branches.)
rm -rf \
  lib/db/dist lib/db/tsconfig.tsbuildinfo \
  lib/api-zod/dist lib/api-zod/tsconfig.tsbuildinfo \
  lib/api-client-react/dist lib/api-client-react/tsconfig.tsbuildinfo
# Step 2: regenerate from openapi.yaml.
pnpm --filter @workspace/api-spec run codegen
# Step 3: rebuild the lib outputs so every consumer (h2budget,
# api-server, scripts) typechecks against current types.
pnpm run typecheck:libs

# Task #63 — seed the user's 18 recurring bills (idempotent; safe to re-run).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/seed_bills_user_3DBrWZkCKIzrkYoLS6N9tIMcdso.sql"

# Migrate any legacy percentage-form APRs to decimal form
# (idempotent; skips rows already < 1.0).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/migrate_debt_apr_to_decimal.sql"
