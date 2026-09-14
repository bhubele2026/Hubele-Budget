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
