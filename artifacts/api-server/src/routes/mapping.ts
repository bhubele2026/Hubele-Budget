import { Router, type IRouter } from "express";
import { and, eq, desc } from "drizzle-orm";
import { db, mappingRulesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateMappingRuleBody,
  UpdateMappingRuleBody,
  UpdateMappingRuleParams,
  DeleteMappingRuleParams,
  ReorderMappingRulesBody,
  TestMappingRulesBody,
  PreviewMappingRuleRecategorizeBody,
  PreviewMappingRuleRecategorizeParams,
  PreviewMappingRuleRecategorizeByPatternBody,
} from "@workspace/api-zod";
import { findMatchingRules, type RuleRow } from "../lib/autoCategorize";
import {
  countPatternCandidates,
  selectPatternCandidates,
} from "../lib/patternCandidates";

function normalizeMatchType(
  raw: string | null | undefined,
): "contains" | "exact" | "starts_with" {
  if (raw === "exact" || raw === "starts_with") return raw;
  return "contains";
}

const router: IRouter = Router();

router.get("/mapping-rules", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(mappingRulesTable)
    .where(eq(mappingRulesTable.userId, req.userId!))
    .orderBy(desc(mappingRulesTable.priority));
  res.json(rows);
});

router.post("/mapping-rules", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateMappingRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = req.userId!;
  const [row] = await db
    .insert(mappingRulesTable)
    .values({ ...parsed.data, userId })
    .returning();
  // Mirror the auto-learn flow's `ruleAction` shape so the Mapping Rules
  // page can reuse the existing `useBulkRecategorizePrompt` helper. We
  // count older *uncategorized* transactions matching the new rule's
  // pattern + matchType and surface that as a `kind: "created"` action
  // — same shape PATCH /transactions/:id ships when the auto-learn flow
  // mints a brand-new specific rule. Manually-categorized rows are
  // deliberately excluded (the bulk endpoint enforces the same guard)
  // so explicit user intent is preserved.
  //
  // Skip the count when the rule has no category (nothing to flip rows
  // onto) — the prompt would be meaningless and the bulk endpoint
  // requires a non-null toCategoryId anyway.
  const matchType = normalizeMatchType(row.matchType);
  const toCategoryId = row.categoryId ?? null;
  let candidateCount = 0;
  if (toCategoryId) {
    candidateCount = await countPatternCandidates(
      userId,
      { pattern: row.pattern, matchType },
      null,
    );
  }
  const ruleAction =
    toCategoryId && candidateCount > 0
      ? {
          kind: "created" as const,
          pattern: row.pattern,
          genericPattern: null,
          ruleId: row.id,
          previousCategoryId: null,
          matchType,
          toCategoryId,
          candidateCount,
        }
      : {
          kind: "none" as const,
          pattern: null,
          genericPattern: null,
          ruleId: null,
          previousCategoryId: null,
          matchType: null,
          toCategoryId: null,
          candidateCount: null,
        };
  res.status(201).json({ ...row, ruleAction });
});

/**
 * Bulk reorder. Rewrites the priority of every rule in `orderedIds` to a
 * descending sequence starting at `BASE` so the front-of-list rule has the
 * highest priority. We leave large gaps (`STEP=10`) so the auto-learn flow,
 * which bumps individual rule priorities by single digits, has plenty of
 * headroom to insert new rules between user-pinned positions without
 * triggering an immediate re-shuffle.
 *
 * Rules the user owns but doesn't include in `orderedIds` keep their
 * existing priorities. We push the reordered window above them by computing
 * BASE = max(existing priorities of the omitted set) + STEP * (1 + ordered count)
 * so the explicit ordering always wins.
 *
 * IDs that don't belong to the calling user are silently ignored — important
 * because the client posts whatever was on screen and we don't want a hostile
 * user to bump someone else's rules.
 */
