# PR4c — A pending charge its posted row replaced counts once

Codex work-order point **1** (cash today), plan PR4 ("pending superseded, read-only"). PR4b, PR4d and PR4d-2 are live
(`b93c01e`). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

| Commit | What it does |
|---|---|
| `4f2969c` | The pairing rule, the comparator move, the ledger wiring and tests. |
| review-fix commit | Fixes from the first review: which pending rows leave only a difference, when a held posted row still counts, ranking, and rows with no description. The rules below are as shipped. |

## The problem

**A charge can sit in the ledger twice, once pending and once posted.**
- Normally the Plaid sync re-keys the pending row onto its posted row through `pending_transaction_id`, so there is one
  row.
- **When that link is missing, both rows stay:**
  - the merchant re-bills under a fresh id and Plaid never sends the link;
  - or the pending row survives because the user already worked it. The cursor `removed` delete and the vanished-pending
    sweep never delete a categorised, bucketed, reviewed or overridden row.
- **Cash today and the forecast curve then count the charge twice.**
- **Example:** a restaurant charge pending at −48.20 posts at −55.00 with the tip. Cash went down by 103.20; the truth
  is 55.00.

## What changed

**One pairing rule, `pairPendingWithPosted`** (`lib/avalanche-core/src/pendingSupersede.ts`, pure). A posted row
replaces a pending row when **all** of these hold:
- same Plaid account; one row pending, the other posted;
- the posted row reached the ledger after the pending row;
- it is dated on the pending row's day or up to 7 days later (`SUPERSEDE_MAX_DAYS`);
- same sign, and |pending| ≤ |posted| ≤ 1.30 × |pending| + $1.00 (a tip, or a final amount above the hold, never
  below it);
- both have a real description (never empty or "(no description)"), and the descriptions are fuzzy-equal. The
  comparator is the dedupe pass's token-subset test, moved verbatim to `lib/avalanche-core/src/descriptionMatch.ts`
  and imported back by `dedupeTransactions.ts`.

Pairing is one to one. Posted rows pick in date order. Each takes the qualifying pending row with the **closest
amount**, then the **oldest**, because holds post oldest first.

**In the ledger** (`lib/forecastLedger.ts`, the one loop behind `bankToday` and the curve), the pending half never
counts. The posted half adds:

| Case | Posted row adds | Why |
|---|---|---|
| Posted and pending both held by the snapshot | 0 | The balance holds the charge — or, for a snapshot-day pair with no evidence of when it happened, PR4b's rule counts neither half (see Residuals). |
| Pending **charge** with evidence it was inside the balance (`pendingChargeWasInBalance`) | posted − pending (−55.00 − −48.20 = **−6.80**) | `available` held the pending amount, so only the tip is new. |
| Anything else | posted, in full | Neither was in the balance, or there is no evidence either was. |

**`pendingChargeWasInBalance`** (`lib/avalanche-core/src/snapshotInclusion.ts`) needs positive evidence, not only
`isInSnapshot`. All of these must hold:
- the row is not a deposit (`available` does not hold pending deposits);
- the snapshot rule holds the row;
- and the row is dated before the snapshot day, reached the ledger at or before the read, or has a real institution
  time at or before the read.

**A snapshot-day pending row with no such evidence** is held by PR4b's rule only because nothing shows when it
happened. It may have happened after the read, so its posting counts in full. This matches `main` and the linked
re-key path.

**A held posted row whose pending half is not held still counts.** The posted row reached the ledger after its pending
half and is dated on or after it, so it cannot be inside a balance that did not hold the pending half.

**Deviation from the plan.** The plan said "the pending row leaves cash". That is not enough: dropping a pending row the
snapshot already held changes nothing, and the posted row would still subtract the whole charge again. The table
above replaces it.

**With a snapshot, the actual-rows query reaches 7 days before the anchor**, so a pending row dated before the snapshot
day can be found. `isInSnapshot` holds every row dated before the snapshot day, so the extra days change nothing on
their own.

## Figures that should move

