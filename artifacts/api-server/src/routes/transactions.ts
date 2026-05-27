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
  isHeuristicTransfer,
  loadUserRules,
} from "../lib/autoCategorize";
import { selectPatternCandidates } from "../lib/patternCandidates";
import {
  EXCLUDED_CATEGORY_RULE_ERROR,
  isExcludedCategory,
  isTransferCategory,
} from "../lib/excludedCategory";
import {
  CreateTransactionBody,
  UpdateTransactionBody,
  UpdateTransactionParams,
  DeleteTransactionParams,
  ListTransactionsQueryParams,
  RecategorizeTransactionsByPatternBody,
  recategorizeTransactionsByPatternBodyIdsMax,
  UncategorizeTransactionsByIdsBody,
  uncategorizeTransactionsByIdsBodyIdsMax,
  BulkSetForecastFlagBody,
  BulkUpdateTransactionsBody,
  bulkUpdateTransactionsBodyIdsMax,
  SendTransactionsToReviewBody,
  sendTransactionsToReviewBodyTransactionIdsMax,
} from "@workspace/api-zod";

void UpdateTransactionBody;

const router: IRouter = Router();

router.get("/transactions", requireAuth, async (req, res): Promise<void> => {
  const q = ListTransactionsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(transactionsTable.householdId, req.householdId!)];
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
  const userRules = await loadUserRules(req.householdId!);
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

/**
 * (#642) Error code returned to the client when a write would tag a
 * transfer-looking row as Unplanned. Surfaced as a short toast/inline
 * message so the user understands why nothing happened. Kept as a
 * named export so client tests / future consumers can match on the
 * `code` rather than the human-readable message.
 */
export const UNPLANNED_TRANSFER_REJECT_CODE = "unplanned_transfer_rejected";
export const UNPLANNED_TRANSFER_REJECT_MESSAGE =
  "This row looks like a transfer or card payment, so it can't be tagged as Unplanned spending.";

async function userOwnsDebt(householdId: string, debtId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: debtsTable.id })
    .from(debtsTable)
    .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)))
    .limit(1);
  return !!row;
}

