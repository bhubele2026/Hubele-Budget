# PR-B2 — everyday hooks (decision 7), reimbursable precedence, biweekly paycheck fix

Branch `reinvent/prb2-hooks-paycheck` on `origin/main` `2faa9a8a` (PR-B1, PR-D, PR-A merged). Synthetic data only.
The law that binds every change: **the forecast may read low, never high**
(`docs/reviews/2026-09-15-holdback-proof-only.md`).

## The owner's decisions

- **Decision 7.** Allowances own the everyday reserve. The Weekly Spend / Monthly Spend bills become date
  hooks: the forecast replaces each occurrence with the card payoff (charges + remaining allowance).
  `keepsPreSnapshotRule` (PR6's temporary carve-out, "PR8 deletes this") is deleted.
- **2026-09-15, reimbursable.** "A reimbursable charge is its own row": `reimbursable` comes ahead of the
  allowance flags in `classifyMovement`.
- **PR9, the biweekly paycheck double count** (pin R2-2): fix it in the matcher, income pairs only, and prove
  no bill pair's tier or `offCurve` moves.

## The model rule in plain words

- A hook occurrence pays for the period that contains it: the Sunday–Saturday week (a Saturday hook = the
  week ending that day) or the calendar month.
- **Payoff = that period's charges on the cards billed at that cadence + what is left of the allowance while
  the period is open.** Every charge counts, filed or not (an unfiled charge is owed, and counts against the
  allowance). A card charge moves money from "left" to "charged", so the payoff holds; a checking debit
  tagged weekly already left the bank, so the payoff shrinks by exactly that debit.
- A **closed** period owes its charges alone. Due and unpaid, it lands on the **next business day**. It counts
  as paid only on evidence: a checking payment naming Amex that covers the payoff (at least the payoff less
  max($1, 1%); no upper bound — round 2), dated from the occurrence up to the next one. Anything else keeps it on the curve (low, never high) until Review confirms
  it. A Review answer (matched / skipped / missed / moved) works on a hook like on any plan.
- The hook item's stored amount is ignored; `GET /forecast/cash-signal` reports it as `hookAmountIgnored`
  (banner data, present only with a hook). No hook = no payoff: the bill stays a plain bill.
- The cap: `allowance_plans` (`everydayPlanFromRows`, week override honoured); no plan in effect →
  `settings.weekly_allowance_amount` / `monthly_allowance_amount`. (Round 2) Neither → the period has no
  allowance at all and the occurrence keeps the item's stored amount (never $0); such a hook is not in
  `hookAmountIgnored`.
- Paycheck: for an INCOME pair, a runner-up whose row (or plan) an earlier pair of the pass already took
  cannot be this pair's row (or plan), so it casts no doubt.

## What changed

| File | Change |
|---|---|
| `lib/avalanche-core/src/everydayHooks.ts` (new) | `readEverydayHooks`, `hookPeriodOf`, `payoffFor`, `payoffsPaidBy`, `nextHookOccurrence` — pure |
| `artifacts/api-server/src/lib/everydayHooks.ts` (new) | `readHookSettings`, `loadHookPayoffs`: charges via `computeWeeklyPayoff(…, { allCoverages: true })`, spent via `loadMoneyContext` + `classifyMovement` with the ledger's own tier-2 pairs (as the money position), cap via `allowance_plans` → settings |
| `forecastLedger.ts` | hooks read; hooks never enter the matcher; payoffs sized after the matcher; due payoffs paid on evidence (`overdueAssumedPaid`, confidence `card_payment`) or dragged to the next business day; `keepsPreSnapshotRule` and every call site deleted (`dragged_past_due` retired); `hookAmountIgnored`, `hookPayoffs` on the ledger |
| `amexAnchor.ts` | `computeWeeklyPayoff` gains `opts.allCoverages` (default false: the Amex page is unchanged) |
| `cashSignal.ts`, `openapi.yaml`, generated clients | `hookAmountIgnored?` (additive); assumption docs |
| `routes/settings.ts` | `everydayHooks` in `SERVER_OWNED_PREFERENCE_KEYS` |
| `lib/db/migrations/0042_everyday_hooks.sql` | one-time idempotent backfill (below) |
| `planMatch.ts` | the income-only ambiguity fix |
| `householdMoney.ts` | `reimbursable` ahead of the flags (step 3) |

**The backfill's match.** Per household, the owner's settings row gains
`everydayHooks = { weekly: {recurringItemId} | null, monthly: … }` from the ACTIVE recurring items named
exactly `Weekly Spend` / `Monthly Spend` (case and spacing exact; oldest by `created_at`, then id, if two).
A household with neither gets no key. A row that already carries the key is never touched; non-object
preferences read as `{}`. Pinned by the backfill test (exact names, a lowercase and a paused item ignored,
an existing key kept, a re-run writes nothing).

## Figures that move

| Fixture | Figure | Before | After | Why | Low-never-high |
|---|---|---|---|---|---|
| Household scenario S1, S2 | available until payday | 1,605.00 | 1,725.00 | the dragged $300 bill for the closed week becomes its $180 payoff | old value counted $120 that is not owed; = contract |
| S3, S4 | available | 1,225.00 / 1,180.00 | 1,525.00 / 1,480.00 | the $180 Amex payment pays the closed week; the $300 bill no longer drags | old value double counted a paid week; = contract |
| S5 | available (lowest date) | 1,177.60 (10/9) | 1,477.60 (Fri 10/9) | the same; the phone still counts on payday before the paycheck | = contract; the contract's date fixed from Thu 10/8 to Fri 10/9 (due today → next business day) |
| S6–S8 | available | 1,272.60 | 1,572.60 | the same | = contract |
| S9, S10 | available | 912.60 / 762.60 | 1,175.00 / 1,025.00 | one $337.60 payoff replaces two $300 bills | old value double counted; = contract |
| S1–S10 | expected Fri 10/16 | not asserted | 3,485.00 … 3,025.00 | switched on | = contract |
| `cashSignalProbablyPaid` R2-2 | balance 05-15 | 5,000.00 | 3,000.00 | the early paycheck no longer counts twice | lower |
| R2-2 outflow mirror (new) | balance 05-15, tiers | −1,000.00; 05-01 ambiguous tier 3; 05-15 held back | identical | income-only fix | unchanged |
| `cashSignalOverdue` weekly $300, no hook | 05-18 / ending / lowest | 700.00 / −500.00 / −500.00 | 400.00 / −800.00 / −800.00 | the carve-out is gone: 05-09 drags too | lower |
| Seed household A0–F2 (no hooks) | lowest, max safe, ending | e.g. A0 8,807.98 / 8,307.98 | each −900.00 | two unpaid $450 Weekly Spend occurrences in the last 14 days drag like any bill | lower |
| `availableToSpend` Q6 pin | reimbursable+weekly row: remaining | 665.00 | 700.00 | reimbursable leaves the allowance sum | allowance sum only; no cash figure moves |
| `spendingFactsClassifierParity` forward | reimbursable+weekly $35 | 35.00 | 0.00 | the same | forward mode only; no displayed figure |
| `budgetActuals` forward | reimbursable+weekly $25 bucket | weekly 25.00 | nowhere | the same; the `reimbursable_flagged` divergence class is gone (now equal to today) | forward mode only |
| Hooks integration T5 | payoff / remaining week | 250 / 185 (old order) | 275 / 210 | the reimbursable $25 is owed to Amex but leaves the allowance | payoff higher → curve lower |
| Golden (11 existing entries) | everything | — | byte-identical | no fixture has a weekly-cadence expense or a consumed-runner-up income pair | unchanged |

**Reimbursable on the fixtures:** the household scenario has no reimbursable rows: `spentWeek`, remaining,
unplanned, needs classification and position are unchanged at every step (asserted).

## Must not change — and the proof runs

- **`bankToday`, `reviewCount`:** asserted at every scenario step (cash, review count), in every hooks test,
  R2-2 and the mirror; spine parity suite green.
- **Any bill pair's tier / `offCurve`:** the fix is `!(income && takenEarlier(o))`, which is `true` for every
  outflow pair — the old predicate term for term. Shown by the two unit mirrors (row-taken and plan-taken
  shapes) and the integration mirror, all passing on the parent and on this branch; mutant M4 (fix applied to
  outflows) is caught by all three. Every hold-back, tier and probably-paid test is unchanged except R2-2.
  Hooks leave the matcher, so their own former pairs leave `matches`; no other pair changes (golden identical).
- **`payoffPct`, the single-flow rule:** untouched code; spine parity green.
- **Endpoint shapes:** only `hookAmountIgnored?` is added (OpenAPI, codegen without drift).

## Tests and fails-before

Red commit `35e0356f` run against the parent's implementation (tests only):

| File | Failed before / total | What |
|---|---|---|
| `everydayHooks.test.ts` (new) | 25 / 25 | the pure rule did not exist |
| `everydayHooks.integration.test.ts` (new) | 12 / 13 | T1–T10, server-owned key, backfill (T11 paused hook: a guard, passes before) |
| `householdScenario.integration.test.ts` | 10 / 10 steps | lowest/available read the PR-B1 pins; expected 10/16 newly asserted |
| `planMatch.test.ts` | 2 / 67 | the two income cases; the two outflow mirrors pass before (by design) |
| `cashSignalProbablyPaid.integration.test.ts` | 1 / 36 | R2-2 (the mirror measured −1,000.00 on the parent, now its pinned value) |
| `cashSignalOverdue.integration.test.ts` | 2 / 15 | the carve-out's figures |
| `householdMoney.test.ts` | 5 / 51 | reimbursable ahead of flags ×4, the property model |
| `budgetActuals.test.ts` | 2 / 16 | the class list, the forward pin |
| `spendingFactsClassifierParity.integration.test.ts` | 1 / 18 | forward 35 → 0 |
| `availableToSpend.test.ts`, seed tiers (10), golden new entry | fail before | the Q6 flip its comment demanded; −900; no hook output |

Added after the red run: T5b (an unfiled card charge is owed), caught by mutant M9.

## Mutants (13, all caught)

| # | Mutant | Caught by (named tests) |
|---|---|---|
| M1 | hook amount not ignored (stored $300 used) | T1–T9, scenario S1–S10 (20 tests) |
| M2 | due payoff dated on its own day, not the next business day | T1, T2…, scenario (8) |
| M3 | remaining not reduced by spending (weekly-tagged debit not subtracted) | T2, unit S4, scenario (18) |
| M4 | paycheck fix reaches outflow pairs | both unit mirrors, the integration mirror |
| M5 | reimbursable still counted under its flag | householdMoney ×4, availableToSpend flip, T5 (7) |
| M6 | closed period still adds the remaining allowance | unit "closed period", T1, scenario S1 (21) |
| M7 | any Amex payment pays, whatever its amount | T7, unit "within max($1, 1%)" |
| M8 | item start date applied to a hook (closed week dropped) | T1…, scenario S1–S2 (11) |
| M9 | unfiled card charges left out (Amex page rule) | T5b, T1… (10) |
| M10 | no fallback to settings.weekly_allowance_amount | T9 |
| M11 | everydayHooks not server-owned | "a settings PUT can neither write nor clear it" |
| M12 | a paid payoff leaves the curve silently | T6 |
| M13 | the paycheck fix reverted | R2-2, both income unit tests |

## Gates

- `pnpm run typecheck`: 0. Codegen: regenerated, 0 drift after commit.
- Classic web suite, 4 TZs: UTC 1,249 passed / 3 skipped; Chicago, New York, Los Angeles 1,250 passed / 2
  skipped. H2 web: 315 passed / 2 skipped.
- API suite (serial, `h2budget_test_prb2`, `CI=true`): 2,216 passed, 0 failed, 2 todo (2,218 tests, 205 files).
- Golden under `CI=true`: 12 / 12 — regenerated once (`-u`): 1 entry written, 0 lines removed; the 11 existing
  entries byte-identical.
- `pnpm run build`: 0; entry graph: classic 576.1 KB / 580 KB, H2 390.8 KB / 400 KB.
- `pnpm audit --prod`: exit 0 (the one high is the repo's existing ignore).

## Residuals

1. *(Closed in round 2: a hook with no allowance at all keeps its stored amount.)*
2. **Payment evidence is Amex-named and must cover the payoff.** A household that pays less, pays before the
   Saturday, or a week late reads low until Review confirms; so does a payment whose bank description does
   not name "Amex"/"American Express". Since round 2 a larger payment (a Blue or full-statement payment in the
   same window) pays the week — the lead's ruling; the oldest due week takes the earliest covering row.
3. **Old unpaid payoffs are dropped after 14 days** (as weekly bills were before); listing them is a later
   package (lead's ruling, round 2).
4. **A non-Saturday weekly hook** pays for the week that contains it; a Tuesday hook meant as "last week's
   payoff" would size the current week. The seed and the scenario use Saturdays.
5. **A monthly hook dated before month end** (the 28th) sizes its whole calendar month; charges on the 29th–31st
   fall in that month's payoff, already past.
6. **Weekly bills that are not hooks** now drag when unpaid (reads lower: −$900 on the seed household without
   hooks). In production, 0042 hooks the exactly-named items; any other weekly reserve bill drags.
7. **Hooks are only set by 0042.** A household created later, or one that renames its items, has no hook until
   a route lets the owner choose (none in this package).

## Questions for the owner

Round 1 asked three; the lead ruled in round 2 (owner unavailable), below. None remain open.

## Round 2 (lead's rulings, 2026-10-07)

| Q | Ruling | Change | Test (fails on round 1) |
|---|---|---|---|
| 1 | No allowance at all (no plan row in effect, settings $0) → the hook keeps the item's stored amount, never $0 | `loadHookPayoffs`: cap `null` → `amountCents = stored`, `fromStoredAmount: true`; such a period is not sized from the card; `hookAmountIgnored` omits a hook whose every sized occurrence kept its stored amount | T9b: 09-26 and 10-03 each −300.00 dragged to Thu 10/8, 10/10 and later −300.00, no banner (round 1: −120.00 / −40.00 / $0) |
| 2 | A payment that covers the week or MORE pays it; smaller than owed (past max($1, 1%)) does not | `payoffsPaidBy`: paid cents ≥ payoff − tolerance, no upper bound | unit "covers the payoff or MORE" (−400 and −181.80 pay; −178.19 and −100 do not); T7b: −150.00 pays the $120 week (round 1: stayed on the curve); T7 (−100) still does not |
| 3 | Not now | residual 3 reworded | — |

**Figures that move in round 2:** only the no-allowance fixture (T9b, new). The household scenario, the
golden (12 entries, byte-identical to round 1) and every other fixture have an allowance or no hook, and no
covering-more payment, so nothing else moves. Low-never-high: Q1 reads lower than round 1 (stored $300 where
round 1 put $120 / $40 / $0). Q2 reads higher than round 1 only when a larger Amex payment lands in the
week's window — the ruling accepts that a full-statement payment pays the week.

**Mutants added:** M14 "no allowance → $0" (round 1's rule) — caught by T9b; M15 "upper bound restored" —
caught by T7b and the unit test (the round-2 fails-before run above is exactly these two).

**Round 2 gates.** `pnpm run typecheck` 0 · codegen drift, CI style (`lib/api-zod/dist`,
`lib/api-client-react/dist` and both `tsconfig.tsbuildinfo` deleted, regenerated): no diff, no untracked
file · API suite 2,218 passed, 0 failed, 2 todo (2,220 tests, 205 files; round 1 + T7b, T9b) · golden under
`CI=true` 12 / 12, no regeneration · `pnpm run build` 0; entry graph OK for both apps.
