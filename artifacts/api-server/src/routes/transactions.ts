import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, isNull, ilike, sql, inArray } from "drizzle-orm";
import {
  db,
  transactionsTable,
  forecastResolutionsTable,
  mappingRulesTable,
  upsertMappingRule,
  debtsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { findMatchingRules, loadUserRules } from "../lib/autoCategorize";
import {
  CreateTransactionBody,
  UpdateTransactionBody,
  UpdateTransactionParams,
  DeleteTransactionParams,
  ListTransactionsQueryParams,
  RecategorizeTransactionsByPatternBody,
} from "@workspace/api-zod";

void UpdateTransactionBody;

const router: IRouter = Router();

router.get("/transactions", requireAuth, async (req, res): Promise<void> => {
  const q = ListTransactionsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(transactionsTable.userId, req.userId!)];
  if (q.data.from) conds.push(gte(transactionsTable.occurredOn, q.data.from));
  if (q.data.to) conds.push(lte(transactionsTable.occurredOn, q.data.to));
  if (q.data.source) {
    const sources = q.data.source.split(",").map((s) => s.trim()).filter(Boolean);
    if (sources.length === 1) {
      conds.push(eq(transactionsTable.source, sources[0]));
    } else if (sources.length > 1) {
      conds.push(inArray(transactionsTable.source, sources));
    }
  }
  if (q.data.uncategorized === true) {
    conds.push(isNull(transactionsTable.categoryId));
  }
  if (q.data.excludeTransfers === true) {
    conds.push(eq(transactionsTable.isTransfer, false));
  }
  if (typeof q.data.reimbursable === "boolean") {
    conds.push(eq(transactionsTable.reimbursable, q.data.reimbursable));
  }
  if (q.data.categoryId) {
    conds.push(eq(transactionsTable.categoryId, q.data.categoryId));
  }
  if (q.data.search) {
    conds.push(ilike(transactionsTable.description, `%${q.data.search}%`));
  }
  if (q.data.minAmount) {
    conds.push(
      sql`abs(${transactionsTable.amount}) >= ${q.data.minAmount}`,
    );
  }
  if (q.data.maxAmount) {
    conds.push(
      sql`abs(${transactionsTable.amount}) <= ${q.data.maxAmount}`,
    );
  }
  const rows = await db
    .select()
    .from(transactionsTable)
    .where(and(...conds))
    .orderBy(desc(transactionsTable.occurredOn))
    .limit(q.data.limit ?? 500);
  res.json(rows);
});

/**
 * Cleans a raw transaction description into a short, stable pattern suitable
 * for a `contains` mapping rule. Strips trailing reference suffixes (after
 * `#` / `*`), takes the first couple of meaningful tokens, and caps length.
 * Mirrors the client-side `defaultRememberPattern` so the auto-created rule
 * matches the user's mental model.
 */
function derivePatternFromDescription(description: string | null | undefined): string {
  if (!description) return "";
  const cleaned = description.replace(/[#*].*$/, "").trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const head = tokens.slice(0, 2).join(" ");
  return (head || cleaned).slice(0, 40);
}

async function userOwnsDebt(userId: string, debtId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: debtsTable.id })
    .from(debtsTable)
    .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)))
    .limit(1);
  return !!row;
}

router.post("/transactions", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.debtId && !(await userOwnsDebt(req.userId!, parsed.data.debtId))) {
    res.status(400).json({ error: "Invalid debtId" });
    return;
  }
  const [row] = await db
    .insert(transactionsTable)
    .values({ ...parsed.data, userId: req.userId! })
    .returning();
  res.status(201).json(row);
});

