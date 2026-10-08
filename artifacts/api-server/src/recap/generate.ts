import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  agentFindingsTable,
  agentRunsTable,
  householdsTable,
  recapsTable,
  type Recap,
} from "@workspace/db";
import { runStructured } from "../ai/structured";
import { resolvePrompt } from "../ai/prompts";
import { RecapDraft } from "../ai/prompts/recap.v2";

import type { AiFailureInfo, AiResult, AiUsageSummary } from "../ai/types";
import { logger } from "../lib/logger";
import { recapFacts, type RecapFacts } from "./facts";
import { renderRecapTemplate, templateFindingId } from "./template";
import { maxTextFor, normalizeDraftText, validateRecapDraft } from "./validate";

// (AI-4a) One recap: facts (code) -> model draft (validated by code, one retry
// with the validator's message) -> else the deterministic template. The link is
// appended here, by code, never written by a model.
//
//   preview: true   nothing is stored: no recaps row, no agent_runs row (the
//                   model call still counts against the daily `recap` cap,
//                   because runStructured records it in ai_usage).
//   preview: false  one recaps row per (user, day), idempotent, and one
//                   agent_runs row per generation, with the model's tokens.

export function recapLink(forDate: string): string {
  const base = (process.env.APP_URL?.trim() || "https://h2budget.onrender.com").replace(/\/+$/, "");
  return `${base}/?d=${forDate}`;
}

export function withLink(text: string, forDate: string): string {
  return `${text} ${recapLink(forDate)}`;
}

/** The facts as a model may see them: no row ids. */
export function promptFacts(facts: RecapFacts): unknown {
  return { ...facts, findings: facts.findings.map(({ id: _id, ...rest }) => rest) };
}

export interface ModelDraft {
  /** Normalised text without the link, or null when the model gave nothing usable. */
  text: string | null;
  demo: boolean;
  model: string | null;
  promptVersion: string;
  failure: AiFailureInfo | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; attempts: number };
  factsUsed: string[];
}

function addUsage(acc: ModelDraft["usage"], u: AiUsageSummary | undefined): void {
  if (!u) return;
  acc.inputTokens += u.inputTokens;
  acc.outputTokens += u.outputTokens;
  acc.attempts += u.attempts;
  acc.costUsd = acc.costUsd === null || u.costUsd === null ? null : acc.costUsd + u.costUsd;
}

/**
 * The action line is chosen by code, so a draft that left it out gets it
 * appended; if that no longer validates (too long), the draft is dropped and
 * the template speaks instead.
 */
function withAction(text: string, facts: RecapFacts, link: string): string | null {
  const action = facts.action?.text;
  if (!action || text.includes(action)) return text;
  const next = `${text} ${action}`;
  return validateRecapDraft({ text: next, factsUsed: [] }, facts, { link }) === null ? next : null;
}

export async function draftWithModel(
  householdId: string,
  facts: RecapFacts,
  opts: { runId?: string | null } = {},
): Promise<ModelDraft> {
  const prompt = resolvePrompt("recap")!;
  const link = recapLink(facts.forDate);
  const out: ModelDraft = {
    text: null,
    demo: false,
    model: null,
    promptVersion: prompt.PROMPT_VERSION,
    failure: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, attempts: 0 },
    factsUsed: [],
  };
  let retryNote: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r: AiResult<RecapDraft> = await runStructured({
      task: "recap",
      householdId,
      runId: opts.runId ?? null,
      promptVersion: prompt.PROMPT_VERSION,
      schema: RecapDraft,
      system: prompt.system,
      messages: prompt.build({ facts: promptFacts(facts), retryNote }),
      validate: (v) => validateRecapDraft(v, facts, { link }),
    });
    addUsage(out.usage, r.usage);
    if (r.ok) {
      out.text = withAction(normalizeDraftText(r.value.text), facts, link);
      out.factsUsed = r.value.factsUsed;
      out.demo = r.demo;
      out.model = r.usage.model;
      out.failure = null;
      return out;
    }
    out.failure = r.failure;
    out.model = r.usage?.model ?? out.model;
    if (r.failure.kind === "validation_failed" && attempt === 1) {
      retryNote = r.failure.message;
      continue;
    }
    return out;
  }
  return out;
}

export interface GenerateOptions {
  preview?: boolean;
  ownerUserId?: string;
  trigger?: "user" | "schedule" | "retry";
  /** The pg-boss job id; a retried job reuses its agent_runs row. */
  jobId?: string;
}

export type GenerateResult =
  | {
      preview: true;
      facts: RecapFacts;
      model: { text: string; source: "model"; demo: boolean } | null;
      template: { text: string };
    }
  | { preview: false; created: boolean; recap: Recap };

