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
import {
  categorize,
  findMatchedRuleId,
  findMatchingRules,
  loadUserRules,
} from "../lib/autoCategorize";
import { selectPatternCandidates } from "../lib/patternCandidates";
import {
  CreateTransactionBody,
  UpdateTransactionBody,
  UpdateTransactionParams,
  DeleteTransactionParams,
  ListTransactionsQueryParams,
  RecategorizeTransactionsByPatternBody,
  BulkSetForecastFlagBody,
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
  // Annotate each row with the mapping rule that auto-categorize would
  // currently attribute, so the Transactions / Amex pages can show a
  // "matched by rule X" affordance and let the user jump to the rule on
  // the Mapping Rules page. Computed lazily per-list rather than stored
  // on the txn so editing a rule's pattern instantly reflects on every
  // existing row without a backfill. Rules are loaded once for the list.
  const userRules = await loadUserRules(req.userId!);
  const annotated = rows.map((r) => ({
    ...r,
    matchedRuleId: findMatchedRuleId(r.description, r.categoryId, userRules),
  }));
  res.json(annotated);
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
  // Mirror the import / Plaid-sync auto-categorize pipeline so a hand-typed
  // "STARBUCKS COFFEE #221" expense lands in the same category an imported
  // row would (and so the Transactions page's "matched by rule X" chip
  // lights up automatically). Only fill in fields the client OMITTED:
  //   - `categoryId` — only auto-fill when the body did not pass one. An
  //     explicit categoryId (including null, which the user might pass to
  //     deliberately leave the row uncategorized) wins.
  //   - `isTransfer` — only auto-fill when the body did not pass one.
  //     Explicit `true`/`false` from the client stays authoritative.
  // PFC fields aren't part of CreateTransactionBody (manual entries don't
  // come from Plaid) so categorize() here just runs the description path.
  const insertValues: Record<string, unknown> = {
    ...parsed.data,
    userId: req.userId!,
  };
  const bodyHasCategoryId = Object.prototype.hasOwnProperty.call(
    req.body ?? {},
    "categoryId",
  );
  const bodyHasIsTransfer = Object.prototype.hasOwnProperty.call(
    req.body ?? {},
    "isTransfer",
  );
  // `autoCategorizedRuleId` is the id of the mapping rule that the
  // categorize() pipeline used to auto-attribute the new row's category.
  // Set only when the body OMITTED categoryId AND a rule matched — an
  // explicit user-supplied categoryId takes precedence and is reported
  // as `null` (no auto-attribution happened). Surfacing the rule id
  // back to the Add-Transaction client lets it show a small "matched
  // by rule X" toast (mirroring the PATCH `ruleAction` toast) with an
  // Undo affordance that clears the auto-picked category from the new
  // row without deleting the row itself.
  let autoCategorizedRuleId: string | null = null;
  if (!bodyHasCategoryId || !bodyHasIsTransfer) {
    const rules = await loadUserRules(req.userId!);
    const result = categorize(
      {
        description: parsed.data.description,
        pfcPrimary: null,
        pfcDetailed: null,
      },
      rules,
    );
    if (!bodyHasCategoryId && result.categoryId) {
      insertValues.categoryId = result.categoryId;
      autoCategorizedRuleId = findMatchedRuleId(
        parsed.data.description,
        result.categoryId,
        rules,
      );
    }
    if (!bodyHasIsTransfer) {
      insertValues.isTransfer = result.isTransfer;
    }
  }
  const [row] = await db
    .insert(transactionsTable)
    .values(insertValues as typeof transactionsTable.$inferInsert)
    .returning();
  res.status(201).json({ ...row, autoCategorizedRuleId });
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
      // Id of the mapping rule that auto-categorize currently attributes
      // for this sample in its *present* (pre-bulk-flip) category, or
      // null when no rule matches. Surfaces the same MatchedRuleChip
      // affordance in the "Show matches" preview dialog as the
      // Transactions / Amex / Dashboard surfaces. Note: by the time we
      // compute this the originating rule has *already* been repointed
      // away from `fromCategoryId`, so for samples whose only matching
      // rule was the one we just moved this is null — i.e. the chip
      // reads "manually categorized" until the user clicks Apply, which
      // moves the row into the rule's new category and restores
      // attribution.
      matchedRuleId: string | null;
    };
    type RepointedRule = {
      ruleId: string;
      pattern: string;
      matchType: ReturnType<typeof normalizeMatchType>;
      fromCategoryId: string;
      toCategoryId: string;
      candidateCount: number;
      sampleTransactions: RepointedRuleSample[];
    };
    // `ruleId` and `previousCategoryId` are populated for the kinds that
    // have an undoable side-effect on the user's mapping rules:
    //   - `created` / `created_priority_bump` → `ruleId` of the new rule
    //     so the client's Undo button can DELETE it.
    //   - `repointed` → `ruleId` of the touched rule + `previousCategoryId`
    //     (the rule's old aim) so Undo can PATCH the rule back to its
    //     previous category. The transaction's own categoryId is left
    //     alone — Undo only reverts the rule, not the user's manual pick.
    type RuleAction =
      | {
          kind: "none";
          pattern: null;
          genericPattern: null;
          ruleId: null;
          previousCategoryId: null;
          matchType: null;
          toCategoryId: null;
          candidateCount: null;
        }
      | {
          kind: "created";
          pattern: string;
          genericPattern: null;
          ruleId: string | null;
          previousCategoryId: null;
          matchType: "contains";
          toCategoryId: string;
          candidateCount: number;
        }
      | {
          kind: "created_priority_bump";
          pattern: string;
          genericPattern: string;
          ruleId: string | null;
          previousCategoryId: null;
          matchType: "contains";
          toCategoryId: string;
          candidateCount: number;
        }
      | {
          kind: "skipped_generic";
          pattern: string;
          genericPattern: string;
          ruleId: null;
          previousCategoryId: null;
          matchType: null;
          toCategoryId: null;
          candidateCount: null;
        }
      | {
          kind: "repointed";
          pattern: string;
          genericPattern: null;
          ruleId: string;
          previousCategoryId: string | null;
          matchType: null;
          toCategoryId: null;
          candidateCount: null;
        };
    const repointedRules: RepointedRule[] = [];
    let ruleAction: RuleAction = {
      kind: "none",
      pattern: null,
      genericPattern: null,
      ruleId: null,
      previousCategoryId: null,
      matchType: null,
      toCategoryId: null,
      candidateCount: null,
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

      // Track each repointed rule's pre-PATCH categoryId so we can hand
      // it back to the client for the Undo affordance on the toast.
      const repointedPrev = new Map<string, string | null>();
      for (const r of matchingSpecific) {
        if (r.categoryId === patch.categoryId) continue;
        repointedPrev.set(r.id, r.categoryId);
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
        // Re-load rules *after* the repoint so `matchedRuleId` reflects
        // the post-PATCH world the user will see in the preview dialog.
        // Cheap (handful of rows) and keeps the chip's semantics
        // consistent with GET /transactions.
        const rulesAfterRepoint = await loadUserRules(userId);
        const sampleTransactions: RepointedRuleSample[] = remaining
          .slice(0, 10)
          .map((c) => ({
            id: c.id,
            description: c.description ?? "",
            occurredOn: c.occurredOn,
            amount: c.amount,
            matchedRuleId: findMatchedRuleId(
              c.description,
              fromCategoryId,
              rulesAfterRepoint,
            ),
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
          // Look up any pre-existing rule for this pattern *before* the
          // upsert so we can capture its previous categoryId for the
          // explicit-remember repoint branch below.
          const existingForPattern = matching.find(
            (r) => r.pattern === pattern,
          );
          const previousCategoryId = existingForPattern?.categoryId ?? null;
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
          if (upsertResult.status !== "inserted") {
            // Repoint via the upsert path — only emit a `repointed`
            // RuleAction when the upsert actually moved the rule (i.e.
            // we have a ruleId AND the previous category differs from
            // the new pick). A pure noop has nothing to undo, so leave
            // ruleAction at "none" and let the client suppress the
            // toast description.
            if (upsertResult.ruleId && previousCategoryId !== patch.categoryId) {
              ruleAction = {
                kind: "repointed",
                pattern,
                genericPattern: null,
                ruleId: upsertResult.ruleId,
                previousCategoryId,
                matchType: null,
                toCategoryId: null,
                candidateCount: null,
              };
            }
          } else {
            // A brand-new specific rule was inserted. Count older
            // *uncategorized* rows that match this pattern (excluding
            // the row that triggered the auto-learn) so the client
            // can offer the same "apply to past charges?" prompt
            // already used for repointed rules. We deliberately scope
            // to uncategorized rows: any row the user previously
            // categorized by hand reflects explicit intent and should
            // be left alone (the bulk endpoint enforces the same
            // guard). The freshly-edited row itself is already on
            // `patch.categoryId` after the UPDATE above, so it falls
            // out of the uncategorized candidate pool naturally —
            // we only need to defensively exclude its id in case a
            // future change moves the categorize step.
            const candidates = await selectPatternCandidates(
              userId,
              { pattern, matchType: "contains" },
              null,
            );
            const candidateCount = candidates.filter(
              (c) => c.id !== row.id,
            ).length;
            if (matchingGeneric.length > 0) {
              // A different (non-colliding) generic rule still matches —
              // we left it alone and gave the new specific rule a higher
              // priority. Tell the user so they understand both rules
              // coexist and which one wins on future similar charges.
              const generic = matchingGeneric[0]!;
              ruleAction = {
                kind: "created_priority_bump",
                pattern,
                genericPattern: generic.pattern,
                ruleId: upsertResult.ruleId,
                previousCategoryId: null,
                matchType: "contains",
                toCategoryId: patch.categoryId,
                candidateCount,
              };
            } else {
              ruleAction = {
                kind: "created",
                pattern,
                genericPattern: null,
                ruleId: upsertResult.ruleId,
                previousCategoryId: null,
                matchType: "contains",
                toCategoryId: patch.categoryId,
                candidateCount,
              };
            }
          }
        } else if (pattern && collidingGeneric) {
          ruleAction = {
            kind: "skipped_generic",
            pattern,
            genericPattern: collidingGeneric.pattern,
            ruleId: null,
            previousCategoryId: null,
            matchType: null,
            toCategoryId: null,
            candidateCount: null,
          };
        }
      } else if (repointedRules.length > 0) {
        // At least one specific matching rule was repointed onto the
        // chosen category. The "apply to past" prompt covers the
        // candidate-count side; this summary just lets the client tell
        // the user which existing rule was reused — and now also lets
        // the client offer Undo to restore the rule's previous aim.
        const first = repointedRules[0]!;
        ruleAction = {
          kind: "repointed",
          pattern: first.pattern,
          genericPattern: null,
          ruleId: first.ruleId,
          previousCategoryId: repointedPrev.get(first.ruleId) ?? null,
          matchType: null,
          toCategoryId: null,
          candidateCount: null,
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
    const { pattern, matchType, fromCategoryId, toCategoryId, ids, ruleId } =
      parsed.data;
    // `fromCategoryId === null` means "rows currently uncategorized" — used
    // by the "apply to past charges?" prompt that follows a freshly created
    // mapping rule. The same-category short-circuit only applies when the
    // categories actually match (null is distinct from any category id).
    if (fromCategoryId !== null && fromCategoryId === toCategoryId) {
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
    // Optional rule re-point — used by the client's "Undo" affordance so
    // that reverting a bulk recategorize also reverses the mapping-rule
    // repoint that triggered it. Without this, future matching charges
    // would keep snapping onto the user's accidental category pick. We
    // do this unconditionally when `ruleId` is supplied (and we're past
    // the empty-ids degenerate-no-op guard above) so an Undo still
    // resets the rule even if the user has already manually re-edited
    // every affected row away from `fromCategoryId`. The ownership
    // filter on the UPDATE makes a stale or foreign `ruleId` a silent
    // no-op rather than an error, so callers can pass it
    // unconditionally.
    if (ruleId) {
      await db
        .update(mappingRulesTable)
        .set({ categoryId: toCategoryId })
        .where(
          and(
            eq(mappingRulesTable.id, ruleId),
            eq(mappingRulesTable.userId, userId),
          ),
        );
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
          fromCategoryId === null
            ? isNull(transactionsTable.categoryId)
            : eq(transactionsTable.categoryId, fromCategoryId),
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

/**
 * Bulk set the `forecast_flag` on a list of transactions to a target
 * boolean value. Mirrors the per-row PATCH behavior:
 *   - rows whose flag already matches the target are silently skipped
 *     (so the client's one-click "Undo" can re-issue the inverse with
 *     the affectedIds and naturally drop any rows the user has since
 *     toggled back by hand);
 *   - when the target is `false`, any forecast_resolutions pointing at
 *     the affected rows are also dropped so the Forecast inbox/bucket
 *     stays consistent.
 * Returns the ids that were actually flipped so the client can scope an
 * Undo whitelist to exactly those rows.
 */
router.post(
  "/transactions/bulk-set-forecast-flag",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = BulkSetForecastFlagBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const userId = req.userId!;
    const { ids, forecastFlag } = parsed.data;
    if (ids.length === 0) {
      res.json({ updated: 0, affectedIds: [] });
      return;
    }
    const updated = await db
      .update(transactionsTable)
      .set({ forecastFlag })
      .where(
        and(
          eq(transactionsTable.userId, userId),
          inArray(transactionsTable.id, ids),
          eq(transactionsTable.forecastFlag, !forecastFlag),
        ),
      )
      .returning({ id: transactionsTable.id });
    const affectedIds = updated.map((r) => r.id);
    if (!forecastFlag && affectedIds.length > 0) {
      await db
        .delete(forecastResolutionsTable)
        .where(
          and(
            eq(forecastResolutionsTable.userId, userId),
            inArray(forecastResolutionsTable.matchedTxnId, affectedIds),
          ),
        );
    }
    res.json({ updated: affectedIds.length, affectedIds });
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
