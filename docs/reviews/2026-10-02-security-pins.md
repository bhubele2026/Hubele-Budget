# Security pins — multer 2.4.0, axios 1.20.0 (via plaid), qs 6.16.0 (via express)

Branch `fix/security-pins-2026-10-02` off `main` `59cbbda7`. Dependency-only. The owner approved this security fix
on 2026-10-02. No source file, route, financial calculation, query or stored value changed; the web bundle is
byte-identical.

## Why

`pnpm audit --prod` on `59cbbda7`: **19 advisories — 10 high, 8 moderate, 1 low**, all in three API-server packages.
CLAUDE.md requires `pnpm audit --prod` to stay at 0 high.

| Package (path) | Held | Advisories | Fixed in |
|---|---|---|---|
| `multer` (api-server, direct) | 2.2.0 | high GHSA-wc9g-mqfw-jrwm (crafted field names DoS), high GHSA-qfvm-cv95-jqjf (fd leak on aborted uploads), high GHSA-535w-7cp7-47q4 (oversized array index DoS), moderate GHSA-3pph-fpjx-jg34 (orphaned disk writes on abort), low GHSA-qvfw-j98x-7q72 (size-limit bypass via async fileFilter) | 2.4.0 |
| `axios` (api-server > plaid) | 1.19.0 | high GHSA-c29m-xwm3-cm6r, GHSA-mghh-pgcx-3jjj, GHSA-x97p-jq2g-jp4f, GHSA-3pq3-5fj3-cg6v, GHSA-542g-h47m-68v8, GHSA-m8m8-qj5v-23w3, GHSA-r4gj-5m52-g5wh; moderate GHSA-vh66-26gq-q6x8, GHSA-9fr6-4gfg-395g, GHSA-j8rh-479h-cp32, GHSA-4hqw-qxg8-jxx2, GHSA-44g4-m2mj-wpvx | 1.20.0 |
| `qs` (api-server > express / body-parser) | 6.15.3 | moderate GHSA-x5fp-wj9c-mxmx (array-limit bypass), GHSA-4mjr-xmp4-gh2g (isBuffer DoS) | 6.16.0 |

## What changed

- `artifacts/api-server/package.json`: `multer` `^2.2.0` → `^2.4.0`.
- `pnpm-lock.yaml` (pnpm 10.34.3): axios and qs refreshed inside the ranges their parents already declare
  (plaid `axios ^1.7.4`; express `qs ^6.14.0`, body-parser `qs ^6.15.2`). **No override added** — the lockfile alone holds them.
  All three targets are weeks past `minimumReleaseAge` (multer 2.4.0 2026-09-14, axios 1.20.0 2026-08-26, qs 6.16.0
  2026-08-29).

Lockfile packages moved, and nothing else:

| Change | Packages |
|---|---|
| bumped | `multer` 2.2.0 → 2.4.0, `axios` 1.19.0 → 1.20.0, `qs` 6.15.3 → 6.16.0 |
| removed (multer 2.4 no longer depends on `concat-stream`) | `concat-stream` 2.0.0, `buffer-from` 1.1.2, `readable-stream` 3.6.2, `string_decoder` 1.3.0, `typedarray` 0.0.6, `util-deprecate` 1.0.2 |
| pnpm dedupe on re-resolve | `media-typer` 1.1.0 dropped; `type-is@2.0.1` (express chain) now uses the `media-typer` 1.1.1 already in the tree |

