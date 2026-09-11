# PR3b3 — The Forecast bank line takes the server's verdict; Bills overview invents no month

Codex work-order point **12**: never show missing or stale data as if it were current. This is the third web part
of plan PR3, on top of PR3b2 (live, `b6c32f7`). After PR3b2, the rest of PR3 was split again:
- **this PR:** the Forecast bank card and Bills overview;
- **PR3b4:** the Reports tiles and Chase stats;
- **PR3b5:** "Why this number?".

Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

- **The Forecast page's bank card** showed only a timestamp under the balance ("Last auto-updated 3 hours ago").
  - It could not say a refresh had failed, a feed had gone quiet, or a typed-in balance was old.
  - Banking has shown the server's verdict since PR3b1.
- **The Forecast page's error banner** was worded unlike every other banner: "Forecast refresh failed. Displayed
  figures may be out of date." and "Forecast could not load. Try again to see your projection."
- **Bills overview had no error handling.** `num()` turns a missing `/bills/summary` into 0, so while it loaded
  or after it failed, the month card read:
  - five $0.00 figures;
  - "Surplus";
  - "Committed 0%";
  - "Of every income dollar, 0¢ is already spoken for".

  The bills card said "No recurring bills", and the Next bill hint said "nothing scheduled" before the spine had
  answered.
- **PR3b2's second look** left two test-hygiene NITs.

## What changed

- **Forecast bank card (`forecast.tsx`)**
  - The page reads `useSpine()`. It is cached app-wide, so there is no extra request.
  - The snapshot line uses `FreshnessLine`, but only when the spine describes the same snapshot:
    `Date.parse(spine.bank.asOfDate) === Date.parse(bankSnapshot.at)`.
    - Both are the same stored time, `forecast_settings.bank_snapshot_at` as an ISO string. The spine reads it
      through `lib/cashSignal.ts` (`settings.bankSnapshotAt`, lines 318 and 826); `/forecast` reads it through
      `presentSnapshot` in `routes/forecast.ts`.
    - Until the spine answers, or if the two ever disagree on which snapshot is current, the existing timestamp
      label stays.
  - The fresh-state wording and the `text-bank-snapshot-freshness` test id are unchanged.
- **Forecast banner:** "Couldn't refresh the forecast." when there are figures to keep, and "Couldn't load the
  forecast." when there never were. These match Forecast Overview. "Retry forecast" is unchanged.
- **Bills overview (`bills-overview.tsx`)**
  - The summary query goes through `dataState()`.
  - A `RefreshBanner` covers failure. After a failed refresh the month stays on screen with its age; after a
    failed first load the banner says so. Both offer Retry.
  - Without a summary:
    - the five month figures read "—";
    - the Short/Surplus chip, the Committed meter and its footnote are not drawn;
    - the bills card says "Loading bills…" or "Couldn't load bills" in place of "No recurring bills".
  - "nothing scheduled" shows only once the spine has answered.
- **Tests:**
  - Ten Forecast page tests mock `useSpine`. Their client mocks cannot load `useSpine.ts`, which calls the spine
    query-key helper at import.
  - The eleventh, `forecastAccuracy.test.tsx`, gets a mock it can steer.
- **PR3b2's second-look NITs:**
  - `forecastOverview.test.tsx` resets the spine state in `beforeEach`.
  - `dataState.test.tsx` restores its `setInterval` spy in a `finally`.
  - The PR3b2 note records the second look's approval and this split.

## Figures that should move

**No money figure changes.** What you would see:
- **Forecast, bank card:** a stale balance says why, as on Banking:
  - "Refresh failed · last updated …";
  - "Bank last updated 2 days ago";
  - "Set manually … · needs an update".
- **Forecast, error banner:** the new wording.
- **Bills overview:** dashes and "Loading bills…" before the summary arrives, and a banner with Retry when it
  fails.

## Must not change

- **Every figure once it has loaded.**
  - The Bills month table still matches `/bills/summary` to the cent.
  - Its headline is still the spine's.
  - The existing parity tests are unchanged.
- **The fresh bank line:** same words, same test id. The e2e spec and `forecastBankSnapshotFreshness.test.tsx`
  are unchanged.
- **The landing page.**
  - Untouched.
  - Forecast and Bills overview are lazy routes, so the open path does not grow.

## Tests

- **`pages/forecastAccuracy.test.tsx`** (+3):
  - "Refresh failed" on the bank line when the spine judges this snapshot stale;
  - the timestamp label while the spine has not answered;
  - a verdict about a different snapshot is ignored.
- **`pages/billsOverviewSpine.test.tsx`** (+4):
  - while loading: dashes, no chip, meter, footnote or "No recurring bills", and no banner;
  - after a failed first load: the banner with Retry, dashes, "Couldn't load bills";
  - after a failed refresh: the banner, and the month kept to the cent;
  - "nothing scheduled" only once the spine answers.
- **Ten Forecast page test files:** the spine mock only. No assertion changed.
- **Not unit-tested:** the Forecast banner's wording. It is one string choice, and no test pinned the old copy.

## Verification

- **Workspace typecheck and build:** pass, including the end-to-end specs' typecheck.
- **Full web suite (clock in UTC, as on CI):** **115 files, 876 pass**, seven more than PR3b2: the three Forecast
  bank-line cases and the four Bills overview cases.
- **API suite:** not re-run. No server code changed.
- **Landing bundle guard:** **572.0 KB of 580**, unchanged. No recharts on open.
- **End-to-end:** unchanged specs. Playwright is opt-in on CI and was not run locally.

## Left for later PRs

- **PR3b4:**
  - the Reports hub tiles: Spending, Budget and Cash flow while the spending facts load or fail;
  - `ReportsBalanceTiles`: the cash buffer's "No Snapshot" on a missing spine, and the account and Amex hints
    while their queries load;
  - the Chase stats: "No checking account linked" while the forecast loads, and the `?? 0` balances.
- **PR3b5:** "Why this number?" on the Banking bank stat, from the typed explain response.