router.patch(
  "/transactions/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UpdateTransactionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateTransactionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // `rememberPattern` is a legacy UI affordance kept for backward compat
    // but no longer required: assigning a category always implies "remember"
    // and auto-creates a mapping rule below. Strip it from the drizzle patch.
    const { rememberPattern, ...patch } = parsed.data as typeof parsed.data & {
      rememberPattern?: string | null;
    };
    if (patch.debtId && !(await userOwnsDebt(req.userId!, patch.debtId))) {
      res.status(400).json({ error: "Invalid debtId" });
      return;
    }
    const [row] = await db
      .update(transactionsTable)
      .set(patch)
      .where(
        and(
          eq(transactionsTable.id, params.data.id),
          eq(transactionsTable.userId, req.userId!),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Whenever a category is assigned via the quick-categorize flow, learn a
    // mapping_rule from the txn's description so future matching transactions
    // auto-categorize the same way. The user no longer needs to opt in via
    // `rememberPattern`. Internal transfers and very short descriptions are
    // skipped because they wouldn't form a useful pattern.
    //
    // Two-step learning:
    //   1. AUTO-RELEARN — repoint any existing rule whose pattern already
    //      matches this description but currently aims at a different
    //      category. The seed mapping rules for debt-payment patterns
    //      (Amex / Cap One / Apple / PayPal / Discover / Citi / etc.) are
    //      pre-pointed at "Misc / Buffer" because the per-debt budget
    //      categories are created lazily by syncAutoDebtCategories only after
    //      the user adds the debt to the tracker. The first time the user
    //      manually picks the real debt category for a payment txn, every
    //      matching seed rule snaps onto it.
    //   2. INSERT — only when no existing rule matched do we derive a fresh
    //      pattern from the description and upsert. Otherwise the repoint in
    //      step 1 is sufficient and we avoid creating overlapping near-
    //      duplicates (e.g. seed "AMERICAN EXPRESS ACH" alongside an auto
    //      "AMERICAN EXPRESS"). Existing rules' priorities are preserved so
    //      they continue to win on auto-categorize for new transactions.
    type RepointedRule = {
      ruleId: string;
      pattern: string;
      matchType: "contains" | "exact" | "starts_with";
      fromCategoryId: string;
      toCategoryId: string;
      candidateCount: number;
    };
    const repointedRules: RepointedRule[] = [];
    if (patch.categoryId && !row.isTransfer) {
      const userId = req.userId!;
      const description = row.description ?? "";
      const allRules = await loadUserRules(userId);
      const matching = findMatchingRules(description, allRules);
      const toRepoint = matching.filter(
        (r) => r.categoryId && r.categoryId !== patch.categoryId,
      );
      for (const r of toRepoint) {
        await db
          .update(mappingRulesTable)
          .set({ categoryId: patch.categoryId })
          .where(
            and(
              eq(mappingRulesTable.id, r.id),
              eq(mappingRulesTable.userId, userId),
            ),
          );
        // Count older transactions still sitting in the rule's old
        // category that match this rule's pattern. Surfacing this count
        // lets the client offer a "apply to past transactions too" prompt
        // so the user doesn't have to touch every prior payment one at a
        // time. We scope to rows currently in `fromCategoryId` so manual
        // edits to a different category are preserved.
        const fromCategoryId = r.categoryId as string;
        const candidates = await selectPatternCandidates(
          userId,
          r,
          fromCategoryId,
        );
        const candidateCount = candidates.filter(
          (c) => c.id !== row.id,
        ).length;
        repointedRules.push({
          ruleId: r.id,
          pattern: r.pattern,
          matchType: normalizeMatchType(r.matchType),
          fromCategoryId,
          toCategoryId: patch.categoryId,
          candidateCount,
        });
      }
      if (matching.length === 0) {
        const explicit =
          typeof rememberPattern === "string" ? rememberPattern : null;
        const source =
          explicit ?? derivePatternFromDescription(row.description);
        const pattern = (source ?? "").trim().slice(0, 60);
        await upsertMappingRule(db, {
          userId,
          pattern,
          matchType: "contains",
          categoryId: patch.categoryId,
          priority: 100,
        });
      }
    }
    // If forecast_flag was turned off, drop any forecast resolution that
    // points to this txn so the Forecast inbox/bucket stays consistent.
    if (parsed.data.forecastFlag === false) {
      await db
        .delete(forecastResolutionsTable)
        .where(
          and(
            eq(forecastResolutionsTable.userId, req.userId!),
            eq(forecastResolutionsTable.matchedTxnId, params.data.id),
          ),
        );
    }
    res.json({ ...row, repointedRules });
  },
);

function normalizeMatchType(
  raw: string,
): "contains" | "exact" | "starts_with" {
  if (raw === "exact" || raw === "starts_with") return raw;
  return "contains";
}

/**
 * Build the SQL pattern for ilike from a mapping rule's matchType. Mirrors
 * `ruleMatchesDescription`'s semantics (case-insensitive substring/exact/
 * prefix) but uses Postgres ilike so we can do the candidate scan in a
 * single query instead of pulling rows back to JS.
 */
function ilikePatternFor(rule: { matchType: string; pattern: string }): string {
  const safe = rule.pattern.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
  switch (rule.matchType) {
    case "exact":
      return safe;
    case "starts_with":
      return `${safe}%`;
    case "contains":
    default:
      return `%${safe}%`;
  }
}

async function selectPatternCandidates(
  userId: string,
  rule: { pattern: string; matchType: string },
  fromCategoryId: string,
): Promise<{ id: string; occurredOn: string }[]> {
  return db
    .select({
      id: transactionsTable.id,
      occurredOn: transactionsTable.occurredOn,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.categoryId, fromCategoryId),
        eq(transactionsTable.isTransfer, false),
        ilike(transactionsTable.description, ilikePatternFor(rule)),
      ),
    );
}

/**
 * Bulk re-categorize past transactions whose description matches a mapping
 * rule's pattern AND that currently sit in the rule's old category. Used
 * by the "apply this rule to past transactions too" prompt that fires
 * after PATCH /transactions/:id repoints a seed rule onto the user's real
 * category. Transactions manually re-categorized to some other category
 * are skipped (we only touch rows whose categoryId == fromCategoryId).
 */
router.post(
  "/transactions/recategorize-by-pattern",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = RecategorizeTransactionsByPatternBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const userId = req.userId!;
    const { pattern, matchType, fromCategoryId, toCategoryId } = parsed.data;
    if (fromCategoryId === toCategoryId) {
      res.json({ updated: 0, affectedMonths: [] });
      return;
    }
    const candidates = await selectPatternCandidates(
      userId,
      { pattern, matchType },
      fromCategoryId,
    );
    if (!candidates.length) {
      res.json({ updated: 0, affectedMonths: [] });
      return;
    }
    const ids = candidates.map((c) => c.id);
    const monthSet = new Set<string>();
    for (const c of candidates) {
      const m = `${c.occurredOn.slice(0, 7)}-01`;
      monthSet.add(m);
    }
    const updated = await db
      .update(transactionsTable)
      .set({ categoryId: toCategoryId })
      .where(
        and(
          eq(transactionsTable.userId, userId),
          eq(transactionsTable.categoryId, fromCategoryId),
          inArray(transactionsTable.id, ids),
        ),
      )
      .returning({ id: transactionsTable.id });
    res.json({
      updated: updated.length,
      affectedMonths: Array.from(monthSet).sort(),
    });
  },
);

router.delete(
  "/transactions/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteTransactionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(transactionsTable)
      .where(
        and(
          eq(transactionsTable.id, params.data.id),
          eq(transactionsTable.userId, req.userId!),
        ),
      );
    res.sendStatus(204);
  },
);

export default router;
