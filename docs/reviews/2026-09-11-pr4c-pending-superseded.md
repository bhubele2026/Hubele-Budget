# PR4c — A pending charge its posted row replaced counts once

Codex work-order point **1** (cash today), plan PR4: "pending superseded, read-only". PR4b, PR4d and PR4d-2 are live
(`b93c01e`). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

**A charge can sit in the ledger twice: once pending, once posted.**
- Normally the Plaid sync re-keys the pending row onto its posted row through `pending_transaction_id`, so they become
  one row.
- **When that link is missing, both rows stay.** This happens when:
  - the merchant re-bills under a fresh id and Plaid never sends the link;
  - the pending row survives because the user already worked it. The cursor `removed` delete and the vanished-pending
    sweep never delete a categorised, bucketed, reviewed or overridden row.
- **Cash today and the forecast curve then subtract the charge twice.**
- **Example:** a restaurant charge pending at −48.20 posts at −55.00 with the tip. Cash was down by 103.20; the truth is
  55.00.

## What changed

**One pairing rule, `pairPendingWithPosted`** (`lib/avalanche-core/src/pendingSupersede.ts`, pure). A posted row
replaces a pending row when **all** of these hold:
- same Plaid account; one row pending, the other not;
- the posted row reached the ledger after the pending row;
- the posted row is dated on the pending row's day or up to 7 days later (`SUPERSEDE_MAX_DAYS`);
- same sign, and |pending| ≤ |posted| ≤ 1.30 × |pending| + $1.00, so a tip or a final amount above the hold, never below it;
- the descriptions are fuzzy-equal. That is the dedupe pass's own token-subset comparator, moved verbatim to
  `lib/avalanche-core/src/descriptionMatch.ts`; `dedupeTransactions.ts` imports it back.

Pairing is one to one. Posted rows pick in date order, each taking the nearest-dated pending row, then the closest
amount, then the oldest.

**In the ledger** (`lib/forecastLedger.ts`, the one loop `bankToday` and the curve share), the pending half never
counts. What the posted half adds depends on what the bank snapshot already held, because `available` included the
charge while it was pending:

| Posted row | Pending row | Posted row adds | Why |
|---|---|---|---|
| held by the snapshot | either | 0 | the balance already has the posting |
| counts | held by the snapshot | posted − pending (−55.00 − −48.20 = **−6.80**) | the balance held the pending amount; only the tip is new |
| counts | counts | posted (−55.00) | neither was in the balance |

**The plan's wording, "the pending row leaves cash", is not enough.** Dropping a pending row the snapshot already held
changes nothing, and the posted row would still subtract the whole charge again. The table above is the deviation.

**With a snapshot, the actual-rows query reaches 7 days before the anchor.** A pending row dated before the snapshot
day can be the half a posted row replaced. `isInSnapshot` holds every row dated before the snapshot day, so the extra
days change nothing on their own.

## Figures that should move

**Live**, wherever cash today is shown or used (`bankToday`, the curve and low point, the spine's bank balance): up
by the double-counted half of any pending/posted pair the sync left unlinked.
- **Pending row held, posted row after the read:** up by the pending amount. Cash moves only by the tip.
- **Neither held:** up by the pending amount. The charge counts once, at the posted amount.
- **Unchanged:** every other row, and every household with no such pair. **No existing test fixture holds a pair.**
  Golden, cash signal, household scenario, spine parity, bank-balance explain and forecast past rows all pass
  unchanged, and the golden snapshot file is untouched.

**Not measured:** how many pairs the household's ledger holds. That needs a read-only production query Brad approves.
The production database stays locked.

## Residuals

- **False pair (overstates cash).**
  - A real charge still pending, plus a *different* later charge at the same merchant that posted first. It must be
    within 7 days and 1.30× + $1, with fuzzy-equal descriptions (coffee, gas).
  - The pending charge is dropped until it posts, when it is re-keyed and the pair disappears.
  - It needs out-of-order posting: the later charge posts before the earlier one. There is no
    `pending_transaction_id` column to tell them apart.
- **Missed pair (understates cash, as before).** A posted amount below the hold, over 1.30× + $1, more than 7 days
  later, or with a description the token-subset test does not match.
- **Spending totals still count both halves.** This rule applies only to cash and the forecast. Spending reports use
  `isRealSpend` (plan PR7).
- **The same surfaces as PR4b stay on their own rules:** the web Chase page (`lib/accountBalance.ts`), "Why this
  number?" (`sinceAnchor`) and the sync's reconciliation. They can differ by the pairs above as well (PR4e).
- **Only Plaid rows pair.** Manual and Amex rows never do.

## Must not change

- Every existing figure and test. No fixture holds a pair; see above.
- `dedupeTransactions.ts` behaviour: the comparator moved verbatim, and its suite passes.
- The web app's code. The shared library gains two modules, and the web suite and bundle guard were re-run.

## Tests

- **New `lib/pendingSupersede.test.ts`** (9):
  - a tip pairs;
  - same day (posted later) and +7 days pair; +8 does not;
  - never a posted row dated earlier, or one that reached the ledger first;
  - the amount bounds at exactly 1.30 × + $1, a cent over, a cent under, the other sign, and deposits;
  - account, pending flag and description, plus the moved comparator;
  - one-to-one pairing: two pendings with one posted row, one pending with two posted rows, and the closer amount on a
    tie.
- **`__tests__/cashSignal.integration.test.ts`** (+6), on a balance of 1,000.00 read at 10:00 CT on 05-01:
  - pending −48.20 held, posted −55.00 the next day → **993.20** in `bankToday` and `daily[0]`;
  - neither held → **945.00**;
  - a pending row dated before the snapshot day (found through the widened query) → **993.20**;
  - not a pair: a different merchant (895.00), the amount over 1.30× + $1 (905.00), eight days apart (896.80).
- **Failing before:** run against `main`'s `forecastLedger.ts` (`b93c01e`), **the three pairing tests fail** (993.20, 945.00,
  993.20). The three "not a pair" tests pass there, as they must.

## Verification

- **Ledger-dependent API files:** 9 files, 137 pass, 8 todo. The golden snapshot file is unchanged.
- **Full API suite:** **121 files, 916 pass, 8 todo** (901 on `main`, plus 9 unit and 6 cash-signal tests).
- **Web suite:** 118 files, 917 pass (the shared library gained two modules).
- **Workspace typecheck and build:** pass; workspace build exit 0.
- **Landing bundle guard:** 572.5 KB of 580, unchanged.

## Left for later

- **PR4d, still open:** backfill order around the balance read; an optional untouched-delete for an OLD/NEW re-mint
  pair; a time-evidence re-mint tie-break.
- **PR4e:** move the web `accountBalance.ts`, the explain route and the sync reconciliation onto `isInSnapshot` and this
  pairing rule.
- **PR7:** spending totals should not count both halves of a pair.
