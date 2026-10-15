# Contract — the checking balance

One balance, one name, one moment, on every surface. Added 2026-10-15 (T1/T2).

## The three quantities

| Term | What it is | Server field (one function) | On screen |
|---|---|---|---|
| **Checking today** (authoritative) | The bank's reading rolled forward through the ledger's counted rows (manual rows included) to the household's today | `computeCashSignal().bankToday` = `spine.bank.balance` = `/banking/review balance.today` = `/transactions/balances anchor.todayBalance` = `/forecast .cashSignal.bankToday` = `/forecast/bank-balance-explain displayed.bankToday` | "Checking today $X" · "as of Oct 15" |
| **Bank's last reading** (evidence) | `forecast_settings.bank_snapshot_balance` at `bank_snapshot_at`, with its source | `spine.bank.snapshot`, `spine.bankConfidence.bankBalance/bankAsOf`, `/forecast .bankSnapshot`, explain `.snapshot`, `/banking/review balance.reading` + `balance.asOf` | Plaid: "Bank's last reading $X · Oct 15, 7:02 AM" · typed: "Typed balance $X (not from the bank) · Oct 15" |
| **Forecast start** | Checking today rolled to the curve's first day (`fromDate`) | `cashSignal.startingBalance`; the chart's `cashSignal.daily[0]` | "Starting at $X · as of Oct 15" |

- No surface prints the raw reading under a "today" label.
- No surface prints `settings.startingBalance` as a balance: it is the curve's fallback when there is no reading, and says so ("No bank reading yet — the curve starts from your starting balance $X").
- No reading → "—", never "$0.00". A real reading of $0.00 → "$0.00", plain, dated, never rust.

## Which reading is this answer built on? (`dataAsOf`)

Every response that carries the checking balance names its reading:
`dataAsOf: { snapshotAt, computedAt }` on `GET /spine`, `/forecast`, `/forecast/cash-signal`,
`/banking/review`, `/transactions/ledger`, `/transactions/balances`, `/forecast/bank-balance-explain`,
`/banking/check-explain` (helper `api-server/src/lib/dataAsOf.ts`). `snapshotAt` is the same moment on
all of them for one household state (pinned in `spineParity.integration.test.ts`).

The web keeps the newest `snapshotAt` any response carried (`h2budget/src/lib/dataAsOf.ts`, fed by the
QueryCache in `App.tsx`). An answer built on an older reading is shown as
"Earlier reading (Oct 14) — updating…" (grey, never "today") and asked again once. No reading is
"unknown" and never guarded; a placeholder (another key's answer) is never judged.

## When the reading moves (the anchor rule)

The reading (anchor) moves only on an owner action that reads the bank:

- a manual **Sync** (`plaidSync`, `syncOrigin: "manual"`, the forecast's checking account);
- **Refresh** on the Forecast card (`POST /forecast/refresh-bank`);
- **Link** / reconnect / reset-cursor (`syncOrigin: "manual"`);
- `POST /forecast/bank-snapshot {balance}` — a **typed** balance (source `manual`). Kept for data and
  API compatibility; the app no longer offers it (owner, 2026-10-15: "he will never type a balance by
  hand"). A typed balance is not evidence from the bank and is replaced by the next reading.

Background syncs (webhook, cron) add rows and never re-read the balance.

After **any** Sync (rows or not) the web invalidates the forecast family and `/banking/review`
(`use-plaid-sync.tsx`); every write invalidates `/banking/review` with the spine
(`lib/mutationInvalidation.ts`). Back on a tab after more than a minute, the money reads refetch
(`hooks/useRefetchMoneyOnReturn.ts`).

## The balance check (one state machine)

`lib/bankConfidenceView.ts` `checkState` reads only the server's `status / stale / staleReason /
difference / direction / lastDrift`:

| Server | Chip | Line | Action |
|---|---|---|---|
| matches, fresh | Balances match (ok) | Checked <ago> · bank $X = H2 $X | — |
| off_by, fresh | Difference needs review (rust) | At the last check (<day>) the bank was $D lower/higher than H2 expected. | Review difference |
| resolved_since | Resolved since (ok; grey when only old) | Was off by $D at the <day> check; rows that arrived later explain it. | — |
| matches/off_by, stale | Check is out of date (grey) | why (re-read / typed / rows arrived / last checked N days ago) + "It was off by $D then." | Sync to check |
| not_checked | Not checked (grey) | its reason | Sync to check |

Plus "Today H2 $X and the bank $X agree." when a difference stands but today's two figures are one
reading, and "Earlier: off by $D on <day>" from `lastDrift`. Nothing on screen clears or changes a
check. `resolved_since` is not made stale by the late rows that explain it (`bankCheck.ts`).

"Review difference" reads `GET /banking/check-explain` (read-only, no Plaid): the stored record, the
bank rows the check counted, deposits left out / added, rows H2 recorded itself (counted in H2's
balance, left out of the check), rows that arrived since, today's figures, and a verdict
(`late_rows_tie` · `manual_rows_match` · `unknown`).

## Zero, buffer, negative

- Checking today = $0.00, fresh: plain and dated, never rust.
- Low point ≥ $0 but under the buffer: quiet — "Under the $500 buffer".
- Low point < $0: rust — "Below zero on <date>" → Review shortfall (`/forecast?day=<date>`).
- Stale reading: grey — the freshness line says why; the low point says "from an out-of-date bank balance".
- No reading: "—" and "No bank reading yet — the curve starts from your starting balance $X".