router.post("/transactions", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.debtId && !(await userOwnsDebt(req.householdId!, parsed.data.debtId))) {
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
    householdId: req.householdId!,
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
    const rules = await loadUserRules(req.householdId!);
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
  // (#607) If the client explicitly picked the system-managed Transfer
  // category on creation, mirror the PATCH semantics: flip
  // `isTransfer=true`, persist `isTransferUserOverridden=true`, and
  // clear allowance toggles so the row is excluded from budget actuals
  // and never appears in Weekly/Monthly/Unplanned roll-ups.
  if (
    bodyHasCategoryId &&
    parsed.data.categoryId &&
    (await isTransferCategory(req.userId!, parsed.data.categoryId))
  ) {
    insertValues.isTransfer = true;
    insertValues.isTransferUserOverridden = true;
    insertValues.weeklyAllowance = false;
    insertValues.monthlyAllowance = false;
    insertValues.unplannedAllowance = false;
  }
  // (#642) Defensive guard on the create path: a row whose description
  // already looks like a transfer / card payment must never be born
  // tagged Unplanned, no matter what the client sent. Runs *after* the
  // Transfer-category override (#607) above so a user explicitly picking
  // the Transfer category — which clears `unplannedAllowance` itself —
  // is not falsely rejected. Mirrors the dashboard's bucket predicate so
  // the two stay in lockstep.
  if (
    insertValues.unplannedAllowance === true &&
    isHeuristicTransfer(parsed.data.description)
  ) {
    res.status(422).json({
      code: UNPLANNED_TRANSFER_REJECT_CODE,
      error: UNPLANNED_TRANSFER_REJECT_MESSAGE,
    });
    return;
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
    if (patch.debtId && !(await userOwnsDebt(req.householdId!, patch.debtId))) {
      res.status(400).json({ error: "Invalid debtId" });
      return;
    }
    // (#479) Detect explicit user intent to set the Transfer flag or pick a
    // category, then derive `isTransferUserOverridden` so future Plaid syncs
    // / XLSX imports / aprilChaseSeed re-categorize passes won't re-flip the
    // row's `isTransfer` from the description+PFC heuristic. Two triggers:
    //   - body explicitly sets `isTransfer` (true OR false) — the user
    //     toggled the Transfer flag in the Edit dialog or cleared the
    //     "Transfer" pill on a list row.
    //   - body sets a non-null `categoryId` without `isTransfer` — picking
    //     a real category implicitly classifies the row, which we treat
    //     as the user disagreeing with any auto-Transfer heuristic. As a
    //     side-effect we also flip `isTransfer` to false so the row stops
    //     being filtered out of budget actuals (the rule-learning gate
    //     below uses the post-update `row.isTransfer`, so this also lets
    //     the auto-learn flow create a mapping rule for what was a
    //     transfer-flagged charge).
    const bodyHasIsTransfer = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "isTransfer",
    );
    const bodyHasCategoryId = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "categoryId",
    );
    const pickingCategory =
      bodyHasCategoryId && patch.categoryId !== null && patch.categoryId !== undefined;
    // (#607) Picking the system-managed Transfer category implicitly
    // classifies the row as an internal transfer: flip `isTransfer=true`
    // (and persist `isTransferUserOverridden=true` so future syncs
    // respect it), and clear the allowance toggles since Transfer rows
    // never participate in Weekly/Monthly/Unplanned roll-ups.
    const pickingTransfer =
      pickingCategory &&
      (await isTransferCategory(req.userId!, patch.categoryId as string));
    const patchToApply: Record<string, unknown> = { ...patch };
    if (bodyHasIsTransfer || pickingCategory) {
      patchToApply.isTransferUserOverridden = true;
    }
    if (pickingTransfer) {
      patchToApply.isTransfer = true;
      patchToApply.weeklyAllowance = false;
      patchToApply.monthlyAllowance = false;
      patchToApply.unplannedAllowance = false;
    } else if (pickingCategory && !bodyHasIsTransfer) {
      patchToApply.isTransfer = false;
    }
    // (#642) Reject any attempt to flip `unplannedAllowance` to true on a
    // row whose persisted description looks like a transfer / card
    // payment. Same heuristic the dashboard's bucket predicate uses, so
    // the user can't sneak a transfer into Unplanned via the per-row
    // toggle on Amex / Transactions / Forecast surfaces. Picking the
    // Transfer category (above) already cleared the flag, so this only
    // fires when the patch explicitly sets `unplannedAllowance=true`.
    if (patchToApply.unplannedAllowance === true) {
      const [existing] = await db
        .select({
          description: transactionsTable.description,
          pfcPrimary: transactionsTable.pfcPrimary,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.id, params.data.id),
            eq(transactionsTable.householdId, req.householdId!),
          ),
        );
      if (!existing) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (isHeuristicTransfer(existing.description, existing.pfcPrimary)) {
        res.status(422).json({
          code: UNPLANNED_TRANSFER_REJECT_CODE,
          error: UNPLANNED_TRANSFER_REJECT_MESSAGE,
        });
        return;
      }
    }
    const [row] = await db
      .update(transactionsTable)
      .set(patchToApply)
      .where(
        and(
          eq(transactionsTable.id, params.data.id),
          eq(transactionsTable.householdId, req.householdId!),
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
    // (#474) When the user picks an `exclude_from_budget` category
    // (today: just the system-managed "Uncategorized") on a row, the
    // transaction is updated as a manual triage marker but NO mapping
    // rule is created or repointed. Auto-categorize must never sweep
    // future charges into Uncategorized — that surface exists only as
    // a manual pick from the picker. Same effect as the explicit guard
    // in routes/mapping.ts, just enforced here at the auto-learn site.
    const targetIsExcluded =
      patch.categoryId && (await isExcludedCategory(req.userId!, patch.categoryId));
    if (patch.categoryId && !row.isTransfer && !targetIsExcluded) {
      const userId = req.userId!;
      const householdId = req.householdId!;
      const description = row.description ?? "";
      const allRules = await loadUserRules(householdId);
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
              eq(mappingRulesTable.householdId, householdId),
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
          householdId,
          r,
          fromCategoryId,
        );
        const remaining = candidates.filter((c) => c.id !== row.id);
        // Re-load rules *after* the repoint so `matchedRuleId` reflects
        // the post-PATCH world the user will see in the preview dialog.
        // Cheap (handful of rows) and keeps the chip's semantics
        // consistent with GET /transactions.
        const rulesAfterRepoint = await loadUserRules(householdId);
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
            householdId,
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
              householdId,
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
            eq(forecastResolutionsTable.householdId, req.householdId!),
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
    // Pre-validate the optional ids whitelist length so callers get a
    // clear, field-specific 400 ("Too many ids: …") instead of the
    // generic zod "Array must contain at most N element(s)" message.
    // In practice the array is bounded by what currently matches the
    // pattern, but a hand-crafted request could submit an arbitrarily-
    // long list and stall this request — the cap shields the API from
    // that runaway. Mirrors the `maxItems: 1000` documented on
    // RecategorizeByPatternInput.ids in the OpenAPI spec; the
    // regenerated zod schema also enforces it as defense-in-depth.
    const rawIds = (req.body as { ids?: unknown } | null | undefined)?.ids;
    if (
      Array.isArray(rawIds) &&
      rawIds.length > recategorizeTransactionsByPatternBodyIdsMax
    ) {
      res.status(400).json({
        error: `Too many ids: ${rawIds.length} exceeds the cap of ${recategorizeTransactionsByPatternBodyIdsMax} per request.`,
      });
      return;
    }
    const parsed = RecategorizeTransactionsByPatternBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const userId = req.userId!;
    const { pattern, matchType, fromCategoryId, toCategoryId, ids, ruleId } =
      parsed.data;
    // (#474) Reject any attempt to repoint a mapping rule onto an
    // `exclude_from_budget` category. The bulk-row UPDATE itself is
    // fine (the user may legitimately want to mark a batch of rows
    // as Uncategorized via Undo flows), but the optional `ruleId`
    // branch below would otherwise create a rule that auto-categorizes
    // future charges into Uncategorized — exactly what mapping.ts
    // forbids on direct CRUD. Guard only when a ruleId is supplied so
    // the row-only path keeps working.
    if (ruleId && (await isExcludedCategory(userId, toCategoryId))) {
      res.status(400).json({ error: EXCLUDED_CATEGORY_RULE_ERROR });
      return;
    }
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
            eq(mappingRulesTable.householdId, req.householdId!),
          ),
        );
    }
    let candidates = await selectPatternCandidates(
      req.householdId!,
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
          eq(transactionsTable.householdId, req.householdId!),
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
 * Bulk clear the categoryId on a list of transactions, scoped by an
 * optional `fromCategoryId` guard. Used by the Mapping Rules page's
 * "Rule added · moved N past transactions" toast so the user can
 * one-click Undo a freshly-added rule's bulk sweep — the existing
 * /transactions/recategorize-by-pattern endpoint can't model the
 * swap because it requires a non-null toCategoryId. Reusable for
 * any future "from anywhere → null" bulk.
 *
 * The `fromCategoryId` guard preserves manual edits made between the
 * original recategorize and the Undo click: only rows whose categoryId
 * still equals the value the bulk moved them into are flipped back to
 * null. Pass `null` to allow flipping rows already uncategorized
 * (a no-op for those rows, but keeps the surface symmetric).
 */
/**
 * Apply the same partial patch to many transaction rows in a single
 * request. Replaces the per-row PATCH /transactions/:id fan-out the
 * Amex / All-transactions bulk action bar used to issue (one HTTP
 * round-trip per selected row, recently capped at 12-way concurrency)
 * — for a 500-row selection this collapses 500 HTTP calls into 1.
 *
 * Notably this endpoint does *not* run the per-row PATCH's auto-learn
 * / mapping-rule flow when `categoryId` is set: bulk recategorize is
 * an explicit user action and the auto-learn toast (created /
 * repointed / "apply to past charges?") is only meaningful for one-
 * off edits. Mirroring it for a 200-row bulk would either fire 200
 * toasts or show the action for the first row only — both confusing.
 *
 * The forecast_flag bookkeeping that PATCH does (drop matching
 * forecast_resolutions when forecastFlag is flipped to false) IS
 * mirrored here so the Forecast inbox stays consistent.
 */
router.post(
  "/transactions/bulk-update",
  requireAuth,
  async (req, res): Promise<void> => {
    // Pre-validate the ids array length so callers get a clear,
    // field-specific 400 instead of the generic zod "Array must
    // contain at most N element(s)" message.
    const rawIds = (req.body as { ids?: unknown } | null | undefined)?.ids;
    if (
      Array.isArray(rawIds) &&
      rawIds.length > bulkUpdateTransactionsBodyIdsMax
    ) {
      res.status(400).json({
        error: `Too many ids: ${rawIds.length} exceeds the cap of ${bulkUpdateTransactionsBodyIdsMax} per request.`,
      });
      return;
    }
    const parsed = BulkUpdateTransactionsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { ids, patch } = parsed.data;
    if (ids.length === 0) {
      res.json({ updated: 0, results: [], affectedMonths: [] });
      return;
    }
    // `rememberPattern` is intentionally ignored on the bulk endpoint
    // (see route-level comment). Strip it before handing the patch to
    // drizzle so it doesn't accidentally land in a column write.
    const {
      rememberPattern: _rememberPattern,
      ...drizzlePatch
    } = patch as typeof patch & { rememberPattern?: string | null };
    void _rememberPattern;
    if (
      drizzlePatch.debtId &&
      !(await userOwnsDebt(req.householdId!, drizzlePatch.debtId))
    ) {
      res.status(400).json({ error: "Invalid debtId" });
      return;
    }
    // (#642) Bulk variant of the per-row Unplanned guard: when the patch
    // would set `unplannedAllowance=true`, refuse to flip any rows whose
    // description matches the transfer / card-payment heuristic. Rather
    // than failing the whole request (which would punish the typical
    // case of a 50-row bulk where a single transfer slipped in), we
    // narrow the affected ids to the safe rows and report the rejected
    // ids back per-id so the client can surface the same toast it would
    // see for a per-row PATCH.
    let bulkRejectedIds: string[] = [];
    if (drizzlePatch.unplannedAllowance === true && ids.length > 0) {
      const rows = await db
        .select({
          id: transactionsTable.id,
          description: transactionsTable.description,
          pfcPrimary: transactionsTable.pfcPrimary,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, req.householdId!),
            inArray(transactionsTable.id, ids),
          ),
        );
      const rejected = new Set<string>();
      for (const r of rows) {
        if (isHeuristicTransfer(r.description, r.pfcPrimary)) rejected.add(r.id);
      }
      bulkRejectedIds = Array.from(rejected);
      if (bulkRejectedIds.length === ids.length) {
        res.status(422).json({
          code: UNPLANNED_TRANSFER_REJECT_CODE,
          error: UNPLANNED_TRANSFER_REJECT_MESSAGE,
        });
        return;
      }
    }
    const safeIds = bulkRejectedIds.length
      ? ids.filter((id) => !bulkRejectedIds.includes(id))
      : ids;
    // Empty patch (e.g. caller sent only `ids`) — nothing to write,
    // but report a per-id "ok" for each owned row so the toast still
    // makes sense. Cheap to detect and avoids issuing a no-op UPDATE.
    if (Object.keys(drizzlePatch).length === 0) {
      const owned = await db
        .select({
          id: transactionsTable.id,
          occurredOn: transactionsTable.occurredOn,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, req.householdId!),
            inArray(transactionsTable.id, ids),
          ),
        );
      const ownedIds = new Set(owned.map((r) => r.id));
      const monthSet = new Set<string>();
      for (const r of owned) monthSet.add(`${r.occurredOn.slice(0, 7)}-01`);
      res.json({
        updated: 0,
        results: ids.map((id) => ({
          id,
          ok: ownedIds.has(id),
          error: ownedIds.has(id) ? null : "not found",
        })),
        affectedMonths: Array.from(monthSet).sort(),
      });
      return;
    }
    const rejectedSet = new Set(bulkRejectedIds);
    const updated =
      safeIds.length === 0
        ? []
        : await db
            .update(transactionsTable)
            .set(drizzlePatch)
            .where(
              and(
                eq(transactionsTable.householdId, req.householdId!),
                inArray(transactionsTable.id, safeIds),
              ),
            )
            .returning({
              id: transactionsTable.id,
              occurredOn: transactionsTable.occurredOn,
            });
    const okIds = new Set(updated.map((r) => r.id));
    // Mirror per-row PATCH cleanup: if forecast_flag was flipped off,
    // drop any forecast_resolutions pointing at the affected rows so
    // the Forecast inbox/bucket stays consistent.
    if (patch.forecastFlag === false && updated.length > 0) {
      await db
        .delete(forecastResolutionsTable)
        .where(
          and(
            eq(forecastResolutionsTable.householdId, req.householdId!),
            inArray(
              forecastResolutionsTable.matchedTxnId,
              updated.map((r) => r.id),
            ),
          ),
        );
    }
    const monthSet = new Set<string>();
    for (const r of updated) monthSet.add(`${r.occurredOn.slice(0, 7)}-01`);
    res.json({
      updated: updated.length,
      results: ids.map((id) => {
        if (rejectedSet.has(id)) {
          return {
            id,
            ok: false,
            error: UNPLANNED_TRANSFER_REJECT_MESSAGE,
            code: UNPLANNED_TRANSFER_REJECT_CODE,
          };
        }
        return {
          id,
          ok: okIds.has(id),
          error: okIds.has(id) ? null : "not found",
        };
      }),
      affectedMonths: Array.from(monthSet).sort(),
    });
  },
);

