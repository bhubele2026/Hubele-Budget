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
  - whether the next Sync will even ask the bank for it.
- **The server already answers every one of those.** `GET /forecast/bank-balance-explain` is read-only, makes no
  Plaid call, and since PR3a has a typed response with its freshness verdict. Nothing in the app showed it.
- **The tile's "as of" day** was cut from the UTC timestamp. A snapshot taken at 9:30pm in Chicago read as the next
  day.

## What changed

- **New `components/bank-balance-why.tsx`: an info button on the bank balance tile opens a popover.**
  - **Only asked when opened, and never older than the tile.**
    - The explain query runs with `enabled: open` and `staleTime: 0`, so every open asks afresh.
    - Sync (`hooks/use-plaid-sync.tsx`) and every successful write (the `mutationCache` in `App.tsx`) invalidate
      it too.
    - While a newer answer is on its way, the popover says "Loading…" rather than showing the older one.
    - A failed refresh keeps the last answer under a `RefreshBanner` that says how old it is.
    - A failed first load says "Couldn't load", with Retry.
  - **Every figure, day and reason is the server's.**
    - The balance on screen: `displayed.bankToday`.
    - The snapshot: its balance, the server's household day for it (`ledger.anchorDay`), and its source, name and
      mask.
    - The rows since it: the count and the net, from `ledger.sinceAnchor`.
    - The freshness verdict: the same `FreshnessLine` used in the spending card's header, dated from `snapshot.at`.
    - With a snapshot, whether the next Sync asks the bank for the balance. If it won't, the server's reason,
      verbatim.

    The component's only arithmetic is comparing these figures to the cent.
  - **With no snapshot,** it says the forecast runs off the starting balance, and nothing about the next Sync.
- **No equation.** The two figures follow different rules, so the popover never shows snapshot + rows = balance:
  - the balance on screen is the cash signal's roll-forward;
  - the rows-since net is a plain sum of the account's rows after the snapshot day (`routes/bankBalanceExplain.ts`,
    lines 111-127), and it is absent when the snapshot's account does not resolve.

  The lines are separate. Whenever they do not add up to the cent, a sentence says they are counted by different
  rules. That covers two cases:
  - the snapshot plus the rows' net;
  - with no rows figure, the snapshot alone.

  PR4 makes cash today one rule.
- **`command-center.tsx`**
  - The bank balance `Stat` sits in a `relative grid` wrapper with the button in its top-right corner. The wrapper
    is a grid, so the Stat still stretches to its row.
  - The Stat's props are unchanged.
  - The button sits beside the Stat, not inside it, so a clickable Stat could never nest a button inside a button.
  - The button enters with its tile (`tile-in`) and is a 24px target.
  - The tile's "as of" day now comes from `householdDayOfAt`, the same household calendar as the popover.

## Figures that should move

**No money figure changes.** What you would see on Banking:
- a small info icon on the bank balance tile, which opens the explanation;
- a snapshot taken on a Chicago evening now reads "as of" its Chicago day, not the next day.

## Must not change

- **The bank balance figure** is still the spine's, and the parity tests are unchanged.
- **No new request on open.** The explain endpoint is called only while the popover is open.
- **No server change.** The popover invents no prose: its sentences are fixed labels around the server's
  figures and reasons.
- **The landing page's content.** Untouched. The popover itself is in Banking's lazy chunk (`command-center-*.js`).
  See Verification for what the landing bundle did gain.

## Tests

- **New `components/bankBalanceWhy.test.tsx`** (15)
  - **Fetching:**
    - closed: the query is disabled and nothing renders;
    - open: the query is enabled with `staleTime: 0`, and it says "Loading…";
    - refreshing: "Loading…", never the older answer;
    - a failed refresh: the banner, with the last answer kept;
    - a failed load: "Couldn't load", and Retry refetches.
  - **The lines:**
    - the balance, the snapshot with source, name and mask, "2 rows since then" with the net, and the next-Sync
      sentence;
    - the snapshot dated by the server's household day, not a UTC slice;
    - the freshness line dated from `snapshot.at`, not from when the answer was made;
    - lines that add up (0.10 + 0.20 = 0.30): no note and no "=";
    - lines that don't add up: the note, still with no "=";
    - no rows figure and a different snapshot: the note;
    - no rows figure and an equal snapshot: no note;
    - the server's `whyNot`, verbatim;
    - no snapshot: the starting-balance sentence, with no snapshot line, no note and no next-Sync line;
    - a stale verdict: "Refresh failed".
