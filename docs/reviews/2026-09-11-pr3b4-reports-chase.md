# PR3b4 — Reports tiles and Chase stats say when their figures haven't arrived

Codex work-order point **12**: never show missing or stale data as if it were current. This is the fourth web part
of plan PR3, on top of PR3b3 (live, `5ca3843`). PR3b5 ("Why this number?") follows. Plan:
`~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

- **Reports hub tiles (`reports.tsx`).** The spending-facts query had no error handling, so while it loaded or
  after it failed:
  - **Spending** read **$0.00** (a `MoneyText` of `?? 0`) and "No spend in range";
  - **Cash flow** read "No activity in range";
  - **Budget** read "No income recorded, last 30 days", with a ring labelled "0%" and In/Out at $0.00;
  - **Habits'** weekday bars stayed flat for good after a failure.

  Even with facts and no income, the Budget ring's centre read "0%" beside a "—" value.
- **Reports balance tiles (`reportsShared.tsx` `ReportsBalanceTiles`).**
  - **Cash buffer**, with no spine, read **"No Snapshot"** and "Set a checking balance on Forecast", a setup
    instruction for a spine that simply had not answered.
  - **Bank** said "No checking snapshot yet" while the forecast bundle loaded.
  - **Amex** said "Link an Amex card to track your revolving balance" while the card accounts loaded.
- **Chase stats (`transactions.tsx`, "Money in vs out" and "Checking balance").**
  - "No checking account linked." showed while the forecast bundle loaded or had failed.
  - A start balance of $0 showed a change of "0%", a percentage of nothing. A $0 start rolled back through decimal
    amounts can land a hair off zero, and then the pill showed an absurd figure.
  - Start, End and the card head fell back to **$0.00** through `?? 0` on a missing balance.
    - Today that fallback is unreachable. The cards render only behind `hasLinkedChecking`, so a snapshot anchors
      the balance closures, and `computeBalanceAtEndOfDate` always returns a number.
    - It is replaced anyway, so it cannot become a false zero later.
- **PR3b3's second look** left a NIT: `useSpine.ts` said the numbers "can't visibly age during a session", which
  is false.

## What changed

- **Reports hub**
  - The facts query goes through `dataState()`.
  - Without facts:
    - Spending and In/Out show "—";
    - the notes read "Loading…" or "Couldn't load" in place of "No spend in range" and "No activity in range";
    - Budget's sub says "No income recorded" only once the facts say so.
  - The ring's centre shows "—" whenever there is no income, so there is no ratio to state.
  - Habits keeps its seven empty columns while loading, and says "Couldn't load" after a failure.
- **Reports balance tiles**
  - **Cash buffer:**
    - without the spine: "—", with "Loading…" or "Couldn't load" from `useSpine().state`;
    - "No Snapshot" and the setup hint only once the spine says `no_data`.
  - **Bank and Amex hints:**
    - nothing while their query loads;
    - "Couldn't load" after it fails. `reports.tsx` passes the forecast bundle's error down, and the tile reads
      its own card-accounts query.
    - Once answered, "No checking snapshot yet" and "Link an Amex card…" as before.
- **Chase stats**
  - `useGetForecast` now reads `isError`.
  - The empty stats card says "Loading checking account…" or "Couldn't load checking account." until the bundle
    answers, and only then "No checking account linked.".
  - The change pill needs a start balance of at least half a cent in magnitude, otherwise "—". This is a display
    gate, not money maths.
  - A missing Start, End or head balance shows "—", not `?? 0`.
  - Three test ids are added: `chase-stats-in-out`, `chase-stats-balance` and `chase-stats-no-account`.
- **`useSpine.ts` comment** now says what is true. A page left open does not refresh on its own, because there is
  no focus refetch and no polling. That is why the refresh banner and the freshness line state their age.

## Figures that should move

**No money figure changes once loaded.** What you would see:
- **Reports:**
  - dashes and "Loading…" or "Couldn't load" before the aggregate and the spine arrive;
  - "Couldn't load" on the bank and Amex hints and on Habits after a failure;
  - with no income, the Budget ring reads "—", not "0%".
- **Chase:**
  - "Loading checking account…" instead of "No checking account linked." on open;
  - with a start balance that is $0 to the cent, the change reads "—", not "0%" or a rounding-error percentage.

## Must not change

- **Every figure once it has loaded.**
- **The Reports hub** still never asks for raw transactions. It still quotes the spine's bank balance and
  cash-buffer verdict, the server's real spend, and the budget ring against real income. Those tests are
  unchanged.
- **The landing page.** Untouched. Reports and Chase are lazy routes.

## Tests

- **`pages/reportsHubKitRestyle.test.tsx`**
  - Its mocks are steerable, with a hoisted `hub` state reset in `beforeEach`. The defaults match the old fixtures.
  - +8:
    - while the facts load: dashes and "Loading…", never $0.00, "No spend", "No income recorded" or "0%";
    - after the facts fail: "Couldn't load" on Spending, Budget, Cash flow and Habits;
    - facts with no income: a ring dash, not "0%";
    - without the spine: the cash buffer says loading, not "No Snapshot" or the setup hint;
    - after the spine fails: "Couldn't load";
    - before the account and card queries answer: no "No checking snapshot yet" and no "Link an Amex card";
    - after those queries fail: "Couldn't load" on both hints;
    - once they answer empty: both hints return. This one passes on the base code too, as a control.
- **New `pages/chaseStats.test.tsx`** (6)
  - The clock is pinned mid-month.
  - The account note while the bundle loads, when it failed, and once it answers with no account.
  - The change row reads a dash:
    - on a $0 start;
    - on a start that is $0 to the cent but a hair off in floating point (0.30 − 0.10 − 0.20).
  - A real start balance: the pill and every balance.
  - The change assertions read the "Change" label's own row, so the In/Out legend's "100%" cannot satisfy them.

## Verification

- **Workspace typecheck and build:** pass, including the end-to-end specs' typecheck.
- **Full web suite (clock in UTC, as on CI):** **116 files, 895 pass**. That is one file and fourteen tests more
  than PR3b3: the eight Reports hub cases and the new Chase stats file (6).
- **API suite:** not re-run. No server code changed.
- **Landing bundle guard:** **572.0 KB of 580**, unchanged. No recharts on open.
- **End-to-end:** unchanged specs. Playwright is opt-in on CI and was not run locally.

## Independent review

A separate reviewer read `f23fcaa` and asked for changes: one MEDIUM, LOWs and NITs. It found 11 of the 12 new
tests failing on the base code. All findings are fixed in the follow-up commit.
- **MEDIUM:** the $0-start Chase test failed on the 1st of every month. On that day the day before the week's start
  falls before the snapshot, so today's row rolled back into the start. The clock is now pinned mid-month.
- **LOW:** a true $0 start rolled back through decimals can land a hair off zero and show an absurd percentage.
  The pill is gated at half a cent, with a test.
- **LOW:** the bank and Amex hints stayed blank for good after their query failed. They now say "Couldn't load".
- **NIT:** the Chase comment and this note credited the rows' early return for why the balances are never null.
  The real guard is the snapshot gate. Both are corrected.
- **NIT:** a Change assertion held only for this fixture. It now reads the Change row itself.
- **NIT:** the facts-failed test did not check Cash flow, and Habits stayed flat after a failure. Both are fixed.
- **Note overstatements** are corrected: three test ids, the failure hints, and the exact-zero pill.

## Left for later PRs

- **PR3b5:** "Why this number?" on the Banking bank stat, from the typed explain response.
- **PR13/PR14** replace the Chase page's local sums over a 1,000-row pull with the paginated ledger and its
  server totals. This PR only stops the false zeros.
- **Server, when PR4 touches `/spine`:** read the settings row once (from PR3b3's review).
