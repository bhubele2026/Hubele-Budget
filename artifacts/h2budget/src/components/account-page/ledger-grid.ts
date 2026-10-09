/**
 * ⭐ THE LEDGER'S COLUMN GEOMETRY, IN ONE PLACE.
 *
 * A ledger row is a wrapping flex on a narrow LEDGER and a fixed-column grid
 * on a wide one. "Wide" is the ledger's own width, not the window's: the rows
 * sit in a `@container` (the day group's row box), and every grid class is a
 * container-query variant (`@6xl:` = 72rem). A ledger squeezed into a span-8
 * panel on a 1440 px screen therefore wraps instead of crushing the merchant
 * column, and the full-width page still gets its columns at 1280 px.
 *
 * `LedgerColumns` renders the column HEADS against the same track list, so a
 * header and the rows it labels cannot drift apart.
 *
 * Columns: select · merchant · card · category · buckets · amount · actions.
 *
 * ⚠️ A plain module, not `transaction-row.tsx`: page tests mock that file
 * with a fixed export list, so a new constant there would throw in them.
 */
export const LEDGER_GRID =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_7rem_13.5rem_8rem_7rem_12.5rem]";

/**
 * The Chase ledger: the same columns with room for its row actions (date,
 * send to Forecast, Mark reviewed, edit, delete), which overflowed 12.5rem
 * and ran over the amount, and a card column wide enough for the account's
 * masked digits.
 */
export const LEDGER_GRID_WIDE_ACTIONS =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_13.5rem_7.5rem_7.5rem_16.75rem]";
