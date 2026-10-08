// (AI-1) The MODEL stage. It sees only what the deterministic stages could not
// decide at 0.6 or more (index.ts hands it `ambiguous`), asks the model in
// batches of up to 20 through `runStructured({ task: 'categorize' })` (budget,
// caps and the usage ledger come with it), and returns StageResults. Whatever a
// model says is validated by code before any write (CLAUDE.md §1):
//
//   - the category must be one of the household's candidates (also a schema enum);
//   - a debt category only on a payment against a liability (see debtCategoryAllowed);
//   - split amounts must add up to the row to the cent, else the suggestion is dropped;
//   - `isTransfer` is never written: it turns the answer into a queue-only
//     "looks like a transfer" decision with no category;
//   - confidence is banded: high 0.85, medium 0.7, low 0.5. Only when the
//     household opted in AND the track record holds (modelGate.ts) does `high`
//     become 0.92 (auto). `validateModelResult` in index.ts enforces the same cap.
//
// The model never sees a raw description beyond `untrusted('merchant', …)` (200
// characters, markup escaped) and its cleaned form; priors are category names.
import { and, eq, inArray } from "drizzle-orm";
import { db, budgetCategoriesTable, plaidAccountsTable, plaidItemsTable } from "@workspace/db";
import { isAiEnabled } from "../../ai/client";
import { runStructured } from "../../ai/structured";
import { resolvePrompt } from "../../ai/prompts";
import {
  categorizeOutputSchema,
  type CandidateCategory,
  type CategorizeAnswer,
  type CategorizeInput,
  type CategorizeRowInput,
  type Confidence,
} from "../../ai/prompts/categorize.v1";
import { untrusted } from "../../ai/redact";
import type { AiFailureInfo } from "../../ai/types";
import { cleanMerchant } from "../merchantNameExtract";
import { isOutflow } from "./stages/heuristic";
import { loadPriors, weekdayOf } from "./modelPriors";
import type { EngineContext, EngineRow, StageResult } from "./types";

export interface ModelStage {
  readonly name: string;
  decide(
    householdId: string,
    rows: readonly EngineRow[],
    ctx: EngineContext,
  ): Promise<Map<string, StageResult>>;
}

export class NullModelStage implements ModelStage {
  readonly name = "null";
  async decide(): Promise<Map<string, StageResult>> {
    return new Map();
  }
}

export const MODEL_BATCH_SIZE = 20;
/** Confidence bands: what each of the model's three words is worth to the engine. */
export const MODEL_CONFIDENCE: Readonly<Record<Confidence, number>> = { high: 0.85, medium: 0.7, low: 0.5 };
/** `high` once the household's gate is open (bands.ts: ≥ 0.9 is auto). */
export const MODEL_AUTO_CONFIDENCE = 0.92;
/** A queue-only "looks like a transfer" opinion. */
export const MODEL_TRANSFER_CONFIDENCE = 0.5;

export interface AccountFacts {
  type: string | null;
  subtype: string | null;
  institutionSlug: string | null;
}

/**
 * A debt category is only for a payment ON a liability: money coming into a
 * credit or loan account, or the bank's own loan-payment hint on the paying
 * side. A coffee on a credit card is not a debt payment.
 */
export function debtCategoryAllowed(
  row: Pick<EngineRow, "amount" | "source" | "pfcPrimary">,
  account: AccountFacts | undefined,
): boolean {
  if (row.pfcPrimary?.toUpperCase().startsWith("LOAN_PAYMENTS")) return true;
  const liability = account?.type === "credit" || account?.type === "loan";
  return liability && !isOutflow(row);
}

/** Split amounts are positive parts that add up to the row's absolute amount, to the cent; ≥ 2 parts. */
export function validSplit(
  split: ReadonlyArray<{ categoryId: string; amount: number }> | null,
  rowAmount: number,
  candidateIds: ReadonlySet<string>,
): Array<{ categoryId: string; amount: number }> | null {
  if (!split || split.length < 2 || split.length > 20) return null;
  let sum = 0;
  for (const p of split) {
    if (!candidateIds.has(p.categoryId) || !Number.isFinite(p.amount) || p.amount <= 0) return null;
    sum += p.amount;
  }
  return Math.abs(sum - Math.abs(rowAmount)) <= 0.01 ? split.map((p) => ({ categoryId: p.categoryId, amount: p.amount })) : null;
}

