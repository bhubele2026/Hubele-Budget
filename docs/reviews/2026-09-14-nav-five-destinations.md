# R0 — five destinations: navigation-only reshuffle

Owner-approved redesign, phase R0. Branch `feat/nav-five-destinations` off `main` (`df5d8b0b`). Web-only, navigation
only — **no route added or removed, no financial calculation, query, or stored value touched.**

## Before → after nav map

**Primary row** (was: Home · Banking · Bills · Forecast · Future Goal):

| New label | Href | Was |
|---|---|---|
| Home | `/banking` | "Banking" (same href) |
| Forecast | `/forecast/overview` | unchanged |
| Spending | `/reports/spending` | new — borrows Reports → Spending until R2 builds its own page |
| Review | `/review` | was a Forecast sub-tab, now primary |
| Debt | `/avalanche` | "Future Goal" (same href) |

The old "Home" primary tab (href `/home`) is gone from the ribbon — the landing is reached only through the
**wordmark** now (`brand-home`, still → `/home`, still dollar-free: % paid + the bell).

**Area ribbons** (shown while inside that destination):

| Area | Ribbon tabs | Area membership (routes that show this ribbon) |
|---|---|---|
| Home | Overview · Chase · Amex · Budget · Allowance (**unchanged** — Home is Banking today, redesigned in R3) | `/banking` only |
| Forecast | Overview · Forecast · Bills | `/forecast`, `/forecast/*`, `/bills`, `/bills/*` |
| Spending | Spending · Budget · Allowances · Reports | `/reports/spending`, `/budget`, `/allowances`, `/reports` (exact) |
| Review | Review · Chase · Amex | `/review`, `/transactions`, `/amex` |
| Debt | Debt · Debts · Debt report | `/avalanche`, `/debts`, `/reports/debt` |

**Settings** moved from a Home-adjacent More item to the very end of More (now `Mapping rules`, `Settings` — the only
two pages with no area). **More is hidden inside an area**, unchanged pattern; it only shows next to the five-tab
primary row (`/settings`, `/mapping-rules`, `/plaid-oauth`, `/reports/cashflow`, `/reports/behavior`, `/reports/budget`,
`/not-found`).

**Every old route still resolves**, just reached through a different door:

| Old route | Old nav path | New nav path |
|---|---|---|
| `/banking` | primary "Banking" | primary "Home" |
| `/bills`, `/bills/all` | primary "Bills" (own 2-tab area) | Home tile → Forecast ribbon → "Bills" (one tab covers both) |
| `/transactions`, `/amex` | Banking ribbon | Review ribbon (also still shortcut-linked from Home's ribbon) |
| `/budget`, `/allowances` | Banking ribbon / More | Spending ribbon (also still shortcut-linked from Home's ribbon) |
| `/reports` | More | Spending ribbon |
| `/debts` | More | Debt ribbon |
| `/review` | Forecast ribbon | primary "Review" (+ Review ribbon) |
| `/avalanche` | primary "Future Goal" (1-tab area) | primary "Debt" (3-tab area) |

**Landing tiles** (6, unchanged 3×2 grid, unchanged no-`$`/digit/skeleton rules): Home (`/banking`, "Cash today and
what's next"), Forecast, Spending, Review, Debt (keeps "N% paid"), Settings. The quiet "More" row at the bottom of the
landing (Reports, Allowances, Chase, Amex, Debts, Mapping rules) is **untouched** — it was already independent of the
six loud tiles.

## Files changed

- `src/components/layout.tsx` — `PRIMARY_NAV`/`MORE_NAV` replaced; `HOME_SUBNAV` (renamed from `BANKING_SUBNAV`,
  contents unchanged), `FORECAST_SUBNAV` (gains Bills), new `SPENDING_SUBNAV`/`REVIEW_SUBNAV`/`DEBT_SUBNAV`; area
  membership booleans (`inHome`/`inForecast`/`inSpending`/`inReview`/`inDebt`) replace the old four; `showMore` and
  `ribbonHrefs` rewired to the new set. Added `/review` to the existing hover-prefetch branch that warms the forecast
  bundle (Review renders the same page, same data). Mobile-title fallback (`currentTitle`) now also checks the active
  tab's own label, so area sub-pages (Bills, Chase, Debts, …) keep a real title instead of falling back to "H2 Budget"
  now that they are out of `MORE_NAV`.
- `src/pages/landing.tsx` — `TILES` array only (ids, hrefs, copy) and the payoff badge's testid check
  (`"avalanche"` → `"debt"`). `MORE` (the quiet row) and all digit/skeleton logic untouched.
- `src/hooks/useLandingWarmup.ts` — `STAGES` now one per non-Settings tile (Home, Forecast, Spending, Review, Debt).
  Bills/Budget lost their dedicated data warm-up (no longer landing tiles); Spending has no data warm-up at all (its
  query takes a caller-chosen range with no safe default key — see the module doc) but still warms its JS chunk;
  Review reuses Forecast's exact query (same underlying page/data).
- `e2e/a11y-smoke.spec.ts` — added `/review` to the scanned page list (now a primary destination).
- `src/components/appShell.test.tsx`, `src/pages/landing.test.tsx` — see Tests below.
- `src/routes.test.tsx` (new) — route/redirect regression guard, see below.

`App.tsx` and `lib/routePrefetch.ts` are **untouched** — no route was added, removed, or retargeted, so there is
nothing for them to move in lockstep with. `/review`'s importer and `/reports/spending`'s importer already existed in
`routePrefetch.ts` from before this PR.

## Tests changed, and why

- **`appShell.test.tsx`**: rewrote the area-model tests for the five new areas (`Home`/`Forecast`/`Spending`/`Review`/
  `Debt`), including the three cases called out explicitly — `/bills/all` → Forecast·Bills, `/transactions` →
  Review·Chase, `/debts` → Debt·Debts — plus `/reports/debt` → Debt·Debt report (the same sibling-prefix hazard as
  Bills, one level deeper: Spending's `/reports` tab vs Debt's `/reports/debt` tab). Added a "the five destinations"
  block asserting the primary row's five hrefs/labels. Added a Review-badge case for when the five-destination primary
  row is showing (Review is now in it). Added a "puts the unmapped pages under More" case — this needed a
  `vi.mock("@/components/ui/dropdown-menu")` render-everything shim (same pattern already used in
  `debtPlaidReconnect.test.tsx`) because Radix only mounts `DropdownMenuContent` once opened, which jsdom's
  pointer-capture model doesn't drive cleanly.
- **`landing.test.tsx`**: tile ids/hrefs updated to `home`/`forecast`/`spending`/`review`/`debt`/`settings`. The
  money/digit/skeleton tests are byte-for-byte unchanged and still pass.
- **`e2e/a11y-smoke.spec.ts`**: added `/review`.
- **`src/routes.test.tsx`** (new): every route from the "Today" list resolves through a real wouter `Switch` (never
  the NotFound catch-all), and both rename redirects (`/dashboard`→`/banking`, `/recurring`→`/bills/all`) still work.
  A second block reads `App.tsx`'s actual source text and asserts each route/redirect path literally appears there,
  so if a future change drops or renames a route without updating this file, that block fails loudly instead of the
  route list silently drifting from what ships. (Full-page rendering of all ~20 real lazy pages was deliberately not
  attempted — it would need either live network calls or mocking two dozen page modules for no gain, since this PR
  cannot touch page internals anyway.)

## Gates

- `pnpm run typecheck`: **0 errors** (singleton-deps check + all 9 workspace packages + e2e types).
- Web tests, `TZ=UTC`: **140 files, 1204 passed, 3 skipped**.
- Web tests, `TZ=America/Chicago`: **140 files, 1205 passed, 2 skipped** (the 1/2 skip split is pre-existing
  TZ-dependent test gating, unrelated to this change).
- `pnpm run build`: exit 0 (api-server + h2budget).
- `node scripts/check-entry-graph.mjs`: **574.8 KB raw / 173.2 KB gz**, budget 580.0 KB — up **+0.4 KB** from the
  ~574.4 KB baseline (new area-ribbon arrays are a similar size to the ones they replaced). Cap unchanged. No
  recharts on the open path; react-dom confined to `vendor-react-*`.
- No API changes — API suite not run, per the task.

## What must not change (and didn't)

- No file under `lib/avalanche-core`, `lib/db`, `api-server/src/lib`, or any `spine`/`forecast`/`spending`/`debt`
  calculation was touched.
- No `useQuery`/`prefetchQuery` call reads a **different** endpoint or param shape than before — the only additions
  reuse an *already-imported* query key builder + fetcher pair (`getForecast`/`getForecastCashSignal` for `/review`,
  exactly as `/forecast/overview` already did).
- The landing's two numbers (bell count, % paid), the spine-only data source, and the never-an-amount-owed rule are
  unchanged; `landing.test.tsx`'s digit/skeleton assertions are untouched text and still pass.
- Design laws unchanged: navy/orange/platinum tokens only, flat/matte, one type family, no exclamation marks — no new
  classes or colors were introduced, only label/array edits.

## Open questions for the owner (naming)

1. **Page headings still say the old names.** `src/pages/avalanche.tsx` renders `<Page title="Future Goal">`, and
   `bills.tsx` has body copy referencing "Future Goal" twice. The nav now calls this destination "Debt" everywhere,
   so a user lands on a page titled "Future Goal" after clicking "Debt". Left unchanged deliberately — this PR is
   navigation-only — but it's an inconsistency worth a follow-up PR once the naming is final.
2. **"Home" is two things.** The primary nav tab "Home" opens `/banking` (per the plan), while the wordmark's
   destination — also colloquially "home" — is the separate `/home` landing door. Worth confirming this is the
   intended mental model before R3 redesigns the Banking page itself under the "Home" label.
3. **Spending borrows Reports → Spending** (`/reports/spending`) as its destination, but the Spending ribbon *also*
   carries a separate "Reports" tab pointing at the `/reports` hub, which itself links back into Spending. Confirm
   that's the intended nesting until R2 ships a dedicated Spending page.

---

## Round 2 — review fixes (2026-09-15)

The independent review of round 1 returned **REQUEST CHANGES**: 2 HIGH, 2 MEDIUM, 2 LOW, 1 NIT. The branch carries
merge `67b5518` (`origin/main` `2731077` into `5f2d2df`). `origin/main` then moved to `2e1949f3` while this round was
in progress. That change removed the seed-bills tool and touched only the API server, scripts and docs, none of the R0
files. The round-2 commit is `dd3ea92b`, the new main is merged on top as `f1947554` without conflicts, and every gate
below was re-run on that merged tree. This round is still web-only and navigation-only, apart from the rename the owner
asked for. No route, query, stored value or calculation changed.

### 1. HIGH — pages that live only in a ribbon were unreachable on a phone

**What changed.** `layout.tsx` now has one `DESTINATIONS` config. Each destination holds its primary link, its ribbon
`tabs`, and the routes it `owns`. Everything else is derived from that one list: `PRIMARY_NAV`, the desktop ribbon, area
membership, and the phone drawer. Area membership replaces the five hand-written `inHome`/`inForecast`/… booleans and
covers the same routes. The drawer lists the five destinations in order, each with its ribbon pages beneath it, and then
More:

| Drawer row | Pages beneath it |
|---|---|
| Home (`/banking`) | none (see the rule below) |
| Forecast (`/forecast/overview`) | Forecast `/forecast` · Bills `/bills` |
| Spending (`/reports/spending`) | Budget `/budget` · Allowances `/allowances` · Reports `/reports` |
| Review (`/review`) | Chase `/transactions` · Amex `/amex` |
| Debt (`/avalanche`) | Debts `/debts` · Debt report `/reports/debt` |
| More | Mapping rules · Settings |

The rule is that each ribbon page is listed once, under the destination that owns it. The tab that shares the
destination's own href folds into the destination row. Home's ribbon shortcuts (Chase, Amex, Budget, Allowance) appear
under Review and Spending, because those areas own them. Listing them under Home as well would put two "Chase" rows in
the drawer, and both would light up on `/transactions`. A ribbon tab whose route no area owns stays under the ribbon
that carries it, so nothing on a ribbon can fall out of the drawer.

The drawer is a Radix Dialog and had no accessible name. It now has a screen-reader-only title, "Navigation".

**Proof** is in `appShell.test.tsx`, block "the phone drawer reaches every page a ribbon reaches":
- The block starts from a hand-typed list of all 14 ribbon routes. That list is itself checked against the ribbons that
  actually render on one route in each area, so it can't go stale.
- The drawer is opened for real, with a click, from `/settings`, `/bills/all`, `/banking` and `/transactions`. Each time
  it links to every one of the 14 routes.
- The exact tree above is asserted, and no href appears twice.

These tests were also run against the round-1 `layout.tsx`, with only the dialog title added so the drawer could be
found. They fail, for example: `expected [ '/home', '/banking', …(6) ] to include '/transactions'`.

### 2. HIGH — the review count was hidden on a phone at `/transactions` and `/amex`

**What changed.** The header pill is no longer removed when the ribbon carries the Review tab. It gets `md:hidden`
instead. A desktop still shows the count once, on the ribbon's Review tab. A phone, which never sees the ribbon, always
shows the pill.

**Proof.** jsdom applies no CSS, so a new `countsShown(width)` helper reads the Tailwind display classes on an element
and its ancestors. A test pins the helper itself: the ribbon is desktop-only and the drawer trigger is phone-only.

| Route | Count visible on a phone | Count visible on a desktop |
|---|---|---|
| `/review`, `/transactions`, `/amex`, `/settings` | pill | ribbon |
| `/banking`, `/bills/all` | pill | pill |

A further test checks that the phone pill is a real link to `/review` with its aria-label. Against the round-1 layout,
all four of the first row's routes fail with `expected [] to deeply equal [ 'pill' ]`.

### 3. MEDIUM — `routes.test.tsx` checked nothing independent

**What changed.** The file is rewritten.
- It mounts the real `App.tsx`, with its real `<Switch>`, `<Route>` and `<Redirect>` elements, inside the real
  `AppLayout`.
- Only leaves are mocked: Clerk (always signed in), the API client, and each lazy page, which becomes a stub that names
  itself.
- A hand-typed table lists all 27 old routes. For each route it records where you land (the route itself or its
  redirect target), which page renders there, and which destination's ribbon the shell shows. The ribbons are hand-typed
  too.
- A NotFound control proves the catch-all is reachable.
- A final check requires a table row for every `path="…"` that `App.tsx` declares.

**Proof.** All 29 tests pass. Changing `App.tsx`'s `/recurring` redirect to `/bills` makes the test fail:
`'/recurring' → '/bills/all' renders 'bills'` reports `Unable to find … [data-testid="page-bills"]`. The file was
restored afterwards and verified byte-identical with `cmp`.

### 4. MEDIUM — e2e was not run

**Still not run. No Playwright spec executed in either round.** This is what was attempted:

```
CI=true PORT=5199 pnpm --filter h2budget exec playwright test e2e/a11y-smoke.spec.ts e2e/perf-open.spec.ts \
  e2e/bills-avalanche-nav.spec.ts e2e/bills-avalanche-locked-row.spec.ts e2e/bills-debt-payoff-celebratory-row.spec.ts
```

It exited 1 in `e2e/global-setup.ts`: `CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY must be set for Playwright tests.`

What is missing:
- **The keys.** `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are not in the shell environment. There is also no
  `.env`, the untracked file that `.env.example` says to create for local work, in the worktree or in the main checkout.
  No other location was searched.
- **A dev server would not help without them.** `App.tsx` throws "Missing VITE_CLERK_PUBLISHABLE_KEY" before it
  renders, so starting one with `PORT` would not have got further.
- **Other prerequisites, not checked because setup stopped at the key check.** The specs also need `DATABASE_URL` (the
  Clerk helper writes household rows through `@workspace/db`), a running app (API and web) at `PLAYWRIGHT_BASE_URL`, and
  installed Playwright browsers.

**e2e edits made, typechecked by `typecheck:e2e` but not run.** Three specs asserted the `/avalanche` heading
`/^future goal$/i` and now assert `/^debt$/i`: `bills-avalanche-locked-row`, `bills-avalanche-nav` and
`bills-debt-payoff-celebratory-row`. Elsewhere in `src`, the only text that reads exactly "Debt" is table `<th>` cells.
Those are column headers, not headings, so the heading locator stays unambiguous.

### 5. Owner decision — rename "Future Goal" to "Debt"

**What changed.**
- `avalanche.tsx` now renders `<Page title="Debt">`.
- The doc comment in `landing.tsx` is updated.
- `bills.tsx` has two body-copy pointers that named a page that no longer exists. They now read "manage on the Debt
  page" and "edited on the Debt page".
- The describe label and comment in `avalancheHeroPayoff.test.tsx` are updated, along with the three e2e locators
  above.

**Proof.** `grep -rni "future goal"` over the web `src` and `e2e` folders finds nothing. `landing.test.tsx` passes
unchanged: `/home` shows no `$`, no amount owed, and no digits beyond the bell count and % paid. This resolves round-1
open question 1. One historical comment in `lib/avalanche-core` still says "Future Goal". It was left alone because
this PR touches no lib code.

### 6. NIT — `MobileNav` lit rows with a raw `startsWith`

**What changed.** The ribbon, the drawer, More's active state and the phone page title all now use the same two
helpers: `isAtOrUnder` (matches whole path segments) and `longestMatch`. The drawer lights what the ribbon lights. Only
rows in the current area can light up (or More's rows when you're in no area), and only the longest match among them.

**Proof** is a table test:
- `/bills` and `/bills/all` light Bills.
- `/billsx` lights nothing.
- `/forecast/overview` lights only its destination row.
- `/reports/debt` lights Debt report, not Reports.
- `/reports/cashflow` and `/settingsx` light nothing.
- The phone title at `/settingsx` is "H2 Budget".

Changing `isAtOrUnder` to a raw `startsWith` fails the `/billsx`, `/settingsx` and title cases. The file was restored
afterwards and verified with `cmp`.

### Files touched in round 2

- `src/components/layout.tsx`, `src/components/appShell.test.tsx`, `src/routes.test.tsx`
- `src/pages/avalanche.tsx` (the title), `src/pages/bills.tsx` (2 strings), `src/pages/landing.tsx` (a comment),
  `src/pages/avalancheHeroPayoff.test.tsx` (labels)
- `e2e/bills-avalanche-locked-row.spec.ts`, `e2e/bills-avalanche-nav.spec.ts`,
  `e2e/bills-debt-payoff-celebratory-row.spec.ts`

Checked and deliberately left unchanged:
- `e2e/a11y-smoke.spec.ts`: it scans at desktop width, never opens the drawer, and the phone-only pill is
  `display:none` at that width.
- `lib/routePrefetch.ts`: no route was added or removed, and drawer rows reuse the existing `prefetch` →
  `prefetchRoute` path. A test covers warming from the drawer.
- `hooks/useLandingWarmup.ts`: the landing tiles are unchanged.

`AppLayout`'s idle chunk warm-up now loops over `DESTINATIONS`. It warms the same five hrefs as before. The drawer uses
only existing tokens: navy ground, white alphas, the orange active bar and badge. No new colors, fonts or classes of
pill were introduced.

### Gates (round 2)

All gates ran on the merged tree `f1947554`, which is the round-2 commit `dd3ea92b` plus `origin/main` `2e1949f3`. A
run on `dd3ea92b` before the merge gave identical numbers. The only commit after `f1947554` updates this note.

- **`pnpm run typecheck`:** exit 0, including `typecheck:e2e`.
- **Web tests, `TZ=UTC`:** 140 files, 1212 passed, 3 skipped.
- **Web tests, `TZ=America/Chicago`:** 140 files, 1213 passed, 2 skipped.
  - Against round 1, that is +8 net: `appShell.test.tsx` went from 26 to 51 tests and `routes.test.tsx` from 46 to 29.
- **`pnpm run build`:** exit 0.
- **`node scripts/check-entry-graph.mjs`** (run from the repo root): **575.7 KB raw / 173.4 KB gz**, against a budget
  of 580.0 KB.
  - That is +0.9 KB over round 1's 574.8 KB, from the shared config and the nested drawer in the eager `layout.tsx`.
  - 4.3 KB of headroom remains.
  - No recharts on the open path, and react-dom stays confined to `vendor-react-*`.

### Still open

- **e2e.** It needs Clerk test keys, a database, and a running app (see finding 4).
- **The phone drawer has not been checked visually in a browser.** The app cannot boot without the Clerk publishable
  key. The drawer's structure, reachability and active states are covered only in jsdom.
- **Round-1 open questions 2 and 3** (Home is both a tab and the door; Spending's Reports nesting) are unchanged. Both
  are the owner's call.