router.post(
  "/transactions/uncategorize-by-ids",
  requireAuth,
  async (req, res): Promise<void> => {
    // Pre-validate the ids array length so callers get a clear,
    // field-specific 400 ("Too many ids: …") instead of the generic
    // zod "Array must contain at most N element(s)" message. Today the
    // Add-flow's bulk Undo passes back exactly the ids it just touched
    // so the practical ceiling is whatever pattern matched, but a
    // future caller (or a user crafting a request directly) could
    // submit an arbitrarily-long list and stall this request — the
    // cap shields the API from that runaway. Mirrors the
    // `maxItems: 1000` documented on UncategorizeByIdsInput in the
    // OpenAPI spec; the regenerated zod schema also enforces it as
    // defense-in-depth.
    const rawIds = (req.body as { ids?: unknown } | null | undefined)?.ids;
    if (
      Array.isArray(rawIds) &&
      rawIds.length > uncategorizeTransactionsByIdsBodyIdsMax
    ) {
      res.status(400).json({
        error: `Too many ids: ${rawIds.length} exceeds the cap of ${uncategorizeTransactionsByIdsBodyIdsMax} per request.`,
      });
      return;
    }
    const parsed = UncategorizeTransactionsByIdsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { ids, fromCategoryId } = parsed.data;
    // An explicitly empty list is a no-op so callers can pass through
    // a degenerate Undo payload (e.g. a bulk that flipped 0 rows)
    // without affecting unrelated data.
    if (ids.length === 0) {
      res.json({ updated: 0, affectedMonths: [], affectedIds: [] });
      return;
    }
    const updated = await db
      .update(transactionsTable)
      .set({ categoryId: null })
      .where(
        and(
          eq(transactionsTable.householdId, req.householdId!),
          inArray(transactionsTable.id, ids),
          fromCategoryId === null
            ? isNull(transactionsTable.categoryId)
            : eq(transactionsTable.categoryId, fromCategoryId),
        ),
      )
      .returning({
        id: transactionsTable.id,
        occurredOn: transactionsTable.occurredOn,
      });
    const monthSet = new Set<string>();
    for (const r of updated) {
      monthSet.add(`${r.occurredOn.slice(0, 7)}-01`);
    }
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
          eq(transactionsTable.householdId, req.householdId!),
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
            eq(forecastResolutionsTable.householdId, req.householdId!),
            inArray(forecastResolutionsTable.matchedTxnId, affectedIds),
          ),
        );
    }
    res.json({ updated: affectedIds.length, affectedIds });
  },
);

