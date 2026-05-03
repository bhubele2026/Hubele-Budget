#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Re-run OpenAPI codegen + tsc --build so api-zod, api-client-react,
# and lib/db dist outputs match current source.
pnpm --filter @workspace/api-spec run codegen

# Task #63 — seed the user's 18 recurring bills (idempotent; safe to re-run).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/seed_bills_user_3DBrWZkCKIzrkYoLS6N9tIMcdso.sql"

# Migrate any legacy percentage-form APRs to decimal form
# (idempotent; skips rows already < 1.0).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/migrate_debt_apr_to_decimal.sql"
