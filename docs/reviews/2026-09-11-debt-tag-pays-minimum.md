# Debt tag pays the minimum — a row the user tagged to a debt pays that debt's overdue minimum

Follow-up to PR6 (third look, LOW 2; "Left for later" in `2026-09-11-pr6-overdue-bills.md`). Branch
`fix/debt-tag-pays-minimum`, built on `main` at `500473e` (PR6 merged); `main` merged in at `9b72830` (household
months) and `78979fe` (PR14, Chase review inbox). The review of `800ac47` asked for changes; they are below under
**Review fixes**.

| Commit | What it does |
|---|---|
| `259029d` | The helper's tag rule, the ledger's cross-debt guard, `confidence: "debt_tag"` (spec + codegen), tests. |
| `800ac47` | First note. |
| `31e007c` | Merge of `origin/main` (`9b72830`, household months). No conflicts. |
| `bc4fbb6` | Review fixes: a conflicting tag is never `offCurve` and a used row pays nothing else (M1); only a checking-account bank row's tag counts (M2); tests. |
| `5ae8c55` | Merge of `origin/main` (`78979fe`, PR14). One conflict, a generated source map (`api.schemas.d.ts.map`): took `main`'s side, then re-ran codegen and committed its output (PR14's new `ledger` client module picks up the `debt_tag` description too). `openapi.yaml` kept both sides (PR14's ledger fields and `bulk-review-matching`, this branch's `debt_tag` text). |
| _this note_ | Review fixes added. |

## ⭐ The rule Brad should know

**A payment the bank shows on checking, tagged to a debt, pays that debt's overdue minimum** when it is money out, at
least the minimum, and dated 10 days before to 14 days after the due date. The card's name is not needed. It is listed
in `overdueAssumedPaid` with `confidence: "debt_tag"`.
- **A payment tagged to one debt never pays another debt's minimum**, whatever its name says, and never takes another
  debt's upcoming minimum off the curve (review M1).
- **A payment you log in the app** ("Payment — Chase Sapphire") **doesn't pay a minimum by its tag** (review M2): the
  bank's own row does. Logged alone, the minimum drags until the bank row arrives. Errs low.
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

## Review fixes (review of `800ac47`: REQUEST CHANGES)

Verified sound by the reviewer and kept: C5, the −$1,000 two-minimums case, the Freedom/Sapphire mis-pair (2,460),
refunds, underpayment remainders, after-today rows, the April/May window, where tags come from, non-debt bills, the
`evidence` field.

