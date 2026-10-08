# Household scenario — the contract (PR1)

Codex work-order point **14**: one controlled household week that a reviewer can follow end to end,
reconciling every displayed number without guessing which hidden rule produced it.

- **The table as data:** `artifacts/api-server/src/__tests__/_fixtures/householdScenario.ts`.
- **The test:** `artifacts/api-server/src/__tests__/householdScenario.integration.test.ts`.
  - It asserts the three columns the app computes today, and (PR-B1, 2026-10-07) the money position's
    columns from `GET /money/position`: remaining, unplanned and needs classification this week and safe
    to spend now at every step. (PR-B2, 2026-10-07) With the funding bills now date hooks, lowest before
    payday, available until payday and the expected balance on Fri 10/16 are asserted at every step too;
    see "PR-B2 delivery".
  - Every other column is an `it.todo` naming the PR that switches it on. Switching it on is part of
    that PR's definition of done.
  - A PR that legitimately changes a rule updates this document, the fixture and the test together —
    never loosens an expectation to go green.

## The household

All times are America/Chicago. Steps are pinned between 09:00 and 16:00, so the calendar date is the
same in Chicago and in UTC.

| | |
|---|---|
| **Checking** | Chase ••5526. Plaid snapshot **$2,500.00** at Sun 10/4 08:00. Cash buffer $500. |
| **Savings** | Chase ••8801 |
| **Cards** | Amex Platinum ••1001 is paid **weekly** for last week's charges. Amex Blue ••2002 is paid **monthly**. |
| **Plans** | **Income:** Paycheck A +$2,000, biweekly from Fri 10/9. Paycheck B +$1,500 on the 15th. |
| | **Bills:** Mortgage −$1,800 on the 12th. Electric −$140 on the 13th. Phone −$95 on the 8th. |
| | **Spend plans:** Weekly Spend −$300 on Saturdays (the Platinum payoff). Monthly Spend −$400 on the 28th (Blue). |
| | **Weekly cap (PR-B1):** $300 — the household pool's allowance plan (`allowance_plans`, from 2026-05-01), the allowance the Weekly Spend bill funds. |
| | **Monthly cap (PR-B2):** $400 — the pool's monthly plan, the allowance the Monthly Spend hook pays out on the Blue. |
| | **Hooks (PR-B2, decision 7):** `preferences.everydayHooks` names Weekly Spend (weekly) and Monthly Spend (monthly), as `0042_everyday_hooks.sql` sets them. Each occurrence is the card payoff; the bills' stored $300 / $400 are ignored. |
| **Last week** | Amex Platinum groceries $180.00 on Tue 9/29 — the payoff that posts this Tuesday. |

## Rules the expected values assume

These are the approved model rules from the overhaul plan. The PR that implements a rule turns its
column on here.

- **Cash today (now):**
  - Starts from the snapshot and adds every Chase row dated after the snapshot day through today.
  - Pending rows are included. The forecast flag is irrelevant.
  - Card activity never touches it; the card payment from checking does.
- **Spent this week (now; the one spending rule since PR7):**
  - Sums purchases on any account, categorized or not, Sun 10/4 – Sat 10/10, pending included.
  - Transfers, debt payments, card payments, reimbursable charges and income are excluded.
  - Unplanned purchases are spending too.
- **Review count (now):** unresolved Chase rows this month in the forecast.
  - A row that has already happened always counts until resolved (`inForecast`).
  - A probable match still counts until it is confirmed (PR5).
- **Remaining this week (PR8, PR10):** $300 minus weekly-tagged everyday spend, from any account.
  - Unplanned spend sits on top and never shrinks it.
  - Bill-matched spend doesn't consume it.
- **Expected balance on Fri 10/16 (PR8 + PR9):** end-of-day checking balance.
  - **Start:** cash today.
  - **Plus:** income, bills and the Amex payoffs dated from today through 10/16. Today's plans count; a
    plan matched or probably matched to a real row is removed.
  - **Payoff for a week:** that week's Platinum charges plus the remaining allowance, dated on the plan's
    Saturday. (PR-B2) Every charge counts, filed or not; the Weekly Spend bill's own $300 is ignored.
  - **Closed week not yet paid:** the payoff lands on the next business day. A closed week owes its charges
    alone (nothing is left to spend in it). (PR-B2) It counts as paid only on evidence: a checking payment
    naming Amex that covers it (at least the payoff less max($1, 1%); more is fine — round 2), dated from the
    Saturday up to the next one — here the $180 on Tue 10/6. (Round 2) A hook whose period has no allowance
    at all keeps the bill's stored amount.
- **Lowest before payday (PR9):** the lowest end-of-day expected balance from today until the day
  before the next income that hasn't already been matched away.
