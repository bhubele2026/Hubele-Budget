# Speed batch — summary (2026-10-14)

Branch `perf/integration` (from live `21a51339`). Owner: "all pages super slow to load."

## Before (live, warm browser cache)
- Every page ≈ 4–5 s to data.
- Page calls started only at ~2.0–2.7 s: routes waited for Clerk to finish booting.
- Server: the same 90-day forecast ledger built 3–7× per page; nav badge = 20 sequential text searches;
  /amex summary ×3; /banking review ×2; `GET /debts` could call Plaid.

## What changed
| Package | Change |
|---|---|
| P1 gate | Routes mount at once when this device was signed in; 401-before-Clerk refetches once; preloadable lazy routes (no 300 ms Suspense hold); one `/version` check |
| P2 share | Concurrent requests share ONE forecast build (in-flight only, no result cache, write fence); windowed pending pairing; parallel reads; pool timeout + pressure log |
| P3 light | `GET /categorization/review/count`; review queue in one read; Amex per-card purchases in the `all` summary; read indexes (migration 0200); `GET /debts` never calls Plaid (Sync does) |
| P4 pages | Badge via count; /banking one call; /amex band from one summary, 12-month pull when the chart is near; idle warm-up; hover/press prefetch warms each section's real first calls |

## Proof
- Figures: none moved (P2 concurrency deep-equal vs sequential with sharing off; windowed-pairing property
  test; old-vs-new review queue deep-equal; Amex per-card parity). Intended change: debt balances refresh on Sync only.
- Local timings (synthetic household): dashboard's 8 concurrent calls 1,059 → 180 ms (×3 data), 1,989 → 418 ms
  (×8 data); ledger builds 7 → 1; page's first call 1.5–1.8 s → 54–73 ms with a simulated 1.5 s Clerk boot.
- Calls per page: /amex 14 → 10, /banking 4 → 3, /transactions 12 → 11.
- Gates: API 2,932 ✓ · web 2,275/2,274 (Chicago/UTC) ✓ · landing 613.7/622 KB ✓ · codegen clean · journeys
  42/42 in Chromium, Firefox, WebKit.

## Hosting
Render Starter → Standard is the owner's click (dashboard → h2budget → Settings → Instance Type).

## Remaining
- Live after-numbers: measured after deploy.
- Pre-existing: nested-interactive on /forecast and /review; Chromium Tab-to-bar on /amex.
