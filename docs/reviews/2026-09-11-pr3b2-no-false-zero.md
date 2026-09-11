# PR3b2 — Missing numbers read "—", and PR3b1's review follow-ups

Codex work-order point **12**: never show missing or stale data as if it were current. This is the second web
part of plan PR3, on top of PR3b1 (live, `5805efb`). PR3b3 (the Chase stats, Bills overview, Reports, and the
Forecast snapshot line) and PR3b4 ("Why this number?") follow. Plan:
`~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

- **The Forecast page** showed **$0.00** as the ending balance while the projection was loading or had failed.
  "Bank before", "Matched impact" and "Through" in its footnote did the same.
- **The date lookup** ("How much will we have?") said "Set a bank balance and load the forecast" while the
  forecast was simply loading or had failed.
- **Forecast Overview** drew its In/Out bar from zeros before there was a projection. Its forecast banner was
  worded differently from the spine banner above it.
- **Banking** said "none scheduled" and "next 90 days" before the spine had answered. With no bank snapshot it
  left an empty slot beside Sync.
- **The spending strip** read "Loading comparison…" forever when the previous window's request failed, and its
  head did not wrap on a phone.
- **PR3b1's review** approved that PR and left LOW and NIT findings. They are fixed here, listed below.

## What changed

- **Money that has not arrived reads "—".** `moneyFace()` in `components/data-state.tsx` does it. Do not use
  `MoneyText` for this: it turns a missing amount into $0.00.
  - `forecast.tsx`: the ending balance and the three footnote figures.
  - `forecast-overview.tsx`: no In/Out bar until the projection is ready, a dash instead.
- **The date lookup says why it has no answer**, through a new `state` prop that the Forecast page passes from its
  projection query:
  - "Loading the forecast…" while it loads;
  - "Couldn't load the forecast" after it failed;
  - the setup hint only when there is no bank balance.
- **Banking:** the hints wait for the spine, and there is no freshness slot without a snapshot.
- **The spending strip:** "Comparison unavailable" when the previous window failed, and a head that wraps.
- **PR3b1's review follow-ups:**
  1. **The spine asks again after sign-in.**
     - **Why:** `App.tsx` prefetches the spine before Clerk boots, with `retry: false`. A page that mounts while
       that request is out shares it rather than starting its own. Its old comment said "the mounted query
       refetches", and it does not. So a 401 left the page on "Couldn't load" for a valid session.
     - **Fix:** once Clerk has signed in, `lib/spineRecovery.ts` asks once more. That covers a prefetch that
       already failed with nothing to show, and one that is still out and fails after sign-in.
     - **Limits:** it asks once, never in a loop. A failed refresh with numbers on screen is left to the banner's
       Retry.
  2. **Tests:** a new `chaseBucketChip.test.tsx` checks the Chase chip on an unknown count, a real zero and a
     count. The app-shell test alone could not tell the old code from the new.
  3. **`FreshnessLine`:** "last updated" after a failed refresh uses the latest bank contact, as the server does.
  4. **End-to-end:** at 390px the freshness label must lie inside the viewport at its full width, not merely be
     visible.
  5. **Copy:**
     - "Bank last updated 2 days ago", in place of a line that contradicted itself;
     - "Set manually 1 week ago · needs an update", which states the age once;
     - "May be out of date" for a reason this build does not know;
     - Forecast Overview's forecast banner now reads "Couldn't refresh the forecast." with Retry.
  6. **Leftovers:**
     - no empty slot beside Sync;
     - the dead cash-signal fixture is gone;
     - the refresh banner's age keeps ticking, with a timer only while it shows one;
     - `useSpine` exposes `isFetching`, and the banner says "Refreshing…" while a Retry is in flight.
  7. **The PR3b1 note's two overstatements** are corrected.

## Figures that should move

**No money figure changes.** What you would see:
- **Forecast:** "—" instead of $0.00 before the projection arrives, and the date lookup says it is loading or
  failed.
- **Forecast Overview:** a dash instead of an empty bar, and the forecast banner's new wording.
- **Banking:**
  - no "none scheduled" or "next 90 days" before the spine answers;
  - the new wording on a stale balance;
  - "Refreshing…" during a Retry.
- **Spending strip:** "Comparison unavailable" when the comparison fails. The head wraps at 390px.
- **After an expired session:** the numbers arrive once Clerk signs in, instead of "Couldn't load".

## Must not change

- **Every figure, once it has loaded.**
- **The landing page.**
  - Still no dollar figures.
  - The sign-in effect is in the signed-in shell. It adds a request only when the spine failed with nothing to
    show.
- **The Forecast page's snapshot meta line.**
  - It still uses the timestamp label.
  - Moving it onto the server's verdict means `forecast.tsx` reading the spine, and 11 Forecast page tests mock
    the client without it.
  - PR3b3 does both together.

## Tests

- **New `lib/spineRecovery.test.ts`** (6), on a real `QueryClient`:
  - asks again after a prefetch that already failed;
  - waits for a prefetch still out, and asks again when it fails after sign-in;
  - no second request when that prefetch succeeds;
  - asks once, not in a loop, when the server keeps failing;
  - leaves a failed refresh with numbers on screen alone;
  - does nothing when the spine was never asked for.
- **`components/dataState.test.tsx`:**
  - the copy for each reason (the latest contact after a failed refresh, the age stated once, an unknown reason);
  - "Refreshing…" in place of Retry;
  - the ticking age;
  - `moneyFace` for a missing figure and for a real zero.
- **`hooks/useSpine.test.tsx`:** `isFetching`, including a Retry in flight after a failed refresh.
- **New `pages/chaseBucketChip.test.tsx`** (3): "All reconciled" on a real zero, nothing on an unknown count, and
  the match link with the count.
- **`pages/commandCenter.test.tsx`:** hints before and after the spine answers, and no empty freshness slot.
- **`pages/forecastOverview.test.tsx`:** a dash, not an In/Out bar, until there is a projection.
- **`components/forecast-date-balance.test.tsx`:** loading, failed, and the setup hint only without a bank
  balance.
- **New `components/chaseInsightStrip.test.tsx`** (3): loading, unavailable, and the comparison once it arrives.
- **Not unit-tested:**
  - The Forecast hero and footnotes. Each is a one-line ternary on `moneyFace`, which is tested.
  - The two-line effect in `ProtectedShell` that calls the tested helper.

## Verification

- **Workspace typecheck and build:** pass, including the end-to-end specs' typecheck.
- **Full web suite (clock in UTC, as on CI):** **115 files, 861 pass**. That is three files and 26 tests more than
  PR3b1:
  - the new files: sign-in recovery (6), the Chase chip (3) and the spending strip (3);
  - 14 cases added to the freshness line and banner, spine hook, Banking, Forecast Overview and date lookup
    tests.
- **API suite:** not re-run. No server code changed.
- **Landing bundle guard:** **572.0 KB of 580**.
  - Up 0.4 KB from PR3b1; PR3 as a whole has added 0.7 KB, inside its 1 KB allowance.
  - The sign-in helper is on the open path, because `App.tsx` imports it.
  - No recharts on open.
- **End-to-end:** the changed spec typechecks. Playwright is opt-in on CI and was not run locally.

## Left for later PRs

- **PR3b3:**
  - the Chase stats, Bills overview and the Reports tiles;
  - the Forecast page's snapshot meta line onto `FreshnessLine`, with the spine added to the 11 Forecast page
    test mocks;
  - the Forecast page's own error banner ("Forecast refresh failed. Displayed figures may be out of date.") onto
    the same wording as the others.
- **PR3b4:** "Why this number?" on the Banking bank stat, from the typed explain response.
