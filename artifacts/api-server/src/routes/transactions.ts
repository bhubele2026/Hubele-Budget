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

/**
 * A mapping-rule pattern is considered "specific" — i.e. safe to silently
 * auto-repoint when the user manually picks a category for a transaction it
 * matches — when it has at least two whitespace-separated tokens. This is the
 * shape of every debt-payment seed rule we ship ("AMERICAN EXPRESS ACH",
 * "AMEX EPAYMENT", "DISCOVER E-PAYMENT", etc.) so the auto-relearn behavior
 * from Task #177 still fires for them. One-token catch-all patterns the user
 * tends to author by hand ("AMAZON", "TARGET", "WALMART") are treated as
 * generic and left alone — those are typically broadly-used routing rules
 * and silently re-aiming them when the user picks Groceries for an
 * "AMAZON FRESH 123" charge would break their general behavior.
 */
function isPatternSpecific(pattern: string): boolean {
  return pattern.trim().split(/\s+/).filter(Boolean).length >= 2;
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
    // `rememberPattern`. Internal transfers are skipped because they
    // wouldn't form a useful pattern.
    //
    // Two-step learning:
    //   1. AUTO-RELEARN — repoint any *specific* matching rule (≥ 2 tokens,
    //      see `isPatternSpecific`) whose pattern matches this description
    //      but currently aims at a different category. The seed mapping
    //      rules for debt-payment patterns (Amex / Cap One / Apple / PayPal
    //      / Discover / Citi / etc.) are all 2+ tokens and pre-pointed at
    //      "Misc / Buffer" because the per-debt budget categories are
    //      created lazily by syncAutoDebtCategories only after the user
    //      adds the debt to the tracker. The first time the user manually
    //      picks the real debt category for a payment txn, every matching
    //      seed rule snaps onto it. Generic 1-token rules ("AMAZON",
    //      "TARGET") are deliberately *not* repointed — they're typically
    //      broadly-used routing the user authored, and silently re-aiming
    //      them when the user picks Groceries for an "AMAZON FRESH 123"
    //      charge would break their general behavior. Each repointed
    //      specific rule is tracked in `repointedRules` along with a count
    //      of older transactions still sitting in the rule's old category
    //      AND a small `sampleTransactions` preview list (most-recent
    //      first, capped at 10), so the client can offer a "apply to
    //      past transactions too" prompt with a "Show matches" link
    //      instead of making the user touch every prior payment.
    //   2. INSERT — derive a fresh pattern from the description and upsert
    //      a more-specific rule, *unless* a specific matching rule already
    //      points at the new category (the repoint in step 1 is sufficient
    //      and we avoid duplicates like seed "AMERICAN EXPRESS ACH"
    //      alongside an auto "AMERICAN EXPRESS"). When a generic matching
    //      rule was deliberately left in step 1, the new specific rule
    //      gets a priority bump so it wins on future similar charges. The
    //      auto-derive path also refuses to upsert a pattern that would
    //      collide with — and silently overwrite — one of those left-alone
    //      generic rules; an explicit `rememberPattern` body field
    //      (legacy UI affordance) still bypasses that guard since it
    //      represents user-stated intent.
    type RepointedRuleSample = {
      id: string;
      description: string;
      occurredOn: string;
      amount: string;
    };
    type RepointedRule = {
      ruleId: string;
      pattern: string;
      matchType: "contains" | "exact" | "starts_with";
      fromCategoryId: string;
      toCategoryId: string;
      candidateCount: number;
      sampleTransactions: RepointedRuleSample[];
    };
    type RuleAction =
      | { kind: "none"; pattern: null; genericPattern: null }
      | { kind: "created"; pattern: string; genericPattern: null }
      | {
          kind: "created_priority_bump";
          pattern: string;
          genericPattern: string;
        }
      | { kind: "skipped_generic"; pattern: string; genericPattern: string }
      | { kind: "repointed"; pattern: string; genericPattern: null };
    const repointedRules: RepointedRule[] = [];
    let ruleAction: RuleAction = {
      kind: "none",
      pattern: null,
      genericPattern: null,
    };
    if (patch.categoryId && !row.isTransfer) {
      const userId = req.userId!;
      const description = row.description ?? "";
      const allRules = await loadUserRules(userId);
      const matching = findMatchingRules(description, allRules);
      const matchingSpecific = matching.filter((r) =>
        isPatternSpecific(r.pattern),
      );
      const matchingGeneric = matching.filter(
        (r) => !isPatternSpecific(r.pattern),
      );

      for (const r of matchingSpecific) {
        if (r.categoryId === patch.categoryId) continue;
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
        // (and a small preview list) lets the client offer a "apply to
        // past transactions too" prompt — with a "Show matches" link
        // that opens a small dialog — so the user doesn't have to touch
        // every prior payment one at a time. We scope to rows currently
        // in `fromCategoryId` so manual edits to a different category
        // are preserved.
        const fromCategoryId = r.categoryId as string;
        const candidates = await selectPatternCandidates(
          userId,
          r,
          fromCategoryId,
        );
        const remaining = candidates.filter((c) => c.id !== row.id);
        const sampleTransactions: RepointedRuleSample[] = remaining
          .slice(0, 10)
          .map((c) => ({
            id: c.id,
            description: c.description ?? "",
            occurredOn: c.occurredOn,
            amount: c.amount,
          }));
        repointedRules.push({
          ruleId: r.id,
          pattern: r.pattern,
          matchType: normalizeMatchType(r.matchType),
          fromCategoryId,
          toCategoryId: patch.categoryId,
          candidateCount: remaining.length,
          sampleTransactions,
        });
      }

      const isCovered = matchingSpecific.length > 0;
      if (!isCovered) {
        const isExplicit =
          typeof rememberPattern === "string" && rememberPattern.length > 0;
        const source = isExplicit
          ? rememberPattern!
          : derivePatternFromDescription(row.description);
        const pattern = (source ?? "").trim().slice(0, 60);
        const collidingGeneric = !isExplicit
          ? matchingGeneric.find(
              (r) => r.pattern.trim().toLowerCase() === pattern.toLowerCase(),
            )
          : undefined;
        if (pattern && !collidingGeneric) {
          const maxGenericPriority = matchingGeneric.reduce(
            (acc, r) => Math.max(acc, r.priority),
            0,
          );
          const newPriority = Math.max(100, maxGenericPriority + 1);
          const upsertResult = await upsertMappingRule(db, {
            userId,
            pattern,
            matchType: "contains",
            categoryId: patch.categoryId,
            priority: newPriority,
          });
          // `upsertMappingRule` is keyed on (userId, pattern). If it
          // returned "updated"/"noop" the pattern already had a rule —
          // the explicit-remember case where the user re-categorizes a
          // single-token merchant they previously remembered. That's
          // semantically a repoint of the same rule, not a "new specific
          // alongside a different generic", so report it as such even
          // when the pre-existing rule was classified generic.
          if (upsertResult !== "inserted") {
            ruleAction = { kind: "repointed", pattern, genericPattern: null };
          } else if (matchingGeneric.length > 0) {
            // A different (non-colliding) generic rule still matches —
            // we left it alone and gave the new specific rule a higher
            // priority. Tell the user so they understand both rules
            // coexist and which one wins on future similar charges.
            const generic = matchingGeneric[0]!;
            ruleAction = {
              kind: "created_priority_bump",
              pattern,
              genericPattern: generic.pattern,
            };
          } else {
            ruleAction = { kind: "created", pattern, genericPattern: null };
          }
        } else if (pattern && collidingGeneric) {
          ruleAction = {
            kind: "skipped_generic",
            pattern,
            genericPattern: collidingGeneric.pattern,
          };
        }
      } else if (repointedRules.length > 0) {
        // At least one specific matching rule was repointed onto the
        // chosen category. The "apply to past" prompt covers the
        // candidate-count side; this summary just lets the client tell
        // the user which existing rule was reused.
        const first = repointedRules[0]!;
        ruleAction = {
          kind: "repointed",
          pattern: first.pattern,
          genericPattern: null,
        };
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
    res.json({ ...row, repointedRules, ruleAction });
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
): Promise<
  {
    id: string;
    occurredOn: string;
    description: string | null;
    amount: string;
  }[]
> {
  // Ordered most-recent first so the first N rows can be served straight
  // through to the client as the "Show matches" preview list. Bulk
  // re-categorize callers don't care about order (they just need the
  // full id set) so this is safe to apply unconditionally.
  return db
    .select({
      id: transactionsTable.id,
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.categoryId, fromCategoryId),
        eq(transactionsTable.isTransfer, false),
        ilike(transactionsTable.description, ilikePatternFor(rule)),
      ),
    )
    .orderBy(desc(transactionsTable.occurredOn));
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
    const { pattern, matchType, fromCategoryId, toCategoryId, ids } =
      parsed.data;
    if (fromCategoryId === toCategoryId) {
      res.json({ updated: 0, affectedMonths: [], affectedIds: [] });
      return;
    }
    // Optional id whitelist — used by the client's "Undo" affordance
    // to revert exactly the rows the original bulk touched. Anything
    // the user has since re-edited (away from `fromCategoryId`) is
    // already filtered out by the `categoryId == fromCategoryId`
    // guard inside `selectPatternCandidates` and the UPDATE; the
    // whitelist additionally guarantees we don't sweep up unrelated
    // rows that happen to match the pattern. An explicitly-supplied
    // empty array is treated as a no-op so callers can pass through
    // a known-empty list (e.g. a degenerate Undo payload) without
    // accidentally affecting every matching row.
    if (ids && ids.length === 0) {
      res.json({ updated: 0, affectedMonths: [], affectedIds: [] });
      return;
    }
    let candidates = await selectPatternCandidates(
      userId,
      { pattern, matchType },
      fromCategoryId,
    );
    if (ids && ids.length > 0) {
      const allow = new Set(ids);
      candidates = candidates.filter((c) => allow.has(c.id));
    }
    if (!candidates.length) {
      res.json({ updated: 0, affectedMonths: [], affectedIds: [] });
      return;
    }
    const candidateIds = candidates.map((c) => c.id);
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
          inArray(transactionsTable.id, candidateIds),
        ),
      )
      .returning({ id: transactionsTable.id });
    res.json({
      updated: updated.length,
      affectedMonths: Array.from(monthSet).sort(),
      affectedIds: updated.map((r) => r.id),
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
