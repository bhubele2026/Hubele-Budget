# PR3b5 — "Why this number?" on the Banking bank balance

Codex work-order point **12**: never show missing or stale data as if it were current, and let the household see
why a figure reads what it reads. This is the last web part of plan PR3, on top of PR3b4 (live, `b4cf585`). PR4
(cash today, one rule) follows. Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

- **The bank balance on Banking is one figure with a date under it.** When it looks wrong, nothing on screen says
  what it is built from:
  - which snapshot it starts from;
  - what has been added since;
  - whether the server trusts it;
  - whether the next Sync will even re-read it.
- **The server already answers every one of those.** `GET /forecast/bank-balance-explain` is read-only, makes no
  Plaid call, and since PR3a has a typed response with its freshness verdict. Nothing in the app showed it.

## What changed

- **New `components/bank-balance-why.tsx`: an info button on the bank balance tile opens a popover.**
  - **Nothing is fetched until it opens.** The explain query runs with `enabled: open` and a 60s `staleTime`.
  - **Every line is the server's.**
    - The balance on screen: `displayed.bankToday`.
    - The snapshot: its balance, household day, source, name and mask.
    - The rows since it: the count and the net, from `ledger.sinceAnchor`.
    - The freshness verdict: the same `FreshnessLine` as the tile.
    - Whether the next Sync re-reads the balance. If not, the server's reason, verbatim.
  - **With no snapshot,** it says the forecast runs off the starting balance.
  - **Loading and failure** say so. Failure offers a Retry.
- **No equation.** The two figures follow different rules, so the popover never shows snapshot + rows = balance:
  - the balance on screen is the cash signal's roll-forward;
  - the rows-since net is a plain sum of the account's rows after the snapshot day (`routes/bankBalanceExplain.ts`,
    lines 111-127).

  The lines are separate. When they do not add up to the cent, a sentence says they are counted by different rules.
  PR4 makes cash today one rule.
- **`command-center.tsx`**
  - The bank balance `Stat` sits in a `relative` wrapper with the button in its top-right corner.
  - The `Stat` itself is unchanged: same test id, value and hint.
  - The button is not nested inside the tile, so a clickable `Stat` could never put a button inside a button.

## Figures that should move

**None.** No figure changes. What you would see on Banking is a small info icon on the bank balance tile. Tapping it
shows the explanation.

## Must not change

- **The bank balance figure** is still the spine's, and the parity tests are unchanged.
- **No new request on open.** The explain endpoint is called only when the popover opens.
- **No server change.** The popover invents no prose: its sentences are fixed labels around the server's
  figures and reasons.
- **The landing page's content.** Untouched. The popover itself is in Banking's lazy chunk (`command-center-*.js`).
  See Verification for what the landing bundle did gain.

## Tests

- **New `components/bankBalanceWhy.test.tsx`** (9)
  - **Fetching:**
    - closed: the query is disabled and nothing renders;
    - open: the query is enabled, and it says "Loading…";
    - failed: "Couldn't load", and Retry refetches.
  - **The lines:**
    - the balance on screen, the snapshot with source, name and mask, "2 rows since then" with the net, the next-Sync
      sentence, and the freshness line;
    - no note when the snapshot and rows add up to the cent;
    - the "different rules" note when they don't, and no "=" anywhere;
    - the server's `whyNot`, verbatim;
    - no snapshot: the starting-balance sentence, with no snapshot line and no note;
    - a stale verdict: "Refresh failed".
- **`pages/commandCenter.test.tsx`** (+1): the button sits on the bank balance tile. Its explicit client mock gains
  the explain hook and its query key.

## Verification

- **Workspace typecheck and build:** pass, including the end-to-end specs' typecheck.
- **Full web suite (clock in UTC, as on CI):** **117 files, 905 pass**, ten more than PR3b4: the nine popover cases
  and the Banking button.
- **API suite:** not re-run. No server code changed.
- **Landing bundle guard:** **572.4 KB of 580**, up **0.4 KB**. No recharts on open.
  - **Why it grew.** The generated API client (`lib/api-client-react`) is one module that already sits in the
    landing chunk, because the landing reads the spine through it. Using the explain hook anywhere keeps that
    endpoint's small helpers in the module: its URL builder, query key, query options and fetcher.
    - The built landing chunk contains `bank-balance-explain` twice.
    - It contains none of the popover: no "Why this number", no `bank-why`, no Popover code.
  - **The alternative.** Hand-writing a `useQuery` around the bare fetcher would save a fraction of that, but
    CLAUDE.md requires consuming the generated hook, so the hook stays.
  - ⚠️ **Over plan.** PR3 as a whole has now added **1.1 KB** to the landing (571.3 → 572.4), 0.1 KB over the plan's
    1 KB allowance for PR3. The enforced 580 KB cap is met. This is flagged for the reviewer, rather than hidden
    by trimming unrelated code.
- **End-to-end:** unchanged specs. Playwright is opt-in on CI and was not run locally.

## Left for later PRs

- **PR4:** one rule for cash today, which would let the popover state an equation that always holds.
- **Server, when PR4 touches `/spine`:** read the settings row once (from PR3b3's review).
