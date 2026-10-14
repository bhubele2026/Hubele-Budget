# Nav + financial review correction — batch summary (2026-10-14)

Branch `fix/nav-review` (from `e14cc3f9`). Fast-forwarded to `main` on the owner's "deploy" (2026-10-14).

## Owner's ask
- "I click into something and don't know where I am."
- "I liked the tile dashboard."
- "Review banking and immediately see what wasn't in the plan. Same with Amex."
- "Why are we over weekly and monthly?"
- "Too many words, not user friendly."

## Owner decisions (10/14)
- This month = Monthly allowance. Household budget = a separate line.
- Calculation fixes allowed, with a before/after table. Nothing live without his OK.
- Weekly plan: "Plan not set" + a confirmed one-tap "Use $450 from this week". Past weeks untouched.
- Nav: one stable bar (Dashboard · Banking · Amex · Spending · Forecast · Debt · More) + section tabs under it.

## Live observations → cause → fix
| Seen on e14cc3f | Cause | Fix |
|---|---|---|
| Nav "Home" went to /banking | label | "Home" gone; logo + Dashboard → /home |
| Banking/Chase/Amex replaced the nav | ribbon swapped per area; Chase/Amex owned by "Review" | stable bar + section tabs + breadcrumb |
| Chase showed household spending | strip had no account filter | strip retitled "Household · all accounts", moved below, closed |
| "Unplanned $0" beside "NOT PLANNED" rows | two meanings (UN flag vs forecast answer) | "Unplanned allowance (UN)" vs "Marked not in plan" |
| "ALL RECONCILED" beside to-review rows | chip = review inbox empty, not a balance check | "Review inbox clear" + separate "Balance check" |
| "No weekly plan set" beside $450 Weekly Spend | no plan row; hook kept its stored $450 | "Plan not set" + one-tap; forecast line says "reserve · no weekly plan set" |
| Monthly overage with no drivers | no drill-down; browser rule | This month page with Why over? → categories → rows |
| Amex "forward 12 months" chart, empty future | no projection exists | "Balance history · last 12 months", starts at real data |

## Inventory → where it lives now
| Before | After |
|---|---|
| /home panels | 6 tiles + forecast graph + one action |
| /banking command center | Banking › Review (Not in the plan) |
| Chase register | Banking › Chase register (all tools kept) |
| /next/accounts | Banking › Accounts |
| Amex page | Amex › All cards + one tab per card (summary, needs attention, editor kept) |
| Forecast, Bills, Review (reconcile) | Forecast › Overview · Forecast · Reconcile · Bills |
| Budget, Allowances, Wish list, Reports | Spending › This week · This month · Budget · Allowances · Wish list · Reports |
| Debt pages | Debt › Payoff plan · Debts · Debt report |
| Categories, Suggestions, Ask, Mapping rules, Settings | More |
| Biggest charges | Spending › This month › Details (sorted largest first) |

## Packages
- S2 plans · S3 period breakdown · S4 banking review · S5 Amex summary · S6 money fixes (API).
- W1 nav · W2 tiles · W3 banking · W4 Amex · W5 spending · W6 polish · W7 preview fixes (web).
- Each has its own note in this folder.

## Figures that move (approved; before → after)
### On test fixtures (exact)
| Figure | Before | After | Package |
|---|---|---|---|
| Purchase $80 + return $30 on a non-Amex card: household spend | 120.00 | 90.00 | S6 |
| Preview household, this week counts toward plan | 674.46 | 644.47 | S6 (Visa return netted) |
| Review badge, unlinked pending/posted pair | 4 | 2 | S6 |
| Ways back, dining this week (cents) | 15000 | 10000 | S6 |
| Allowances page weekly total (fixture) | 195.75 | 220.25 | W5 (server rule) |
| Hook with settings $200 but no plan row | −200 | −300 (stored) | S2 (one no-plan rule) |
| Editing an old plan row: past weeks' cap | rewritten | unchanged | S2 |

### Live (which figures move; real amounts stay out of this public repo)
| Where | Before | After | Why |
|---|---|---|---|
| Allowances · Weekly · this week | flagged rows only, summed in the browser | server "counts toward plan" (higher when purchases are unfiled) | one rule: weekly + not filed, refunds netted |
| Allowances · Monthly · this month | browser sum vs cap | server monthly-allowance figure | same rule as the hook |
| Allowances · Unplanned · this month | browser sum | server unplanned figure | same |
| Dashboard week | "Room to spend · No weekly plan set" | "Counts toward plan · Plan not set" | names the figure |
| Forecast Weekly Spend line | the stored amount | "Weekly Spend reserve $X · no weekly plan set" | label only |
| Non-Amex card returns | not netted | netted | only matters if such a card exists |

## ⚠️ Decision before tapping "Use $X as the weekly plan"
- Proven on preview data: after the tap, this Saturday's Weekly Spend reserve goes **$450 → $0**.
- Why: when the household's Amex cards are linked to debts, the weekly payoff counts only charges on non-debt cards.
- With a plan, the reserve = those charges ($0) + what's left of the plan ($0 when over).
- The forecast low point after Saturday then reads $450 better while the Saturday Amex payment still happens.
- Options: (a) count debt-linked weekly-billed cards in the weekly payoff (model change), (b) unlink the cards from debts, (c) hold the tap.
- Not changed in this batch.

## Release state
- Implemented: yes, on `fix/nav-review`.
- Tested: see the gates in the lead's report.
- Deployed: on the owner's "deploy" (2026-10-14). Enabled: nothing new switched on (no AI, SMS, sync or setting changed).
- Migration `0190_last_bank_reconciliation` (additive, nullable) ships with the deploy.
