# PR5a — "Probably paid": a plan a bank row probably paid leaves the curve (server)

Codex work-order point **6** ("probably paid" matching), plan PR5, server half. The web half — "Suggested" in Review,
Confirm / Not this / Partial — is PR5b. Built on `main` with PR4c, PR4e and PR7 merged (`56596f3`). Plan:
`~/.claude/plans/h2-budget-work-serene-pebble.md`.

| Commit | What it does |
|---|---|
| `c235f37` | `lib/avalanche-core/src/planMatch.ts` — the pure matcher, with unit tests. |
| `2f3d305` | Resolutions: "Not this" (`not_match`) and `partial`; narrowed neighbour delete; review count. |
| `a7d1428` | The ledger uses the matcher; `CashSignal.matches`; OpenAPI + codegen; golden re-recorded. |
| `faefe3d` | Merge of `origin/main` (PR7). Only generated declaration maps conflicted; regenerated. |

## The problem

**A bill that is already paid can still weigh on the forecast.**
- A planned payment stays on the curve until someone matches it to the bank row that paid it.
- The row counts in cash as soon as it posts, so until then the bill counts twice: once as the real row, once as the
  plan.
- **Example:** a $150 water bill paid at $173. The row takes $173 out of cash; the unmatched plan takes another $150
  on its due date, so the curve dips by $323 instead of $173.
- Server auto-match is off by design (`plaidSync` `AUTO_MATCH_ENABLED=false`). The only matching on `main` is a
  suggestion list the web computes on its own.

## What changed

### The matcher (`matchPlansToRows`, `lib/avalanche-core/src/planMatch.ts`)

A plan and a bank row pair when all of these hold:
- same sign;
- the row is dated 10 days before to 14 days after the plan;
- **with label evidence** (a distinctive word of the plan's label appears in the row's description): the amounts
  differ by at most max($25, 25% of the plan);
- **without it:** they differ by at most max($1, 1%), and the dates are at most 3 days apart.

**How the pairing works.**
- **Stop-words never count as evidence:** "minimum" (every debt label), "payment" (the avalanche label), "pmt", "ach",
  "autopay", "online", and others.
- **Aliases:** "Amex" and "American Express" count as the same payee.
- **One to one:** best score first, where score = |Δcents| + 100·|days| − 5,000 with evidence.
- **`ambiguous`:** a runner-up for the same plan or row scores within max(100, 10%).
- **`confidence`:**
  - "high" = evidence and within max($1, 1%) and 5 days;
  - "medium" = evidence, or an exact amount within 3 days without it;
  - otherwise "low".
- **A rejected pair** (`not_match`) never pairs again.

### The ledger (`buildForecastLedger`)

After the resolutions are read, and before the plans loop:
- **Candidate plans:**
  - unresolved occurrences dated today−21 to today+10, after any reschedule, from the same expansion the curve uses;
  - excluded: plans matched, skipped, missed, dismissed, or with a `partial` resolution.
- **Candidate rows:**
  - checking rows dated today−31 to today, from their own read;
  - classified by the PR4e cash-row rule with no anchor, so rows the snapshot holds are still candidates, and a pending
    half its posted row replaced is not;
  - excluded: rows claimed by any resolution other than "Not this". A posted row whose replaced pending row is claimed
    counts as claimed.