**Live**, wherever cash today is shown or used (`bankToday`, the curve and low point, the spine's bank balance). Only
pending/posted pairs the sync left unlinked are affected:
- **A double-counted charge:** cash goes **up** by the pending amount. If the balance held the pending charge, only the
  tip moves cash.
- **A double-counted pending deposit that was not held** (dated after the snapshot day): cash goes **down** by the
  deposit that was counted twice.
- **Unchanged:** every other row, and every household with no such pair. **No existing fixture holds a pair.** Golden,
  cash signal, household scenario, spine parity, bank-balance explain and forecast past rows all pass unchanged, and
  the golden snapshot file is untouched.

**Not measured:** how many unlinked pairs the household's ledger holds. The reviewer asks for a read-only production
count before merge. The production database is locked, so that needs Brad's approval.

## Residuals

**False pair — overstates cash by the dropped pending charge until it posts.**
- A real charge that is still pending gets paired with a *different* same-merchant charge that posted first, within
  7 days and 1.30× + $1.
- A re-keyed posted row keeps its own pending row's `created_at`, so it cannot pair with a pending row that reached the
  ledger *after* its own. Charges posting in order are safe. It can still pair with an *older* pending row that is still
  pending — the out-of-order case (R4).
- Descriptions are the sync's `merchant_name || name`. Short labels ("Amazon", "Uber", "PayPal", "Starbucks") are
  token subsets across different purchases.
- The +$1 slack lets a $3.00 charge pair with a $4.00 one.
- The reviewer reproduced 994.25 against a true 989.00.

**Snapshot-day pending charge, no evidence.** Its posting counts in full. If it was in fact authorised before the read
and only reached the ledger late, cash is understated by the pending amount. That is `main`'s behaviour and the
linked path's.

**A hold voided before the read (overstates).**
- A user-worked pending hold dated before the snapshot day, already released before the balance was read, is still
  treated as inside the balance. The rule assumes a pending row dated before the snapshot day was still pending at the
  read.
- If a different or re-billed same-merchant charge then posts within 7 days and 1.30× + $1, it counts only the
  difference, and cash reads too high by the hold.
- Reviewer's case A1: 950.00 against a true 750.00; `main` gives 750.00.
- It can't be told apart from the case this PR fixes without a schema change. Restaurant holds usually drop when the
  final amount posts; hotel and rental holds, often hundreds of dollars, are the risk.

**Both halves on the snapshot day after the read, with no evidence (overstates, as on `main`).**
- PR4b's rule holds snapshot-day rows that have no time. A pair that posts the same day counts 0.
- Reviewer's case A4: 1000.00 against a true 945.00. The same pair posting the next day counts in full (R2, 945.00).

**Contradicting times (understates).**
- A pending row with no time, or a time after the read, whose posted row carries a real time before the read: the
  posting counts in full.
- Reviewer's case A3: 945.00 against a true 993.20; `main` gives 951.80.

**Ranking by amount first** can pick an unrelated older pending row of exactly the posted amount over the true pending
row with a tip. The error is bounded by the amount gap.

**`current` anchor.** When Plaid returned no `available` and the snapshot used `current`, pending charges were not in
the balance, so "posted − pending" is too small a charge. The same happens with a typed-in balance that left pending
charges out. The source only records "plaid" or "manual", so this can't be detected.

**Missed pairs — understates cash, as before:**
- the posted amount is below the hold, over 1.30× + $1, or more than 7 days later;
- the descriptions don't match;
- the posted row reached the ledger before its pending row.

**Other surfaces:**
- `acceptedImpact` (`forecast.tsx`, "accepted") now takes only the tip for a matched posted row, and a matched pending
  row that was replaced drops out of it.
- Spending totals still count both halves (plan PR7).
- The web Chase page (`lib/accountBalance.ts`), "Why this number?" and the sync reconciliation still use their own
  rules (PR4e, in progress).
- Only Plaid rows pair.

## Must not change

- Every existing figure and test (no fixture holds a pair).
- `dedupeTransactions.ts` behaviour: the comparator moved verbatim, and its suite passes.
- The web app's code. The shared library gains modules, and the web suite and bundle guard were re-run.

## Tests

- **`lib/pendingSupersede.test.ts`** (11):
  - a tip pairs;
  - same day and +7 days pair, +8 doesn't;
  - never a posted row dated earlier, or one that reached the ledger first;
  - amount bounds: exactly 1.30× + $1, a cent over, a cent under, the other sign, deposits;
  - account, pending flag and description, plus the moved comparator;
  - rows with no description never pair;
  - one to one:
    - two equal pendings take the oldest;
    - the closest amount beats the nearest date;
    - the earlier posted row takes a lone pending row;
    - nothing qualifies.
- **`lib/snapshotInclusion.test.ts`** (+5, `pendingChargeWasInBalance`):
  - never a deposit;
  - a charge before the snapshot day;
  - snapshot-day evidence (arrival, real time) versus none;
  - never when the rule counts the row;
  - an ahead-dated charge the ledger had.
- **`__tests__/cashSignal.integration.test.ts`** (+12). Balance 1,000.00 read at 10:00 CT on 05-01; values are
  `bankToday` and `daily[0]`:
  - pending −48.20 with evidence, posted −55.00 the next day → **993.20**;
  - neither held → **945.00**;
  - pending dated before the snapshot day → **993.20**;
  - not a pair:
    - different merchant → **895.00**;
    - over 1.30× + $1 → **905.00**;
    - eight days apart → **896.80**;
  - review regressions:
    - a pending deposit held, posted the next day → **3000.00** (R1);
    - the same deposit dated before the snapshot day → **3000.00** (R1b);
    - a snapshot-day pending charge that reached the ledger after the read → **945.00** (R2);
    - a pending charge timed after the read, posted the same day with no time → **945.00** (R3);
    - both halves held → **1000.00**;
    - two pendings, the older posts → **930.00**.
- **Failing before:**
  - on `b93c01e` (`main`), the first three pairing tests fail;
  - on `4f2969c` (this PR before review), **5 of the 6 review regression tests fail**: R1, R1b, R2, R3 and the
    two-pendings case. The both-held test passes on both, as it should.

## Verification

- **Ledger-dependent API files:** 9 files, **150 pass**, 8 todo. The golden snapshot file is unchanged.
- **Full API suite:** **121 files, 929 pass, 8 todo** (916 at `4f2969c`, plus 13 tests).
- **Web suite:** **118 files, 917 pass**.
- **Workspace typecheck and build:** clean; workspace build exit 0.
- **Landing bundle guard:** 572.5 KB of 580, unchanged.

## Review

**First review of `4f2969c`: REQUEST CHANGES.** Every money finding was reproduced on a 1,000.00 balance.

| Finding | Done |
|---|---|
| HIGH H1: a pending deposit was subtracted from its posted row (R1, R1b: 1000.00 against a true 3000.00) | Only a pending **charge** can leave a difference. Two tests. |
| HIGH H2: a pending charge that happened after the read counted only as a tip, overstating cash (R2: 993.20 against 945.00) | A difference is taken only with evidence the pending charge was in the balance (`pendingChargeWasInBalance`). Test. |
| MEDIUM M1: a held posted row wiped out a charge whose pending half was not held (R3: 1000.00 against 945.00) | A held posted row is skipped only when its pending half is held too. Test, plus a both-held test. |
| MEDIUM M2: false pairs are wider than the note said (a newer pending row, short labels, +$1 slack, "(no description)") | "(no description)" and empty rows never pair. The residual is rewritten accurately. The production count needs Brad's approval. |
| LOW L1: the date tie-break took the newest pending row (R6) | Rank by closest amount, then oldest. Unit test and ledger test (930.00). |
| LOW L2: `current` anchor; LOW L3: arrival-order misses | Disclosed. |
| NITs: `acceptedImpact`; the figure direction for deposits; missing tests | Disclosed; the figures section is corrected; tests added. There is no no-snapshot ledger test: `heldBySnapshot` is always false there, so the posted row counts in full and the pending row is skipped. |

**Second look, `62c7db0`: APPROVE.** H1, H2, M1 and L1 hold under new cases. The reviewer's figures (1,000.00 read at
10:00 CT on 05-01):