router.put(
  "/mapping-rules/reorder",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = ReorderMappingRulesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { orderedIds } = parsed.data;

    const userId = req.userId!;
    const owned = await db
      .select({
        id: mappingRulesTable.id,
        priority: mappingRulesTable.priority,
      })
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, userId));
    const ownedIds = new Set(owned.map((r) => r.id));

    const filtered: string[] = [];
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (!ownedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      filtered.push(id);
    }

    if (filtered.length === 0) {
      const rows = await db
        .select()
        .from(mappingRulesTable)
        .where(eq(mappingRulesTable.userId, userId))
        .orderBy(desc(mappingRulesTable.priority));
      res.json(rows);
      return;
    }

    const STEP = 10;
    const orderedSet = new Set(filtered);
    const omittedMaxPriority = owned.reduce((max, r) => {
      if (orderedSet.has(r.id)) return max;
      return Math.max(max, r.priority);
    }, 0);
    const base = omittedMaxPriority + STEP * (filtered.length + 1);

    await db.transaction(async (tx) => {
      for (let i = 0; i < filtered.length; i++) {
        const id = filtered[i]!;
        const newPriority = base - i * STEP;
        await tx
          .update(mappingRulesTable)
          .set({ priority: newPriority })
          .where(
            and(
              eq(mappingRulesTable.userId, userId),
              eq(mappingRulesTable.id, id),
            ),
          );
      }
    });

    const rows = await db
      .select()
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, userId))
      .orderBy(desc(mappingRulesTable.priority));
    res.json(rows);
  },
);

router.post(
  "/mapping-rules/test",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = TestMappingRulesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const userId = req.userId!;
    const rows = await db
      .select()
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, userId));
    const sorted: RuleRow[] = [...rows].sort(
      (a, b) => b.priority - a.priority,
    );
    const matches = findMatchingRules(parsed.data.description, sorted);
    const winner = matches.find((m) => m.categoryId) ?? null;
    res.json({
      matches: matches.map((rule) => ({
        rule,
        winner: winner !== null && rule.id === winner.id,
      })),
      winningCategoryId: winner?.categoryId ?? null,
    });
  },
);

/**
 * Read-only preview of the bulk-recategorize that would happen if the
 * Mapping Rules edit UI saved a new `categoryId` for this rule and then
 * called POST /transactions/recategorize-by-pattern with the same
 * `{ pattern, matchType, fromCategoryId, toCategoryId }`. Surfaces the
 * candidate count + a thin sample list so the edit form can show
 * "N past transactions will move into <new category>" with a
 * "Show matches" affordance before the user confirms.
 *
 * Mounted before the more-generic PATCH /mapping-rules/:id route. Express
 * matches by segment count so the routing isn't ambiguous, but we keep
 * the preview definition adjacent to the rule mutators for grep-ability.
 */
/**
 * Variant of /mapping-rules/:id/recategorize-preview that takes the
 * unsaved rule's `{ pattern, matchType, toCategoryId }` directly so the
 * "Add New Rule" form on the Mapping Rules page can surface the same
 * "N past transactions will move into <category>" inline banner +
 * "Show matches" affordance the edit flow shows — *before* the user
 * clicks Add. `fromCategoryId` is implicitly `null` (uncategorized rows
 * only) since no rule exists yet to scope by; this mirrors how the
 * post-create `ruleAction` toast already counts candidates for
 * brand-new rules.
 *
 * Mounted before the more-generic PATCH /mapping-rules/:id route. The
 * literal "recategorize-preview-by-pattern" segment can't collide with a
 * UUID id thanks to Express's exact-match routing, but we keep the
 * preview definitions adjacent for grep-ability.
 */