- **In the plans loop:**
  - a probably-paid plan is skipped before the pre-snapshot rule (#666). `bankToday` is final before this point and
    never moves.
  - A `partial` resolution keeps only the unpaid remainder (plan − paid row) on the curve, when more than $1 remains.
  - Its row counts as accepted, like a match (`acceptedImpact`).
- **Output:** `ledger.matches` becomes `CashSignal.matches`. Fields: planKey, planItemId, planDate (the resolution
  key date), txnId, the plan and row amounts, difference (|row| − |plan|), dayDelta, confidence, ambiguous. It is in
  OpenAPI; confidence is a plain string, so no runtime constant reaches the landing bundle.

### Resolutions (`POST /forecast/resolutions`)

- `not_match` and `partial` require a plan occurrence and a bank row.
- **Neighbour delete.** It used to keep one resolution per plan occurrence and one per row by deleting "neighbours".
  Now:
  - it leaves `not_match` rows alone, so a rejected suggestion never comes back after another decision about either
    side;
  - a `not_match` write replaces only the identical pair;
  - confirming a pair clears its rejection;
  - every other status behaves as before.
- **Review count:** a row whose only resolution is "Not this" still needs review.

## Figures that should move

- **The forecast curve, low point and projected balances:** up by every plan a recent bank row probably paid. The
  bill now counts once, as the real row.
  - $150 plan paid $173 → the curve carries −$173 once, never −$323.
  - A bill paid 8 days early no longer dips again on its due date.
- **Unchanged:**
  - cash today (`bankToday`) and the spine's bank balance;
  - the review count (a suggestion is not a decision);
  - spending;
  - the Budget page;
  - plans with no likely row;
  - plans outside today−21 to today+10.
- **Golden:** all 11 entries gain `"matches"`, and no figure changes (+90 lines, additions only).
  - Ten entries have an empty list.
  - The full-household fixture shows one match: a $38 debt minimum dated 04-25, paired with a $20 row 14 days later
    ("golden" appears in both the debt name and the row description).
  - That plan is dated before the snapshot, so it was already off the curve.
- **Not measured:** how many plans the household's live data would match. That needs a read-only production query
  Brad approves.

## Residuals

- **A match can hide a shortfall until the user answers.**
  - With label evidence the tolerance is max($25, 25%). A $20 row can take a $38 plan off the curve, and the $18
    difference stays hidden until the user confirms "partial" or rejects the pair.
  - "Suggested" in Review (PR5b) is where the user answers.
  - Tightening the tolerance is a one-line change if the reviewer or Codex prefers it.
- **The web doesn't show matches yet (PR5b).** Until then:
  - the Forecast register still lists a probably-paid plan as "Pending plan", while the curve has already dropped it;
  - the web's own suggestion list runs its own rules;
  - `forecastReconcile` still adds the plan into its "Forecast" end figure.
- **Label evidence is a word match.**
  - A generic payee word shared by an unrelated row can pair them, as in the golden fixture's "golden".
  - Stop-words cover the known generic label words only.
- **Horizon.** Candidate plans come from the curve's own expansion, so a request with fewer than 10 days ahead sees
  fewer candidates. Every web caller asks for 30 days or more.
- **Only the checking account.**
  - A payment from the Amex, or another account, is matched only by an explicit resolution, as before.
  - The logged Avalanche payment and its bank debit (a separate open question for Brad) are two checking rows. Either
    can match a debt minimum, but not both: pairing is one to one.

## Must not change

- `bankToday`, the spine bank balance, spine parity and the review count.
- Server auto-match stays off; nothing is written.
- The pre-snapshot rule, the past-due drag, reschedule/skip/missed behaviour.
- The golden figures (only `matches` is added).
- No new dependencies; no DDL.
- Landing bundle within the cap.

## Tests

- **`lib/planMatch.test.ts` (13):**
  - label evidence and stop-words; the Amex alias;
  - $150/$150 high; $150/$173 with difference +23;
  - 6 days early and 5 days late match, 11 early and 15 late do not;
  - no label: exact within 3 days matches, $23 off or 4 days does not;
  - two −$50 rows never pay a −$100 plan;
  - a stop-word is not evidence;
  - a card payment matches a debt minimum by the card name;
  - opposite signs never pair;
  - one to one with `ambiguous`;
  - a rejected pair never returns;
  - an income deposit.
- **`__tests__/forecastResolutionsPairs.integration.test.ts` (8):**
  - validation;
  - a rejection survives another match of the plan, and another decision about the row;
  - repeat and second rejections;
  - confirming clears a rejection;
  - partial replaces a match;
  - the unchanged one-per-plan / one-per-row behaviour;
  - the review count with "Not this".
- **`__tests__/cashSignalProbablyPaid.integration.test.ts` (7).** Balance 1,000.00 read 05-01, today 05-14, plans due
  on the 20th:
  - $150 paid 8 days early → `bankToday` 850.00, 05-20 850.00 (not 700.00), 06-20 700.00, and the exact match object;
  - $150 paid $173 → 05-20 827.00 (never 677.00), difference 23.00;
  - "Not this" → 05-20 700.00, no match;
  - partial $500 / $250 → 05-20 500.00;
  - two −$50 rows vs a −$100 plan → 05-20 800.00, no match;
  - a row already matched to another plan → not a candidate;
  - a replaced pending half → the posted row is the match.
- **Failing before:** with `main`'s server code (`56596f3`: `forecastLedger.ts`, `cashSignal.ts`, `routes/forecast.ts`,
  `reviewCount.ts`) swapped in, **12 of the 28 new tests fail**:
  - **all 7 probably-paid tests.** Two of them ("two −$50 rows" and "a row already matched") fail only because
    `matches` is missing there; their curve figures already hold on `main`.
  - **5 resolution tests:** validation, both survivals, repeated rejection, and the review count.
  - **Still passing on `main`:** "confirming clears a rejection", "partial replaces a match" and the unchanged
    behaviour, which pin behaviour `main` already had, and the 13 matcher unit tests (a new module).

## Verification

- **Full API suite:** **128 files, 1064 pass, 7 todo** (`CI=true`, on the merge with PR7; golden compares clean).
- **Web suite:** **119 files, 933 pass**.
- **Workspace typecheck and build:** typecheck clean; workspace build exit 0.
- **Landing bundle guard:** 572.5 KB of 580, unchanged.
- **Codegen:** regenerated after the merge; the working tree is clean.

## Left for later

- **PR5b (web):**
  - "Suggested" in Review, with Confirm (`matched`), Not this (`not_match`) and Partial;
  - the new statuses in `forecastMatch.ts` (`rescheduled` is missing there too);
  - the register and `forecastReconcile` read `CashSignal.matches`.
- **PR6:** overdue bills now have "probably paid" evidence to lean on; it replaces the pre-snapshot rule (#666) only
  after this.
- **Brad's decision on logged Avalanche payments** vs their bank debits (options a/b/c).
