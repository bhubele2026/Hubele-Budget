# Dashboard refinement (Phase 2, builder B)

Branch `restore/dash-refine`, from `origin/main` 6d159935, with `origin/restore/dash-accuracy` (builder A, e01f8952) merged in. Not merged to main. Not deployed.

- **Implemented:** everything below, on the branch.
- **Tested:** unit and component tests, plus fixture screenshots in six scenarios at 1280×800 and 390×844.
- **Deployed:** no.
- **Enabled:** nothing new is behind a flag, and no AI, SMS, sync or automation setting changed.

## The goal it answers
The owner asked: "We make good money but overspend. I want to understand our position quickly, control spending, and get out of debt."

`/home` now answers, top to bottom, in that order:
1. What cash do we have?
2. What can we spend before payday?
3. Will we run short, and when?
4. Are we making progress on debt?
5. What needs us today?

The header and the summary row answer the first four at a glance. Each panel below is the detail behind one of them.

## What changed and why

### Layout
Desktop uses 12 columns. On a phone it is one column, in this order:

| Order | Block | Span | Loads |
|---|---|---|---|
| 1 | Header: "Today · Fri Oct 9", one line of facts, per-bank freshness, ONE action, "Preview tomorrow's morning text" | 12 | eager |
| 2 | Summary row: Checking cash · Room to spend · Projected low point · Debt paid off | 12, one surface | eager |
| 3 | Cash-flow forecast (chart 320 px, 30/90/180) + Coming up (next 5) | 8 + 4 | lazy slot 1 |
| 4 | Accounts: one list surface | 12 | eager |
| 5 | Spending pace + Debt progress | 6 + 6 | lazy slot 2 |
| 6 | Needs attention (one list) + Recent activity (6 rows) | 7 + 5 | lazy slot 2 |

- **Why this order:** the old page gave every figure the same 18 px weight and repeated checking, the low point, the next bill and the review count two or three times each. Each figure now appears once at its own weight. A figure repeated in a panel below is that panel's detail, not a copy.
- **Lazy loading:** both lazy slots come from ONE chunk (`dashboard/BelowFold.tsx`, exporting `ForecastRow` and `LowerRows`), asked for once on idle (a single shared import promise). Each slot stands behind same-size skeletons (`belowFoldSizes.ts`, `BelowFoldSkeleton.tsx`). Recharts stays a further lazy chunk inside the forecast panel.
- **No bank linked:** the page knows this from the eager accounts read, so the skeletons and the real panels drop their fixed heights together (`foldDensity.ts`). The empty household gets short, honest panels instead of a page of tall empty cards.

