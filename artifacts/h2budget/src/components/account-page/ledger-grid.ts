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
 * `LEDGER_GRID` is the Amex ledger's (its row actions are the date and, since F4,
 * "Split" by category: 8rem).
 *
 * ⚠️ A plain module, not `transaction-row.tsx`: page tests mock that file
 * with a fixed export list, so a new constant there would throw in them.
 */
export const LEDGER_GRID =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_12rem_6.75rem_7rem_8rem]";

/**
 * The Chase ledger: the same columns with room for its row actions (date,
 * send to Forecast, Mark reviewed, split by category, edit, delete — 19rem; 15.6rem before F4's Split button), which
 * overflowed the old 12.5rem and ran over the amount.
 *
 * (C10) Both tracks were retuned so the merchant column gets the room the
 * fixed columns did not use: the category picker fills a 12rem column, the
 * four bucket marks need 6.5rem, the amount and its "bal" line 7rem, and the
 * Amex actions are only the date controls (4.6rem). At a 1280 px window the
 * Chase merchant column is ~300 px, so a name and its "In Review" chip share
 * one 40 px line unless the name is long — then the chip takes a second line.
 */
export const LEDGER_GRID_WIDE_ACTIONS =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_12rem_6.75rem_7rem_19rem]";