- **Available until payday (PR-B1):** lowest before payday less the $500 cash buffer (and any money
  held for goals; none here), never below zero. (PR-B1 round 2) Payday's own day is in the window, read
  before its paycheck: a bill landing on payday counts.
- **Safe to spend now (PR-B1):** the smaller of remaining this week and available until payday.
- **Chase to review (PR13, PR14):** Chase rows this month not marked reviewed. Marking reviewed never
  moves money.
- **Bank freshness (PR3):** `refresh_failed` from a failed refresh until the next successful one.

## The week

**Asserted now:** cash, spent this week, review count; (PR-B1) remaining, unplanned, needs classification
and safe to spend now at every step; (PR-B2) expected on 10/16, lowest before payday and available until
payday at every step. **Contract for later work:** Chase to review, stale.

| # | When | Event | Cash | Spent week | Review | Remaining | Unplanned | Needs class. | Expected Fri 10/16 | Lowest before payday | Available until payday | Safe to spend now | Chase to review | Stale |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | Sun 10/4 12:00 | Set up | 2,500.00 | 0.00 | 0 | 300.00 | 0.00 | 0.00 | 3,485.00 | 2,225.00 Thu 10/8 | 1,725.00 | 300.00 | 0 | — |
| S2 | Mon 10/5 12:00 | Amex Plat: groceries 96.60, gas 45.00 (weekly) | 2,500.00 | 141.60 | 0 | 158.40 | 0.00 | 0.00 | 3,485.00 | 2,225.00 Thu 10/8 | 1,725.00 | 158.40 | 0 | — |
| S3 | Tue 10/6 12:00 | Amex Plat: hardware 85.00 (unplanned). Chase: 200.00 to savings; Amex payoff 180.00 posts | 2,120.00 | 226.60 | 2 | 158.40 | 85.00 | 0.00 | 3,200.00 | 2,025.00 Thu 10/8 | 1,525.00 | 158.40 | 2 | — |
| S4 | Wed 10/7 12:00 | Chase debit: Shell 45.00 pending (weekly) | 2,075.00 | 271.60 | 3 | 113.40 | 85.00 | 0.00 | 3,200.00 | 1,980.00 Thu 10/8 | 1,480.00 | 113.40 | 3 | — |
| S5 | Thu 10/8 09:00 | Shell posts at 47.40 | 2,072.60 | 274.00 | 3 | 111.00 | 85.00 | 0.00 | 3,200.00 | 1,977.60 Fri 10/9 | 1,477.60 | 111.00 | 3 | — |
| S6 | Thu 10/8 12:00 | Phone moved 10/8 → 10/14 | 2,072.60 | 274.00 | 3 | 111.00 | 85.00 | 0.00 | 3,200.00 | 2,072.60 Thu 10/8 | 1,572.60 | 111.00 | 3 | — |
| S7 | Thu 10/8 15:00 | Electric 140 → 165 | 2,072.60 | 274.00 | 3 | 111.00 | 85.00 | 0.00 | 3,175.00 | 2,072.60 Thu 10/8 | 1,572.60 | 111.00 | 3 | — |
| S8 | Thu 10/8 16:00 | Chase refresh fails | 2,072.60 | 274.00 | 3 | 111.00 | 85.00 | 0.00 | 3,175.00 | 2,072.60 Thu 10/8 | 1,572.60 | 111.00 | 3 | refresh_failed |
| S9 | Fri 10/9 09:00 | Refresh OK; Paycheck A 2,000.00 posts | 4,072.60 | 274.00 | 4 | 111.00 | 85.00 | 0.00 | 3,175.00 | 1,675.00 Wed 10/14 | 1,175.00 | 111.00 | 4 | — |
| S10 | Sat 10/10 10:00 | Chase: Capital One card payment 150.00; payroll match confirmed; all Chase rows reviewed | 3,922.60 | 274.00 | 4 | 111.00 | 85.00 | 0.00 | 3,025.00 | 1,525.00 Wed 10/14 | 1,025.00 | 111.00 | 0 | — |

Before PR7 the app reported **424.00** at S10: it counted the Capital One payment as spending. PR7
recognizes card payments in spending totals, and S10 is asserted at 274.00
(`docs/reviews/2026-09-11-pr7-one-spending-rule.md`).

## The arithmetic

### Cash today
Starts at the snapshot and walks Chase rows dated after Sun 10/4.

| Step | Calculation | Cash |
|---|---|---|
| S1–S2 | No Chase rows | $2,500.00 |
| S3 | − $200.00 transfer − $180.00 Amex payoff | $2,120.00 |
| S4 | − $45.00 Shell, pending | $2,075.00 |
| S5 | The same row now posted at − $47.40 | $2,072.60 |
| S6–S8 | Plans, a moved bill and a refresh stamp never move cash | $2,072.60 |
| S9 | + $2,000.00 payroll | $4,072.60 |
| S10 | − $150.00 Capital One payment | $3,922.60 |

