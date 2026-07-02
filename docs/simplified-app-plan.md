# H2 Budget — Simplified App Plan (locked)

**Approved 2026-07-02.** Source of truth for the IA simplification. Goal: control
spending → get out of debt, simple enough for any family member to manage.

## Front door
A **landing page** with **4 tiles** is the whole navigation. No crowded top bar
(was: Dashboard / Overview / Chase / Amex / Allowance / Forecast / More).

## The 4 areas

| Tile | Opens to | Also inside | Debt shown? |
|---|---|---|---|
| 🏦 **Banking** | **Spending view** — this week / this month (◀▶ to review past), "cancel these" subscriptions, "stop buying" roasts | Chase · Amex (Blue = monthly, Platinum = weekly) · Allowance · 1–2 folded-in spending charts | No |
| 🧾 **Bills** | Recurring bills list | AI review — what to cut, what you're missing | No |
| 📈 **Forecast** | Forecast + Review | **Budget** (plan vs actual) · "what's coming" | No |
| 🔥 **Avalanche** | Debt payoff plan | All debts · free-by date · Sky Card · kill stack · progress · folded-in debt/cashflow charts | Yes (on purpose) |

## Removed / moved
- ❌ **Overview / Reports** standalone page — removed from nav; useful charts fold into Banking & Avalanche.
- ❌ Dashboard clutter — savings goal, "vs last month" removed; **"what's coming" → Forecast**.
- ➡️ **Debt** → only in Avalanche.
- ➡️ **Sky Card** off Amex → Avalanche (a card tracked as a debt drops off the Amex band automatically).
- ➡️ **Allowance** → under Banking.
- ➡️ **Budget** → under Forecast.
- 🔽 **Weekly Debrief + Mapping Rules** → tucked under **More / Settings** (still work, just out of the way).

## Conventions
- Amex: **Blue = monthly** expenses, **Platinum = weekly**. Tier drives cadence.
- Debt totals are never shown on the spending surfaces — only in Avalanche.
- The savage advisor voice stays; only clutter and complexity are removed.

## Already built & green when this plan was approved
Landing (4 tiles), spending view (this week/month + cancel/stop-buying), Sky Card
removal from the Amex band, Blue=monthly/Platinum=weekly cadence.

## Execution
One clean pass → typecheck + build green → single push → single Replit redeploy.
No piecemeal shipping.