router.post(
  "/mapping-rules/recategorize-preview-by-pattern",
  requireAuth,
  async (req, res): Promise<void> => {
    const body = PreviewMappingRuleRecategorizeByPatternBody.safeParse(
      req.body,
    );
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const userId = req.userId!;
    const { pattern, matchType, toCategoryId } = body.data;
    // `toCategoryId` is optional in the request: the candidate count +
    // samples only depend on pattern + matchType (the bulk recategorize
    // always scopes to uncategorized rows), so the Add form can fire
    // this preview as soon as the user types a pattern — before they
    // pick a destination — and reuse the same response after the
    // category is chosen. Echo back `null` when omitted so the client
    // can render the neutral "would match N uncategorized past
    // transactions" banner without a separate field.
    const echoedToCategoryId = toCategoryId ?? null;
    // Empty pattern means the user hasn't typed anything yet — return
    // an empty preview so the client can avoid showing a stale banner
    // without a separate guard.
    if (!pattern.trim()) {
      res.json({
        pattern,
        matchType,
        fromCategoryId: null,
        toCategoryId: echoedToCategoryId,
        candidateCount: 0,
        sampleTransactions: [],
      });
      return;
    }
    const candidates = await selectPatternCandidates(
      userId,
      { pattern, matchType },
      null,
    );
    const sampleTransactions = candidates.slice(0, 10).map((c) => ({
      id: c.id,
      description: c.description ?? "",
      occurredOn: c.occurredOn,
      amount: c.amount,
      // Uncategorized rows by definition haven't been auto-categorized
      // by any existing rule, so `matchedRuleId` is always null here.
      // Keeping the field present (rather than omitting) matches the
      // RepointedRuleSample shape so the shared MatchesPreview Dialog
      // can render either preview without a special case.
      matchedRuleId: null as string | null,
    }));
    res.json({
      pattern,
      matchType,
      fromCategoryId: null,
      toCategoryId: echoedToCategoryId,
      candidateCount: candidates.length,
      sampleTransactions,
    });
  },
);

router.post(
  "/mapping-rules/:id/recategorize-preview",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = PreviewMappingRuleRecategorizeParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = PreviewMappingRuleRecategorizeBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const userId = req.userId!;
    const [rule] = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.id, params.data.id),
          eq(mappingRulesTable.userId, userId),
        ),
      );
    if (!rule) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const fromCategoryId = rule.categoryId;
    const toCategoryId = body.data.toCategoryId;
    const matchType = normalizeMatchType(rule.matchType);
    // Empty preview is the right answer when:
    //   * the rule is currently uncategorized — the bulk endpoint requires
    //     a concrete from-category to scope the update, so there's
    //     nothing we could safely flip on save anyway, OR
    //   * the user is "moving" to the same category — no-op, no preview.
    if (!fromCategoryId || fromCategoryId === toCategoryId) {
      res.json({
        ruleId: rule.id,
        pattern: rule.pattern,
        matchType,
        fromCategoryId,
        toCategoryId,
        candidateCount: 0,
        sampleTransactions: [],
      });
      return;
    }
    const candidates = await selectPatternCandidates(
      userId,
      { pattern: rule.pattern, matchType: rule.matchType },
      fromCategoryId,
    );
    // patternCandidates returns description as nullable; the
    // RepointedRuleSample / preview-dialog schema expects a string,
    // so coalesce here.
    const sampleTransactions = candidates.slice(0, 10).map((c) => ({
      id: c.id,
      description: c.description ?? "",
      occurredOn: c.occurredOn,
      amount: c.amount,
    }));
    res.json({
      ruleId: rule.id,
      pattern: rule.pattern,
      matchType,
      fromCategoryId,
      toCategoryId,
      candidateCount: candidates.length,
      sampleTransactions,
    });
  },
);

router.patch(
  "/mapping-rules/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UpdateMappingRuleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateMappingRuleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [row] = await db
      .update(mappingRulesTable)
      .set(parsed.data)
      .where(
        and(
          eq(mappingRulesTable.id, params.data.id),
          eq(mappingRulesTable.userId, req.userId!),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/mapping-rules/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteMappingRuleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.id, params.data.id),
          eq(mappingRulesTable.userId, req.userId!),
        ),
      );
    res.sendStatus(204);
  },
);

export default router;
