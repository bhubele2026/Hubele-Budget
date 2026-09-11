# Debt tag pays the minimum — a row the user tagged to a debt pays that debt's overdue minimum

Follow-up to PR6 (third look, LOW 2; "Left for later" in `2026-09-11-pr6-overdue-bills.md`). Branch
`fix/debt-tag-pays-minimum`, built on `main` at `500473e` (PR6 merged).

| Commit | What it does |
|---|---|
| `259029d` | The helper's tag rule, the ledger's cross-debt guard, `confidence: "debt_tag"` (spec + codegen), tests. |
| _this note_ | This note. |

## ⭐ The rule Brad should know

**A payment you tagged to a debt pays that debt's overdue minimum** when it is money out, at least the minimum, and
dated 10 days before to 14 days after the due date. The card's name is not needed. It is listed in
`overdueAssumedPaid` with `confidence: "debt_tag"`.
- **A payment tagged to one debt never pays another debt's minimum**, whatever its name says.
- One payment pays one minimum. Two occurrences in the window: the nearer one.

## The problem

PR6's debt-minimum helper (`plansPaidInFullByName`) marked an overdue `debt:` minimum paid only by a checking row that
**names the card as a word** and **is a card payment** by PR7's rules 3, 8 or 9 (the user's flag, Plaid's
`LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`, an issuer phrase). It ignored PR7's rule 2: the row's `debtId`.

- **C5:** "CHASE ONLINE PAYMENT" −600 tagged to Chase Sapphire. PR7 has no phrase for it and there's no Plaid category,
  so the $40 minimum still dragged although the user had said, on that very row, which debt it paid. Errs low.

Found while building this: the tag was also ignored in the **other** direction.
- **Cross-tag:** "CHASE ONLINE PAYMENT" −45 tagged to Chase **Freedom**, a day after a $40 Chase **Sapphire** minimum.
  The matcher pairs it with Sapphire (shared word "chase", $5 over, 1 day: medium, not ambiguous), PR6's evidence rule
  took that pair as paying Sapphire, and Freedom's $30 then dragged. The row the user tagged to Freedom paid Sapphire.

## What changed

### `plansPaidInFullByName` (`lib/avalanche-core/src/planMatch.ts`)

- `MatchRow.debtId` (the row's tag) and `MatchPlan.debtId` (the debt the plan is the minimum of). Both optional; the
  matcher never reads them.
- A candidate still needs: same sign, the window (10 before, 14 after), at least the plan, not a rejected pair. Then:
  - **row tagged:** it pays only when `row.debtId === plan.debtId` (`evidence: "debt_tag"`). Tagged to another debt, or
    the plan names no debt: it pays nothing, not even by name;
  - **row untagged:** exactly as before: a distinctive label word AND a card payment by PR7's rule
    (`evidence: "card_payment"`).
- **One to one, unchanged:** one row pays one plan, one plan takes one row. **Tagged pairs go first**, then nearest date,
  so an untagged "CHASE CREDIT CRD" payment that names both Chase cards can't take Sapphire from Sapphire's own tagged
  row (it pays Freedom instead).
- `PaidInFull` gains `evidence`.

### The ledger (`artifacts/api-server/src/lib/forecastLedger.ts`)

- Each candidate row carries `debtId` (`transactions.debt_id`).
- Due `debt:` minimums are passed with their `debtId`.
- **Cross-debt guard, overdue evidence only.** A matcher pair whose row is tagged to one debt and whose plan pays
  another (a `debt:` minimum, or a recurring bill linked to a debt) is not evidence: it doesn't mark the plan paid,
  doesn't use up the row (so the row can pay its own debt), and doesn't keep the plan out of the helper.
  - The pair itself stays in `matches`, unchanged (still a suggestion, `offCurve` untouched).
  - Future plans still leave the curve only on `offCurve` (`probablyPaidKeys` is built from `matches`, as before).
- The helper's `evidence` becomes the `overdueAssumedPaid` entry's `confidence`.

### API

- `CashSignalAssumedPaidPlan.confidence` gains `"debt_tag"` (a string; the description and the `overdueAssumedPaid`
  description say so). Codegen changes description text only. The web doesn't read `confidence` yet (PR12).

## Figures that move

Today = snapshot = Tue 05-05, balance 3,000, buffer 500, 90 days; a monthly paycheck on the 28th covers the month's
minimums. Before = `origin/main` source with these tests (measured).

| Case | Figure | Before | After |
|---|---|---|---|
| **C5** Sapphire $40 due 05-01; "CHASE ONLINE PAYMENT" −550 (04-01) and −600 (05-01) tagged to Sapphire | 05-06 / low point | 2,960.00 | **3,000.00** |
| | max safe extra | 2,460.00 | **2,500.00** (+40) |
| | dragging | Sapphire −40.00 | none |
| | `overdueAssumedPaid` | — | Sapphire 04-01 and 05-01, `debt_tag` |
| | `overdueOutsideForecast` | Sapphire 04-01 | — |
| **Tagged to another debt** Sapphire $40 (05-01), Freedom $30 (05-03); −600 tagged to Freedom | 05-06 | 2,930.00 | **2,960.00** |
| | max safe extra | 2,430.00 | **2,460.00** |
| | dragging | Sapphire −40, Freedom −30 | **Sapphire −40** (still) |
| | `overdueAssumedPaid` (May) | — | Freedom, `debt_tag` |
| **Cross-tag through the matcher** as above, −45 (05-02) tagged to Freedom | 05-06 | 2,970.00 | **2,960.00** |
| | max safe extra | 2,470.00 | **2,460.00** (−10) |
| | dragging | Freedom −30 | **Sapphire −40** |
| | `overdueAssumedPaid` (May) | Sapphire, `medium` | Freedom, `debt_tag` |
| | `matches` | Sapphire ↔ the row, medium, not off the curve | unchanged |

- **Up:** an overdue minimum paid by a row tagged to its debt, when the row has no issuer phrase and no Plaid category.
- **Down (by the gap between two minimums):** a row tagged to one debt that the matcher paired with another debt's
  minimum. The right debt is now paid and the wrong one drags.
- **Golden: no change.** No golden household has a tagged row; it compares clean without re-recording.

## Must not change

- `matchPlansToRows`, `matches`, `offCurve`, and pairing for plans due after today.
- The untagged card-payment path: every earlier `plansPaidInFullByName` test passes; the only edit to them adds
  `evidence: "card_payment"` to the expected objects.
- `bankToday`, the spine and spine parity; the spending rule (`spendingRule.ts` untouched); nothing is written.
- No DDL, no dependency (`pnpm-lock.yaml` unchanged). Landing bundle 572.6 KB of 580 (unchanged).

## Residuals

- **A debt whose minimum is a linked recurring bill** (not a synthetic `debt:` minimum) isn't in the helper: a row
  tagged to it pays it only through the matcher (the name within max($25, 25%), or the exact amount within 3 days).
  Errs low. The cross-debt guard does cover linked bills.
- **Only the row's own tag counts.** A row in a category linked to a debt (PR7's rule 4) isn't tagged here. Errs low.
- **A tagged row can still be evidence for a bill that is not a debt's** (rent, a utility) through the matcher: PR6's
  accepted risk, unchanged. Only another debt's payment is refused.
