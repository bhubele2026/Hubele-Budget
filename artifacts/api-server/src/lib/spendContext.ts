// The household's categories as the one spending rule reads them
// (`SpendContext`). Pure. (WP5d) Moved out of categorizer/context.ts so the
// insert-time rule fill (autoCategorize.ts `loadRuleContext`) can build the
// same context without importing the categorizer (an import cycle).
import type { SpendContext } from "@workspace/avalanche-core";

export function spendContextOf(
  cats: { id: string; name: string; debtId: string | null; kind: string }[],
): SpendContext {
  const categoriesById = new Map(cats.map((c) => [c.id, { name: c.name, debtId: c.debtId, kind: c.kind }]));
  const debtCategoryIds = new Set(cats.filter((c) => c.debtId).map((c) => c.id));
  return { categoriesById, debtCategoryIds };
}
