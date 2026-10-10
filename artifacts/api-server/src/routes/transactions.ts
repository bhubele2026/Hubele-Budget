import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, isNull, ilike, sql, inArray, notExists, or } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  transactionsTable,
  forecastResolutionsTable,
  mappingRulesTable,
  debtsTable,
  merchantAliasesTable,
  plaidAccountsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  categorize,
  directionGuard,
  findMatchedRuleId,
  isHeuristicTransfer,
  loadRuleContext,
  loadUserRules,
} from "../lib/autoCategorize";
import { runCategorizationBatch } from "../lib/categorizer";
import { selectPatternCandidates } from "../lib/patternCandidates";
import { expandSplits, loadSplitsForTxns } from "../lib/categorizer/splits";
import { recordHandFiling, recordUserDecisions } from "../lib/categorizer/userDecisions";
import type { RetroactiveCandidates } from "../lib/categorizer/memory";
import { forecastTodayISO } from "../lib/forecastInclusion";
import { recordRuleChange, ruleSnapshot } from "../lib/mappingRuleAudit";
import { cleanMerchant, merchantSignature } from "../lib/merchantNameExtract";
import { isUuid } from "../lib/bankLedger";
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
  PutMerchantAliasBody,
  DeleteMerchantAliasQueryParams,
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
    // (PR7b) No category, or one that no longer exists in this household. The
    // spending rule counts a row whose category was deleted as uncategorized
    // spend (`classifyOutflow`), so the Spending page's popover must be able to
    // list it; `category_id IS NULL` alone left it in the banner's total but
    // out of the list. Some delete paths null the rows; others do not.
    conds.push(
      or(
        isNull(transactionsTable.categoryId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(budgetCategoriesTable)
            .where(
              and(
                eq(budgetCategoriesTable.id, transactionsTable.categoryId),
                eq(budgetCategoriesTable.householdId, req.householdId!),
              ),
            ),
        ),
      )!,
    );
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
  if (q.data.plaidAccountId !== undefined) {
    // (WP7) One Plaid account's rows, by its external `account_id`: a card's own
    // ledger asks with it instead of the source list, so it never lists another
    // card's rows. Exact match. A row with no Plaid account (null, or the empty
    // string the sync treats as none) never matches, so an empty value matches
    // nothing rather than every row. Postgres refuses a NUL byte in text.
    const plaidAccountId = q.data.plaidAccountId;
    if (plaidAccountId.includes("\u0000")) {
      res.status(400).json({ error: "plaidAccountId must not contain a NUL byte" });
      return;
    }
    conds.push(plaidAccountId === "" ? sql`false` : eq(transactionsTable.plaidAccountId, plaidAccountId));
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
  // (#888) Load the household's merchant aliases once and key them by
  // signature so each row's displayName can prefer a user rename over the
  // deterministic cleanMerchant label. One query per list, not per row.
  const aliasRows = await db
    .select({
      signature: merchantAliasesTable.signature,
      alias: merchantAliasesTable.alias,
    })
    .from(merchantAliasesTable)
    .where(eq(merchantAliasesTable.householdId, req.householdId!));
  const aliasBySignature = new Map(aliasRows.map((a) => [a.signature, a.alias]));
  // (F4b) The parts of every VALID split on this page, in one query. A charge
  // whose splits do not add up (or are flagged invalid) gets no `splits` key
  // and counts whole, exactly as the server's category totals do.
  const partsByTxn = expandSplits(rows, await loadSplitsForTxns(req.householdId!, rows.map((r) => r.id)));
  const annotated = rows.map((r) => {
    // (#888) displayName precedence: a user/AI alias keyed on the row's
    // stable signature wins; otherwise fall back to cleanMerchant. Never
    // persisted — computed per-list so the stored description is untouched.
    const sig = merchantSignature(r.description);
    const alias = sig ? aliasBySignature.get(sig) : undefined;
    return {
      ...r,
      matchedRuleId: findMatchedRuleId(r.description, r.categoryId, userRules),
      // (#888) Stable signature exposed so the client can group rows and
      // tell the user how many transactions a rename will affect.
      merchantSignature: sig,
      displayName: alias ?? cleanMerchant(r.description),
      ...(partsByTxn.has(r.id) ? { splits: partsByTxn.get(r.id) } : {}),
    };
  });
  res.json(annotated);
});

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

