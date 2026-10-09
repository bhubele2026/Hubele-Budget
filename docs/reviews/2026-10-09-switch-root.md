# The switch — the app serves `/`, `artifacts/h2` is deleted (2026-10-09)

Branch `restore/switch-root`, cut from `origin/main` 428c9eb9 (C12 merged).
- Approved by the owner as part of Wave C.
- The API routes and the OpenAPI spec are unchanged.
- No query, money helper or figure changed.

## What changes for the owner

- **One address.** The app opens at `https://h2budget.onrender.com/`. It is the app that was at `/classic` and was previewed: same sign-in, same data.
- **Bookmarks:**
  - anything under `/classic/…` redirects permanently to the same page without `/classic`, filters kept (`/classic/transactions?month=2026-10` → `/transactions?month=2026-10`);
  - bookmarks into the stripped-down app that used to be at `/` land on the matching page:

| Old link | Now opens |
|---|---|
| `/` (Today), `/today` | the dashboard (`/home`) |
| `/activity`, `/activity/review` | Review › Categories |
| `/activity?txn=…` | that transaction on Chase |
| `/activity/rules` | Mapping rules |
| `/plan` | Allowances (the weekly plan panel) |
| `/plan/bills` | Bills |
| `/plan/debt` | Avalanche (payoff ranges) |
| `/plan/categories` | Budget |
| `/plan/wishlist` | Wish list |
| `/plan/proposals` | Review › Suggestions |
| `/ask` | Ask (same page name) |
| `/ask/memory` | Settings › Memory |
| `/household`, `/household/members` | Settings › Household |
| `/household/ai` | Settings › AI cost |
| `/household/automation` | Settings › Automation |
| `/recap` | Settings › Morning text |
| `/design…` | the dashboard (those were sample pages) |

- **Phone icon:**
  - an icon saved from the old `/` keeps working and now opens this app;
  - one saved from `/classic/…` is redirected;
  - neither app had a web manifest or a service worker, so nothing cached can hold the old app;
  - re-adding the icon from Safari picks up this app's H2 mark (`apple-touch-icon`), which the old app never had.
- **The preview line is gone.** The "Modernization preview: Forecast · Accounts · Current app →" line above the header (SH-01) is removed. `/next/forecast` and `/next/accounts` still open (Home › Accounts in the ribbon).
- **Bank linking: nothing to change in Plaid.**
  - The redirect URI the server sends Plaid is `PLAID_REDIRECT_URI` = `https://h2budget.onrender.com/plaid-oauth` (env; `index.ts` warns unless the path is exactly `/plaid-oauth`). That is at the root, not under `/classic`.
  - The app's own `/plaid-oauth` page now answers it in place (no redirect), so `oauth_state_id` and `receivedRedirectUri` round-trip as registered.
- **Texts and emails:**
  - the morning text's link is `…/?d=<day>`, which opens the dashboard;
  - the Plaid re-link email points at `…/settings`;
  - invitations point at `…/sign-up`;
  - all three are root paths this app serves, so nothing changed there.
- **Worth a look in the Render dashboard (not readable from here):**
  - if `WEB_DIST_DIR` was ever set, it pointed at the deleted app; the server now ignores a value without a build, logs a warning and serves this app;
  - `CLASSIC_DIST_DIR` is no longer read;
  - `BASE_PATH` no longer matters (the build pins `/`).
  - In Clerk's dashboard, any path still set under `/classic/…` keeps working through the redirect.

## What changed

- **Serving** (`api-server/src/webMounts.ts`, `app.ts`):
  - `mountWebApp` serves one build at `/`.
  - `/classic`, `/classic/` and `/classic/<path>` → 301 to `/<path>` with the query string. Registered even without a build. Leading slashes and backslashes collapse, so `/classic//evil.example` cannot become a protocol-relative open redirect.
  - Caches as before: hashed assets 1 year, `index.html` `no-cache`.
  - **New:** a missing `/assets/*` file is a plain-text 404, not the HTML shell. A tab left open across a deploy then fails its old chunk cleanly into `main.tsx`'s reload-once.
  - The SPA fallback no longer answers `/api` itself. It already skipped `/api/*`.
  - `resolveWebDistDir`: `WEB_DIST_DIR` only when it holds an `index.html`.
- **The app** (`artifacts/h2budget`):
  - `build` is `BASE_PATH=/ vite build`. Every in-app path already derives from `BASE_URL`, so they all moved with it: the wouter base, Clerk `signInUrl`/`signUpUrl`, the sign-in/up `path`, the logo, the sample workbook link and the Plaid return.
  - The Plaid return also strips a legacy `/classic` prefix: a link started before the deploy stored `/classic/settings`.