### Spent this week

| Step | Calculation | Spent |
|---|---|---|
| S2 | Groceries $96.60 + gas $45.00 | $141.60 |
| S3 | + hardware $85.00. The transfer ("online transfer") and the Amex payoff ("ach pmt") are not spending. | $226.60 |
| S4 | + Shell $45.00 | $271.60 |
| S5 | Shell at $47.40 | $274.00 |
| S10 | Unchanged: the Capital One payment ("crcardpmt") is a card payment, even filed by hand under Misc / Buffer | $274.00 |

### Review count
Unresolved Chase rows in October.

| Step | Rows | Count |
|---|---|---|
| S3 | Transfer + Amex payoff | 2 |
| S4 | + Shell | 3 |
| S9 | + payroll | 4 |
| S10 | + Capital One; payroll confirmed as matched | 4 |

### Remaining this week
$300 minus weekly-tagged everyday spend.

| Step | Calculation | Remaining |
|---|---|---|
| S2 | $300 − $141.60 | $158.40 |
| S3 | Hardware is unplanned, so unchanged | $158.40 |
| S4 | − Shell $45.00 | $113.40 |
| S5 | Shell at $47.40 | $111.00 |

### Expected balance on Fri 10/16

**The Platinum payoff for this week (Sat 10/10)** is this week's Platinum charges plus what is left of
the allowance.

| Step | Charges + remaining | Payoff |
|---|---|---|
| S1 | $0 + $300 | $300.00 |
| S2 | $141.60 + $158.40 | $300.00 |
| S3 | $226.60 (hardware included) + $158.40 | $385.00 |
| S4 | $226.60 + $113.40 — the Chase debit gas already left checking, so the payoff shrinks by exactly that $45 | $340.00 |
| S5–S10 | $226.60 + $111.00 | $337.60 |

**Last week's payoff ($180)** has no match at S1–S2, so it lands on the next business day. From S3 the
real $180 payment is in cash and the plan is matched away.

| Step | Calculation | Expected |
|---|---|---|
| S1–S2 | 2,500 − 180 − 95 phone + 2,000 Paycheck A − 300 payoff − 1,800 mortgage − 140 electric + 1,500 Paycheck B | $3,485.00 |
| S3 | 2,120 − 95 + 2,000 − 385 − 1,800 − 140 + 1,500 | $3,200.00 |
| S4 | 2,075 − 95 + 2,000 − 340 − 1,800 − 140 + 1,500 | $3,200.00 |
| S5–S6 | 2,072.60 − 95 + 2,000 − 337.60 − 1,800 − 140 + 1,500. Moving the phone bill to 10/14 keeps it inside the window. | $3,200.00 |
| S7–S8 | Electric +$25 | $3,175.00 |
| S9 | 4,072.60 − 337.60 − 1,800 − 165 − 95 + 1,500. Paycheck A is matched away by the real deposit. | $3,175.00 |
| S10 | 3,922.60 − 337.60 − 1,800 − 165 − 95 + 1,500 | $3,025.00 |

### Lowest before payday

| Step | Next payday | Daily balances in the window | Lowest |
|---|---|---|---|
| S1 | Paycheck A, Fri 10/9 | 10/5 2,320 (payoff) · 10/8 2,225 (phone) | $2,225.00 Thu 10/8 |
| S2 | Paycheck A, Fri 10/9 | 10/6 2,320 · 10/8 2,225 | $2,225.00 Thu 10/8 |
| S3 | Paycheck A, Fri 10/9 | 10/8: 2,120 − 95 | $2,025.00 Thu 10/8 |
| S4 | Paycheck A, Fri 10/9 | 10/8: 2,075 − 95 | $1,980.00 Thu 10/8 |
| S5 | Paycheck A, Fri 10/9 | The $95 phone is due today, so it lands on the next business day — payday — and counts before the paycheck: 10/9 2,072.60 − 95 | $1,977.60 Fri 10/9 |
| S6–S8 | Paycheck A, Fri 10/9 | The phone bill moved out, so only 10/8 remains | $2,072.60 Thu 10/8 |
| S9 | Paycheck B, 10/15 (Paycheck A matched away) | 10/10 3,735 · 10/12 1,935 · 10/13 1,770 · 10/14 1,675 | $1,675.00 Wed 10/14 |
| S10 | Paycheck B, 10/15 | 10/10 3,585 · 10/12 1,785 · 10/13 1,620 · 10/14 1,525 | $1,525.00 Wed 10/14 |