/**
 * (WP8) Is this external Plaid `account_id` one of the household's accounts?
 * A created row may name its account; an id from nowhere, or from another
 * household, never lands on a row.
 *
 * (WP8b) An id the household's own rows already carry counts too: removing a
 * Plaid connection (DELETE /plaid/items) deletes its `plaid_accounts` rows but
 * keeps the transactions and their account id, and so does a dedupe that drops
 * a re-linked twin. A row placed beside those rows must still be accepted.
 */
async function householdKnowsPlaidAccount(householdId: string, externalId: string): Promise<boolean> {
  const [account] = await db
    .select({ id: plaidAccountsTable.id })
    .from(plaidAccountsTable)
    .where(and(eq(plaidAccountsTable.householdId, householdId), eq(plaidAccountsTable.accountId, externalId)))
    .limit(1);
  if (account) return true;
  const [onRow] = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.householdId, householdId), eq(transactionsTable.plaidAccountId, externalId)))
    .limit(1);
  return !!onRow;
}

/**
 * (WP8b) Where the charge a split part comes from lives: its `source` and Plaid
 * account. Null when the id is not a transaction of this household.
 */
async function splitParentOf(
  householdId: string,
  id: string,
): Promise<{ source: string; plaidAccountId: string | null } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select({ source: transactionsTable.source, plaidAccountId: transactionsTable.plaidAccountId })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.id, id), eq(transactionsTable.householdId, householdId)))
    .limit(1);
  return row ?? null;
}

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
  // ⭐ (WP8b) A SPLIT PART STAYS WHERE ITS CHARGE IS. With `splitOf` the part
  // takes the charge's `source` and Plaid account, whatever the body says: a
  // part of a card charge stays on the card even when the card's
  // `plaid_accounts` row is gone, and never lands on the checking ledger.
  const { splitOf: rawSplitOf, ...body } = parsed.data;
  const splitOf = rawSplitOf?.trim() || null;
  const parent = splitOf ? await splitParentOf(req.householdId!, splitOf) : null;
  if (splitOf && !parent) {
    res.status(400).json({ error: "Invalid splitOf", code: "invalid_split_parent" });
    return;
  }
  // (WP8) A row that names its Plaid account must name one of the household's.
  // Empty is "no account", as everywhere else.
  const plaidAccountId = parent ? parent.plaidAccountId || null : body.plaidAccountId?.trim() || null;
  if (!parent && plaidAccountId && !(await householdKnowsPlaidAccount(req.householdId!, plaidAccountId))) {
    res.status(400).json({ error: "Invalid plaidAccountId", code: "invalid_plaid_account" });
    return;
  }
  const source = parent ? parent.source : body.source;
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
    ...body,
    ...(source !== undefined ? { source } : {}),
    plaidAccountId,
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
  // (WP5d) Set when a rule would have filed this row against its direction.
  let directionConflict = false;
  if (!bodyHasCategoryId || !bodyHasIsTransfer) {
    const ruleCtx = await loadRuleContext(req.householdId!);
    const rules = ruleCtx.rules;
    // ⭐ (WP5d) The rule fill never files money in under an expense category,
    // nor money out under an income one: the row is stored uncategorized and
    // queued below, naming the rule. The row's own flags (a transfer, a debt,
    // reimbursable, the card-payment flag) are judged as the client sent them.
    const result = categorize(
      {
        description: parsed.data.description,
        pfcPrimary: null,
        pfcDetailed: null,
      },
      rules,
      directionGuard(ruleCtx, {
        amount: parsed.data.amount,
        source: source ?? "manual",
        accountType: null,
        ...(bodyHasIsTransfer ? { isTransfer: parsed.data.isTransfer ?? false } : {}),
        debtId: parsed.data.debtId ?? null,
        isExternalCardPayment: parsed.data.isExternalCardPayment ?? false,
        reimbursable: parsed.data.reimbursable ?? false,
      }),
    );
    directionConflict = !bodyHasCategoryId && result.directionConflict !== null;
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
    (await isTransferCategory(req.householdId!, parsed.data.categoryId))
  ) {
    insertValues.isTransfer = true;
    insertValues.isTransferUserOverridden = true;
    insertValues.weeklyAllowance = false;
    insertValues.monthlyAllowance = false;
    insertValues.unplannedAllowance = false;
  }
  // (PR-0) A category named in the body was chosen by a person, so the row
  // is born locked: the categorizer never moves it. A category the rules
  // auto-filled above is NOT locked.
  if (bodyHasCategoryId && parsed.data.categoryId) {
    insertValues.categoryLockedByUser = true;
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
  // (PR-A) A category a person named is a `user` decision on the new row.
  if (row && row.categoryLockedByUser) {
    await recordUserDecisions(db, req.householdId!, req.userId!, [
      { transactionId: row.id, previousCategoryId: null, categoryId: row.categoryId },
    ]);
  }
  // (WP5d) A rule left this row uncategorized because of its direction: run the
  // deterministic engine over it now, as a sync would, so the question is in
  // the review queue at once ("Money in, but this would file it under an
  // expense category", naming the rule). Non-fatal: the next categorize job
  // sweeps uncategorized rows anyway.
  let created = row;
  if (row && directionConflict) {
    try {
      await runCategorizationBatch(req.householdId!, {
        txnIds: [row.id],
        trigger: "manual",
        freshIds: new Set([row.id]),
      });
      // The engine may have filed it another way (a merchant memory): answer
      // with the row as it now stands.
      const [now] = await db
        .select()
        .from(transactionsTable)
        .where(and(eq(transactionsTable.id, row.id), eq(transactionsTable.householdId, req.householdId!)));
      if (now) created = now;
    } catch (e) {
      req.log?.warn?.({ err: e, txnId: row.id }, "[transactions] direction-conflict queue failed (non-fatal)");
    }
  }
  res.status(201).json({ ...created, autoCategorizedRuleId });
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
    // / XLSX import re-categorize passes won't re-flip the
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
      (await isTransferCategory(req.householdId!, patch.categoryId as string));
    const patchToApply: Record<string, unknown> = { ...patch };
    if (bodyHasIsTransfer || pickingCategory) {
      patchToApply.isTransferUserOverridden = true;
    }
    // (PR-0) A category picked here was picked by a person: lock it so the
    // categorizer never moves it. Clearing the category (`categoryId: null`)
    // clears the lock and hands the row back to the categorizer.
    if (bodyHasCategoryId) {
      patchToApply.categoryLockedByUser = pickingCategory;
      // (PR-A) A person answered it: no longer the engine's provisional pick.
      patchToApply.categoryProvisional = false;
    }
    // When the user manually moves a row to a different day (e.g. pulling a
    // "paid Saturday, posted Sunday" charge back into the correct Sun→Sat
    // allowance week), mark it overridden so the Plaid sync upsert preserves
    // the edited date instead of restamping it from Plaid on the next
    // `modified` row. Mirrors the `isTransferUserOverridden` guard above.
    const bodyHasOccurredOn = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "occurredOn",
    );
    if (bodyHasOccurredOn) {
      patchToApply.occurredOnUserOverridden = true;
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
    // (PR-A) The category before this write, for the `user` decision.
    const [before] = bodyHasCategoryId
      ? await db
          .select({ categoryId: transactionsTable.categoryId })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.id, params.data.id),
              eq(transactionsTable.householdId, req.householdId!),
            ),
          )
      : [];
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
    // (PR-A) mapping_rules are user-authored only: the 2-token auto-rule this
    // handler used to create (and the repoint of matching rules) is gone. A
    // category picked here is a `user` decision and teaches merchant memory
    // (the same path as POST /categorization/review/:id/correct); the rows it
    // would also fit come back as `retroactiveCandidates` and are NEVER moved
    // unless a person asks (POST /learned-rules/:id/apply-retroactively).
    // `repointedRules` / `ruleAction` stay in the response, always empty, so
    // the classic app's toasts simply do not fire.
    let retroactiveCandidates: RetroactiveCandidates | null = null;
    // (PR-A2) The decision this hand filing wrote and the learned rule it
    // taught or confirmed, so the client can undo / apply by id.
    let decisionId: string | null = null;
    let learnedRuleId: string | null = null;
    if (bodyHasCategoryId) {
      const filed = await recordHandFiling(req.householdId!, req.userId!, row.id, {
        previousCategoryId: before?.categoryId ?? null,
        categoryId: row.categoryId,
      });
      retroactiveCandidates = filed?.retroactiveCandidates ?? null;
      decisionId = filed?.decisionId ?? null;
      learnedRuleId = filed?.learnedRuleId ?? null;
    }
    // If forecast_flag was turned off on a FUTURE row, drop any forecast
    // resolution that points to it so the Forecast inbox/bucket stays
    // consistent. A row that has already happened is cash whatever its flag
    // says (`inForecast`) — it stays on the curve and in Review — so deleting
    // its match would only restart the bill it paid and count the money twice.
    if (
      parsed.data.forecastFlag === false &&
      row.occurredOn > forecastTodayISO()
    ) {
      await db
        .delete(forecastResolutionsTable)
        .where(
          and(
            eq(forecastResolutionsTable.householdId, req.householdId!),
            eq(forecastResolutionsTable.matchedTxnId, params.data.id),
          ),
        );
    }
    res.json({
      ...row,
      repointedRules: [],
      ruleAction: {
        kind: "none",
        pattern: null,
        genericPattern: null,
        ruleId: null,
        previousCategoryId: null,
        matchType: null,
        toCategoryId: null,
        candidateCount: null,
      },
      retroactiveCandidates,
      // Absent (not null) when no category was set; see the spec.
      ...(decisionId ? { decisionId } : {}),
      ...(learnedRuleId ? { learnedRuleId } : {}),
    });
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
    const {
      pattern,
      matchType,
      fromCategoryId,
      toCategoryId,
      ids,
      ruleId,
      lockedIds,
    } = parsed.data;
    // (#474) Reject any attempt to repoint a mapping rule onto an
    // `exclude_from_budget` category. The bulk-row UPDATE itself is
    // fine (the user may legitimately want to mark a batch of rows
    // as Uncategorized via Undo flows), but the optional `ruleId`
    // branch below would otherwise create a rule that auto-categorizes
    // future charges into Uncategorized — exactly what mapping.ts
    // forbids on direct CRUD. Guard only when a ruleId is supplied so
    // the row-only path keeps working.
    if (ruleId && (await isExcludedCategory(req.householdId!, toCategoryId))) {
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
    //
    // (WP5b) The re-point is a direct edit of the rule: it stamps
    // `updated_at` and records an "updated" history row in the same
    // transaction. A rule already on `toCategoryId` is left alone (nothing
    // to record), as is a stale or foreign id.
    if (ruleId) {
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(mappingRulesTable)
          .where(
            and(
              eq(mappingRulesTable.id, ruleId),
              eq(mappingRulesTable.householdId, req.householdId!),
            ),
          )
          .for("update");
        if (!before || before.categoryId === toCategoryId) return;
        const [after] = await tx
          .update(mappingRulesTable)
          .set({ categoryId: toCategoryId, updatedAt: sql`now()` })
          .where(eq(mappingRulesTable.id, before.id))
          .returning();
        await recordRuleChange(tx, {
          householdId: req.householdId!,
          ruleId: before.id,
          action: "updated",
          actor: userId,
          previous: ruleSnapshot(before),
          next: ruleSnapshot(after!),
          note: "Re-pointed together with a bulk move of past charges.",
        });
      });
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
    // (round 4, PR-D review note) This is a user action re-filing these rows
    // by hand: mark it the same way `PATCH /transactions/:id` does so
    // `effectiveFiling` (round 4) treats a re-file here exactly like a
    // one-off PATCH re-file, and so a future Plaid re-mint preserves the
    // pick (plaidSync.ts's `isTransferUserOverridden` preservation).
    // (PR-0) Which of these rows a person had already locked, BEFORE the
    // move: returned as `lockedIds` so the Undo can hand them back.
    const wasLocked = new Set(
      (
        await db
          .select({ id: transactionsTable.id })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, req.householdId!),
              inArray(transactionsTable.id, candidateIds),
              eq(transactionsTable.categoryLockedByUser, true),
            ),
          )
      ).map((r) => r.id),
    );
    // Only ids this call can move count (also keeps a malformed id out of SQL).
    const relockIds = lockedIds?.filter((id) => candidateIds.includes(id));
    const updated = await db
      .update(transactionsTable)
      .set({
        categoryId: toCategoryId,
        categoryProvisional: false,
        isTransferUserOverridden: true,
        // (PR-0) A person re-filed these rows, so they are locked — unless
        // this is an Undo carrying `lockedIds`, which restores each row's
        // lock exactly as it was before the move being undone.
        categoryLockedByUser:
          relockIds === undefined
            ? true
            : relockIds.length > 0
              ? inArray(transactionsTable.id, relockIds)
              : false,
      })
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
    // (PR-A) Each moved row is a `user` decision.
    await recordUserDecisions(
      db,
      req.householdId!,
      req.userId!,
      updated.map((r) => ({ transactionId: r.id, previousCategoryId: fromCategoryId, categoryId: toCategoryId })),
    );
    res.json({
      updated: updated.length,
      affectedMonths: Array.from(monthSet).sort(),
      affectedIds: updated.map((r) => r.id),
      lockedIds: updated.filter((r) => wasLocked.has(r.id)).map((r) => r.id),
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
    // (round 5, review H1) Bulk recategorize is an explicit user action —
    // BulkUpdateTransactionsBody's own description calls it that — exactly
    // like a one-off PATCH. Mirror PATCH /transactions/:id's
    // isTransferUserOverridden derivation (~:352-373) here: without it, a
    // pending row bulk-recategorized by hand (e.g. the Amex page's "Set
    // category" bulk action) never marks itself overridden, so
    // `effectiveFiling` (round 4) misreads it as automatic and a rule-filed
    // posted row's category can beat the household's bulk pick, or a bulk
    // pick on the POSTED row is silently outranked by a stale hand filing
    // on the pending row it replaced.
    const bulkBodyHasIsTransfer = Object.prototype.hasOwnProperty.call(
      patch,
      "isTransfer",
    );
    const bulkPickingCategory =
      Object.prototype.hasOwnProperty.call(patch, "categoryId") &&
      drizzlePatch.categoryId !== null &&
      drizzlePatch.categoryId !== undefined;
    if (bulkBodyHasIsTransfer || bulkPickingCategory) {
      (drizzlePatch as Record<string, unknown>).isTransferUserOverridden = true;
    }
    // (PR-0) Same lock rule as PATCH: a bulk category pick locks the rows; a
    // bulk clear (`categoryId: null`) unlocks them.
    const bulkSetsCategory = Object.prototype.hasOwnProperty.call(patch, "categoryId");
    if (bulkSetsCategory) {
      (drizzlePatch as Record<string, unknown>).categoryLockedByUser =
        bulkPickingCategory;
      (drizzlePatch as Record<string, unknown>).categoryProvisional = false;
    }
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
    // (PR-A) Categories before the write, for the `user` decisions.
    const bulkBefore =
      bulkSetsCategory && safeIds.length > 0
        ? new Map(
            (
              await db
                .select({ id: transactionsTable.id, categoryId: transactionsTable.categoryId })
                .from(transactionsTable)
                .where(
                  and(
                    eq(transactionsTable.householdId, req.householdId!),
                    inArray(transactionsTable.id, safeIds),
                  ),
                )
            ).map((r) => [r.id, r.categoryId] as const),
          )
        : null;
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
    let bulkDecisionIds: string[] = [];
    if (bulkBefore) {
      bulkDecisionIds = await recordUserDecisions(
        db,
        req.householdId!,
        req.userId!,
        updated.map((r) => ({
          transactionId: r.id,
          previousCategoryId: bulkBefore.get(r.id) ?? null,
          categoryId: (drizzlePatch.categoryId as string | null | undefined) ?? null,
        })),
      );
    }
    const okIds = new Set(updated.map((r) => r.id));
    // Mirror per-row PATCH cleanup: if forecast_flag was flipped off on a
    // FUTURE row, drop any forecast_resolutions pointing at it so the
    // Forecast inbox/bucket stays consistent. Rows that have already
    // happened keep theirs — they stay on the curve and in Review
    // (`inForecast`), so deleting a match would restart the bill it paid.
    const forecastToday = forecastTodayISO();
    const futureFlaggedOffIds =
      patch.forecastFlag === false
        ? updated.filter((r) => r.occurredOn > forecastToday).map((r) => r.id)
        : [];
    if (futureFlaggedOffIds.length > 0) {
      await db
        .delete(forecastResolutionsTable)
        .where(
          and(
            eq(forecastResolutionsTable.householdId, req.householdId!),
            inArray(forecastResolutionsTable.matchedTxnId, futureFlaggedOffIds),
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
      decisionIds: bulkDecisionIds,
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
      // (PR-0) No category, no lock: the row goes back to the categorizer.
      .set({ categoryId: null, categoryLockedByUser: false, categoryProvisional: false })
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
    // (PR-A) Each cleared row is a `user` decision (category null, unlocked).
    await recordUserDecisions(
      db,
      req.householdId!,
      req.userId!,
      updated.map((r) => ({ transactionId: r.id, previousCategoryId: fromCategoryId, categoryId: null })),
    );
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
 *     affected FUTURE rows are also dropped so the Forecast inbox/bucket
 *     stays consistent. Rows that have already happened keep theirs: they
 *     stay on the curve and in Review (`inForecast`), so deleting a match
 *     would restart the bill it paid and count the money twice.
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
      .returning({
        id: transactionsTable.id,
        occurredOn: transactionsTable.occurredOn,
      });
    const affectedIds = updated.map((r) => r.id);
    const forecastToday = forecastTodayISO();
    const futureFlaggedOffIds = !forecastFlag
      ? updated.filter((r) => r.occurredOn > forecastToday).map((r) => r.id)
      : [];
    if (futureFlaggedOffIds.length > 0) {
      await db
        .delete(forecastResolutionsTable)
        .where(
          and(
            eq(forecastResolutionsTable.householdId, req.householdId!),
            inArray(forecastResolutionsTable.matchedTxnId, futureFlaggedOffIds),
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
// transaction so the next Plaid sync / XLSX import pass
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
      // (PR-0) "Reset to auto" hands the row back to the automatic
      // categorizer too: the category lock goes with the transfer override.
      .set({ isTransferUserOverridden: false, categoryLockedByUser: false })
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

// (#888) Remove a merchant alias (reset the headline back to the bank
// default). Idempotent — deleting a non-existent alias is a no-op 200.
// IMPORTANT: declared BEFORE DELETE /transactions/:id so Express does not
// shadow this fixed path with the parameterized one.
router.delete(
  "/transactions/merchant-alias",
  requireAuth,
  async (req, res): Promise<void> => {
    const q = DeleteMerchantAliasQueryParams.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: q.error.message });
      return;
    }
    await db
      .delete(merchantAliasesTable)
      .where(
        and(
          eq(merchantAliasesTable.householdId, req.householdId!),
          eq(merchantAliasesTable.signature, q.data.signature),
        ),
      );
    res.json({ signature: q.data.signature, deleted: true });
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

// (#888 — Merchant rename & learn, Phase 1) Set/update a friendly merchant
// alias for a signature. The client passes a raw `description` (so the server
// owns signature derivation — the two must never drift) plus the `alias`. We
// compute the signature, upsert the household-scoped alias, and report how
// many existing transactions share that signature so the UI can say "applies
// to N transactions". An empty/whitespace alias is rejected (use DELETE to
// clear / reset to the bank default).
router.put(
  "/transactions/merchant-alias",
  requireAuth,
  async (req, res): Promise<void> => {
    const body = PutMerchantAliasBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const signature = merchantSignature(body.data.description);
    const alias = body.data.alias.trim();
    if (!signature) {
      res.status(400).json({ error: "Description has no stable merchant signature" });
      return;
    }
    if (!alias) {
      res.status(400).json({ error: "Alias must not be empty" });
      return;
    }
    const now = new Date();
    await db
      .insert(merchantAliasesTable)
      .values({
        householdId: req.householdId!,
        userId: req.userId!,
        signature,
        alias,
        source: "user",
      })
      .onConflictDoUpdate({
        target: [merchantAliasesTable.householdId, merchantAliasesTable.signature],
        set: { alias, userId: req.userId!, source: "user", updatedAt: now },
      });
    // Count existing rows that share this signature so the client can show
    // the blast radius. Signature is computed in JS (not SQL), so we load the
    // household's descriptions and count matches — bounded by the household's
    // transaction volume and only on an explicit rename action.
    const rows = await db
      .select({ description: transactionsTable.description })
      .from(transactionsTable)
      .where(eq(transactionsTable.householdId, req.householdId!));
    const affectedCount = rows.filter(
      (r) => merchantSignature(r.description) === signature,
    ).length;
    res.json({ signature, alias, affectedCount });
  },
);

export default router;