- **Old links:** `lib/legacyRoutes.ts` is a 16-row table plus `/activity?txn=` and `/design*`.
  - Read only by the not-found page, which is already a lazy chunk. A known old path `<Redirect replace>`s; anything else is still a 404.
  - No route was added and no eager import, so `routes.test`, `routePrefetch` and the open path are untouched.
- **SH-01 removed** from `layout.tsx`.
- **Deleted:** `artifacts/h2` (whole app).
  - `pnpm-lock.yaml` regenerated with pnpm 10.34.3: only the h2 importer and its four unique packages leave (two fontsource families, IBM Plex Mono, user-event). `--frozen-lockfile` passes.
  - CI: the `web-tests-h2` job (4 zones) and the H2 400 KB entry-graph step are gone; the build job's guard is the one app's.
  - `check-entry-graph.mjs` header; `capture-classic.mjs` opens root paths; `.env.example`.
  - `CLAUDE.md`: h2budget is the one app at `/`; the two-app rules, the per-app cap wording and the frozen-h2 test line are rewritten; old links are documented as `lib/legacyRoutes.ts`, not routes.
  - Provenance comments ("ported from the frozen h2 app") are kept as history.

## Tests

- `api-server` `webMounts.test.ts`, rewritten (24):
  - root URLs → index, `no-cache`, including `/today`, `/classicfoo`, `/apiary`;
  - `/plaid-oauth?oauth_state_id=` → 200, no `Location`;
  - eight `/classic…` → 301 rows with queries;
  - the open-redirect guard;
  - asset hit (1-year cache) and miss (plain 404); an old `/classic/assets/…` → 301 → 404;
  - `/api` and `/api/x` never HTML;
  - no build → `/classic` still redirects;
  - `resolveWebDistDir`.
- h2budget `lib/legacyRoutes.test.tsx` (23): every old path, with and without a trailing slash; `?txn=`; app paths and unknown paths stay null. Through the real not-found page inside a `Switch`: redirect with `replace` (history length 1) to the target route; the 404 is still shown for a path that never existed.
- `appShell.test`: the SH-01 test now asserts the line is gone on four pages and the header is the shell's first child.

## Local boot (the built server, test DB)

`node artifacts/api-server/dist/index.mjs` on port 3197:
- `/api/healthz` 200;
- `/`, `/home`, `/today` and `/plaid-oauth?oauth_state_id=abc-123` → the app's `index.html`, `no-cache`, `/assets/index-*.js`;
- `/classic` and `/classic/` → 301 `/`; `/classic/home?x=1` → 301 `/home?x=1`; `/classic//evil.example` → 301 `/evil.example`; HEAD works too;
- `/assets/index-missing.js` → 404 `text/plain`;
- `/h2-mark.png` → 1-year cache;
- `/api` and `/api/nope` → Express's own 404, as before, never the shell.

## Bundle

- Landing JS: **620,417 bytes** of the 622 KB cap (C12 measured 621,007). That is 590 bytes less, because the preview line is gone.
- The old-link table adds nothing to the open path. The cap is not touched, and the drawer did not need to go lazy.

## Gates

- `pnpm run typecheck`: clean.
- h2budget vitest, 202 files:
  - UTC: 1,794 passed, 3 skipped;
  - America/Chicago: 1,795 passed, 2 skipped.
- API suite on `h2budget_test_switch`: 236 files, 2,566 passed, 2 todo.
- CI-style codegen: no drift.
- `pnpm run build` + `check-entry-graph`: OK, 620.4 of 622 KB, no recharts on open.
- `pnpm audit --prod`: 1 high, already ignored.
- E2E not run (no Clerk keys). `a11y-smoke`, `perf-open` and the Playwright `baseURL` already use root paths.

## For the lead

- **Merge gate:** `/private/tmp/claude-501/-Users-bhubele/662a47bb-562b-43f4-8e13-e4b43eacd793/scratchpad/merge-gates-post-switch.sh` drops the h2 suite and the h2 entry graph, runs the web suite in UTC and Chicago, and refuses a pre-switch worktree.
- **Recap link kept as `/?d=`.** `/` is this app (signed in → `/home`). `/home?d=` would take 4 characters out of every morning text's budget (`maxTextFor(link)`), and could push a draft onto the shorter template.
- **Follow-up, not done ("API and spec unchanged"):**
  - `orval.config.ts` says that at the switch `features` can join the main client module's exclude list;
  - the `features` tag description in `openapi.yaml` still mentions the frozen app.
- **Behaviour kept:** sign-up still finishes on `/dashboard` → `/banking`, as before.
