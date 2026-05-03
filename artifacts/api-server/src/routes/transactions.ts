import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, isNull, ilike, sql } from "drizzle-orm";
import {
  db,
  transactionsTable,
  forecastResolutionsTable,
  mappingRulesTable,
  debtsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateTransactionBody,
  UpdateTransactionBody,
  UpdateTransactionParams,
  DeleteTransactionParams,
  ListTransactionsQueryParams,
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
  if (q.data.source) conds.push(eq(transactionsTable.source, q.data.source));
  if (q.data.uncategorized === true) {
    conds.push(isNull(transactionsTable.categoryId));
  }
  if (q.data.excludeTransfers === true) {
    conds.push(eq(transactionsTable.isTransfer, false));
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
    // Whenever a category is assigned via the quick-categorize flow, upsert
    // a high-priority mapping_rule from the txn's description so future
    // matching transactions auto-categorize the same way. The user no longer
    // needs to opt in via `rememberPattern`. Internal transfers and very
    // short descriptions are skipped because they wouldn't form a useful
    // pattern. We trim to a reasonable length so noisy suffixes don't make
    // the rule too narrow.
    if (patch.categoryId && !row.isTransfer) {
      const explicit =
        typeof rememberPattern === "string" ? rememberPattern : null;
      const source = explicit ?? derivePatternFromDescription(row.description);
      const pattern = (source ?? "").trim().slice(0, 60);
      if (pattern.length >= 3) {
        const existing = await db
          .select({ id: mappingRulesTable.id })
          .from(mappingRulesTable)
          .where(
            and(
              eq(mappingRulesTable.userId, req.userId!),
              eq(mappingRulesTable.pattern, pattern),
            ),
          );
        if (existing.length > 0) {
          await db
            .update(mappingRulesTable)
            .set({ categoryId: patch.categoryId, priority: 100 })
            .where(eq(mappingRulesTable.id, existing[0].id));
        } else {
          await db.insert(mappingRulesTable).values({
            userId: req.userId!,
            pattern,
            matchType: "contains",
            categoryId: patch.categoryId,
            priority: 100,
          });
        }
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
    res.json(row);
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
