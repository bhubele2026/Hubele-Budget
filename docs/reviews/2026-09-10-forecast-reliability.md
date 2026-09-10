# H2Budget forecast, weekly spending, and Chase review fixes

## Changes and review findings

- **Opening cash mismatch fixed.** With a $1,000 snapshot, a $200 checking withdrawal and a $50 deposit after the snapshot, both Bank today and the forecast now start at $850. Actual transactions no longer disappear from the curve because their forecast/review flag is off. Future transactions still require the forecast flag. Account scope and snapshot-day exclusions remain in place. Duplicate Plaid transaction IDs are counted once in the projection.
- **Recurring due dates fixed.** Quarterly January 31 schedules now produce April 30, July 31, and October 31. Leap-day annual schedules return to February 29 in leap years. Client and server follow the same anchor-based calculation.
- **Moved bills remain in the forecast.** A one-time January or December bill moved into May is recovered even if its original date is outside the expansion window. Existing skip/match/reschedule handling still applies.
- **Future-date lookup added.** Forecast has a date picker that reads the expected end-of-day checking balance directly from the server curve. It does not invent values beyond the selected horizon or without a bank snapshot. Scheduled cash flow excludes additional unplanned future purchases; the panel states that limitation.
- **Weekly and unplanned spending surfaced.** Banking opens with the current week's household spending. Chase and Banking show explicitly marked UN spending, the underlying largest 20 purchases, and uncategorized spending separately. Aggregate totals include the whole selected period. Existing categorized spending totals are unchanged. Transfers, debt payments, and income are excluded from unplanned purchases using existing spending classification. Unplanned and uncategorized can overlap and are labeled accordingly.
- **Spending refresh fixed.** Successful mutations invalidate report aggregates centrally, including category and UN changes that previously only refreshed the ledger.
- **Chase review can be cleared.** Individual and bulk reviewed/unreviewed actions use the existing API; a persistent visibility toggle hides reviewed rows and restores them. Undo reverses successful writes only; failed rows remain selected for retry. Clearing is display-only and preserves money, source transactions, and history. Pending selections outside the active month remain valid.
- **Failures no longer look like success.** Chase and Forecast have retryable error states. Missing forecast data no longer displays a $0 balance or a reassuring Clear runway. The Chase ledger discloses its existing 1,000-row cap.

## Validation

- All 776 frontend tests passed, including reviewed-row clearing, partial save failures, future-date lookup, loading/no-snapshot states, and recurring-date stability.
- 86 targeted API/database tests passed using a newly initialized, isolated temporary PostgreSQL database. Coverage includes cash-signal calculation, spine parity, bulk transaction updates, rescheduled bills, and unplanned classification. No real household database was used.
- Full workspace typecheck and production build passed. Entry-graph performance guard passed.
- Desktop and 390px phone previews of the new forecast and spending panels used sample data. No browser exceptions or horizontal overflow occurred.

## Delivery status and limits

Self-reviewed locally on `fix/forecast-reliability-review`. Not published or deployed: automatic approval review rejected the GitHub publishing check as outside the user's authorization. Live bank synchronization and production household data have not been exercised. Existing spending classifications and the existing capped Chase ledger are not replaced in this change. No database migration or new dependency is required.
