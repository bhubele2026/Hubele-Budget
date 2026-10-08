import { prepareBudgetCategories, prepareBudgetMonth } from "../../routes/budget";

/**
 * (PR-E) A GET no longer runs the budget's seed / ensure / sync passes: the
 * budget and debt WRITE routes and the nightly job do. These older tests were
 * written when the read ran them, and what they pin (the passes' behavior and
 * order) has not changed, only the caller. Their `requireAuth` mock calls this
 * for a budget GET, running exactly what that GET used to run before it
 * answered: the category list's seed + system categories, or the month's passes.
 */
export async function runBudgetPassesOnRead(req: {
  method?: string;
  originalUrl?: string;
  userId?: string;
  householdId?: string;
  householdOwnerId?: string;
}): Promise<void> {
  if (req.method !== "GET" || !req.householdId || !req.userId) return;
  const path = (req.originalUrl ?? "").split("?")[0]!;
  const owner = req.householdOwnerId ?? req.userId;
  if (/\/budget\/categories$/.test(path)) {
    await prepareBudgetCategories(req.householdId, owner, req.userId);
    return;
  }
  const m = /\/budget\/months\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (m) await prepareBudgetMonth(req.householdId, owner, req.userId, m[1]!);
}
