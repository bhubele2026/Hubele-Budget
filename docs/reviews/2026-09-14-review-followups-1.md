# Review follow-ups 1: signed caption, stale comments, paused-review actual, doc corrections

- **Branch:** `chore/review-followups-1`, off `main` = `df5d8b0b`.
- **Scope:** four small, independently-reviewed follow-up items (PR-B LOW, PR-B NIT, PR-C LOW, docs-only). No item
  touches a financial calculation, query, or stored value — items 1 and 3 are display/read-path fixes that change what
  a number reads as, never what it is; item 2 is comment wording; item 4 is documentation.

## What changed

### 1. PR-B LOW — the "Paid X of Y" caption showed signed figures

`artifacts/h2budget/src/pages/forecast/PlanDropRow.tsx`, the remainder caption (`data-testid="plan-remainder-paid-…"`,
added in round 4 of the match-evidence-tiers PR) rendered `formatCurrency(paidSoFar)` and `formatCurrency(row.amount)`
directly. For an expense (`row.amount` negative), that read **"Paid -$165.00 of -$180.00"** instead of **"Paid
$165.00 of $180.00"** — the review's own repro. `RemainderNote` (`probablyPaidText.tsx`) already wraps its own figure
in `Math.abs()` for exactly this reason; the caption now matches that convention:

```tsx
{formatCurrency(Math.abs(paidSoFar))} … {formatCurrency(Math.abs(row.amount))}
```

Display-only: `paidSoFar` and `row.amount` are unchanged, only how they're printed.

**Test:** `forecastProbablyPaid.test.tsx`, the "(round 4, HIGH) … with a 'paid X of Y' caption" test asserted
`toContain("$165.00")` / `toContain("$180.00")` — a substring check a leading "-" would still pass. Changed to one
exact-text assertion: `expect(caption.textContent).toBe("Paid $165.00 of $180.00")`.

I did not touch the sibling "partly paid" caption a few lines up (`plan-partial-paid-…`, `row.paidAmount` /
`row.plannedAmount`), which has the same latent sign issue for an expense — it wasn't named in this item, has its own
(substring) test using different figures ($1,000/$1,500), and fixing it wasn't asked for here. Flagging it as a
candidate for a future LOW.

### 2. PR-B NIT — "due today or later" wording, `remainder_assumed_unpaid`