| Case | `main` | `4f2969c` | `62c7db0` | Truth |
|---|---|---|---|---|
| R4 false pair (a different coffee posts first) | 989.00 | 994.25 | 994.25 | 989.00 (disclosed) |
| R5 held hold, later same-merchant charge | 975.00 | 995.00 | 995.00 | 995.00 |
| R6 two pendings, the older posts | 930.00 | 960.00 | **970.00** | 970.00 |
| A1 hold voided before the read, a different −250 later | 750.00 | 950.00 | 950.00 | 750.00 (disclosed) |
| A2 ahead-dated pending −40 the ledger had, posts −53 | — | 987.00 | 987.00 | 987.00 |
| A3 pending with no time, posted with a real time before the read | 951.80 | 1000.00 | **945.00** | 993.20 (disclosed) |
| A4 both halves on the snapshot day after the read, no evidence | 1000.00 | 1000.00 | 1000.00 | 945.00 (disclosed) |
| A5 pending deposit dated after the snapshot day, posted later | 5000.00 | 3000.00 | 3000.00 | 3000.00 |

- **Not blocking:** tightening the false-pair rule. A minimum token count would drop true pairs with short labels, and
  relative-only slack would miss small tips.
- **The gate for the false-pair risk** is the production count.
- **Corrected in this note:** the older/newer wording on re-keyed rows, plus residuals A1, A3 and A4 and the ranking
  side effect.

## Left for later

- **PR4d, still open:** backfill order around the balance read; an optional untouched-delete for an OLD/NEW re-mint pair;
  a time-evidence re-mint tie-break.
- **PR4e (in progress):** the explain route and the sync reconciliation onto the same per-row rule. The web Chase page
  moves in PR14.
- **PR7:** spending totals should not count both halves of a pair.
- **A read-only production count of unlinked pending/posted pairs**, if Brad approves.