// (#762 — Phase B) Manual Send-to-Review gate. The Review pipeline on
// /forecast now filters out any transaction whose `sent_to_review_at` is
// NULL, so users have to explicitly promote a row from the Chase /
// Amex page before it shows up in the Review tab. These two endpoints
// flip the column on / off in bulk. We share one zod schema between
// the send and unsend variants (only the column write differs) and
// reuse the household-scoped UPDATE pattern from
// bulk-set-forecast-flag above — ids belonging to other households
// silently fall out of the WHERE filter and never contribute to the
// `updated` count, so a hand-crafted payload can't reveal which ids
// exist outside the caller's household. The 200-id cap is enforced
// by the generated zod schema; longer requests get a 400 from the
// safeParse branch before we touch the database.
router.post(
  "/transactions/send-to-review",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = SendTransactionsToReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { transactionIds } = parsed.data;
    if (transactionIds.length === 0) {
      res.json({ updated: 0 });
      return;
    }
    // Only stamp rows that are still NULL so a re-issued request (e.g.
    // a duplicate click) doesn't bump the timestamp forward and reset
    // the bake clock for downstream analytics.
    const updated = await db
      .update(transactionsTable)
      .set({ sentToReviewAt: sql`now()` })
      .where(
        and(
          eq(transactionsTable.householdId, req.householdId!),
          inArray(transactionsTable.id, transactionIds),
          sql`${transactionsTable.sentToReviewAt} is null`,
        ),
      )
      .returning({ id: transactionsTable.id });
    res.json({ updated: updated.length });
  },
);