- **A mis-tag is trusted:** a payment tagged to the wrong debt pays that debt's minimum and leaves the right one
  dragging, until the tag is fixed.
- **A tagged row below the minimum** doesn't pay by tag. If the matcher pairs it (name within max($25, 25%)), PR6's
  remainder rule applies as before; otherwise the full minimum drags. Errs low.
- **Not visible to the user yet:** like `card_payment`, `debt_tag` pairs aren't in `matches`, so "Not this" can't be
  offered for them until PR12. A "Not this" already written for that pair is respected.
- **The Avalanche extra names no debt**, so a tagged row paired with it is still evidence for it (unchanged).

## Tests

- **`planMatch.test.ts` (+7, "a row tagged to the debt"):**
  - C5: the tagged row pays; the same row untagged pays nothing; a nameless tagged Zelle pays;
  - never another debt: tagged to Freedom pays no Sapphire minimum, not even as a flagged card payment naming
    Sapphire; with both minimums in the window it pays Freedom only; a plan with no `debtId` takes no tagged row;
  - below the minimum ($39.99) pays nothing; exactly $40 pays;
  - the wrong sign pays nothing;
  - the window: 10 before and 14 after pay, 11 and 15 don't;
  - one tagged row pays one occurrence, even inside two windows and big enough for both; a second tagged row pays the
    other; a rejected pair never counts;
  - a tagged pair is taken before a nearer name pair.
  - The 4 earlier tests that compare whole `PaidInFull` objects gain `evidence: "card_payment"`.
- **`cashSignalOverdueEvidence.integration.test.ts` (+3, "debt tag"):** C5, tagged to another debt, and the cross-tag
  matcher case, with the figures above.

## Failing before

Against `origin/main` source with the new and changed tests copied in: **13 of 58 fail** in the two files.
- **Integration, 3 of 3** (C5 at 2,960.00 on 05-06; Freedom dragging at 2,930.00; Sapphire paid by the Freedom row at
  2,970.00).
- **New unit tests, 6 of 7.** Still passing: "the wrong sign pays nothing", which pins behaviour that was already right.
- **Earlier unit tests, 4 of 4** changed ones: the new `evidence` field only.
- `origin/main` moved to `9b72830c` during this build (household months). Its changes since `500473e` touch
  `routes/reports.ts`, one household-clock test and web pages, none of the helper, ledger or cash signal, so this
  measurement stands for `500473e`.

## Verification

- **Workspace typecheck:** exit 0.
- **Full API suite (`CI=true`):** **136 files, 1278 pass, 7 todo** (PR6's 1268 plus these 10). The golden compares
  clean; nothing re-recorded.
- **Web suite:** 128 files, 1025 pass.
- **Build and landing guard:** `pnpm run build` exit 0; `check-entry-graph` OK, 572.6 KB of 580.
- **Codegen:** description text only (11 generated files); a fresh run after the commit changes nothing.
