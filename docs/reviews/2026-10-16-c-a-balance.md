# Review note — C-A: one balance, one chart start, one forecast (C1 + C2 + C3)

Branch `cons/a-balance` from origin/main d8da19c4. Local commit only; not pushed, not deployed.

## What changed (plain words)
### C1 — one presentation of the checking balance
- Five places now say the same thing in the same words: Dashboard Banking tile, Banking cell, Forecast KPI, Forecast "Checking today" card, Overview stat.
- Label "Checking today". Figure. One line: "Calculated · bank read $0.00 Oct 15, 4:19 PM · +2 rows since". One **Details** button (the existing "Why this number?").
- "H2 balance", "Bank today", the per-surface reading lines and "as of Oct 15" are gone from those faces.
- "Bank's last reading" is named only inside Details.
- Line variants: "no rows since" · typed ("Typed balance $X (not from the bank) · Oct 15") · "No bank reading yet" · "Earlier reading (…) — updating…" (grey figure).
- Halves come from the surface's own response when it carries them (Banking: its review reading, rows from the spine only when the spine names the same reading; Forecast: `cashSignal.opening`; Overview and tile: the spine's `bank.snapshot` / `bank.sinceSnapshot`).
- The Forecast card keeps the account name and the freshness line; "No reading" there now reads "The curve starts from your starting balance $X".
- The Dashboard tile loads the note (line + Details) as its own chunk, like its balance check; the label and figure stay in the landing.

### C2 — chart caption and first point are one moment
- Additive `CashSignal.opening { date, balance, reading, since }` (OpenAPI + codegen). Nothing else moved.
- Chart caption, two lines at the first point: "Oct 14 · opens $0.00 · closes $3,374.60" and "Bank read $0.00 Oct 13, 4:19 PM · +2 rows today" (+ Details).
- "+N rows today" when the rows are dated the opening day; "+N rows since" when all are dated before it.
- Hero adds-up line "Starting balance" → "Opening". First-day tooltip says Opening and Close.
- No reading → "—" words and "No bank reading yet", never $0.00.

### C3 — Overview and detail are one forecast
- New `lib/forecastHorizon.ts`: `?horizon=` wins, then the saved choice, then **90** (the detail's 30 default is gone; 30 stays a tab).
- `/forecast` carries `?horizon=` and `?day=`; Back/Forward restore both. A day link widens the horizon only when needed and does not save it.
- Overview reads the same horizon and names it on every figure ("Ending balance · at 90 days", "Money in vs out · 90 days", curve title and Help).
- Overview low point uses the detail's chip words and tone (rust only below zero); "under buffer / above buffer / Awaiting forecast" are gone; sparkline tone and Foot sentence follow the chip.
- Overview stats (low point, runway, ending) open `/forecast?horizon=<h>&day=<lowDate>`; the Dashboard Forecast tile link carries `horizon=90`.
- Overview page and tab kept.

## Figures that moved
- None. Golden snapshot diff = 154 added lines, 0 removed: the new `opening` key only.
- Visible default change: the Forecast detail now opens on 90 days (was 30).

## Tests added or changed
- New: `lib/checkingWords.test.ts` (every `calculatedLine` branch incl. $0.00 and null, caption words), `pages/next/forecast/ChartPanel.caption.test.tsx` (caption figures = `opening.balance` and `daily[0]`, both row cases, no reading), render test in `balanceConsistency.test.tsx` (one household → tile, Banking cell, KPI, card, Overview stat: same label, figure and line; reading only in Details; Details opens), Overview-vs-detail identical low point/date/chip (below zero, under buffer at $0.00), URL-state test in `forecastAgreement.test.tsx` (horizon + day land, survive a pick, Back/Forward), Overview tests (horizon labels, `?horizon=` wins, stat links, chip words, $0.00 not rust), spineParity gains `opening`.
- Updated for the new words/default: Tiles, bankingReview, forecastCashSignalKey, forecastHorizonSwitchPerf, forecastOverview, balanceConsistency, forecastAgreement; fake household serves `opening`.

## Gates (actual)
- typecheck: pass (repo root).
- Web vitest, TZ=America/Chicago: 280 files, 2863 passed, 0 failed, 2 skipped.
- Web vitest, TZ=UTC: 280 files, 2862 passed, 0 failed, 3 skipped.
- API vitest (own DB `h2budget_test_c_a`): spineParity (33) + forecastLedger.golden (12) + cashSignal unit + cashSignal/DayItems/bankNullWithoutSnapshot/bankingReview integration: 7 files, 167 passed, 0 failed.
- Build + entry graph: landing **621.9 KB** raw (budget 622.0; was 621.4 at d8da19c4 — +0.5 KB). OK.
- Codegen: run; generated src + dist committed; `lib/db/dist` noise reverted.
- Headless (fixture `rich2` + `FIXTURE_BALANCE=zero-rows-today`, 390×844 and 1280×800): chromium 52/52, webkit 52/52 checks. Shots in scratchpad `preview/shots/c-a/`.
- Fixture truth (curl): spine 3,374.60, reading 0.00 (+2 rows), cash-signal `bankToday` 3,374.60, `opening.balance` 0.00, `daily[0]` 3,374.60 — agree to the cent.

## Deviations from the brief
- `next/forecast/types.ts` (+ `bankReading`, `bankSince`), `lib/warmRoutes.ts` (a `/forecast?horizon=…&day=…` link still warms the 90-day data), `components/bank-balance-why.tsx` (`defaultOpen`), `pages/__test-helpers__/fakeHouseholdApi.ts` (`opening`) touched — not on the ownership list; small and additive.
- Dashboard Forecast tile link edited in `Tiles.tsx` (outside the Banking block) to carry `horizon=90`.
- Details is mounted on first press (lazy), then open — keeps the explain query and its chunk off every page until asked.
- The Dashboard tile keeps its existing `Fig` for label and figure (byte budget); the line + Details are the shared lazy note.
- Overview Runway stat reads "until negative · 90-day read": the spine's runway is a 90-day read at any horizon.
- Detail's "Overview" tab link does not carry `?horizon=` (the tab strip is layout-owned); the Overview reads the same saved choice the detail writes, so it follows anyway.
- Caption uses `+N rows today` vs `since` by comparing `opening.balance` with Checking today (no arithmetic).
- `dayTimeOf` composed from parts: WebKit printed "Oct 13 at 4:19 PM" for the old formatter.
- No server-side fixture assertion test (headless/curl instead).
- e2e specs not run (need the real stack); none reference changed words.

## Doubts for the owner
- Overview keep/fold is still your call (page and tab kept).
- A mixed day (some rows before today, some today) says "+N rows today"; opening then includes the earlier rows. Exact, but the count mixes both.
- The Forecast card head is now icon + refresh only; the label comes from the block.
- Banking cell for an account the balance does not roll on: "Checking today —" with "Not tracked for this account".
- Landing margin is 0.1 KB; the next landing change needs a trim elsewhere.
