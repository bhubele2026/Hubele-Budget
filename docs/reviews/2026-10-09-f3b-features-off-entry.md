# F3b — the `features` module off the entry chunk (2026-10-09)

Branch `restore/f3b-features-off-entry`, base `60b4ecb5` (main with F3). No behaviour or figure change; the same operations are called, from the main module's identical copies.

## Cause
`pages/next/dashboard/queries.ts` (eager, reachable from `App.tsx`) imported `useGetMoneyPosition`, `getGetMoneyPositionQueryKey` and `previewRecap` from `@workspace/api-client-react/features`. Rollup keeps a module whole in the chunk that statically imports it and retains every export a lazy chunk uses, so the entire sub-module rode in `index-*.js`.

## Change
- `queries.ts` takes those three names from the main module (already whole in the entry chunk, carries identical copies).
- `featuresImportGraph.test.ts`: the C11 exception for `/features` is removed (nothing on the entry path may import `/features` or `/ledger`). Rule 2 ("no `features` operation from the main module") keeps working for everything else, with one narrow named allowlist, `ENTRY_MAIN_FEATURES` (file `pages/next/dashboard/queries.ts`, names `useGetMoneyPosition`, `getGetMoneyPositionQueryKey`, `previewRecap`) and a test that pins the allowlist and that the file really uses each name. Reason is written in the test.
- Cap lowered 633 → 622 KB in `scripts/check-entry-graph.mjs` (default and history comment), `CLAUDE.md` section 2 (two places) and `.github/workflows/ci.yml`.

## Measured
- Landing JS: **632.1 KB before → 616.6 KB after** (−15.5 KB); cap = measured + 5 KB, 622 KB.
- Before: `/api/agent/findings`, `/api/wishlist`, `learned-rules`, `ai/usage` were all in `index-*.js`. After: they are only in the new lazy `api-*.js` chunk (and `mapping-rules-*.js` for the learned rules); `index-*.js` keeps only `api/recap/preview` and `money/position`.

## Gates
`pnpm run typecheck` (repo root) clean; h2budget vitest UTC 1,670 passed / 4 skipped, America/Chicago 1,672 passed / 2 skipped; build + entry graph OK at 616.6 of 622 KB (no recharts on open); `pnpm audit --prod` 1 high, already ignored.
