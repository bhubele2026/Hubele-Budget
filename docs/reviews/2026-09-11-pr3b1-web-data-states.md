# PR3b1 — Screens say when the numbers can't be trusted

Codex work-order point **12**: never show missing or stale data as if it were current. This is the first web half
of plan PR3, on top of PR3a (live, `183328e`), which made the server decide when the bank balance is stale.
PR3b2 follows with the $0 sweep and "Why this number?". Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

- **`useSpine` returned only `{data, isLoading}`.**
  - After a failed refresh, the old numbers stayed on screen with no sign that they were old.
  - A failed first load looked exactly like "still loading", forever.
- **`useReviewInboxCount` returned 0 for loading, failed and empty alike.** So the Chase page said "All
  reconciled" while the spine was still loading or had failed.
- **Banking's freshness label was only a timestamp.**
  - It showed how long ago the snapshot was taken, read from the cash-signal query — a whole extra request for
    two fields — with no notion of a failed refresh or a quiet feed.
  - It was hidden below the `sm` breakpoint, so a phone never saw it.
- **The freshness-label end-to-end spec could not pass.** It targeted a Dashboard tile and a Transactions meta
  line that no longer exist. CI runs Playwright only when `E2E_ENABLED` is set, so nobody noticed.

## What changed

- **`lib/queryState.ts`:** `dataState()` names five states — cold, loaded, refreshing, refresh-failed, failed —
  and `hasData()` says whether there are numbers to show.
- **`hooks/useSpine.ts`** adds `state`, `error`, `updatedAt` and `refetch`. The change is additive.
- **`hooks/useReviewInboxCount.ts`** returns `number | null`. Null means unknown.
- **`components/data-state.tsx`:**
  - **`FreshnessLine`** reads the spine's bank fields from PR3a.
    - Fresh: the existing "Last auto-updated …" / "Set manually …" line, from the same component with the same
      test id.
    - Stale, the words say why:
      - "Refresh failed · last updated …", the only one in the alarm colour;
      - "No bank update in 2 days · last updated …";
      - "Set manually … · over a week old".
  - **`RefreshBanner`**:
    - After a failed refresh: "Couldn't refresh. Showing numbers from 5 minutes ago." with Retry.
    - After a failed first load: "Couldn't load these numbers." with Retry.
    - Otherwise nothing.
- **Banking (`command-center.tsx`):**
  - The refresh banner sits above the spine row.
  - The freshness line sits beside Sync, at every width.
  - The cash-signal query is gone, because the spine now carries the snapshot's source and the freshness
    verdict.
- **Forecast Overview:** the refresh banner for the spine, above the existing cash-signal banner.
- **Nav (`layout.tsx`):** no rail badge and no header pill while the count is unknown.
- **Chase (`transactions.tsx`):** "All reconciled" shows only on a real zero, and the dead
  `BankSnapshotFreshness` import is removed.
- **`e2e/bank-snapshot-freshness-label.spec.ts`** is rewritten against Banking (desktop and 390px) and
  Forecast.
- **Also carries PR3a's last review wording fix** to `docs/reviews/2026-09-11-pr3a-bank-freshness.md`.

## Figures that should move

**No money figure changes.** What you would see:
- **Banking:**
  - The freshness line now shows on a phone.
  - A stale balance says why.
  - After a failed refresh, a banner says the numbers are from N minutes ago and offers Retry.
  - One fewer request when the page opens.
- **Forecast Overview:** the same banner for the spine.
- **Chase:** no "All reconciled" chip while the review count is unknown.
- **Nav:** no review badge while the count is unknown. It is unchanged whenever the count is known.

## Must not change

- **Every figure on Banking and Forecast Overview is still the spine's.** The parity tests are unchanged.
- **The landing page.** Untouched, still no dollar figures; its bell already hides an unknown count.
- **The fresh-state wording** and the `text-bank-snapshot-freshness` test id.
- **The Forecast page's own snapshot meta line.** It keeps its timestamp label for now. Moving it onto the
  server's verdict means the Forecast page reading the spine, and a later PR does that together with the page's
  test mocks.

## Tests

- **`lib/queryState.test.ts`** (10): the full state matrix, including a failed refresh with a retry in flight
  and a real `null` payload, plus `hasData`.
- **`hooks/useSpine.test.tsx`** (5):
  - cold while the first load is in flight;
  - failed first load;
  - loaded with the fetch time;
  - a failed refresh keeps the data;
  - Retry goes through to the query.
- **`hooks/useReviewInboxCount.test.tsx`** (4): the count, a real zero, null while there is no data, and a single
  read of the spine. The null case replaces the old "0 while loading" expectation, **on purpose**.
- **`components/dataState.test.tsx`** (9):
  - `FreshnessLine`: nothing without a snapshot; fresh Plaid; fresh manual; `refresh_failed` in the alarm colour;
    `old` without it; `manual_old`.
  - `RefreshBanner`: nothing when all is well; a failed refresh with its age and Retry; a failed first load with
    Retry.
- **`pages/commandCenter.test.tsx`:**
  - Freshness comes from the spine for Plaid and manual, is visible at phone width, and a stale balance says
    "Refresh failed".
  - The refresh banner keeps the figures and offers Retry; there is no banner when the spine loaded.
  - The mock no longer offers the cash-signal query, so the page fails loudly if it ever calls it again.
- **`pages/forecastOverview.test.tsx`:**
  - A failed refresh shows the banner and keeps the figures.
  - A failed first load shows the banner and em dashes, never $0.
  - There is no banner when the spine loaded.
- **`components/appShell.test.tsx`:** no header pill, and no count on the Review tab, while the count is unknown.
  (The rail badge shares `railBadge`, but no test mounts it in that state.)

## Verification

- **Workspace typecheck and build:** pass, including the end-to-end specs' typecheck.
- **Full web suite (clock in UTC, as on CI):** **112 files, 835 pass**. That is three files and 33 tests more than
  PR3a:
  - the state matrix (10), the spine hook (5), and the freshness line and banner (9);
  - nine cases added to the review count, Banking, Forecast Overview and app shell tests.
- **API suite:** not re-run. No server code changed.
- **Landing bundle guard:** **571.6 KB of 580**, up 0.3 KB, within the 1 KB this PR was allowed. The nav on the
  landing path now imports the few lines of `queryState`. No recharts on open.
- **End-to-end:** the rewritten spec typechecks. Playwright is opt-in on CI and was not run locally.

## Independent review

A separate reviewer read `534a817` and **approved**, with nothing HIGH or MEDIUM. Its LOW and NIT findings are
fixed in PR3b2, and listed in that PR's note:
- a rare race where a page mounting during the failed spine prefetch keeps "Couldn't load";
- the app-shell "unknown count" test also passing on the old code, and no Chase test for the chip itself;
- "last updated" after a failed refresh ignoring the latest sync;
- the 390px end-to-end check not proving the label fits;
- copy that repeats itself or contradicts itself, and two differently worded banners;
- an empty wrapper span, a dead test fixture, and a banner age that never ticks;
- two overstatements in this note, corrected above.

## Left for later PRs

- **PR3b2:** the $0 sweep on the Forecast hero and footnotes, the Overview In/Out bar, `forecast-date-balance`,
  the Banking hints and `chase-insight-strip`, plus this PR's review follow-ups.
- **PR3b3:** the Chase stats, Bills overview and Reports, and the Forecast page's snapshot meta line onto
  `FreshnessLine`.
- **PR3b4:** "Why this number?" on the Banking bank stat, from the typed explain response.