- **`pages/commandCenter.test.tsx`** (+2)
  - The button is on the bank balance tile, and not inside the Stat.
  - An evening Chicago snapshot is dated "as of" its Chicago day.
  - Its explicit client mock gains the explain hook and its query key.
- **`hooks/use-plaid-sync.test.tsx` and `components/sync-button.test.tsx`:** their client mocks gain the explain
  query key that Sync now invalidates. No assertion changed.

## Verification

- **Workspace typecheck and build:** pass, including the end-to-end specs' typecheck.
- **Full web suite (clock in UTC, as on CI):** **117 files, 912 pass**, 17 more than PR3b4: the 15 popover cases
  and the two Banking cases.
- **API suite:** not re-run. No server code changed.
- **Landing bundle guard:** **572.4 KB of 580**, up **0.4 KB** from PR3b4. No recharts on open.
  - **Why it grew.** The generated API client (`lib/api-client-react`) is one module that already sits in the
    landing chunk, because the landing reads the spine through it. Using the explain hook anywhere keeps that
    endpoint's helpers in the module: its URL builder, query key, query options and fetcher.
    - The built landing chunk contains `bank-balance-explain` and none of the popover.
    - The reviewer confirmed this in the built chunk. Rollup keeps that one file whole in one chunk, so manual
      chunk rules cannot split it.
  - **The `App.tsx` invalidation** added about 0.1 KB to the entry chunk (239.7 → 239.8 KB). The total still
    rounds to 572.4.
  - **The alternative.** Hand-writing a `useQuery` around the bare fetcher would save about 150 bytes, but CLAUDE.md
    requires consuming the generated hook, so the hook stays. The reviewer agreed.
  - ⚠️ **Over plan.** PR3 as a whole has added **1.1 KB** to the landing (571.3 → 572.4), 0.1 KB over the plan's
    1 KB allowance for PR3. The enforced 580 KB cap is met. The real fix for this kind of growth is listed
    below: Orval `tags-split`.
- **End-to-end:** unchanged specs. Playwright is opt-in on CI and was not run locally.

## Independent review

A separate reviewer read `019129b` and asked for changes: three MEDIUM, several LOW and NIT. It agreed with the
bundle decision. All findings are fixed in the follow-up commit, except where noted.
- **MEDIUM:** the popover could explain an older balance than the tile after a Sync or an edit, and a failed refresh
  showed old figures as current. Now it asks afresh on open, Sync and writes invalidate it, refreshing reads
  "Loading…", and a failed refresh shows the banner.
- **MEDIUM:** the wrapper stopped the bank tile stretching to its row. The wrapper is now a grid.
- **MEDIUM:** with no rows figure, a snapshot that differed from the balance got no note. The note now covers that
  case.
- **LOW:** the tile's "as of" day and the popover's day could disagree. Both now use the household day; the popover
  uses the server's `anchorDay`.
- **LOW:** the next-Sync line repeated the no-snapshot reason and promised a re-read.
  - It is now hidden without a snapshot, and says Sync "asks the bank".
  - Left for later: the server's reasons are verbatim developer wording, so reason codes mapped to short copy
    would read better.
- **LOW:** the tests did not pin the freshness date source, the cents compare, "no equation" in the add-up case, or
  the button's placement. All are pinned now.
- **LOW:** the icon appeared before its tile. It now enters with it.
- **NIT, partly fixed:** the touch target is now 24px and the icon one shade darker. Kept: the Info icon instead of
  the kit's `?` chip, because `Help` is a hover-only `role="note"`, not a button that opens content.
- **NIT, noted:** while the popover is open, the freshness test id appears twice on the page. The e2e spec's strict
  single match would only trip if it ran with the popover open, which it does not.

## Left for later PRs

- **PR4:** one rule for cash today, which would let the popover state an equation that always holds.
- **Server:** reason codes for `nextSync.whyNot`, so the web can show short fixed copy instead of developer
  wording.
- **Bundle:** try Orval's `tags-split` output (one generated file per tag). Helpers used only by lazy pages would
  then leave the landing chunk, which is the real fix for the kind of growth recorded in this note.
- **Server, when PR4 touches `/spine`:** read the settings row once (from PR3b3's review).