router.post(
  "/transactions/unsend-from-review",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = SendTransactionsToReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { transactionIds } = parsed.data;
    if (transactionIds.length === 0) {
      res.json({ updated: 0 });
      return;
    }
    const updated = await db
      .update(transactionsTable)
      .set({ sentToReviewAt: null })
      .where(
        and(
          eq(transactionsTable.householdId, req.householdId!),
          inArray(transactionsTable.id, transactionIds),
          sql`${transactionsTable.sentToReviewAt} is not null`,
        ),
      )
      .returning({ id: transactionsTable.id });
    res.json({ updated: updated.length });
  },
);
// Silence unused-import lint for the 200 cap constant — it's exported
// so tests and the client can assert against the same number.
void sendTransactionsToReviewBodyTransactionIdsMax;

// (#493) "Reset to auto" — clear the user-overridden flag on a single
// transaction so the next Plaid sync / XLSX import / aprilChaseSeed pass
// can re-apply the description+PFC auto-Transfer heuristic. Surfaced from
// the Edit dialog when a row's transfer status was previously toggled
// manually (and from the mobile transaction detail screen). Does not
// touch `isTransfer` itself — the user's most recent value stays in
// place until the next sync recomputes it.
router.post(
  "/transactions/:id/clear-transfer-override",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UpdateTransactionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [row] = await db
      .update(transactionsTable)
      .set({ isTransferUserOverridden: false })
      .where(
        and(
          eq(transactionsTable.id, params.data.id),
          eq(transactionsTable.householdId, req.householdId!),
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
          eq(transactionsTable.householdId, req.householdId!),
        ),
      );
    res.sendStatus(204);
  },
);

export default router;