async function ownerOf(householdId: string): Promise<string> {
  const [h] = await db.select({ owner: householdsTable.ownerUserId }).from(householdsTable).where(eq(householdsTable.id, householdId));
  if (!h) throw new Error("recap: household not found");
  return h.owner;
}

export async function generateRecap(
  householdId: string,
  userId: string,
  forDate: string,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const ownerUserId = opts.ownerUserId ?? (await ownerOf(householdId));

  if (!opts.preview) {
    const [existing] = await db
      .select()
      .from(recapsTable)
      .where(and(eq(recapsTable.userId, userId), eq(recapsTable.forDate, forDate)));
    if (existing) {
      if (existing.householdId !== householdId) throw new Error("recap: that member belongs to another household");
      return { preview: false, created: false, recap: existing };
    }
  }

  // One agent_runs row per stored generation (a retried job picks its row back up).
  let runId: string | null = null;
  if (!opts.preview) {
    let run: typeof agentRunsTable.$inferSelect | undefined;
    if (opts.jobId) {
      [run] = await db.select().from(agentRunsTable).where(eq(agentRunsTable.jobId, opts.jobId));
      if (run && run.householdId !== householdId) throw new Error("recap: job id belongs to another household");
    }
    if (run) {
      await db.update(agentRunsTable).set({ status: "running", error: null, finishedAt: null }).where(eq(agentRunsTable.id, run.id));
    } else {
      [run] = await db
        .insert(agentRunsTable)
        .values({
          householdId,
          kind: "recap",
          trigger: opts.trigger ?? "schedule",
          status: "running",
          ...(opts.jobId ? { jobId: opts.jobId } : {}),
        })
        .returning();
    }
    runId = run!.id;
  }

  try {
    const facts = await recapFacts(householdId, ownerUserId, userId, forDate);
    const link = recapLink(forDate);
    const templateText = renderRecapTemplate(facts, { maxLen: maxTextFor(link) });
    const model = await draftWithModel(householdId, facts, { runId });

    if (opts.preview) {
      return {
        preview: true,
        facts,
        model: model.text ? { text: withLink(model.text, forDate), source: "model", demo: model.demo } : null,
        template: { text: withLink(templateText, forDate) },
      };
    }

    const useModel = model.text !== null;
    const body = withLink(useModel ? model.text! : templateText, forDate);
    const inserted = await db
      .insert(recapsTable)
      .values({
        householdId,
        userId,
        forDate,
        facts,
        text: body,
        source: useModel ? "model" : "template",
        promptVersion: useModel ? model.promptVersion : null,
        model: useModel ? model.model : null,
        status: "drafted",
      })
      .onConflictDoNothing()
      .returning();
    let recap = inserted[0];
    if (!recap) {
      // A concurrent generation won the unique slot: use it.
      [recap] = await db
        .select()
        .from(recapsTable)
        .where(and(eq(recapsTable.userId, userId), eq(recapsTable.forDate, forDate)));
    }

    // Mark the one finding the text mentioned as surfaced (so tomorrow's does not repeat it).
    const mentioned = useModel
      ? model.factsUsed.includes("findings")
        ? (facts.findings.find((f) => !f.surfaced && f.severity !== "info")?.id ?? null)
        : null
      : templateFindingId(facts, { maxLen: maxTextFor(link) });
    if (mentioned && inserted[0]) {
      await db
        .update(agentFindingsTable)
        .set({ surfacedInRecapId: recap!.id })
        .where(
          and(
            eq(agentFindingsTable.id, mentioned),
            eq(agentFindingsTable.householdId, householdId),
            isNull(agentFindingsTable.surfacedInRecapId),
          ),
        );
    }

    const f = model.failure;
    const status = f?.kind === "refusal" ? "refused" : f?.kind === "budget_exceeded" ? "budget_exceeded" : "succeeded";
    const summary = useModel
      ? `model draft, ${model.usage.attempts} ${model.usage.attempts === 1 ? "call" : "calls"}`
      : `template (${f ? f.kind : "no model call"})`;
    await db
      .update(agentRunsTable)
      .set({
        status,
        finishedAt: new Date(),
        inputTokens: model.usage.inputTokens,
        outputTokens: model.usage.outputTokens,
        costUsd: model.usage.costUsd === null ? null : model.usage.costUsd.toFixed(6),
        summary: summary.slice(0, 300),
      })
      .where(eq(agentRunsTable.id, runId!));
    return { preview: false, created: !!inserted[0], recap: recap! };
  } catch (err) {
    if (runId) {
      await db
        .update(agentRunsTable)
        .set({ status: "failed", finishedAt: new Date(), error: (err instanceof Error ? err.message : String(err)).slice(0, 300) })
        .where(eq(agentRunsTable.id, runId))
        .catch((e) => logger.error({ err: e }, "recap: could not record the failure"));
    }
    throw err;
  }
}
