/**
 * ⭐ ONE WORD FOR A ROW'S CATEGORY, IN FOUR HONEST STATES.
 *
 *   no category id          "Uncategorized"       (the row really has none)
 *   list still loading      ""  (blank / skeleton - never "Unknown" or "Uncategorized")
 *   list loaded, id found   the name
 *   list loaded, id missing "Deleted category"
 *
 * A screen that drew "Unknown" while `/categories` loaded told the owner a
 * categorized row had no category.
 */
export const CATEGORY_LOADING = "";
export const CATEGORY_DELETED = "Deleted category";
export const CATEGORY_NONE = "Uncategorized";

export function categoryLabel(
  categoryId: string | null | undefined,
  categories: readonly { id: string; name: string }[] | undefined,
): string {
  if (!categoryId) return CATEGORY_NONE;
  if (categories === undefined) return CATEGORY_LOADING;
  return categories.find((c) => c.id === categoryId)?.name ?? CATEGORY_DELETED;
}

/** The same, for a row that carries an optional name map already built (`null` = none, "" = loading). */
export function categoryCell(
  categoryId: string | null | undefined,
  names: ReadonlyMap<string, string> | undefined,
): string | null {
  if (!categoryId) return null;
  if (names === undefined) return CATEGORY_LOADING;
  return names.get(categoryId) ?? CATEGORY_DELETED;
}
