#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Re-run OpenAPI codegen + tsc --build so api-zod, api-client-react,
# and lib/db dist outputs match current source.
pnpm --filter @workspace/api-spec run codegen
