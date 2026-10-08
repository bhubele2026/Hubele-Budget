# Modernization preview — what to review before it spreads (2026-10-08)

Written for Brad. The three preview pages are live inside the classic app, signed in, on your real data. Nothing else changed: the old pages are untouched, `/` still serves the current app, and no screen is removed. Approve or redirect before anything propagates.

## Where
- Dashboard: https://h2budget.onrender.com/classic/next/dashboard
- Forecast: https://h2budget.onrender.com/classic/next/forecast
- Accounts: https://h2budget.onrender.com/classic/next/accounts (pick a card or bank at the top; the dashboard's account cards link straight in)
- The top line of every classic page links to the three.

## What you are looking at
- **One design system ("H2 evolved"):** your navy and orange, plus account accents (checking navy, Amex teal-green, other cards violet), real panels on a 12-column grid, large charts, compact tables with the account on every row.
- **Dashboard:** briefing + one next action; one card per account (balance, data-through, reconnect, Sync; cards show statement, minimum and due day when the API has them, a dash when it does not); cash position; spending vs limit and budget; upcoming 14 days; the cash-flow chart (30/90/180); debt with confirmed progress and the next milestone; recent activity; needs review. Every panel links to its page.
- **Forecast:** the same engine, the same register, drag-to-match, Match-to, month close. New: full-width chart with actual (solid) vs projected (dashed), a Today rule, buffer line and risk tints, markers by kind (payday, bill, card payment, debt payment) grouped with counts, hover on desktop, tap on phone, a selected-day panel (opening balance, money in, outflows by kind, projected close, assumptions, the day's events and actions), arrow keys move the day, selection survives refetches and horizon changes.
- **Accounts:** selector with identity and balances; per-card summary (current, statement, minimum, due day, this week's charges, the forecast legend: charged to this card / paid from checking / payment to this card); the Amex and Chase ledgers with every workflow (bulk bar, owed-by, reimbursable, transfer override, external card, review inbox) moved in, not rewritten; a combined 30-day view across accounts.

## Against the original (same fixture household, 1280×800 and 390×844)
Screenshots are in the review pack sent with this note (old vs next). The figures are identical by construction: both read the same endpoints; an agreement test pins the new forecast page's summary, chart points and day figures to the classic page.

## What the money proof found (fixed or pinned)
- A real bug: the Amex balance had stopped refreshing from Plaid (the anchor refresh threw on every Amex row and the sync swallowed it). Fixed and on main. Watch your Amex balance after the next sync; if it reads wrong, tell me the figure.
- Refunds did not net against spending and a refund row got no filing decision. Being fixed now (B6); figures move only for households with refunds, and only downward on spend.
- The full scenario (Amex purchase, checking purchase, pending-to-posted, refund, card payment) agrees to the cent on every route; a purchase and its card payment are never both counted.

## Known gaps in the preview (to be closed in the rollout, not hidden)
- Inside the Accounts page the moved ledgers keep their old row design and their sticky bars do not stick inside a panel.
- Statement balance exists only for cards the weekly payoff knows; minimum and due day exist only when a debt is linked to the card; due day is a day of month, not a date (API gaps, listed for follow-up).
- Phone chart: tap-to-select works; continuous drag-scrub is not there yet; the Expand sheet gives the full-height view.
- "A new version is available" appears only in the local fixture build.

## What approval unlocks (Wave C)
Every remaining classic page restyled on the same system in parity-checklist order; the automation screens (review queue, rules, Automation, Afford, way-back, Ask, Recap, AI cost) folded into the five areas; `/` switched to this app; the stripped-down app deleted; bundle re-organized with a written justification if the cap must rise.

## What to answer
1. Approve the direction as shown, or say what to change (density, colours, panel order, chart).
2. The forecast's "which cash" label: checking only, or combined with savings?
3. Pay-in-full cards as debts: link the card to a debt row (then its charges leave the forecast) or keep it unlinked (then the dashboard's debt panel ignores it)?