The gate that reaches `remainder_assumed_unpaid` (`forecastLedger.ts`) is strictly **after** today — a plan due today
that's underpaid goes through `overdue_remainder_assumed_unpaid` instead (confirmed by tracing the `rawEffectiveDate
<= dragCutoffISO` branch above it, which is the only path to the `overdue_*` assumption; the `remainder_assumed_unpaid`
block is reached only when that condition is false). Four comments said "due today or later" / implied it via "future
or not-yet-due"; corrected to "due after today":

- the `paidByKey` comment (~line 1012–1020) also said `paidByKey` is read "only for plans due on or before today" —
  wrong since decision 13 round 4 added the read for future plans too (the block below); corrected to say both;
- the `remainder_assumed_unpaid` block's own comment (~line 1189);
- the `LedgerPlan.assumption` doc (~line 83);
- `lib/api-spec/openapi.yaml`'s `remainder_assumed_unpaid` description.

No logic changed. `pnpm --filter @workspace/api-spec run codegen` was re-run (the openapi.yaml comment text flows into
the generated Zod `.describe()` strings); committed `src`/`dist` in `lib/api-zod` and `lib/api-client-react`; a second
codegen run left the tree clean (idempotent).

### 3. PR-C LOW — Bills didn't read a paused bill's pending review

`artifacts/api-server/src/lib/billsSummary.ts`, `actualByItem` matched `status === "matched"` literally. A paused
one-time bill whose match went to `needs_review` (or a partial's `needs_review_partial`) before/while it was paused —
every other reader (`forecastLedger.ts`, `reviewCount.ts`, `routes/forecast.ts`) reads these through `readPausedReview`
as the user's last answer while paused — showed `actualAmount: "0.00"` on Bills the whole time it was paused, instead
of the matched amount.

Fix: `matchedRows` now also selects `needs_review` / `needs_review_partial` rows in the month window (plus `status`),
runs them through `readPausedReview` using `pausedItemIds` derived from the already-fetched `items` array (no new
query), then keeps only rows that normalize to `"matched"` before building `actualByItem` — the same rule the other
three readers already apply. A `needs_review_partial` normalizes to `"partial"`, which — like a live `partial`
resolution today — is not counted in `actualByItem`; that's unchanged, existing behavior, not something this fix
touches.

**Test:** new integration test in `oneTimeBillMove.integration.test.ts`, in the existing "round 4 (3) — pausing keeps
a review" describe block: a $300 one-time bill matched, moved (becomes `needs_review`), paused, resumed —
`billRow(id, month)?.actualAmount` is `"0.00"` while active-and-unresolved, `"300.00"` while paused, and `"0.00"`
again after resuming (the paused reading never sticks; nothing else about the bill's figures changes across the
pause/resume, matching the pre-existing pause/resume test in the same block that already checks `reviewCount`,
`signal()` and `bundleStatuses`).

### 4. Docs — corrections and additions to two prior review notes

- `docs/reviews/2026-09-11-seed-defaults-once.md` (PR-A2):
  - **e2e status:** noted it's opt-in behind `E2E_ENABLED` and was not run; identified, by reading each spec, the five
    `bills-*` specs (`bills-actual-vs-planned-indicator`, `bills-avalanche-locked-row`, `bills-month-picker-summary`,
    `bills-month-picker`, `bills-debt-payoff-celebratory-row`) and `forecast-probably-paid` that create a recurring
    item before the browser's first navigation to a categories-fetching page, so those households no longer get
    seeded under this branch; confirmed by grep that none of the six asserts a seeded category name.
  - **Residual 4:** added verified figures. I ran the scenario directly (a household with only a transaction and a
    debt, no marker, then a categories read plus a month read — the combination a real page load makes) against the
    test DB: **29 categories** (27 seeded + `Uncategorized` + the debt's own `auto_debts` category, both added by the
    month read), **21 bills**, **52 rules** — the full seed, same as an empty household's. (A categories read alone,
    with no month read, seeds the same 27/21/52 without the two auto categories — I checked both orders before
    settling on the figures that match "a household with only transactions and a debt got the full seed once".)
  - **Residual 3:** added that reproducing it against the running app needs an API-only client, or a page that never
    calls `useListCategories` (e.g. `/banking`, `/debts`, `/reports`) — the Bills page itself fetches categories on
    mount (same as Budget), so adding a bill through its own UI seeds the household first.
  - **Snapshot regen command:** added the `vitest … -u` invocation for `seedDefaultsOnce.integration.test.ts`'s two
    `toMatchFileSnapshot` base files.
- `docs/reviews/2026-09-11-match-evidence-tiers.md` (PR-B): added one sentence under the MEDIUM hold-back residual —
  round 4's future remainder drag means a misattributed occurrence can now carry a wrong dollar remainder, not only a
  wrong on/off-curve state, since the drag amount comes from the same misattributed pair's `txnAmount`.

No source changed for item 4.

## Figures that move

- Item 1: only the caption's own printed text (a display string), for any plan whose server pair set `remainderAmount`
  on an expense. No stored or computed value changes.
- Item 3: `GET /bills/summary` (and the Bills page) — `actualAmount` for a one-time bill that is BOTH paused AND has a
  pending review (`needs_review`) resolved as `matched` after `readPausedReview`. This is a strict fix toward
  agreement with the ledger/review-count/`/forecast` bundle, which already counted it. No change for any bill that is
  active, or paused without a pending review, or whose review resolves to `needs_review_partial`.
- Items 2 and 4: none (comments, generated description text, and documentation only).

## What must not change

- No query, calculation, or stored value in `forecastLedger.ts`, `billsSummary.ts`, or `PlanDropRow.tsx` beyond the
  exact lines above — verified by reading the diff back before running gates.
- Every other `billsSummary` figure (`monthlyAmount`, `nextOccurrence`, the `monthly.*` totals, debt-min rows) —
  unaffected, since only `matchedRows`'/`actualByItem`'s selection changed, nothing downstream of it.
- `overdue_remainder_assumed_unpaid` and every other `assumption` value's behavior — item 2 touched only the
  `remainder_assumed_unpaid` doc text and the `paidByKey` comment, never the gates that choose between them.
- Landing bundle weight — unchanged (574.4 KB of 580 KB, same as `main`; item 1 is a two-`Math.abs()` change with no
  new import).

## Verification

Worktree `/private/tmp/claude-501/build-fu1`, database `h2budget_test_fu1`.

| Gate | Result |
|---|---|
| `pnpm run typecheck` | exit 0 |
| Web suite, `TZ=UTC` | **139 files passed; 1148 passed, 3 skipped (1151)** |
| Web suite, `TZ=America/Chicago` | **139 files passed; 1149 passed, 2 skipped (1151)** |
| Full API suite (serial) | **145 files passed; 1474 passed, 7 todo (1481)** |
| `pnpm run build` | exit 0 |
| `node scripts/check-entry-graph.mjs` | OK — landing **574.4 KB** of 580 KB (unchanged) |
| Codegen (`lib/api-spec` changed) | re-run; `src`/`dist` committed; a second re-run left the tree clean |

**Fails-before** (source stashed via `git stash push -- <file>`, test kept, run, then popped back):

- Item 1 — `forecastProbablyPaid.test.tsx` (whole file) before the `Math.abs()` fix: **1 failed, 19 passed (20)** —
  `expected 'Paid -$165.00 of -$180.00' to be 'Paid $165.00 of $180.00'`.
- Item 3 — `oneTimeBillMove.integration.test.ts` (whole file) before the `billsSummary.ts` fix: **1 failed, 46 passed
  (47)** — `expected '0.00' to be '300.00'`.
- Item 2 is a comment/doc-only change with no behavior to fail; item 4 is docs-only.

## Residuals

- The sibling "partly paid" caption (`plan-partial-paid-…`, `row.paidAmount`/`row.plannedAmount`) has the same
  unsigned-display gap for an expense, not fixed here (see item 1).
- Everything already disclosed as a residual in the two prior review docs stays exactly as disclosed; this PR only
  added the requested clarifications and figures to them, and did not attempt to resolve any of them.
