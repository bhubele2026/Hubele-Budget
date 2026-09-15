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

## Gates

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

## Skipped

Nothing was skipped — all six items were implementable simply within the stated constraints. Item 2 came closest to
the "stop if it can't be done simply" line; the design that shipped is one `QueryCache` subscription plus one pure
comparison function, with the no-loop property following directly from "skip when the fingerprints already agree"
rather than from anything bespoke per call site.

## Residuals (not this PR's job, noted for the record)

- Item 2 only reconciles entries that are already **cached with data**. A horizon nobody has opened yet has no entry
  to invalidate — it will simply fetch fresh next time it's opened, which is correct, just worth naming.
- Item 4's fallback path (nothing resolves) still shows the stored label, unchanged — there is no better source in
  that case, consistent with item 3's title falling back to plain "bank account not identified" / "balance entered by
  hand" text rather than a name.
- E2e was not run (same prerequisite gap as prior rounds: no Clerk test keys in this environment); nothing in this PR
  touches e2e specs.