/** What the job records beside a decision (ids and figures only, never bank text). */
export interface ModelDetail {
  isTransfer: boolean;
  recurring: { cadence: string; likely: boolean } | null;
  split: Array<{ categoryId: string; amount: number }> | null;
  confidenceWord: Confidence;
}

export interface JudgeContext {
  candidates: ReadonlyMap<string, CandidateCategory & { debtId: string | null }>;
  accounts: ReadonlyMap<string, AccountFacts>;
  autoAllowed: boolean;
  model: string;
  promptVersion: string;
}

/**
 * Turn one validated-by-schema answer into a StageResult, or null when code
 * rejects it. Pure.
 */
export function judgeAnswer(
  row: EngineRow,
  a: CategorizeAnswer,
  j: JudgeContext,
): { result: StageResult; detail: ModelDetail } | null {
  const rationale = a.rationale.replace(/\s+/g, " ").trim().slice(0, 140);
  const base = { source: "model" as const, model: j.model, promptVersion: j.promptVersion };
  const split = validSplit(a.splitSuggestion, Number(row.amount) || 0, new Set(j.candidates.keys()));
  const detail: ModelDetail = {
    isTransfer: a.isTransfer,
    recurring: a.recurringGuess ? { cadence: a.recurringGuess.cadence, likely: a.recurringGuess.likely } : null,
    split,
    confidenceWord: a.confidence,
  };
  if (a.isTransfer) {
    // Queue flag only: no category, no is_transfer write.
    return {
      detail,
      result: {
        ...base,
        categoryId: null,
        confidence: MODEL_TRANSFER_CONFIDENCE,
        explanation: "Looks like a move between your own accounts.",
      },
    };
  }
  const cat = j.candidates.get(a.categoryId);
  if (!cat) return null;
  if (cat.debtId && !debtCategoryAllowed(row, j.accounts.get(row.plaidAccountId ?? ""))) return null;
  const confidence = a.confidence === "high" && j.autoAllowed ? MODEL_AUTO_CONFIDENCE : MODEL_CONFIDENCE[a.confidence];
  const suffix = split ? " May be worth splitting." : "";
  const explanation = (rationale || "Suggested from similar charges.").slice(0, 140 - suffix.length) + suffix;
  return { detail, result: { ...base, categoryId: a.categoryId, confidence, explanation } };
}

export interface ModelUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface AnthropicModelStageOptions {
  /** The household's gate (modelGate.ts): may `high` write outright? */
  autoAllowed: boolean;
  runId?: string | null;
}

