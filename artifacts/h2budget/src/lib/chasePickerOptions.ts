/**
 * (#412) Decide whether the "Manual entries" pseudo-account should appear
 * in the View account picker on the Chase Transactions page.
 *
 * The Plaid `listCheckingAccounts` dedupe in #410 collapses duplicate
 * checking rows by (institutionName, mask), but the "Manual entries"
 * row is a separate, hard-coded picker option that always rendered
 * whenever the user had more than one Plaid checking account. After
 * a clean Chase relink that meant users would see a phantom "Manual
 * entries" option even though every transaction belonged to a real
 * Plaid account — visual clutter that made the picker feel broken.
 *
 * Rule:
 *  - Show "Manual entries" only when the user actually has at least
 *    one transaction with no `plaidAccountId` (i.e. a hand-entered row
 *    that does not belong to any linked Plaid account).
 *  - Always keep the option visible if it is the currently selected
 *    value, otherwise the picker would render an empty trigger.
 */
export function shouldShowManualPickerOption(opts: {
  transactions: ReadonlyArray<{ plaidAccountId?: string | null }>;
  currentlySelected: boolean;
}): boolean {
  if (opts.currentlySelected) return true;
  for (const t of opts.transactions) {
    if (!t.plaidAccountId) return true;
  }
  return false;
}