| # | Finding | Fix | Tests |
|---|---|---|---|
| M1 | **One tagged row paid two cards.** A row tagged to Freedom paid Freedom's overdue minimum by tag, and its matcher pair still took Sapphire's upcoming 05-08 minimum off the curve (`offCurve`): the cross-debt guard freed the row for the helper but `probablyPaidKeys` read every `offCurve` pair. | A pair between a debt plan (a `debt:` minimum, or a recurring bill linked to a debt) and a row tagged to a **different** debt (`tagConflict`) is never `offCurve`, never overdue evidence, and never a named pair for the earlier-unpaid rule. A row whose pair is `offCurve` or evidence is used up and pays nothing else. A row tagged to a debt stays free to pay that debt by tag. | M1 and its untagged twin (T6c); future only |
| M2 | **A logged payment and its bank debit paid two minimums.** `POST /debts/:id/payments` writes a manual row tagged to the debt. `isBankRow` treats a manual row as the checking account's own, so the tag rule counted it: the log paid Sapphire by tag and the untagged bank debit paid Freedom by name. | The ledger passes a row's tag to the helper and the guard only for a **Plaid row on the checking account** (`plaidAccountId` equals the snapshot account's external id). A manual row's tag is ignored: the row is read exactly as before the tag rule (the name rule still applies to it, and "Payment — Chase Sapphire" is no card payment). | M2; a logged payment alone; a tagged bank debit |

**Figures** (today = snapshot = Tue 05-05, balance 3,000, buffer 500, 90 days; a paycheck on the 28th; max safe extra;
all measured on each commit's source with these tests):

| Case | `500473e` (base) | `800ac47` | This fix |
|---|---|---|---|
| **M1** Sapphire $40 due the 8th (April paid), Freedom $30 due 04-28 (overdue); "CHASE SAPPHIRE ONLINE PAYMENT" −40 on 05-04 **tagged to Freedom** | 2,470 (Freedom drags, Sapphire off) | 2,500 (neither) | **2,460** (Freedom paid by tag; Sapphire's $40 on 05-08) |
| **T6c** the same row untagged | 2,470 | 2,470 | **2,470** (unchanged) |
| **Future only** both cards opened 05-01, Sapphire due 05-08, Freedom due 05-20; the same Freedom-tagged row | 2,470 (Sapphire off) | 2,470 | **2,430** (both on the curve) |
| **M2** Sapphire $40 (05-01), Freedom $30 (05-03); "Payment — Chase Sapphire" −500 logged in the app (tagged); "PAYMENT TO CHASE CARD ENDING IN 1234" −500 untagged | 2,470 (debit pays Sapphire; Freedom drags) | 2,500 (log pays Sapphire, debit pays Freedom) | **2,470** |
| **Logged payment alone** Sapphire $40; the tagged manual row only | 2,460 | 2,500 | **2,460** (errs low) |
| **Tagged bank debit** as M2, the debit "CHASE ONLINE PAYMENT" tagged to Sapphire | 2,430 (tags ignored: both drag) | 2,470 | **2,470** (Sapphire `debt_tag`; Freedom drags) |

- ⚠️ **M1 reads 2,460, not the review's expected 2,470.** The row is Freedom's, so the card still owed is Sapphire, and
  Sapphire's minimum is $40: it lands on 05-08 (2,960). Base's 2,470 was Freedom's $30 dragging instead, the wrong card
  by $10. The review's 2,470 would need the curve to charge Freedom again; this fix charges the card the row did not
  pay.
- **Future only errs low by $30:** Freedom's 05-20 minimum stays on the curve although its tagged row paid it. The tag
  rule pays overdue minimums only (the brief's scope); a future plan leaves the curve only on its own `offCurve` pair,
  and the matcher had already given this row to Sapphire.

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
- The helper itself doesn't know bank from manual rows; the ledger decides which tags it sees (M2).

### The ledger (`artifacts/api-server/src/lib/forecastLedger.ts`)

- **(M2) A candidate row carries its tag (`transactions.debt_id`) only when it is a Plaid row on the checking
  account.** A manual row carries no tag, so neither the helper nor the guard below reads it.
- Due `debt:` minimums are passed with their `debtId`.
- **The tag guard (`tagConflict`).** A matcher pair whose row is tagged to one debt and whose plan belongs to another
  debt (a `debt:` minimum, or a recurring bill linked to a debt):
  - stays in `matches` as a suggestion, with **`offCurve: false`** (M1);
  - is not overdue evidence: it doesn't mark the plan paid and doesn't keep the plan out of the helper;
  - doesn't count as a named pair for the earlier-unpaid rule (PR5 review);
  - doesn't use up its row, which stays free to pay its own debt by tag.
- **(M1) One row pays once:** a row whose main-pass pair is `offCurve` or evidence is used, for the listing pass and the
  helper alike.
- The helper's `evidence` becomes the `overdueAssumedPaid` entry's `confidence`.

### API

- `CashSignalAssumedPaidPlan.confidence` gains `"debt_tag"` (a string; the description and the `overdueAssumedPaid`
  description say so). Codegen changes description text only. The web doesn't read `confidence` yet (PR12).

## Figures that move

The first round's cases (today = snapshot = Tue 05-05, balance 3,000, buffer 500, 90 days; a monthly paycheck on the
28th covers the month's minimums). Before = `500473e` source with these tests (measured); all three are unchanged by
the review fixes (their rows are Plaid checking rows).

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

- **Up:** an overdue minimum paid by a checking row tagged to its debt, when the row has no issuer phrase and no Plaid
  category.
- **Down (by the gap between two minimums):** a row tagged to one debt that the matcher paired with another debt's
  minimum, overdue or upcoming. The right debt is paid and the other one is on the curve.
- **Golden: no change.** No golden household has a tagged row; it compares clean without re-recording.

## Must not change

- `matchPlansToRows` and its pairing.
- **`offCurve` changes in one case only:** a pair between a debt plan (a `debt:` minimum, or a recurring bill linked to a
  debt) and a Plaid checking row tagged to a **different** debt. Such a pair is no longer `offCurve`, and it no longer
  counts as a named pair for the earlier-unpaid rule, which can keep a later occurrence of that same debt plan on the
  curve. Every pair whose row carries no tag, or whose plan belongs to no debt, keeps its `offCurve` exactly.
- The untagged card-payment path: every earlier `plansPaidInFullByName` test passes; the only edit to them adds
  `evidence: "card_payment"` to the expected objects.
- A manual row reads exactly as it did before the tag rule.
- `bankToday`, the spine and spine parity; the spending rule (`spendingRule.ts` untouched); nothing is written.
- No DDL, no dependency (`pnpm-lock.yaml` unchanged).

## Residuals

- **A payment logged in the app pays no minimum by its tag** (M2). Until the bank row arrives, or when the bank row
  names no card and has no issuer phrase or Plaid category, the minimum drags. Errs low. Tagging the bank row itself
  pays it.
  - ⏳ **This interacts with Brad's open decision on logged Avalanche payments versus the ACH (options a/b/c).** This
    rule treats the bank's row as the payment and a logged payment as not evidence of it. If Brad's choice makes a logged
    payment the payment of record, this rule has to follow it, and the double count M2 found has to be solved another
    way (pairing the log with its bank row).
- **No resolved checking account, no tag.** When the snapshot's account can't be resolved (no Plaid row is a bank row
  then), no row carries a tag and the rule is off: minimums fall back to PR6's name rule. Errs low.
- **A tagged row pays its debt's overdue minimums only.** An upcoming minimum of the tagged debt leaves the curve only on
  its own `offCurve` pair; when the matcher gave the row to another debt's plan, both stay on the curve (future only:
  errs low by $30).
- **A debt whose minimum is a linked recurring bill** (not a synthetic `debt:` minimum) isn't in the helper: a row
  tagged to it pays it only through the matcher (the name within max($25, 25%), or the exact amount within 3 days).
  Errs low. The tag guard does cover linked bills.
- **Only the row's own tag counts.** A row in a category linked to a debt (PR7's rule 4) isn't tagged here. Errs low.
- **A tagged row can still be evidence for a bill that is not a debt's** (rent, a utility) through the matcher: PR6's
  accepted risk, unchanged. Only another debt's plans are refused.
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
- **`cashSignalOverdueEvidence.integration.test.ts` (+8):**
  - "debt tag" (3): C5, tagged to another debt, and the cross-tag matcher case, with the first-round figures;
  - (review) "review M1" (2): M1 with its untagged twin T6c in the same test; the future-only variant;
  - (review) "review M2" (3): a logged payment plus its untagged debit; a logged payment alone; a tagged bank debit.

## Failing before

**Review fixes** — against `800ac47` with the new tests copied in: **4 of the 5 new tests fail**, both review setups
among them.
- M1 (2,500), future only (2,470), M2 (2,500), a logged payment alone (2,500).
- Still passing: "the bank debit tagged to Sapphire pays Sapphire", which pins that a checking row's tag keeps paying.
- Against `500473e`, for the base column above: M1 and future only fail (2,470), the tagged bank debit fails (2,430);
  M2 and a logged payment alone pass (base got both right, as the review said).

**First round** — against `origin/main` source (then `500473e`) with the new and changed tests copied in: **13 of 58
fail** in the two files.
- **Integration, 3 of 3** (C5 at 2,960.00 on 05-06; Freedom dragging at 2,930.00; Sapphire paid by the Freedom row at
  2,970.00).
- **New unit tests, 6 of 7.** Still passing: "the wrong sign pays nothing", which pins behaviour that was already right.
- **Earlier unit tests, 4 of 4** changed ones: the new `evidence` field only.

## Verification

**After the review fixes and the merge of `origin/main` (`78979fe`), on the merged tree:**
- **Workspace typecheck:** exit 0.
- **Full API suite (`CI=true`):** **138 files, 1302 pass, 7 todo** (1278 before + these 5 + PR14's 19 in its 2 new
  files). The golden compares clean; nothing re-recorded.
- **Web suite:** **133 files, 1103 pass** (the merges brought the household-months and PR14 web tests).
- **Build and landing guard:** `pnpm run build` exit 0; `check-entry-graph` OK, **574.4 KB of 580**. It was 572.6 KB
  before the merges; this branch adds no web code (server-side changes and description text only), so the growth came
  with `main`.
- **Codegen:** codegen (zod and both client targets, including PR14's `ledger` module) and `typecheck:libs` re-run on
  the merged tree and committed in `5ae8c55`; a fresh run after that commit changes nothing.
- **Helper and evidence files on the fix before merging:** 63 pass.

**First round (`800ac47`, on `500473e`):**
- Workspace typecheck exit 0; API suite 136 files, 1278 pass, 7 todo; web suite 128 files, 1025 pass; build exit 0,
  landing guard 572.6 KB of 580; codegen clean.