### Chase to review

| Step | Calculation | To review |
|---|---|---|
| S3 | Transfer + payoff | 2 |
| S4 | + Shell | 3 |
| S9 | + payroll | 4 |
| S10 | + Capital One = 5, then every Chase row is marked reviewed | 0 |

### Needs classification
Every purchase is tagged weekly or unplanned, so this is $0.00 all week. PR10 must keep it that way.

### Available until payday and safe to spend now (PR-B1)

Available until payday is the lowest before payday less the $500 buffer; safe to spend now is the smaller of
that and remaining this week. The week binds at every step, so safe to spend now is remaining this week.

| Step | Lowest before payday − 500 | Available | min(remaining, available) | Safe to spend now |
|---|---|---|---|---|
| S1–S2 | 2,225 − 500 | 1,725.00 | min(300.00 / 158.40, 1,725.00) | 300.00 / 158.40 |
| S3 | 2,025 − 500 | 1,525.00 | min(158.40, 1,525.00) | 158.40 |
| S4 | 1,980 − 500 | 1,480.00 | min(113.40, 1,480.00) | 113.40 |
| S5 | 1,977.60 − 500 | 1,477.60 | min(111.00, 1,477.60) | 111.00 |
| S6–S8 | 2,072.60 − 500 | 1,572.60 | min(111.00, 1,572.60) | 111.00 |
| S9 | 1,675 − 500 | 1,175.00 | min(111.00, 1,175.00) | 111.00 |
| S10 | 1,525 − 500 | 1,025.00 | min(111.00, 1,025.00) | 111.00 |

## PR-B1 delivery (2026-10-07)

- **Switched on, every step:** remaining, unplanned and needs classification this week, and safe to spend
  now — read from `GET /money/position`, whose figures the spine's `position` carries.
- Lowest before payday and available until payday were pinned at the lower values the ledger gave while the
  $300 Weekly Spend bill was still a bill (S1–S2 1,605.00; S3 1,225.00; S4 1,180.00; S5 1,177.60; S6–S8
  1,272.60; S9 912.60; S10 762.60). PR-B2 switched them on — see "PR-B2 delivery".
- **Round 2 (lead's ruling on the S5 question):** the window runs through payday, and on payday the bills
  count before the paycheck. Round 1 asserted S6–S8 at 2,072.60 because it stopped the day before payday;
  that same rule left the $95 phone out at S5 and read high. Counting payday's bills fixes S5's phone and,
  until the hooks land, also counts the dragged $300 Weekly Spend bill at S5–S8 — reading low, as the law
  allows. Once the hooks take that bill off the curve, the same rule should read this table's 1,977.60 at
  S5 and 2,072.60 at S6–S8.
- **Safe to spend now matches at every step** because the week is the smaller ceiling throughout.
- **Stale stays pending.** At S3–S7 today's freshness rule already reads `old` (a Plaid balance read
  Sun 08:00 with no sync for over 48 hours), where this table says fresh; the money position reports that
  as `degraded`. The column predates the 48-hour rule and is left for PR3's owner to reconcile.

## PR-B2 delivery (2026-10-07)

Decision 7 landed: the Weekly Spend and Monthly Spend bills are date hooks, each occurrence the card payoff.
Every column but Chase to review and stale is now asserted at every step, through `GET /money/position`
and `GET /forecast/cash-signal`; the spine's `position` equals the route at every step.

| Step | Available until payday, PR-B1 pin → PR-B2 | Why it moved |
|---|---|---|
| S1, S2 | 1,605.00 → **1,725.00** | Last Saturday's $300 Weekly Spend bill is now the $180 payoff for that closed week (charges only), still on Mon 10/5 / Tue 10/6 |
| S3 | 1,225.00 → **1,525.00** | The $180 Amex payment on 10/6 pays the closed week (evidence); nothing drags |
| S4 | 1,180.00 → **1,480.00** | The same |
| S5 | 1,177.60 → **1,477.60** | The same; the $95 phone still lands on payday before the paycheck (the date is Fri 10/9, not Thu 10/8: due today → next business day) |
| S6–S8 | 1,272.60 → **1,572.60** | Nothing is left in the window but cash; the lowest is Thu 10/8, tied with Fri 10/9 (first day reached) |
| S9, S10 | 912.60 / 762.60 → **1,175.00 / 1,025.00** | One $337.60 payoff for this week replaces two $300 bills |

Every move is up by exactly the funding bill the ledger used to carry in place of a payoff that was paid,
or by the bill's excess over the real payoff; never past this contract. The expected balance on Fri 10/16
reads the contract at every step (3,485.00 / 3,200.00 / 3,175.00 / 3,025.00).