The `overrides` section, the hand-computed `xlsx` CDN-tarball `integrity`, and every other entry are untouched.
(`pnpm update axios qs` was tried first and rejected: it also re-resolves the `@esbuild-kit/esm-loader` → `tsx`
override alias and moved tsx 4.23.12 → 4.23.15. The lockfile was instead produced by a temporary override plus a
plain `pnpm install`, then the override was removed and `pnpm install` re-run; pnpm keeps the new versions because
they satisfy the parents' ranges.)

`pnpm install --frozen-lockfile` from an empty `node_modules`: passes, 581 packages (588 before).

## Evidence — gates, baseline (`59cbbda7`) vs this branch

All run locally with the CI commands (`.github/workflows/ci.yml`), Node 24.18.0, pnpm 10.34.3; API tests on a
dedicated local database.

| Gate | Baseline | After |
|---|---|---|
| `pnpm run check-singleton-deps` | pass, 8/8 single-version | pass, 8/8 |
| `pnpm run typecheck:libs` | pass | pass |
| `pnpm run typecheck` | pass | pass |
| Codegen drift (`api-spec codegen` + `git diff --exit-code`) | clean | clean |
| Web tests, TZ=UTC | 141 files; 1249 passed, 3 skipped | identical |
| Web tests, TZ=America/Chicago / New_York / Los_Angeles | 141 files; 1250 passed, 2 skipped (each) | identical |
| API tests (Postgres, serial) | 151 files; 1605 passed, **1 failed**, 7 todo | identical — same test, same numbers |
| `pnpm run build` | pass | pass |
| `node scripts/check-entry-graph.mjs` | 575.7 KB / 580 KB, OK | 575.7 KB / 580 KB, OK; web `dist/public` byte-identical (100 files, sha256) |
| `pnpm audit --prod` | 19 (10 high, 8 moderate, 1 low) | **0** |
| `pnpm audit --prod --audit-level high` | exit 1 | **exit 0** |

**The one API failure is pre-existing and calendar-dependent, not caused by this change.**
`spineParity.integration.test.ts` › "spentMonth + spentWeek match /reports/spending-facts" asserts
`spentMonth >= spentWeek` ("a week cannot outspend its month"). On 2026-10-02 the Sun–Sat week (Sep 27 – Oct 3)
starts in September while the month starts Oct 1, so the week can outspend the month (221.14 vs 285.24). It fails
identically on `main`, and stops failing once the household day reaches Sunday 2026-10-04. Fixing that assertion is
a separate task.

The full (dev-inclusive) `pnpm audit` goes 93 → 74: exactly these 19 fixed, none new. The 74 left are dev/build-tool
packages (undici, orval, fast-uri, brace-expansion, js-yaml, postcss, nanoid, vite, …) outside `--prod` and outside
this change.

## Evidence — smoke tests

A local script using the api-server's own installed packages (`createRequire` from `artifacts/api-server`), no
secrets, 11/11 pass. Resolved versions: multer 2.4.0, express 5.2.1, plaid 42.2.0 → axios 1.20.0, express → qs 6.16.0.

- **multer**, configured exactly as `routes/import.ts:9-19` (memoryStorage, 25 MB, `upload.single("file")`):
  a small upload returns the right `req.file` (`fieldname`, `originalname`, `encoding`, `mimetype`, `size`, buffer
  sha256, no `path`/`destination`); a 26 MB upload is refused with `MulterError LIMIT_FILE_SIZE` on field `file`
  (through the production chain it surfaces as Express's default 500, because `app.ts` has no error handler — same
  as before this change); exactly 25 MB is still accepted (limit unchanged); no file → the route's own 400; after an
  upload aborted mid-stream the next upload is still served.
- **qs**: `express.urlencoded({ extended: true })` (as in `app.ts:82`) still parses nested bodies.
- **Plaid → axios**: a `PlaidApi` built the same way as `lib/plaid.ts:180-191` (fake client id/secret, basePath a
  local fake server) made `transactionsSync`: HTTP 200, `resp.data` parsed, request carried the configured
  `PLAID-CLIENT-ID` / `Plaid-Version` headers and JSON body; a 400 rejects with a parsed `err.response.data.error_code`.
- **Built bundle** (`artifacts/api-server/dist/index.mjs`, 7,539,071 → 7,438,361 bytes) boots against the test
  database: `/api/healthz` 200, `/api/version` 200, unauthenticated `POST /api/import/workbook` 401.

The upload client (generated `importWorkbook`) sends a single `file` field, so multer 2.4's new field-name limits
(nesting depth, array index) cannot affect it.

## Merge and deploy

- Render auto-deploys `main`; after merge, check `/api/version` returns the merge SHA and `/api/healthz` is 200.
- CI's API-test job will show the calendar-dependent `spineParity` failure above through Saturday 2026-10-03
  (household day), on this branch and on `main` alike. A re-run from Sunday 2026-10-04 should be green.

## Follow-up: the date-dependent parity check (same branch)

CI's api-tests failed on this branch and on `main` alike: `spineParity` asserted "a week cannot outspend its month",
which is false for a Sun–Sat week that began before the 1st (Sun Sep 27 – Sat Oct 3 holds four September days the
October month-to-date does not: 221.14 month vs 285.24 week). Render deploys only on a passing CI, so the security
pins could not ship until Sunday. The assertion now holds only when the week starts on or after the month's 1st;
every parity assertion (to the cent) is unchanged. Test-only — no calculation, query or stored value moved.
`spineParity.integration.test.ts`: 13/13 on a fresh test database; typecheck clean.
