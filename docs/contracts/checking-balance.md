# Contract — the checking balance

One balance, one name, one moment, on every surface. Added 2026-10-15 (T1/T2); one presentation 2026-10-16 (C1–C3).

## The terms (one table, the same words on every screen)

| Term | What it is | Server field (one function) | On screen |
|---|---|---|---|
| **Checking today** (authoritative) | The bank's reading rolled forward through the ledger's counted rows (manual rows included) to the household's today | `computeCashSignal().bankToday` = `spine.bank.balance` = `/banking/review balance.today` = `/transactions/balances anchor.todayBalance` = `/forecast .cashSignal.bankToday` = `/forecast/bank-balance-explain displayed.bankToday` | label "Checking today", the figure, and the calculated line (below) |
| **Bank's last reading** (evidence) | `forecast_settings.bank_snapshot_balance` at `bank_snapshot_at`, with its source | `spine.bank.snapshot`, `spine.bankConfidence.bankBalance/bankAsOf`, `/forecast .bankSnapshot`, explain `.snapshot`, `/banking/review balance.reading` + `balance.asOf`, `cashSignal.opening.reading` | named in full only inside **Details** ("Why this number?"); on the face it is "bank read $X <time>" inside the calculated line |
| **Opening** | Checking today rolled to the START of the curve's first day (`fromDate`): the reading plus rows dated before that day | `cashSignal.startingBalance` = `cashSignal.opening.balance` (with `opening.date`, `opening.reading`, `opening.since`) | "Opening · Oct 16" (hero adds-up), "opens $X" (chart caption, first-day tooltip) |
| **Close** | That first day's balance AFTER its items — the first plotted point | `cashSignal.daily[0].balance` | "closes $X" (chart caption), "Close" (first-day tooltip) |

- On the day the rows are dated today, Opening is the bare reading and Close is Checking today (e.g. "Oct 16 · opens $0.00 · closes $3,374.60"). Both are right; the words name the moment.
- When every row is dated before the opening day, Opening = Checking today.
- No surface prints the raw reading under a "today" label.
- No surface prints `settings.startingBalance` as a balance: it is the curve's fallback when there is no reading, and says so ("The curve starts from your starting balance $X").
- No reading → "—", never "$0.00". A real reading of $0.00 → "$0.00", plain, dated, never rust.

## The block (one presentation, five places)

`components/checking-balance.tsx` (face) + `checking-balance-note.tsx` (note + Details), mounted on the Dashboard
Banking tile, the Banking cell, the Forecast KPI, the Forecast "Checking today" card and the Overview stat:

```
Checking today
$3,374.60
Calculated · bank read $0.00 Oct 15, 4:19 PM · +2 rows since
Details
```

**The Calculated line** (`checkingWords.calculatedLine(reading, since)`):

| Case | Line |
|---|---|
| Bank reading, rows counted | `Calculated · bank read $0.00 Oct 15, 4:19 PM · +2 rows since` (`+1 row since` for one) |
| Bank reading, none counted | `Calculated · bank read $0.00 Oct 15, 4:19 PM · no rows since` |
| Bank reading, the response did not carry the rows | `Calculated · bank read $0.00 Oct 15, 4:19 PM` (says nothing about rows) |
| Typed balance | `Typed balance $120.00 (not from the bank) · Oct 15` |
| No reading | `No bank reading yet` (the figure is "—") |
| Answer older than the newest reading seen | `Earlier reading (Oct 14) — updating…` replaces the line; the figure is grey |

Each surface passes the halves from ITS OWN response when it carries them (`/banking/review balance`,
`cashSignal.opening`), else the spine's `bank.snapshot` / `bank.sinceSnapshot` (same ledger). The Dashboard tile
loads the note as its own chunk (the landing keeps the label and the figure).

## One forecast, one horizon (C3)

`lib/forecastHorizon.ts`: `?horizon=` in the address wins, then the one sessionStorage key, then **90** — on the
Forecast detail, the Overview and the tile link. 30 days stays one tab away. `/forecast` carries `?horizon=` and
`?day=` as URL state (Back/Forward restore both). Every Overview figure names its horizon ("Ending balance · at 90
days"); its low point is said with the detail's chip words (`lowPointView`): "Below zero on <date>" (rust, the only
alarm) · "Under the $N buffer" (quiet) · "Near buffer" · "Above buffer". The spine's forecast figures are a 90-day
read: the Overview uses them at 90 and the cash signal's own low point at any other horizon.

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
