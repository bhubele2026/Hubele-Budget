# Review follow-ups, round 2 — six small leftovers from R0 and PR-K

Branch `chore/review-followups-2` off `main` `9aad7638`. Web-only. Six independent items carried over from
`2026-09-14-nav-five-destinations.md` (R0) and `2026-09-14-cashflow-card-forecast-calc.md` (PR-K). No route, financial
calculation, query shape, or stored value changed — items 1 and 6 are test-only; items 3, 4 and 5 are copy/cache-key
UI fixes; item 2 adds one cache-reconciliation module. All names/numbers in tests are synthetic.

## 1. R0 — the phone drawer must close after you navigate

**Finding.** `DrawerLink`'s `onClick={onNavigate}` (`layout.tsx:265`) is the only thing that sets `mobileOpen` back to
false. Nothing exercised it: `appShell.test.tsx`'s drawer tests open the drawer and read its links, but none of them
click one and check what happens next. wouter's own `<Link>` attaches its own click handler regardless of whether a
caller passes one, so deleting the wiring leaves navigation working — only the drawer stays open over the new page.

**What changed.** `appShell.test.tsx` gained `mountRecording(path)` (same as `mount`, but with wouter's
`memoryLocation({ record: true })` so the resulting `history` array proves a click actually navigated) and a new
describe block, "R0 follow-up — the phone drawer closes after you navigate":

- clicking a nested page link (`mobilenav-budget`) inside the open drawer closes the dialog and pushes `/budget`;
- clicking a destination row itself (`mobilenav-forecast/overview`) does the same.

**Proof.** Removing `onClick={onNavigate}` from `DrawerLink` and re-running just this block: both tests fail —
`expected null but got <dialog>` — while navigation (`history[history.length-1]`) still updates, exactly the failure
mode the task described. Restored afterward and verified identical to the pre-mutation file.

## 2. PR-K LOW — horizons could disagree for up to 5 minutes