async function loadCandidates(householdId: string, ctx: EngineContext) {
  const rows = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      groupName: budgetCategoriesTable.groupName,
      kind: budgetCategoriesTable.kind,
      debtId: budgetCategoriesTable.debtId,
      excluded: budgetCategoriesTable.excludeFromBudget,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));
  return rows
    .filter((c) => !c.excluded && !ctx.uncategorizedIds.has(c.id))
    .sort((a, b) => a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function loadAccounts(householdId: string, rows: readonly EngineRow[]): Promise<Map<string, AccountFacts>> {
  const ids = [...new Set(rows.map((r) => r.plaidAccountId).filter((x): x is string => !!x))];
  const out = new Map<string, AccountFacts>();
  if (ids.length === 0) return out;
  const found = await db
    .select({
      accountId: plaidAccountsTable.accountId,
      type: plaidAccountsTable.type,
      subtype: plaidAccountsTable.subtype,
      institutionSlug: plaidItemsTable.institutionSlug,
    })
    .from(plaidAccountsTable)
    .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
    .where(and(eq(plaidAccountsTable.householdId, householdId), inArray(plaidAccountsTable.accountId, ids)));
  for (const f of found) {
    out.set(f.accountId, { type: f.type, subtype: f.subtype, institutionSlug: f.institutionSlug });
  }
  return out;
}

/** The real stage. One instance per job run: it carries the run's usage, failure and details. */
export class AnthropicModelStage implements ModelStage {
  readonly name = "anthropic";
  readonly usage: ModelUsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  /** The first failure of the run, if any; later batches are not attempted after a stop-worthy one. */
  failure: AiFailureInfo | null = null;
  /** Row id → what the model said beyond the category. */
  readonly details = new Map<string, ModelDetail>();
  /** Rows the model answered for (decided or rejected by code). */
  answered = 0;

  constructor(private readonly opts: AnthropicModelStageOptions) {}

  async decide(
    householdId: string,
    rows: readonly EngineRow[],
    ctx: EngineContext,
  ): Promise<Map<string, StageResult>> {
    const out = new Map<string, StageResult>();
    if (rows.length === 0) return out;
    const prompt = resolvePrompt("categorize");
    if (!prompt) return out;
    const candidateRows = await loadCandidates(householdId, ctx);
    if (candidateRows.length === 0) return out;
    const candidates = new Map(candidateRows.map((c) => [c.id, c]));
    const schema = categorizeOutputSchema(candidateRows.map((c) => c.id));
    const [accounts, priors] = await Promise.all([loadAccounts(householdId, rows), loadPriors(householdId, rows)]);

    for (let i = 0; i < rows.length; i += MODEL_BATCH_SIZE) {
      const chunk = rows.slice(i, i + MODEL_BATCH_SIZE);
      const inputs: CategorizeRowInput[] = chunk.map((r, index) => {
        const acct = r.plaidAccountId ? accounts.get(r.plaidAccountId) : undefined;
        const abs = Math.abs(Number(r.amount) || 0);
        return {
          index,
          merchant: untrusted("merchant", r.description),
          cleanMerchant: untrusted("clean", cleanMerchant(r.description)),
          amount: isOutflow(r) ? -abs : abs,
          weekday: weekdayOf(r.occurredOn),
          account: { type: acct?.type ?? null, subtype: acct?.subtype ?? null, institutionSlug: acct?.institutionSlug ?? null },
          pfc: r.pfcDetailed ?? r.pfcPrimary,
          pending: r.pending,
          priors: priors.get(r.id) ?? [],
        };
      });
      const input: CategorizeInput = {
        candidates: candidateRows.map((c) => ({ id: c.id, name: c.name, groupName: c.groupName, kind: c.kind })),
        rows: inputs,
      };
      const res = await runStructured({
        task: "categorize",
        householdId,
        runId: this.opts.runId ?? null,
        promptVersion: prompt.PROMPT_VERSION,
        schema,
        system: prompt.system,
        messages: prompt.build(input),
        validate: (v) => {
          const seen = new Set<number>();
          for (const r of v.results) {
            if (r.index < 0 || r.index >= chunk.length) return `Answer for a charge that was not asked about (${r.index})`;
            if (seen.has(r.index)) return `Two answers for charge ${r.index}`;
            seen.add(r.index);
          }
          return null;
        },
      });
      if (res.usage) {
        this.usage.calls += res.usage.attempts;
        this.usage.inputTokens += res.usage.inputTokens;
        this.usage.outputTokens += res.usage.outputTokens;
        this.usage.costUsd = this.usage.costUsd === null || res.usage.costUsd === null ? null : this.usage.costUsd + res.usage.costUsd;
      }
      if (!res.ok) {
        this.failure ??= res.failure;
        // Out of money, switched off, or the provider is struggling: later
        // batches would hit the same wall. Anything else (a bad answer) only
        // costs this batch.
        if (["budget_exceeded", "disabled", "rate_limited", "timeout", "connection", "api_error"].includes(res.failure.kind)) break;
        continue;
      }
      const judge: JudgeContext = {
        candidates,
        accounts,
        autoAllowed: this.opts.autoAllowed,
        model: res.usage.model,
        promptVersion: prompt.PROMPT_VERSION,
      };
      for (const a of res.value.results) {
        const row = chunk[a.index]!;
        this.answered += 1;
        const judged = judgeAnswer(row, a, judge);
        if (!judged) continue;
        out.set(row.id, judged.result);
        this.details.set(row.id, judged.detail);
      }
    }
    return out;
  }
}

/** The stage to run with: the real one when AI is on, otherwise the null one. */
export function makeModelStage(opts: AnthropicModelStageOptions): ModelStage {
  return isAiEnabled() ? new AnthropicModelStage(opts) : new NullModelStage();
}
