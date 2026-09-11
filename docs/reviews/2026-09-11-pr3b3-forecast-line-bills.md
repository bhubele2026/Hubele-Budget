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
- **The Forecast page's error banners** were worded unlike every other banner:
  - "Forecast refresh failed. Displayed figures may be out of date.";
  - "Forecast could not load.";
  - "Forecast could not load. Try again to see your projection." (this one was unreachable).
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
  - **The page reads `useSpine()`.** It shares the app-wide spine cache, so it adds no new endpoint. Mounting it
    does refetch a spine older than 60s, as Bills overview, Avalanche and Reports already do. The same correction
    is made to the comment in `useSpine.ts`, which said moving between pages never refetches.
  - **The snapshot line uses `FreshnessLine` only when the spine describes the same snapshot:**
    `Date.parse(spine.bank.asOfDate) === Date.parse(bankSnapshot.at)`.
    - **The same stored time.** Both read `forecast_settings.bank_snapshot_at` for the household owner, as an ISO
      string: the spine through `lib/cashSignal.ts` (`settings.bankSnapshotAt`, lines 318 and 826), `/forecast`
      through `presentSnapshot` in `routes/forecast.ts`. Every writer sets the time and the source together.
    - **When they can differ.** The two are separate requests with different cache lifetimes, so they can
      briefly disagree after a write. Then the times differ, and the existing timestamp label stays.
    - **Until the spine answers**, the label stays too.
  - **The fresh-state wording** and the `text-bank-snapshot-freshness` test id are unchanged.
- **Forecast banners:** the wording is now the same as Forecast Overview.
  - "Couldn't load the forecast." when nothing loaded, both when the page's forecast failed on first load and
    when the projection never arrived.
  - "Couldn't refresh the forecast." when figures are on screen.
  - "Retry forecast" is unchanged.
- **Bills overview (`bills-overview.tsx`)**
  - The summary query goes through `dataState()`.
  - A `RefreshBanner`, placed under the spine's headline row, speaks for the month below. After a failed refresh
    the month stays on screen with its age; after a failed first load the banner says so. Both offer Retry.
  - Without a summary:
    - the five month figures read "—";
    - the Short/Surplus chip, the Committed meter and its footnote are not drawn;
    - the bills card says "Loading bills…" or "Couldn't load bills" in place of "No recurring bills".
  - "nothing scheduled" shows only once the spine has answered.
- **Tests:**
  - Ten Forecast page tests mock `useSpine`. Their client mocks cannot load `useSpine.ts`, which calls the spine
    query-key helper at import.
  - The eleventh, `forecastAccuracy.test.tsx`, gets mocks it can steer for the spine and both forecast queries.
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
- **Forecast, error banners:** the new wording. "Load" and "refresh" now each appear only when true.
- **Forecast, network:** one spine request on opening the page, when the cached spine is over a minute old.
- **Bills overview:** dashes and "Loading bills…" before the summary arrives, and a banner with Retry under the
  headline when it fails.

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

- **`pages/forecastAccuracy.test.tsx`** (+8)
  - **The bank line:**
    - "Refresh failed" when the spine judges this snapshot stale;
    - the same instant with and without milliseconds still matches;
    - a fresh verdict shows exactly one freshness label and no stale line;
    - the timestamp label while the spine has not answered;
    - a verdict about a different snapshot is ignored.

    The first two fail on the base code. The last three guard the main and fallback paths, and pass on the base
    code too.
  - **The error banners:**
    - the projection never loaded: "load", never "refresh";
    - a refresh failed with figures on screen: "refresh", never "load";
    - the page's forecast never loaded: "load".

    The two "load" cases fail on `6601674`. The "refresh" case passes there too, since that code always said
    "refresh"; it guards the other half of the choice.
- **`pages/billsOverviewSpine.test.tsx`** (+4), all of which fail on the base code:
  - while loading: dashes, no chip, meter, footnote or "No recurring bills", and no banner;
  - after a failed first load: the banner with Retry, dashes, "Couldn't load bills";
  - after a failed refresh: the banner, and the month kept to the cent;
  - "nothing scheduled" only once the spine answers.
- **Ten Forecast page test files:** the spine mock only. No assertion changed.

## Verification

- **Workspace typecheck and build:** pass, including the end-to-end specs' typecheck.
- **Full web suite (clock in UTC, as on CI):** **115 files, 881 pass**. That is twelve more than PR3b2: the eight
  Forecast cases (bank line and banners) and the four Bills overview cases.
- **API suite:** not re-run. No server code changed.
- **Landing bundle guard:** **572.0 KB of 580**, unchanged. No recharts on open.
- **End-to-end:** unchanged specs. Playwright is opt-in on CI and was not run locally.

## Independent review

A separate reviewer read `6601674` and asked for changes: one MEDIUM, one LOW and NITs. They are fixed in the
follow-up commit, except where noted.
- **MEDIUM:** the banner's new "load" wording could never show, because the page returns early without its
  forecast. A projection that failed on first load still said "refresh", and the early-return banner kept the old
  copy. Fixed, and three tests pin it.
- **LOW:** "no extra request" was wrong, because a stale spine refetches when the page mounts. The wording is
  corrected here, in `forecast.tsx`, and in `useSpine.ts`'s own comment, which had the same error.
- **NIT, tests:** only one of the first three bank-line tests failed on the base code. Two cases are added: the
  fresh main path, and one instant written two ways, which is the reason for `Date.parse`.
- **NIT, Bills overview:** the banner sat above the spine's headline, which had loaded. It is now under it.
- **NIT, kept:** with no hint while the spine loads, the Next bill stat is a line shorter until it answers. Banking
  does the same since PR3b2.
- **NIT, server, left for later:** `/spine` reads the settings row twice in one `Promise.all`, once for the
  snapshot time and once for the freshness verdict. A write landing between the two reads could pair a new time
  with the previous verdict until the next spine response. The window is tiny and fixes itself, and the server
  code is older than this PR.

## Left for later PRs

- **PR3b4:**
  - the Reports hub tiles: Spending, Budget and Cash flow while the spending facts load or fail;
  - `ReportsBalanceTiles`: the cash buffer's "No Snapshot" on a missing spine, and the account and Amex hints
    while their queries load;
  - the Chase stats: "No checking account linked" while the forecast loads, and the `?? 0` balances.
- **PR3b5:** "Why this number?" on the Banking bank stat, from the typed explain response.
- **Server, when PR4 touches `/spine`:** read the settings row once and hand it to both `computeCashSignal` and
  `computeBankFreshness`.
