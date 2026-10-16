# T4 — Allowances without "over" on no plan, links with context, refresh safety (branch polish/t4-spending-links)

From polish/integration 512602bc (live + P1 + T1T2 + P2 + T3 + P3).
Money: no calculation, stored value, classification or anchor changed. No server file, no OpenAPI change.
All names, ids and amounts in code, tests, fixtures and screenshots are synthetic.

## What changed — Allowances (`pages/allowances.tsx`)
- Weekly and monthly cards read their plan from the server's breakdown (`plan.amount`), scoped to the week or month on screen (`scoped()`).
  - plan none → chip "No plan", line "Plan not set"; $0 plan/override → "Plan set to $0". Never "over", never $0.00.
  - the variance line stays empty on no plan (the plan line already says it).
  - legacy `settings.weeklyAllowanceAmount` and `monthlyAllowanceAmount` are on no comparison any more.
  - unplanned card keeps the saved amount, now labelled "Saved amount $X".
  - monthly pencil removed (the server's monthly plan is a plan row, not the saved amount): a "Set plan" link to /spending/month when none. Weekly pencil kept (writes the week's override the server reads).
- 8-week bars + streak chips from the server's week breakdowns (`useWeekHistory`, 8 reads, asked after the page's own week read answers):
  - bar = server `remaining` (negative = over); streak = consecutive weeks with a plan and `withinPlan` true/false.
  - a week with no plan has no bar: one line "No plan: Aug 16 · Aug 23 …" (and "Plan set to $0: …"); it ends a streak.
  - deleted the browser's streak, under-streak and variance series (txn sums).
- RefreshBanner for the page (week read, else month read).

## What changed — words and links
- `planStatusWords(plan)` (`lib/planWords.ts`): `source none` → "Plan not set"; `override`/`plan` with no cap → "Plan set to $0". Used on Spending and Allowances.
- Spending (`PeriodView`):
  - `?account=<plaid_accounts.id>` read (url state) → request param; header "Amex Platinum ••1001 · household weekly plan · Household" (link clears it).
  - `?open=details` opens Details, scrolls it into view once (Details loads its charges).
  - "See proposed fixes" → `/banking?fixes=1&from=&to=` (+ `&account=` when scoped).
  - `sp-error` → RefreshBanner (failed refresh keeps the figures; failed first load = banner, no figures).
- Amex: household link carries `&account=<row id>` for one card (`whyOverPath` 4th arg; row id from the plaid items); summary RefreshBanner above the panel (first-load error stays the panel's own).
- Banking: household title "Household · this week", link "Open this week's plan →"; `br-error` → RefreshBanner.
- Dashboard `SpendingPanel`: "Biggest charges" → `/spending/month?open=details`; the bridge sentence removed (popover only).
- Needs attention: "Over this week's plan" → `/spending/week` ("See this week"); "runs short" → `/forecast?day=<lowPointDate>`.
- Agent finding `shortfall_before_income` → `/forecast?day=<payload.lowestDate>` (`findingLink`).
- Budget: failed first load → "—" hero, no envelope sections, banner; failed refresh keeps the figures + banner.
- Global write invalidation: `PERIOD_BREAKDOWN_KEY`, `AMEX_SUMMARY_KEY` added (banking review was already there from T1).
- `components/query-refresh-banner.tsx` (new): a query → the standard RefreshBanner.

## Landing cap
- Before: 621.6 KB. After the invalidation + literal strings: 621.9 KB (0.1 KB headroom).
- Made room first, as briefed: `account-menu.tsx` "What's new" icon Sparkles → Info (already imported). Now 621.4 KB of 622.
- `useQueries` pulled 3.5 KB into the landing's query chunk (625.1 KB): replaced by 8 fixed `useGetPeriodBreakdown` calls.

## Figures that move (before → after, fixture rich2)
- Allowances weekly card: "of $X planned" from `settings.weeklyAllowanceAmount` → the server's plan for that week (fixture: none → "Plan not set").
- Allowances monthly card: saved amount → the server's monthly plan ($400.00 in the fixture; same number).
- 8-week bars: spend − saved weekly amount → server `remaining` (= what Spending's "Left" says for that week, carry-over included).
- Streak: counted from txn sums over up to 26 weeks → server weeks over the last 8 (max "8 weeks running").
- Nothing else: Spending, tiles, Banking, Amex figures unchanged (parity: spineParity 32/32).

## Tests
- Web: 278 files / 2839 passed, 2 skipped (America/Chicago); 2838 passed, 3 skipped (UTC).
- New/changed: `planWords` (status words), `amexSummaryView` (`whyOverPath` carry), `agentTrail` (`findingLink`), `attention`, `mutationInvalidation` (prefixes + literal keys = generated keys), `dashboard`, `spendingPeriod` ($0 vs not set, open=details, ?account=, fixes href, refresh/first-load banners), `bankingReview` (banner, words), `amexSummaryPage` (card carry, refresh banner), `allowancesKitRestyle` (server weeks, no-plan rows, $0, legacy amount ignored, banners; PR2 week/month tests re-pointed to server weeks), new `budgetRefreshSafety`.
- API: spineParity 32/32 (no server file touched).
- Headless (chromium 390 + 1280 + webkit for the link checks; `FIXTURE_SEED=rich2`; scripts `t4verify.mjs`, `t4refresh.mjs`; shots in `scratchpad/preview/shots/t4/`):
  - Spending week no plan / plan / $0; Details lands open and in view; `?account=` scope + Household clears; Amex card → Spending for that card; Banking household words.
  - forced 500 after the 60 s staleTime: Spending, Banking, Allowances keep the figures + "Couldn't refresh. Showing numbers from 1 minute ago."; Budget first-load 500 → "—", no $0.00.

## Deviations and doubts
- Tiles ("Plan not set") and the Banking household line ("Not set"): the spine and the banking review carry no plan `source`, so they cannot tell a $0 plan from none without a server field. Left as "not set" wording; Spending and Allowances do tell them apart.
- Dashboard `SpendingPanel` and `AttentionPanel` are not mounted on the tile dashboard (only `SpendingWhy` is used, on Spending). Their hrefs are changed and pinned in unit tests; no headless click is possible. The forecast tile already deep-links `?day=`.
- Budget failed refresh is unit-tested only: its query's staleTime is 5 min, too long to force headlessly.
- Amex failed refresh: unit-tested only (same reason).
- Monthly pencil on Allowances removed (see above): the saved amount it wrote is not the server's plan.
- Streak is capped at the 8 weeks shown (was up to 26).
- Allowances asks for 8 extra week reads once its own reads answer (5 min cache); each is the existing endpoint.
- No-plan history is a grouped line, not one row per week (eight identical rows read as noise on a household with no plan history).
