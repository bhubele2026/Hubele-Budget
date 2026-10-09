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
- **The facts line:** room to spend until payday (spine), the NEXT OBLIGATION, and charges to match (spine). A fact that is not known is left out, never printed as $0. With no bank linked it says so.
  - **One next obligation, one amount** (polish round). The next obligation is the first money-out event on the cash curve (`dashboard/obligations.ts`: `upcomingRows` → `obligationLine`), the same hook-aware event Coming up lists and Needs attention's "due today / tomorrow" reads. It is what will leave checking, not `spine.nextBill`.
  - A hook item is worded the same everywhere: "Weekly Spend · card payoff $477.57 (plan $450) · Sat Oct 10".
  - ⚠️ The morning text and the Bills page still show the single STORED payment ($450). They read the bills summary (`pickNextBill` / `occurrenceAmountOn`, A's fix), and for a hook item the bills summary does not know the card payoff, which only the forecast ledger computes (`forecastLedger.ts`, the period's card charges plus what is left of the allowance). A's proposed server change (`pickNextBill` reading the ledger's payoff for a hook occurrence) would align them, for the owner's OK.
- **Bank freshness** is one entry per bank, not per account: "Chase · synced 2 h ago", "American Express · needs reconnecting". Two items at the same bank are told apart by their first account's name and mask (`bankState.ts`).
- **One action:** `headerActionOf()` in `lib/attention.ts` (pure, tested), with first match winning:
  1. Link a bank (no bank linked) → `/settings`
  2. Reconnect (the checking feed failed, OR any bank's saved login expired. A card's bank counts now: `attentionItems({ reauthBanks })`) → `/settings`
  3. **See where it runs short** → `/forecast`, when `lowPointView` says `below` (under the buffer) or the low point is below zero inside the 90 days (polish round)
  4. Pick a way back (the week is over its plan)
  5. "Can we afford something?"

  When anything but Afford takes the slot, Afford stays beside it as a quiet text control.