### Header (`DashboardHeader.tsx`)
- **The facts line** is built from spine fields only: room to spend until payday, the next bill (`spine.nextBill`, now a single payment by A's fix), and charges to match. A fact that is not known is left out, never printed as $0. With no bank linked it says so.
- **Bank freshness** is one entry per bank, not per account: "Chase · synced 2 h ago", "American Express · needs reconnecting". Two items at the same bank are told apart by their first account's name and mask (`bankState.ts`).
- **One action:** `headerActionOf()` in `lib/attention.ts` (pure, tested), with first match winning:
  1. Link a bank (no bank linked)
  2. Reconnect (the checking feed failed, OR any bank's saved login expired. A card's bank counts now: `attentionItems({ reauthBanks })`)
  3. Pick a way back (the week is over its plan)
  4. "Can we afford something?"

  When Reconnect or Pick a way back takes the slot, Afford stays beside it as a quiet text control.
- **The morning text** is behind a disclosure, and the request is sent only when it is opened (`RecapPreview.tsx`, lazy, using `previewRecap` from `/features`). Before, the landing posted `/recap/preview` on every open. The chip reads "Written from your numbers · AI is off" (or "Model draft…" / "Demo draft" when a model wrote it), never "TEMPLATE".

### Summary row (`SummaryRow.tsx`)
One `.panel` with a `.kpi-grid` inside: four across at 1024 px and up, two by two below, split by hairlines and not drawn as four cards. Figures are mono tabular numerals at the new `--text-kpi` step (22–30 px). Labels are 11 px, uppercase and tracked. Each tile has at most two sublines.

- **Checking cash:** `spine.bank.balance`, the account chip from the cash signal, the freshness line, and "Why this number?".
  - When the snapshot is from an earlier day, it adds "Includes N entries since the <day> snapshot". That count comes from the diagnostic's `ledger.sinceAnchor.rowCount` (`/forecast/bank-balance-explain`, read-only, no Plaid call), asked only on that condition.
- **Room to spend:** `spine.position.safeToSpendNow`, with two sublines:
  - "This week's plan $Y left" or "$Y over", from `remainingWeek`;
  - "Checking covers $Z until <payday>, after the $B buffer", from `availableUntilPayday` and `forecast.cashBuffer`. When goals hold money it adds "and $R held for goals" (from `/money/position.reservesHeld`). The line turns to the alarm colour when it is $0.
- **Projected low point:** A's `lowPointView()`, which gives the value, the date and "next 90 days".
  - The words say where it sits against the buffer: "below / just above / above your $500 buffer".
  - Under the buffer it adds "short by $X", and when the projection crosses zero it adds "below zero in N days".
  - A stale balance keeps the figure and says so. Only `no_data` hides it.
- **Debt paid off:** `spine.debt.payoffPct` leads. Under it, smaller: "$X left across HELOC" (or the list of names). The total is `remainingDebtScope()`, the same sum the Avalanche page and the Reports Debt page now call (see "Debt tile" below).

### Accounts (`AccountsPanel.tsx`)
- One list surface, one row per account.
- The full name and ••last4 wrap and are never truncated.
- Each row keeps its accent edge.
- **Checking:** "Cash held" (the spine's roll-forward, the only depository balance the app reports).
- **Savings:** "Savings balance is not tracked yet." in words.
- **Cards and loans:** Owed, Minimum and Due, drawing only the fields that exist.
  - On the debt list: the debt row.
  - Not on the debt list: Plaid's stored liability figures (`GET /plaid/liability-accounts`). They are asked for only when such a card exists, and never with `refresh`.
  - Nothing reported: words.
  - A pending payment shows "Paid, not posted $X".
- Sync once per bank, on its first row, unchanged otherwise. The name opens the account view. "All accounts" is in the panel head.
- No bank linked: "Link a bank in Settings" → `/settings` (Banks tab, which holds the existing Plaid Link button).

### Lazy panels
- **Cash-flow forecast:** the classic `ProjectedBalanceChart` at 320 px (solid line, buffer line, low dot, tooltip), with horizons 30, 90 and 180 ("30d" on a phone).
  - The legend reads "Low point in these N days: $X on <day>".
  - The new `lowLabel="short"` prop draws "Low $X" on the dot. The full label clipped at the plot edge on a phone, and the legend already names the date.
  - Every link goes to `/forecast`.
- **Coming up:** the next five payments out on the cash curve (cash-signal events). For each: one payment, a frequency word, and "card payment" or "debt payment".
  - A Weekly or Monthly Spend hook reads "card payoff · plan $450.00", so a $477.57 payoff beside the $450 plan is explained.
  - Paid-from chip; "Next money in: Paycheck +$2,100.00 on Fri Oct 16"; links All bills and Forecast.
  - The duplicate "Next bill" box is gone; the header quotes it.
- **Spending pace:**
  - This week vs plan: `/money/position`, with the words from `remainingWeek`, the same figure the summary quotes, and an even-pace tick at `paceAllowedToday`.
  - This month vs budget: a day-of-month pace tick.
  - Each says its period and scope.
  - "All household spending $X this week · $Y this month" (spine).
  - Links: Allowances used (`/allowances`), Biggest charges (`/banking`), Budget.
  - No bank linked: words plus Link a bank, Set a weekly plan and Budget.
- **Debt progress:** a % paid meter, paid down this month (bank-confirmed), new charges this month, next milestone, Payoff plan and Debt report. With no debts it shows words plus Add a debt.
- **Needs attention:** ONE list.
  - Now: reconnect (any bank), out of date, over plan, a bill due today or tomorrow.
  - Decisions waiting:
    - "Charges to match to the forecast" → `/review`;
    - "Categories to confirm" → `/review/categories`;
    - "Possible duplicates" → `/transactions`;
    - "Income filed under an expense category" → `/transactions?tx=…&category=…`.
  - What H2 noticed: the monitor's findings, with Why, Resolve and Dismiss (`FindingsList`, unchanged).
  - A source that is loading or failed says so, and is never counted as "nothing".
- **Recent activity:** six rows in `TxnTable layout="list"`.
  - Two-line rows that never scroll sideways on a phone, keeping amount, account chip, category and status.
  - A's `resolveTxnAccount`.
  - A row chip "Income in an expense category".
  - Amex workbook rows read as charges.
  - "All activity" → `/transactions`.

### Visual language
- **The `.surface` depth bug is fixed.** Tailwind v4's `ring-1` writes the whole `box-shadow` from the utilities layer, so every `.surface ring-1` card lost its shadow. `.surface` and `.surface-lift:hover` now compose `var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--shadow-milled[-lift])` in `@layer utilities`, after the generated utilities (the Financial Dashboard's fix). `index.css.test.ts` pins both the composition and the layer.
- **`.panel` is milled:** a white-to-platinum-1 gradient plus `--shadow-milled` (a lit top rim and a two-stop navy shadow). This is app-wide, so every page's panels change subtly.
- **The ground is tinted:** `body` has a fixed platinum-2 → platinum-4 gradient. Also app-wide.
- **`--text-kpi`** is a new type step, with its reason written in `index.css`. `--text-hero` stays one per screen, and the dashboard uses none. tailwind-merge has been taught `kpi`, `hero` and the milled shadows (`lib/utils.ts`). Without that, `cn()` silently dropped `text-kpi` beside a text colour. This is pinned in `lib/utilsCn.test.ts`.
- **Spans** `.span-5` and `.span-7` were added.
- **Hover lift only on real destinations:** every dashboard panel is `variant="static"`. Rows that are links get a hover ground.
- **Page padding:** `Page` lost its own `px-6 py-8 xl:px-10`, which doubled the shell's padding. The dashboard no longer uses `Page`, and the Accounts page, its only other user, loses the doubled gutter too.
- **Motion:**
  - no count-up on money;
  - the classic chart draws once per data fingerprint;
  - `CssFillMeter` sweeps once;
  - the panel entrances use the existing `tile-in` dial;
  - reduced motion is covered by the existing switches.
- **Colours:** no new colour literals and no brown. Account accents are kept.

## Distinct words for each money-position figure
"Room in the plan" named `safeToSpendNow` on the old cash panel and `availableUntilPayday` in the morning text. On the dashboard now:

| Field | Words |
|---|---|
| `safeToSpendNow` | **Room to spend** (the tile, and the header's "$X room to spend until payday …") |
| `remainingWeek` | **This week's plan $Y left / over** (summary subline; Spending pace "…in the plan") |
| `availableUntilPayday` | **Checking covers $Z until <payday>, after the $B buffer** |

- ⚠️ **Not changed, proposed:** the morning text itself is server copy. `api-server/src/recap/template.ts:53` writes "Room in the plan: $X until <day>" from `availableUntilPayday`, and the AI prompt `recap.v2.ts:14` asks for the same. Inside the disclosure it is a quote of the SMS, so I left it alone.
  - Proposal for the owner's OK: "Checking covers $X until <day>." in both places, plus their tests.

## Debt tile: the one total
- `lib/debtBalance.ts` gains `remainingDebtTotal(debts)` and `remainingDebtScope(debts)`.
  - The total covers active debts, netted of pending payments (`effectiveDebtBalance`).
  - The names are the active debts still carrying a balance.
- The Avalanche page's inline `activeDebts.reduce(…)` and the Reports `totalsForDebts().totalBalance` now call `remainingDebtTotal`. It is the same sum, in the same order, so no figure moves.
- **Parity tests** in `pages/debtBalanceParity.test.tsx`:
  - the dashboard's "$X left across …" equals the Avalanche page's Totals row to the cent ($8,620.55, netted, not the raw $8,920.55);
  - the three callers agree;
  - archived and cleared debts are not named.
- **Bundle:** `effectiveDebtBalance` and `pendingPaymentTotalOf` moved, verbatim, to `@workspace/avalanche-core/pendingDebt` (a sub-path like `./householdTime`). `index.ts` re-exports them unchanged. Importing the package index from the landing had put the whole payoff simulator in the entry chunk (+8 KB).
- **CLAUDE.md §1** now says: % paid leads; the amount left is a smaller secondary line; its scope is always named; the amount comes from the debts endpoint through the shared total, never from the spine. §3's spine-law sentence matches.
  - ⚠️ The lead should update memory `budget-landing-avalanche-no-owed` to match.

## Builder A's helpers, wired
- **`lowPointView`:** the summary's low point, including "short by $X" (A's CashPanel wording). CashPanel itself is retired.
- **`resolveTxnAccount`:** Recent activity (A also wired the Accounts combined view).
- **`isInflowFiledAsExpense`:**
  - The lead's ruling is added inside it: a credit marked `reimbursable` is never flagged (tested).
  - Surfaced as a Needs attention row and as an activity chip.
  - It reads ONE shared window (last 30 days, limit 100), the same request Recent activity shows its newest six from, so `/home` still makes at most two bounded `/transactions` reads. In practice it makes one: the old Spending pull is gone.
  - A full window says "newest 100 rows".
  - ⚠️ This is a browser-side filter over a bounded pull: the API has no sign or category-kind filter. Proposal: a server count, like the duplicate count.
- **Amex workbook rows:**
  - `displayAmount(raw, identity, source)` flips a `source: "amex"` row for display only, because the workbook stores a charge as positive (`spendingRule.spendAmount`).
  - Used by Recent activity and the Accounts combined view. No stored value changes. Tested in `lib/amountDisplay.test.ts`.
- **Single-payment next bill:** the header's "Next: Weekly Spend $450.00" and the Coming up row agree. For a hook item the row's plan amount is the next bill's $450, beside the $477.57 payoff. This is tested on screen.

## Lead's before-shot defects
| Defect | Outcome |
|---|---|
| Names truncated; "Paid from" chip overflowed in `longnames` | Fixed: rows wrap the full name + ••last4; `AccountChip wrap` keeps the mask after the name and the dot on the first line |
| Card owed / minimum / due "—" when data exists; `missing` Platinum $0.00 | Fixed: debt row, else Plaid stored liabilities, else words. The "Statement" fact is dropped: the Amex weekly payoff's `statementBalance` is the card's CURRENT balance under another name (liability → debt → **0 fallback**, which was the false $0.00) |
| `empty`: $0.00 everywhere, no link-a-bank | Fixed: em dashes with words, "Link a bank" as the header action, link-a-bank in Accounts and Spending, compact panels |
| "Room in the plan" two figures | Fixed on the dashboard (words table above). The SMS template is a proposal |
| Phone activity lost amount and account; chart low label clipped | Fixed: list layout; "Low $X" on the dot |
| Debt never names the HELOC | Fixed: "$18,500.00 left across HELOC" |
| `stale`: manual row rolled into checking ($4,788.37) | Intended. PR #22's roll-forward counts bank rows and manual entries on the account after the snapshot day (`/forecast/bank-balance-explain` says "manual rows on the account count"). Labelled: "Includes 1 entry since the Oct 6 snapshot". The helper gives the row count, not a manual-only count, so the label says "entries" |
| Weekly Spend −$477.57 beside $450 | Fixed: "card payoff · plan $450.00" |

## Relocation map (every action on the old dashboard)
| Old action / figure (panel) | New location |
|---|---|
| "Can we afford something?" (top) | Header action; a quiet second control when Reconnect / Pick a way back hold the slot. Also on /budget and /allowances |
| Briefing next action: Reconnect → /settings | Header **Reconnect** (now also for a card bank's expired login); Needs attention "Now" row |
| Briefing: Sync (stale) → /settings | Needs attention "The bank balance is out of date" → /settings; per-bank Sync in Accounts |
| Briefing: Pick a way back (sheet) | Header action when over plan |
| Briefing: See allowances / See bills / Open review | Needs attention rows → /allowances, /bills, /review |
| Recap paragraph + TEMPLATE badge | Header disclosure "Preview tomorrow's morning text" (lazy); chip "Written from your numbers · AI is off" |
| Account card → /next/accounts/:id | Accounts row name → same |
| Account card Sync (per card) | Accounts: Sync once per bank (first row) |
| Reconnect reason text | Accounts row, unchanged copy |
| Cash: Bank today + freshness + "Why this number?" | Summary · Checking cash (all three) |
| Cash: Room in the plan | Summary · Room to spend (+ two sublines) |
| Cash: Low point, date, under buffer, runway | Summary · Projected low point |
| Cash: Buffer | Room-to-spend subline, low-point words, forecast legend |
| Cash: Banking link → /banking | Spending pace "Biggest charges" → /banking (and the ribbon) |
| Spending: week vs limit, month vs budget | Spending pace (with pace ticks, period and scope) |
| Spending: household spent week / month | Spending pace footer "All household spending" |
| Spending: Allowances used (browser sums) | /allowances, linked "Allowances used" |
| Spending: Biggest charges (bars) | /banking, linked "Biggest charges" |
| Spending: Budget / Allowances links | Spending pace links (Budget, Allowances used) |
| Upcoming: income / bills / card / debt groups (14 days) | Coming up: next 5 payments out with kind words; next money in as a footnote; the full list on /forecast and /bills |
| Upcoming: Next bill box | Header facts line ("Next: … on <day>") |
| Upcoming: Paid from chip; Bills, Forecast links | Coming up (same) |
| Forecast: 30/90/180, chart, tooltip | Cash-flow forecast (same) |
| Forecast: "Open the full forecast" → /next/forecast | "Open the forecast" → **/forecast** (plan: every forecast link goes to /forecast; /next/forecast still exists) |
| Debt: Total balance | Summary · Debt paid off, "$X left across <names>" |
| Debt: % paid, paid down, new charges, milestone, Payoff plan, Debt report | Debt progress (same links) |
| Recent activity: 12 rows, row → account page | Recent activity: 6 rows, same links |
| Recent activity: "All accounts" → /next/accounts | Accounts panel head "All accounts"; Recent activity head "All activity" → /transactions |
| Needs review: forecast / categories / duplicates (+ loading / failed rows) | Needs attention · Decisions waiting (same targets, same D20 states) |
| Findings: Why / Resolve / Dismiss + links | Needs attention · What H2 noticed (FindingsList unchanged) |
| Refresh banner with Retry | Unchanged |
| Version label | Unchanged |

## Bundle
- **Open path:** **619.8 KB of 622 KB** (`node scripts/check-entry-graph.mjs`, no recharts on open). Main measured 620.4 KB and A's branch 622.0 KB. The cap is unchanged.
- **Eager:** header, summary row, accounts.
- **Lazy, one chunk:** forecast, coming up, spending pace, debt progress, needs attention, recent activity, the morning text and their queries (`queriesLazy.ts`).
- **The `features` allowance** on the entry path is now only `useGetMoneyPosition` and its key. `previewRecap` left it, and `featuresImportGraph.test.ts` is updated.

## Tests
- **New or rewritten:**
  - `DashboardPage.test.tsx`: order (header, summary, forecast row, accounts, lower rows), lazy slots and skeletons, no `Page` wrapper, refresh banner, skeleton with no numbers, compact skeletons with no bank.
  - `dashboard.test.tsx`, 53 tests:
    - header facts and freshness;
    - **header action choice** (link > reconnect, incl. a card bank > way back > afford);
    - the recap loading only when opened;
    - summary **status-aware cases: missing, stale, not_yet, negative, tight/ready, over-plan $0, loading/failed**;
    - accounts (one surface, liabilities fallback, words not $0, Sync per bank, empty link);
    - **next bill = upcoming row** (regular and hook);
    - **KPI low point = chart legend at 90 days**;
    - spending scopes and pace ticks;
    - debt (incl. no debts);
    - attention (reauth, distinct queue words, income flag, D20);
    - activity (A's identity cases, Amex sign, flag chip);
    - every lazy panel wears its skeleton's span and min-height.
  - `lib/attention.test.ts`: `headerActionOf` and `reauthBanks`.
  - `debtBalanceParity.test.tsx`: the debt total parity.
  - `categoryDirection.test.ts`: the reimbursable exclusion.
  - `amountDisplay.test.ts`: the Amex workbook sign.
  - `index.css.test.ts`: surface ring composition and layer, milled panel, the KPI step.
  - `utilsCn.test.ts`: the tailwind-merge tokens.
  - `agent.test.tsx`: findings inside the merged list.
- **Gates (final, on the branch head):**
  - root `pnpm run typecheck`: clean;
  - web `vitest`: UTC 1,854 passed / 3 skipped, America/Chicago 1,855 passed / 2 skipped;
  - API suite on `h2budget_test_dashref`: 2,572 passed / 1 skipped / 2 todo (avalanche-core changed);
  - `pnpm run build` + entry graph: OK at 619.8 KB;
  - `pnpm audit --prod`: 1 high, already ignored.
- **Screens:** fixture AFTER shots for all six scenarios at both sizes are in `dash-shots/after/`, with zero console errors and zero failed `/api` calls.

## Unverified
- **E2E:** `perf-open.spec.ts` and `a11y-smoke` need Clerk keys and a real DB. Their assumptions still hold by construction (at most two bounded `/transactions` reads, no chart chunk on open), but they did not run.
- **Live Plaid:** sync, reconnect and Link are mocked in the fixture.
  - `GET /plaid/liability-accounts` makes one opportunistic liabilities fetch when a household has NEVER had liability data. The dashboard only asks when a card or loan is missing from the debt list.
- **The recap with AI on:** the fixture always shows the template.
- **Phase 3 checks** (the lead's): the keyboard-only pass, axe and a reduced-motion emulation pass, beyond what the existing CSS switches guarantee.
- **App-wide visuals:** the milled `.panel`, the tinted ground, the `.surface` ring fix and the Accounts page losing its doubled padding change other pages subtly. I only looked at `/home`.
