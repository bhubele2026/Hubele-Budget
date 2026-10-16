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
 * `LEDGER_GRID` is the Amex ledger's (its only row action is the date).
 *
 * ⚠️ A plain module, not `transaction-row.tsx`: page tests mock that file
 * with a fixed export list, so a new constant there would throw in them.
 */
export const LEDGER_GRID =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_12rem_6.75rem_7rem_5rem]";

/**
 * The Chase ledger: the same columns with room for its row actions (date,
 * send to Forecast, Mark reviewed, edit, delete — 15.6rem measured), which
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
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_12rem_6.75rem_7rem_16rem]";

/**
 * (P1) THE AMEX LEDGER, TWO WAYS. Review (the default) says each row's
 * spending in words (a wider, wrapping column); Categorize shows the four
 * bucket marks (the old 6.75rem column). The last column is only the row's
 * Details toggle. The Card column is there on All cards only — one card's
 * page names its card once, in the header.
 *
 * ⚠️ LITERAL STRINGS: Tailwind only generates classes it can read in the
 * source, so each track list is spelled out, never assembled.
 */
export const AMEX_GRID_REVIEW_CARD =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_12rem_8.5rem_7rem_2.5rem]";
export const AMEX_GRID_REVIEW =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_12rem_8.5rem_7rem_2.5rem]";
export const AMEX_GRID_CATEGORIZE_CARD =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_8.5rem_12rem_6.75rem_7rem_2.5rem]";
export const AMEX_GRID_CATEGORIZE =
  "@6xl:grid-cols-[1.75rem_minmax(0,1fr)_12rem_6.75rem_7rem_2.5rem]";

export type AmexRowMode = "review" | "categorize";

/** The Amex track list for a row mode, with or without the Card column. */
export function amexLedgerGrid(mode: AmexRowMode, showCard: boolean): string {
  if (mode === "categorize") return showCard ? AMEX_GRID_CATEGORIZE_CARD : AMEX_GRID_CATEGORIZE;
  return showCard ? AMEX_GRID_REVIEW_CARD : AMEX_GRID_REVIEW;
}