- **Phone title (not changed):** on a phone the shell names the page between the logo and the account button. `/home` belongs to no nav area, so C12's shell-wide fallback (`components/layout.tsx:619-622`, `currentTitle`) prints "H2 Budget" beside the "Budget" wordmark. A one-line special case (`location === "/home" ? "Home"`) would fix it. It is shell behaviour shared by every unowned route, so I left it as a proposal.
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
  - The new `lowLabel="short"` prop draws "Low $X" BELOW the dot. It is the lowest point, so the curve is above it everywhere and the words never sit on the line (above the dot they crossed the dip's walls). The full label also clipped at the plot edge on a phone, and the legend already names the date.
  - The new `monthTicks` prop formats the axis as "Oct 9" / "Oct 25" instead of "10-09".
  - Every link goes to `/forecast`.
- **Coming up:** the next five payments out on the cash curve (cash-signal events). For each: one payment, a frequency word, and "card payment" or "debt payment".
  - A Weekly or Monthly Spend hook reads "weekly · card payoff (plan $450)" under its $477.57, so the payoff beside the $450 plan is explained. The first row is the header's "Next:".
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

- **The morning text now matches (owner-approved, final round).** `api-server/src/recap/template.ts` writes "Checking covers $X until <weekday>." (it was "Room in the plan: $X until <day>."), two characters shorter, so the 240-character budget (`MAX_TEXT_CHARS`, parts dropped from the tail until the text fits) is unchanged.
  - The AI prompt moved to **`recap.v3`** (`ai/prompts/recap.v3.ts`): recap.v2 with only the cash sentence swapped, asking for "Checking covers $1,234 until Fri" / "…until Saturday". It refuses to load if v2's sentence ever changes under it (no silent no-op). v3 is the newest, so it runs; `AI_PROMPT_RECAP=v2` still pins the old one. AI stays off.
  - Tests: the template expectations in `recapAction.test.ts` and `recapValidate.test.ts`, `recapGenerate.integration.test.ts` (prompt version `recap.v3`), and the new `recapPromptV3.test.ts` (the wording, nothing else changed, v3 runs, v2 can be pinned).

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
- **Single-payment next bill:** A's server fix makes `spine.nextBill` one payment ($450). The dashboard now quotes the cash-signal event instead (see Header): for a hook item that is the $477.57 card payoff, with "(plan $450)" beside it. The header, Needs attention and Coming up are tested to show the same words and amount on one screen.

## Lead's before-shot defects
| Defect | Outcome |
|---|---|
| Names truncated; "Paid from" chip overflowed in `longnames` | Fixed: rows wrap the full name + ••last4; `AccountChip wrap` keeps the mask after the name and the dot on the first line |
| Card owed / minimum / due "—" when data exists; `missing` Platinum $0.00 | Fixed: debt row, else Plaid stored liabilities, else words. The "Statement" fact is dropped: the Amex weekly payoff's `statementBalance` is the card's CURRENT balance under another name (liability → debt → **0 fallback**, which was the false $0.00) |
| `empty`: $0.00 everywhere, no link-a-bank | Fixed: em dashes with words, "Link a bank" as the header action, link-a-bank in Accounts and Spending, compact panels |
| "Room in the plan" two figures | Fixed on the dashboard (words table above) and, in the final round, in the morning text ("Checking covers $X until <weekday>", template + prompt recap.v3) |
| Phone activity lost amount and account; chart low label clipped | Fixed: list layout; "Low $X" on the dot |
| Debt never names the HELOC | Fixed: "$18,500.00 left across HELOC" |
| `stale`: manual row rolled into checking ($4,788.37) | Intended. PR #22's roll-forward counts bank rows and manual entries on the account after the snapshot day (`/forecast/bank-balance-explain` says "manual rows on the account count"). Labelled: "Includes 1 entry since the Oct 6 snapshot". The helper gives the row count, not a manual-only count, so the label says "entries" |
| Weekly Spend −$477.57 beside $450 | Fixed: "card payoff · plan $450.00" |

## Polish round (lead, after the first shots)
| Ask | Outcome |
|---|---|
| 1. One next obligation, one amount | Done. The header "Next:", Needs attention "due today / tomorrow" and Coming up all read the same cash-signal event (`dashboard/obligations.ts`). Hook items read "Weekly Spend · card payoff $477.57 (plan $450) · Sat Oct 10". The morning text and Bills page keep the stored $450, and the note under Header says why. The bills-summary read left the landing (it was only for "due soon") |
| 2. "See where it runs short" | Done. Order: Link a bank → Reconnect → runs short (`lowPointView` `below`, or a negative low point) → Pick a way back → Afford. Tested in `lib/attention.test.ts` and on the header |
| 3. Debt copy | Done. "$18,500.00 left on HELOC" for one; "left across A and B" (an and-list) for several |
| 4. Chart | Done. Ticks read "Oct 9"; "Low $X" sits below the dot (never on the line) and is anchored inward at the edges, so it does not clip on a phone |
| 5. Last row sizes to content | Done. Needs attention and Recent activity have no minimum height and `self-start`. The phone order is unchanged |
| 6. Phone title "H2 Budget" | Not changed. It is C12's shell-wide fallback for a route with no nav area (see Header); the one-line `/home` → "Home" case is a proposal |
| 7. Ribbon | Done (harness only): bottom-left, in the kit and in this worktree's copy. The kit also gains `checks.sh` + `e2e/zz-fixture/checks.spec.ts` (the Phase 3 checks below) |

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
- **Open path:** **621.5 KB of 622 KB** (`node scripts/check-entry-graph.mjs`, no recharts on open). Main measured 620.4 KB and A's branch 622.0 KB. The cap is unchanged.
  - ⚠️ Only 0.5 KB of headroom is left: the polish round put the one-next-obligation reader (`obligations.ts`), the runs-short choice and the liability-accounts hook on the first screen (619.8 → 621.5 KB). The next first-screen addition will need something moved lazy first.
- **Eager:** header, summary row, accounts.
- **Lazy, one chunk:** forecast, coming up, spending pace, debt progress, needs attention, recent activity, the morning text and their queries (`queriesLazy.ts`).
- **The `features` allowance** on the entry path is now only `useGetMoneyPosition` and its key. `previewRecap` left it, and `featuresImportGraph.test.ts` is updated.

## Tests
- **New or rewritten:**
  - `DashboardPage.test.tsx`: order (header, summary, forecast row, accounts, lower rows), lazy slots and skeletons, no `Page` wrapper, refresh banner, skeleton with no numbers, compact skeletons with no bank.
  - `dashboard.test.tsx`, 55 tests:
    - header facts and freshness;
    - **header action choice** (link > reconnect, incl. a card bank > runs short > way back > afford);
    - the recap loading only when opened;
    - summary **status-aware cases: missing, stale, not_yet, negative, tight/ready, over-plan $0, loading/failed**;
    - accounts (one surface, liabilities fallback, words not $0, Sync per bank, empty link);
    - **one next obligation, one amount**: header "Next:", Needs attention "due tomorrow" and the first Coming up row show the same hook-aware words and amount on one screen;
    - **KPI low point = chart legend at 90 days**;
    - spending scopes and pace ticks;
    - debt ("left on" one, "left across" several, no debts);
    - attention (reauth, distinct queue words, income flag, D20);
    - activity (A's identity cases, Amex sign, flag chip);
    - every lazy panel wears its skeleton's span and min-height.
  - `lib/attention.test.ts`: `headerActionOf` (incl. runs short, in order), `reauthBanks`, a caller-worded due-soon item.
  - `debtBalanceParity.test.tsx`: the debt total parity.
  - `categoryDirection.test.ts`: the reimbursable exclusion.
  - `amountDisplay.test.ts`: the Amex workbook sign.
  - `index.css.test.ts`: surface ring composition and layer, milled panel, the KPI step.
  - `utilsCn.test.ts`: the tailwind-merge tokens.
  - `agent.test.tsx`: findings inside the merged list.
- **Gates (final, on the branch head):**
  - root `pnpm run typecheck`: clean;
  - web `vitest`: UTC 1,861 passed / 3 skipped, America/Chicago 1,862 passed / 2 skipped;
  - API suite on `h2budget_test_dashref`: 2,575 passed / 1 skipped / 2 todo (re-run after the recap template and prompt change);
  - `pnpm run build` + entry graph: OK at **621.5 KB** of 622 KB;
  - `pnpm audit --prod`: 1 high, already ignored.
- **Screens:** fixture AFTER shots for all six scenarios at both sizes are in `dash-shots/after/`, with zero console errors and zero failed `/api` calls.

## Phase 3 checks (headless, fixture, all six scenarios)
Run with the kit's new `checks.sh` (`e2e/zz-fixture/checks.spec.ts`, harness only); results per scenario in `dash-shots/after/checks/<scenario>.json`. All 30 checks pass (5 per scenario × 6).

| Check | Result |
|---|---|
| **Reachability** (every `main a[href]` on `/home` opened in a fresh page: no 404, no error boundary, not blank, no page error; plus the dashboard's own controls) | normal / stale / negative / missing / longnames: 15 of 15 links each; empty: 9 of 9. Controls: Afford opens its sheet and Escape closes it; the morning text opens; horizons 30/180/90 switch; "Why this number?" opens. Header action per scenario: afford, **reconnect** (stale), **short** (negative), afford, afford, **link** (empty). Skipped on purpose: Sync (Plaid), Resolve / Dismiss (writes), nothing turns AI on |
| **Keyboard only** (Tab from the page title through `<main>`) | 31–33 stops (16 in empty), in visual order: header action, the morning-text toggle, "Why this number?", the three horizons, forecast link, Coming up links, All accounts, each account name, each bank's Sync, the Spending / Debt links, every Needs attention row, All activity, each activity row. **0 stops without a visible focus mark.** Horizons answer Enter and Space; the disclosure answers Enter (`aria-expanded`); the popover opens on Enter, closes on Escape and gives focus back to its trigger |
| **axe** at 1280 and 390 | **0 critical / serious** in every scenario, after two fixes this round: the bank-freshness words and the chip's ••last4 moved to neutral-600/700 (they were 3.9–4.3:1), and an account's facts box is a `<dl>` only when it holds facts (`definition-list`). The stale scenario's "needs reconnecting" is now ink with an alarm dot (the orange is 3:1 at 11 px) |
| **Reduced motion** (`reducedMotion: reduce` vs `no-preference`) | reduce: 0 animations running at first paint and 0 after settle (longest 0 ms). no-preference: 59–61 animations at first paint (entrances, chart draw, meter sweep); at the settle point 4 are still running, the longest 1.98 s (the chart's one draw) |
| **No sideways scroll at 390** | `document` and the shell scroller both 0 px over, every scenario |
| **Names never truncated** | 0 truncated nodes among account names, account links (••last4 present) and every account chip, at both sizes, every scenario (incl. `longnames`) |

- ⚠️ **What axe cannot see.** axe puts contrast over a background IMAGE in `incomplete`, not `violations`: inside the milled panels and on the tinted ground that is 67 nodes on the negative scenario's desktop, 28 on the phone. Measured by hand (WCAG 2.x relative luminance):

  | Colour | panel top `#ffffff` | panel foot `#fbfcfe` | ground top `#f7f9fc` | ground foot `#eef3fa` |
  |---|---|---|---|---|
  | alarm orange `#e16d3e` (fills, bars, dots, chips, the 22–30 px figures) | 3.25 | 3.17 | 3.08 | 2.92 |
  | **`--color-bad-ink` `#c2410c`** (small alarm text, final round) | **5.18** | **5.04** | **4.91** | **4.64** |

  - **Final round (owner-approved):** small alarm TEXT now uses the new token `--color-bad-ink` `#c2410c`, a high-chroma rust of the alarm family. It is not a darkened `#e16d3e`, which would be brown: in OKLCH it has MORE chroma (0.174 vs 0.157), a hue 3° redder (38° vs 42°) and L 0.55. It clears 4.5:1 on every ground above.
  - **Where:** the summary sublines (week over plan, "Checking covers $0.00…", the low point's "below your $X buffer · short by … · below zero in N days"); the account rows' "Needs reconnecting" and "Out of date"; the header's "needs reconnecting"; Needs attention's alarm rows; the Spending pace "over" words; the forecast legend's low value; the shared `FreshnessLine` "Refresh failed"; and on the chart (`CHART.badInk`, the mirror) the "Low $X" and "Cash buffer $500.00" labels, which also changes them on `/forecast`.
  - **Unchanged:** fills, bars, dots, chips, the buffer line, the risk shading and the 22–30 px figures keep `#e16d3e`. Large text needs only 3:1, and the figures are 3.17–3.25 on the panels.
  - **Guard:** `index.css.test.ts` computes the ratios and fails if any ground drops under 4.5. It also fails if the token's OKLCH chroma falls under the alarm orange's (the brown direction), if its hue drifts more than 8° or past 45° (toward amber/brown), if L drops under 0.5, or if the chart mirror stops equalling the CSS token.
  - Not changed: `StatBlock`'s bad tone (18 px figures on other pages) and other pages' own small `text-bad` words. They are outside the dashboard and would now take the same token on request.
  - neutral-500 labels are 4.6–4.7:1 (pass). The missing-figure dash and the version line moved from neutral-400 (2.6:1) to neutral-500.

## Unverified
- **E2E:** `perf-open.spec.ts` and `a11y-smoke` need Clerk keys and a real DB. Their assumptions still hold by construction (at most two bounded `/transactions` reads, no chart chunk on open), but they did not run.
- **Live Plaid:** sync, reconnect and Link are mocked in the fixture.
  - `GET /plaid/liability-accounts` makes one opportunistic liabilities fetch when a household has NEVER had liability data. The dashboard only asks when a card or loan is missing from the debt list.
- **The recap with AI on:** the fixture always shows the template.
- **Screen readers:** the keyboard and axe passes are not a screen-reader pass.
- **App-wide visuals:** the milled `.panel`, the tinted ground, the `.surface` ring fix and the Accounts page losing its doubled padding change other pages subtly. I only looked at `/home`.