> **Superseded in round 2 (M1) — DROPPED.** The review proved this watcher loops: look-back windows legitimately
> return a different `bankToday`, so ordinary use re-triggers it continuously. The module, its test, and its `App.tsx`
> wiring were removed in full. See [Round 2](#round-2--independent-review-response) below for the fetch-count proof
> and the R4 direction. Everything in this section describes what was built and then removed — kept for the record,
> not as a description of what shipped.

**Finding.** The Forecast page's 30-day tab and the Cash flow card's 90-day request cache under different keys
(`["/api/forecast/cash-signal", { horizonDays: 30 }]` vs `{ horizonDays: 90 }`), each with its own 5-minute
`staleTime` (`App.tsx`'s `FORECAST_CACHE`). The server computes both with the identical `computeCashSignal` call, so
after a background bank sync the two entries could each stay "fresh" with two different balances for the same day —
the PR-K round 2 residual ("Only the 90-day tab shares the card's key... After a webhook sync, the 30-day tab and the
card can still sit on two copies for up to the 5-minute staleTime").

**Fix.** New module `src/lib/cashSignalFamilyInvalidation.ts`:

- `watchCashSignalFamily(queryClient)` subscribes to the `QueryCache` once. On every `{ type: "updated", action:
  { type: "success" } }` event whose query key starts with `/api/forecast/cash-signal`, it calls
  `reconcileCashSignalFamily`.
- `reconcileCashSignalFamily` fingerprints the arrived response (`bankToday` + `snapshotAt` — the two fields decision
  16 promises are identical across every horizon/from-date at a given instant) and compares it against every OTHER
  cached cash-signal entry with data. One whose fingerprint disagrees is invalidated with
  `queryClient.invalidateQueries({ queryKey, exact: true })` — the same call the spine's mutation-cache rule already
  uses, so a mounted page refetches immediately and an unmounted one just gets the right answer next time it opens.
- Wired into `App.tsx` at module scope, next to the existing `setQueryDefaults` calls for this same key — one place,
  not per page, per the task's preference.

**No loops.** An entry whose fingerprint already agrees with the one that just arrived is left untouched, and an
already-invalidated entry is skipped too — so the only way this fires twice for the same pair is a genuine third
change in the underlying data, never the reconciliation itself. The loop also explicitly skips the query that just
arrived as a second, belt-and-braces line (in practice redundant here, since that query's own freshly-written data
always trivially agrees with itself under the string/nullable fingerprint fields this file compares — see the
mutation notes below).

**Tests** (`cashSignalFamilyInvalidation.test.ts`, 11 tests) use a real `QueryClient` and `qc.setQueryData(key, data)`
to stand in for a real fetch response "arriving" (`setQueryData` dispatches the identical `{ type: "updated", action:
{ type: "success" } }` cache event a real fetch does):

- a newer 90-day response marks a stale 30-day entry invalid;
- the entry that just arrived is never itself invalidated;
- matching responses cause no invalidation;
- an unrelated key (`/api/forecast`) is never touched;
- **no refetch loop**: after the 90-day arrival invalidates the 30-day entry, the 30-day entry "refetching" and
  coming back in agreement calls `invalidateQueries` **zero additional times** (asserted via `vi.spyOn` call count)
  and leaves the 90-day entry untouched;
- an empty family, and a malformed payload (no `bankToday`/`snapshotAt`), do nothing;
- unsubscribing stops the rule.

**Proof this is load-bearing, not vacuous.** Removing the fingerprint-agreement skip (rule 2) turns 3 of the 11 tests
red, including "no refetch loop" (`invalidateQueries` called when it shouldn't be, and not called when it should).
Removing the redundant self-skip (rule 1) alone changes nothing — confirmed by mutating it and re-running: all 11
still pass, because the arrived query's own just-written data always trivially agrees with itself under rule 2. The
JSDoc says this plainly rather than claiming a second independent rule that testing didn't bear out. The module is
new, so it does not exist on `9aad763` at all; both mutations were restored afterward and the file verified identical
to its final version with `diff`.

## 3. PR-K NIT — the unresolved-account title was misleading for a manually tracked household

> **Superseded in round 2 (NIT) — REVERTED.** "Balance entered by hand" also shows for a Plaid-linked household with a
> manual snapshot and 2+ checking accounts, where Plaid rows ARE excluded from the curve — this page can't tell that
> case apart from a fully manual household with the data it has. The wording reverted to "bank account not
> identified" universally; only the doc-comment and test-name corrections (the false "stays at the raw snapshot"
> claim) survived. See [Round 2](#round-2--independent-review-response).

**Finding.** When no bank account resolves (`via: "unresolved"`), manual rows still move the curve (`isBankRow`,
`lib/avalanche-core/src/cashRows.ts:66-77` — a row with no Plaid account id counts unless its source names a card),
but `cashFlowCardTitle` read "bank account not identified", which sounds like an error rather than the household's
own choice to track by hand. The function's doc comment and one test name repeated the same wrong claim: "the balance
stays at the raw snapshot" — false, since only Plaid-sourced rows are excluded when unresolved; manual entries are
not.

**What changed** (`CashFlowPage.tsx`): `cashFlowCardTitle` now takes `snapshotSource` too. In the `unresolved`
branch, `snapshotSource === "manual"` reads **"Forecast · balance entered by hand · next 90 days"**; any other
snapshot source keeps the existing **"Forecast · bank account not identified · next 90 days"** (a genuine gap, not a
household's choice). The doc comment above the function was corrected to describe both branches accurately, and the
misleading phrase was removed everywhere (comment and test name).

**Tests** (`cashFlowForecastMissing.test.tsx`): the existing "no account resolved" test was renamed ("...and the
snapshot isn't manual (a genuine gap, not a household's choice)") and now passes `snapshotSource: "plaid"` explicitly;
a new test covers `snapshotSource: "manual"` and asserts the calm wording. Every other `cashFlowCardTitle` call in
this file now supplies `snapshotSource` (required by the widened signal type).

**Proof it fails on `9aad763`.** Swapped in the baseline `CashFlowPage.tsx` and ran just the new test: `AssertionError:
expected 'Forecast · bank account not identified...' to be 'Forecast · balance entered by hand...'`. Restored and
verified identical to the working copy with `diff`.

## 4. PR-K NIT — the Forecast page's own "Bank balance" card used the stored snapshot label

> **Corrected in round 2 (L2).** Name and mask each fell back to the stored snapshot INDEPENDENTLY, which could mix a
> resolved account's name with the OLD account's mask (or vice versa) whenever the resolved account had a null field.
> Fixed to read one source's name+mask as a pair. See [Round 2](#round-2--independent-review-response).

**Finding.** `forecast.tsx`'s "Bank balance" card read `data.bankSnapshot.name`/`.mask` — whatever the settings row
stored when the snapshot was last **set**. Once a broken pointer is recovered onto a different account (a mask match,
or "the household's only checking account" — `resolveSnapshotAccount.ts`), the figures are already right (they come
from the resolved account's rows), but the card kept naming the old one.

**What changed.** Two derived values, `bankAccountName`/`bankAccountMask`, prefer `cashProjection.account` (the same
`cashSignal.account` the Cash flow card's title already reads) whenever it resolved to a concrete account
(`via !== "unresolved"`), falling back to the stored `bankSnapshot.name`/`.mask` only when nothing resolved — there is
nothing better to show then. The JSX now reads these two values instead of the stored fields directly.

**Tests** (`forecastAccuracy.test.tsx`, new describe block): a fixture where the stored snapshot names "Old Checking
••9999" but the cash signal resolves "New Checking ••1234" — covered for both `via: "sole checking"` and
`via: "snapshot mask"` — asserts the card shows the resolved name/mask and never the stored one; a third test confirms
the stored label is still shown when nothing resolves (`via: "unresolved"`).

**Proof it fails on `9aad763`.** Swapped in the baseline `forecast.tsx` and ran the two mismatch tests: both fail
(`expected 'Plaid · Old Checking ••9999...' to contain 'New Checking ••1234'`); the fallback test still passes
unchanged (that behavior didn't move). Restored and verified identical with `diff`.

## 5. PR-K NIT — opening look-back sent the browser's date before one was chosen

> **Corrected in round 2 (L1, and a UI NIT).** The `fromDatePicked` restore logic below was undone by a remount:
> opening look-back without picking, then navigating away and back (or reloading), sent the date again. Also, the
> date input's default/`max` used the browser's day instead of the household's. Both fixed — see
> [Round 2](#round-2--independent-review-response).

**Finding.** Opening the "LOOK BACK" panel pre-fills the date input with `forecastFromDate` (already `todayISO()`,
the browser's own calendar day, on first use) so the field isn't blank — but the query immediately started sending
that date as `fromDate`, forking a second cache entry keyed on the browser's own day. This is the same class of bug
M1 already fixed for the closed-panel case (a browser outside the household's timezone asking for its own day instead
of leaving `fromDate` out).

**What changed.** A new `fromDatePicked` boolean tracks whether the date was **actually chosen** — set `true` only by
the date input's own `onChange`, or restored `true` on mount when a prior session had genuinely persisted one
(mirrors the existing `forecastFromDate` restore logic). The query now sends `fromDate` only when
`lookbackOpen && fromDatePicked`; closing the panel resets both the date and the picked flag, so reopening starts
unpicked again.

**Tests** (`forecastCashSignalKey.test.tsx`): opening look-back alone still resolves to `{ horizonDays: 90 }` (no
`fromDate`); typing into the date input then sends `{ horizonDays: 90, fromDate: "2026-05-01" }`; closing after
picking and reopening returns to the unpicked, dateless key.

**Proof it fails on `9aad763`.** Swapped in the baseline `forecast.tsx` and ran the three new tests: all three fail,
e.g. `expected { horizonDays: 90, fromDate: "2026-09-15" } to strictly equal { horizonDays: 90 }` (today's real date,
sent immediately on open). Restored and verified identical with `diff`.

## 6. PR-K NIT — tests couldn't see a cache key forked through hook options

**Finding.** The generated `useGetForecastCashSignal(params, options)` resolves its real query key as
`options?.query?.queryKey ?? getGetForecastCashSignalQueryKey(params)` — an explicit second argument always wins.
Every existing test mocked the hook to record only `params`, so a future call site that added
`{ query: { queryKey: [...] } }` would silently fork the cache and no test would notice.

**What changed.** In both `forecastCashSignalKey.test.tsx` (the Forecast page) and `cashFlowForecastMissing.test.tsx`
(the Cash flow card), the `@workspace/api-client-react` mock now uses `importOriginal` to pull in the **real**
`getGetForecastCashSignalQueryKey`, and the mocked `useGetForecastCashSignal` records the actual resolved key
(mirroring the generated hook's own precedence) into a new `calls.keys` / `q.cashSignalKeys` array. New tests assert
that resolved key equals `["/api/forecast/cash-signal", { horizonDays: N }]` for the Forecast page's 90-day and
30-day cases and for the card.

**Proof — passing `{ query: { queryKey: [...] } }` fails it.** Mutated both call sites to pass
`{ query: { queryKey: ["/api/forecast/cash-signal", "MUTATED"] } }` as a second argument:

- Forecast page: the 2 new key-resolution tests fail (`"MUTATED"` where `{ horizonDays: N }` was expected); the other
  8 tests in the file — the ones checking only `params` — still pass, which is exactly the blind spot this closes.
- Cash flow card: the 1 new key-resolution test fails the same way; the other 22 tests in the file still pass.

Both mutations were restored afterward and verified identical to the working copy with `diff`. This item doesn't
need to fail on `9aad763` (nothing there passes hook options today) — the task allows a mutation demonstration
instead, per its own wording.

## Gates (round 1 — see [Round 2](#round-2--independent-review-response) for the final numbers)

- **`pnpm run typecheck`:** exit 0 (singleton-deps check, all 9 workspace packages, `typecheck:e2e`).
- **Web tests, `TZ=UTC CI=true pnpm --filter h2budget exec vitest run`:** **142 files, 1258 passed, 3 skipped.**
- **Web tests, `TZ=America/Chicago CI=true pnpm --filter h2budget exec vitest run`:** **142 files, 1259 passed, 2
  skipped** (the 1/2 skip split is the same pre-existing TZ-dependent gating noted in prior review rounds).
- **`pnpm run build`:** exit 0 (`api-server` + `h2budget`).
- **`node scripts/check-entry-graph.mjs`:** **576.5 KB raw / 173.7 KB gz**, budget 580.0 KB — **3.5 KB headroom**, up
  +0.8 KB from the prior round's 575.7 KB (the new `App.tsx` import + one-line subscription call, and the widened
  `cashFlowCardTitle` signal type). No recharts on the open path; react-dom confined to `vendor-react-*`.
- **API suite:** not run — no API, spec, or DDL change in this PR.

## What must not change (and didn't)

- No file under `lib/db`, `api-server/src/lib`, or any `computeCashSignal`/`resolveSnapshotAccount`/
  `buildForecastLedger` calculation was touched — items 3, 4 and 5 read existing response fields (`account`,
  `snapshotSource`) differently; they compute nothing new server-side.
- `lib/avalanche-core/src/cashRows.ts` (`isBankRow`) — read for item 3's reasoning, not edited.
- No OpenAPI spec, DDL, or dependency change; no codegen re-run.
- Design laws unchanged: no new colors, fonts, or classes — items 3-5 are copy/derived-value changes inside existing
  markup; item 2 has no UI surface; item 1 and item 6 are test-only.
- `Send-to-Forecast`/spine/single-flow rules untouched.

## Skipped (round 1 record — see Round 2 below)

Nothing was skipped in round 1 — all six items were implementable simply within the stated constraints. Item 2 came
closest to the "stop if it can't be done simply" line; the design that shipped is one `QueryCache` subscription plus
one pure comparison function, with the no-loop property following directly from "skip when the fingerprints already
agree" rather than from anything bespoke per call site.

**This was wrong.** The independent review proved the watcher loops under realistic use. Item 2 is dropped as of
round 2 — see below.

## Residuals (round 1 record — see Round 2 below)

- ~~Item 2 only reconciles entries that are already **cached with data**...~~ Moot — item 2 is dropped as of round 2.
- Item 4's fallback path (nothing resolves) still shows the stored label, unchanged — there is no better source in
  that case, consistent with item 3's title falling back to plain "bank account not identified" text rather than a
  name (round 2 reverted the "balance entered by hand" branch — see below).
- E2e was not run (same prerequisite gap as prior rounds: no Clerk test keys in this environment); nothing in this PR
  touches e2e specs.

## Round 2 — independent review response

The independent review of `52372b6` returned REQUEST CHANGES: 1 MEDIUM, 4 LOW, 3 NIT. Base merged forward to
`origin/main` `f96afb18` (PR-H, household money core — server-only, no conflicts, no overlap with this branch's files)
before addressing the findings. All names/numbers below are synthetic.

### M1 — DROPPED: the cash-signal watcher loops

**Finding.** Look-back windows legitimately return a different `bankToday`: the ledger loads rows only through
`max(toISO, todayISO)`, while `classifyCashRows` needs `today+7`. So a look-back horizon's response can genuinely,
correctly disagree with a same-day horizon's — not staleness, a real difference in what each request asked for. Once
that happens, every sibling arrival re-invalidates the other, forever:

- with two mounted family observers: **54–56 requests in 300 ms**, against 2 expected;
- one look-back page with 10 nav hovers: **22 requests**, against 2 expected.

**What changed.** `src/lib/cashSignalFamilyInvalidation.ts`, its test, and the `watchCashSignalFamily(queryClient)`
call + import in `App.tsx` were removed in full. `grep -rn "cashSignalFamilyInvalidation\|watchCashSignalFamily"
artifacts/h2budget/src` finds nothing.

**What this means for the original gap.** The up-to-5-minute cache-age disagreement between horizons (the PR-K round
2 residual item 2 was trying to close) is back to exactly what it was on `main` before this branch — not made worse,
not fixed. A real fix needs to not treat "the two windows legitimately compute different rows" as "the two windows
disagree and must reconcile."

**R4 direction (for whoever picks this up next), per the lead's decision:** one FORWARD cash-signal key — fetch the
longest horizon once, then slice it in the client for every shorter tab/card that needs a prefix of the same window,
instead of each horizon issuing its own request. That removes the whole family of "two windows, two truths" bugs
(this one included) by construction, since there is only ever one server request and one cached answer for the
forward-looking curve. Look-back (a different anchor date, not just a different length) is a separate axis and keeps
its own key.

### L1 — item 5 was undone by a remount

**Finding.** `fromDatePicked`'s round-1 init read `wasOpen && !!stored` (`forecast.tsx`, then lines ~268-276). But the
effect that persists `forecastFromDate` writes SOME value — the unpicked default, the browser's/household's today —
to that same sessionStorage key on every mount, regardless of whether anything was picked. So: open look-back,
DON'T pick a date, navigate `/forecast` → `/review` → back (or reload) — the next mount sees `wasOpen: true` plus a
truthy stored value and wrongly concludes a date HAD been picked, sending it again.

**What changed.** The picked flag now lives in its OWN sessionStorage key (`FORECAST_FROM_PICKED_KEY`,
`h2budget:forecastFromDatePicked`), set to `true` only by the date input's own `onChange`, and restored across a
reload/remount strictly from that key — never inferred from "there happens to be a stored from-date". Both
`fromDatePicked`'s init and `forecastFromDate`'s "honor a stored date" branch now gate on it. Closing the panel resets
both keys together, as before.

**Test.** `forecastCashSignalKey.test.tsx`, "opening look-back WITHOUT picking a date, then remounting (nav away and
back, or a reload), still sends no date": opens look-back, asserts `{ horizonDays: 90 }`, then `cleanup()` (unmount;
sessionStorage survives, exactly like a real nav-away) + a fresh `renderPage()` (the remount), and asserts the params
are STILL `{ horizonDays: 90 }` — no `fromDate`.

**Proof it fails on `52372b6`.** Swapped in `52372b6`'s `forecast.tsx` and ran just this test:
`expected { horizonDays: 90, fromDate: "2026-09-15" } to strictly equal { horizonDays: 90 }` (today's date leaking
back in on the remount). Restored and verified identical with `diff`.

**Fixture fallout (pre-existing tests, not new bugs).** Five existing test files simulated "a prior session already
picked and persisted a from-date" by seeding only the OLD sessionStorage keys (`forecastFromDate` +
`forecastLookbackOpen`), which no longer proves a pick under the new contract. Updated each to also seed
`h2budget:forecastFromDatePicked: "true"`: `forecastCashSignalKey.test.tsx` (2 tests: "an open look-back still sends
its start date", "closing look-back drops the date"), `forecastMinFromDate.test.tsx` (2 tests), `forecastBigBillJump.
test.tsx`, `forecastFromAndMonthSwitchPerf.test.tsx`, and `forecastHorizonSwitchPerf.test.tsx` (one `beforeEach` each).
None of these had their assertions changed — only their setup, to match the corrected persistence contract. Confirmed
this was the full set: the round 2 full-suite run was clean (0 unexpected failures) after these five fixture updates.

### L2 — item 4 mixed two accounts in one label

**Finding.** `plaid_accounts.name` and `.mask` are both nullable. The round-1 fix read them from the resolved account
INDEPENDENTLY, each falling back to the stored snapshot's own field on its own:

- **R4a:** a sole-checking account with a null mask rendered "New Checking ••9999" — its own (correct) name, paired
  with the OLD account's mask.
- **R4b:** a resolved account with a null name rendered "Old Checking ••1234" — the OLD account's name, paired with
  the new (correct) mask.

Both mint a label that names no real account.

**What changed.** New helper `pairedAccountLabel(account, fallback)` in `forecast.tsx`: once an account resolves
(`via !== "unresolved"`), its name and mask are read together, as a pair, never mixed with the stored snapshot's
fields. A null mask on the resolved account means no mask is shown (not the old one); a null name on a resolved
account reads the neutral label `"bank account"` (matching `cashFlowAccountLabel`'s own neutral fallback in
`CashFlowPage.tsx`), never the old account's name. Only when nothing resolves does the stored snapshot's name/mask
pair get used, also as a pair (unchanged from round 1).

**Tests** (`forecastAccuracy.test.tsx`, two new cases in the same describe block):

- R4a: resolved account `{ name: "New Checking", mask: null }` against a stored snapshot `{ name: "Old Checking",
  mask: "9999" }` — asserts "New Checking" shows and "9999" does not appear anywhere.
- R4b: resolved account `{ name: null, mask: "1234" }` against the same stored snapshot — asserts "Old Checking" does
  not appear and "••1234" does.

**Proof it fails on `52372b6`.** Swapped in `52372b6`'s `forecast.tsx` and ran both: R4a fails (`expected 'Plaid · New
Checking ••9999 · ...' not to contain '9999'`), R4b fails (`expected 'Plaid · Old Checking ••1234 · ...' not to
contain 'Old Checking'`) — exactly the two mixed-account bugs the finding named. Restored and verified identical with
`diff`.

### NIT — item 3 wording reverted

**Finding.** "Balance entered by hand" also shows for a Plaid-linked household that has a manual snapshot and 2+
checking accounts — there, `resolveSnapshotAccount`'s "sole checking"/"sole depository" steps can't pick uniquely
between them, so it falls through to `unresolved` too, but Plaid rows ARE excluded from the curve in that case
(`isBankRow`, `cashRows.ts:71-72`), so bank activity genuinely doesn't move it. `CashFlowPage.tsx` doesn't fetch a
list of linked accounts (round 1's own L2 removed that fetch) or an account count, so it has no reliable way to tell
"fully manual household" apart from "ambiguous multi-account household with a manual snapshot" — both are
`snapshotSource: "manual"` + `via: "unresolved"`.

**What changed.** Reverted the wording branch: `unresolved` always reads "Forecast · bank account not identified ·
next N days" again, regardless of `snapshotSource`. `snapshotSource` was dropped from `cashFlowCardTitle`'s parameter
type (unused now). Kept: the corrected doc comment (removing the false "the balance stays at the raw snapshot" claim
— manual rows still move the curve regardless of whether an account resolved) and the corrected test name (no longer
claiming that either), now further reworded to "a gap this page can't attribute to a cause" to name the real
ambiguity honestly. The round-1 "manually tracked household" test was removed along with the wording it tested.

**Also fixed:** the leftover "and there are none to exclude" phrase in the doc comment (a holdover from the belief
that a manual household has literally zero Plaid rows to exclude, which doesn't generalize to the ambiguous
multi-account case above).

**Proof.** The renamed test passes on both the current code and on `52372b6` (confirmed by swapping in `52372b6`'s
`CashFlowPage.tsx` and running it) — this is a revert to simpler, more honest behavior, not a new bug fix, so there is
no "fails before" to demonstrate.

### NIT — item 5 UI: the date input used the browser's day

**Finding.** With the look-back panel open and no date picked, the date input's default value and its `max` bound
both came from `todayISO()` (the browser's calendar day), not the household's. The register's own "already happened"
cutoff (`todayIso` at `forecast.tsx` ~line 762, feeding `filterForecastTxns`) has the same issue and is a separate,
already-flagged residual (PR-K round 2: "The register's filter still uses the browser's day... It filters rows, not a
figure") — left exactly as is, per the lead's instruction.

**What changed.** The look-back panel's three "today" call sites — the `forecastFromDate` state's unpicked-default
initializer (both the try and catch branches), the close-handler's reset, and the date input's `max` prop — now call
`householdToday()` (from `@/lib/householdDay`, already used elsewhere in this file for `householdDayOfAt`) instead of
the local `todayISO()`. `todayISO()` itself is untouched and still backs the register's cutoff, which stays a browser-
day calculation as instructed.

**Proof.** No dedicated test was added for this one — it's a same-value substitution (`todayISO()` → `householdToday()`)
at three call sites with no branching logic to pin, and the existing look-back tests (item 5's own three, plus the new
L1 remount test) already exercise all three call sites on every run; none of them assert a specific calendar day value
that this substitution would perturb (they either freeze time or use explicitly-picked dates), so they continue to
pass and would catch a signature/behavior regression (e.g. a thrown error) if this substitution broke something.

### Gates (round 2)

All gates ran on the merged tree (`f96afb18` merged into this branch, then the fixes above on top).

- **`pnpm run typecheck`:** exit 0.
- **Web tests, `TZ=UTC`:** **141 files, 1249 passed, 3 skipped** (down one file from round 1's 142, because
  `cashSignalFamilyInvalidation.test.ts` was removed with item 2).
- **Web tests, `TZ=America/Chicago`:** **141 files, 1250 passed, 2 skipped.**
- **`pnpm run build`:** exit 0.
- **`node scripts/check-entry-graph.mjs`:** **575.7 KB raw / 173.4 KB gz**, budget 580.0 KB — **4.3 KB headroom**,
  back down from round 1's 576.5 KB now that the watcher and its `App.tsx` wiring are gone, landing almost exactly on
  the lead's own estimate ("about 575.7").
- **API suite:** not run — no API, spec, or DDL change in this round either.

### Files touched in round 2

- Removed: `artifacts/h2budget/src/lib/cashSignalFamilyInvalidation.ts`,
  `artifacts/h2budget/src/lib/cashSignalFamilyInvalidation.test.ts`.
- `artifacts/h2budget/src/App.tsx` (removed the import + wiring call).
- `artifacts/h2budget/src/pages/forecast.tsx` (L1, L2, NIT-5).
- `artifacts/h2budget/src/pages/reports/CashFlowPage.tsx` (NIT-3 revert).
- Tests: `forecastCashSignalKey.test.tsx`, `forecastAccuracy.test.tsx`, `cashFlowForecastMissing.test.tsx` (new/changed
  assertions), plus fixture-only updates in `forecastMinFromDate.test.tsx`, `forecastBigBillJump.test.tsx`,
  `forecastFromAndMonthSwitchPerf.test.tsx`, `forecastHorizonSwitchPerf.test.tsx`.
- This doc.

### Still open

- The original ≤5-minute cross-horizon cache-age gap (item 2's target) is unresolved — back to `main`'s pre-existing
  behavior. R4's one-forward-key-and-slice direction is the lead's proposed real fix; not attempted here.
- Item 3's underlying ambiguity (fully-manual vs. ambiguous-multi-account-with-manual-snapshot) is unresolved by
  design — surfacing it correctly would need the API to say which case it is (e.g. a linked-account count on
  `CashSignal`), which is a calculation/contract change outside this PR's scope.
- E2e still not run (same prerequisite gap: no Clerk test keys in this environment).
