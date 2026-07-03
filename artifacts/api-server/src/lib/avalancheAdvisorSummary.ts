// (#826 — Phase 2) Claude narrative for the Avalanche extra-payment
// schedule card on /forecast.
//
// Follows debriefAdvisorSummary.ts exactly: same Anthropic client setup,
// same DEFAULT_MODEL, same 12s timeout via AbortController, same 3-layer
// fallback (AI call → deterministic template on timeout/parse failure →
// single-line summary on outer exception).
//
// The numbers come from the DETERMINISTIC scheduler (avalancheScheduler.ts).
// Claude only narrates them — it never invents dates or amounts. Strict
// JSON output: { summary: string, paymentsText: string[] } where each
// paymentsText entry is one short string per proposal, index-aligned.

import Anthropic from "@anthropic-ai/sdk";
import type { AvalancheAdvisorSummary } from "@workspace/db";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";
import {
  type AvalancheScheduleFacts,
  shortDate,
} from "./avalancheScheduler";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 700;
const ANTHROPIC_TIMEOUT_MS = 12_000;

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (process.env.ADVISOR_ENABLED === "false") return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}
function getModel(): string {
  return process.env.ADVISOR_MODEL || DEFAULT_MODEL;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// "18 months (1 yr 6 mo)" — a readable duration for the payoff facts.
function monthsPhrase(n: number): string {
  const years = Math.floor(n / 12);
  const rem = n % 12;
  if (n < 12) return `${n} month${n === 1 ? "" : "s"}`;
  const yPart = `${years} yr${years === 1 ? "" : "s"}`;
  const mPart = rem > 0 ? ` ${rem} mo` : "";
  return `${n} months (${yPart}${mPart})`;
}

// Year-qualified date for the PROMPT facts only. shortDate() (used in the UI
// fallback) is year-less ("Jun 16"); handing the model year-less dates made it
// invent a year in prose ("July 2024" inside a 2026 plan). Always give the LLM
// the full year so it can't hallucinate one.
function fullDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: Narrate the household budget app's "Avalanche extra-payment schedule" card. The app has already computed a deterministic schedule of extra debt payments over the next ~12 months, each landing in a safe paycheck-to-paycheck window where the projected balance stays above the cash buffer. It has ALSO computed a deterministic payoff projection (how long until debt-free, and interest/months saved versus paying only minimums). Narrate these facts — never compute or invent.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"summary": string, "paymentsText": string[]}
- summary: 3-6 sentences that give the household a clear read on their debt payoff. Cover all three of these, using ONLY figures from the FACTS block:
  1. What's going RIGHT — e.g. attacking the highest-APR debt (name it), committing extra above the minimums, and the projected interest and months saved versus minimums-only.
  2. What's WRONG or at risk — e.g. an underwater debt (interest outrunning its minimum), the plan running out of runway (no debt-free date), a punishingly high APR, or a thin/low projected balance versus the cash buffer. If nothing is at risk, say the plan is on track — do NOT manufacture a problem.
  3. HOW LONG until debt-free — state the debt-free date and the months to freedom. If there is no debt-free date (underwater / never converges), say so plainly instead of inventing one.
  End with the total across all the proposed payments.
- paymentsText: EXACTLY one short string per proposed payment, in the SAME ORDER as the FACTS list them. Each is one short phrase like "Pay $750 on Jun 16, after Brad's paycheck". Use the real date and amount.

Rules:
- Whole dollars only (no cents).
- NEVER invent numbers or dates — only values present in the FACTS block. The figures are provided; never alter them. Never state a debt-free date or a months-to-freedom figure that isn't in the FACTS.
- If there are zero proposed payments, return an empty paymentsText array and a one-sentence summary explaining no safe windows were found (still note the debt-free date / months to freedom if the FACTS provide them).`;

function formatFactsForPrompt(facts: AvalancheScheduleFacts): string {
  const lines: string[] = [];
  const target = facts.currentAvalancheTarget;
  if (target) {
    lines.push(
      `AVALANCHE TARGET DEBT: ${target.debtName} (APR ${(target.apr * 100).toFixed(2)}%, balance ${money(target.balance)})`,
    );
  } else {
    lines.push("AVALANCHE TARGET DEBT: none (no active debt with a balance)");
  }
  lines.push(`Cash buffer: ${money(facts.cashBuffer)}`);
  lines.push(`Current bank balance: ${money(facts.bankBalance)}`);
  lines.push(
    `Lowest projected balance AFTER applying the schedule: ${money(facts.lowestPostScheduleBalance)}` +
      (facts.lowestPostScheduleDate ? ` on ${fullDate(facts.lowestPostScheduleDate)}` : ""),
  );
  lines.push(`Total across all payments: ${money(facts.totalProposed)}`);
  lines.push(`Number of payments: ${facts.proposedPayments.length}`);

  // PAYOFF PROJECTION — deterministic, from the shared simulator.
  const po = facts.payoff;
  lines.push("");
  lines.push("PAYOFF PROJECTION (deterministic — narrate, never recompute):");
  lines.push(`  Strategy: ${po.strategy}`);
  lines.push(`  Total active debt: ${money(po.totalDebt)}`);
  if (po.monthsToFreedom != null) {
    lines.push(`  Months until debt-free (with the plan): ${monthsPhrase(po.monthsToFreedom)}`);
  } else {
    lines.push(
      "  Months until debt-free (with the plan): NEVER within horizon — the plan does not fully pay off (a debt is underwater / minimums can't keep up)",
    );
  }
  lines.push(
    `  Debt-free date: ${po.debtFreeDate ? fullDate(po.debtFreeDate) : "none — plan does not converge"}`,
  );
  lines.push(`  Total interest paid under the plan: ${money(po.totalInterestProjected)}`);
  if (po.minOnlyMonthsToFreedom != null) {
    lines.push(`  Minimums-only would take: ${monthsPhrase(po.minOnlyMonthsToFreedom)}`);
  } else {
    lines.push("  Minimums-only: never pays off within horizon");
  }
  if (po.minOnlyTotalInterest != null) {
    lines.push(`  Minimums-only total interest: ${money(po.minOnlyTotalInterest)}`);
  }
  lines.push(`  Interest saved vs minimums-only: ${money(po.interestSavedVsMin)}`);
  if (po.monthsSavedVsMin != null) {
    lines.push(`  Months saved vs minimums-only: ${monthsPhrase(po.monthsSavedVsMin)}`);
  }
  lines.push(`  Any debt underwater (interest outruns its minimum): ${po.underwater ? "YES" : "no"}`);
  lines.push(`  Plan runs out of runway before payoff: ${po.ranOutOfTime ? "YES" : "no"}`);

  lines.push("");
  lines.push("PROPOSED PAYMENTS (in order):");
  facts.proposedPayments.forEach((p, i) => {
    lines.push(
      `  ${i + 1}. ${money(p.amount)} on ${fullDate(p.date)} ` +
        `(after ${p.paycheckAnchor}; window low ${money(p.lowestBetweenThisAndNextPaycheck)}, ` +
        `headroom ${money(p.headroom)}, confidence ${p.confidence})`,
    );
  });
  return lines.join("\n");
}

interface ParsedLLMSummary {
  summary: string;
  paymentsText: string[];
}

function parseLLMResponse(
  raw: string,
  expectedCount: number,
): ParsedLLMSummary | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  const paymentsText = Array.isArray(p.paymentsText)
    ? p.paymentsText.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];
  if (!summary) return null;
  // Guard against a mismatched count — the card index-aligns paymentsText
  // with the deterministic proposals, so a wrong-length array is unusable.
  if (paymentsText.length !== expectedCount) return null;
  return { summary, paymentsText };
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no AI)
// ---------------------------------------------------------------------------

/** Index-aligned per-payment strings built straight from the facts. */
function fallbackPaymentsText(facts: AvalancheScheduleFacts): string[] {
  return facts.proposedPayments.map(
    (p) => `Pay ${money(p.amount)} on ${shortDate(p.date)} after ${p.paycheckAnchor}`,
  );
}

/** Build a deterministic fallback summary from the facts alone. */
export function buildFallbackSummary(
  facts: AvalancheScheduleFacts,
): AvalancheAdvisorSummary {
  const paymentsText = fallbackPaymentsText(facts);
  const po = facts.payoff;
  // Deterministic "how long until debt-free" clause, reused by both branches.
  const timelineClause =
    po.monthsToFreedom != null
      ? `At this pace you're debt-free in ${monthsPhrase(po.monthsToFreedom)}` +
        (po.debtFreeDate ? ` — around ${shortDate(po.debtFreeDate)}, ${po.debtFreeDate.slice(0, 4)}` : "") +
        (po.interestSavedVsMin > 0
          ? `, saving ${money(po.interestSavedVsMin)} in interest versus minimums-only.`
          : ".")
      : po.underwater
        ? "A debt is underwater — its interest outruns its minimum, so minimums alone never clear it; the plan won't fully pay off until that changes."
        : "The plan doesn't fully pay off within the projection horizon yet.";
  let summary: string;
  if (facts.proposedPayments.length === 0) {
    summary =
      "No safe paycheck-to-paycheck windows were found over the next 12 months — every window dips too close to your cash buffer to free up an extra payment. " +
      timelineClause;
  } else {
    const target = facts.currentAvalancheTarget;
    const first = facts.proposedPayments[0];
    const targetPhrase = target
      ? `${target.debtName} (${(target.apr * 100).toFixed(2)}% APR)`
      : "your highest-APR debt";
    summary =
      `${facts.proposedPayments.length} safe windows over the next 12 months let you throw extra at ${targetPhrase}. ` +
      `The first sends ${money(first.amount)} on ${shortDate(first.date)} after ${first.paycheckAnchor}. ` +
      `Even after every payment, your projected balance stays at ${money(facts.lowestPostScheduleBalance)} at its lowest. ` +
      `${timelineClause} ` +
      `Total: ${money(facts.totalProposed)} across ${facts.proposedPayments.length} payments.`;
  }
  return {
    generatedAt: new Date().toISOString(),
    summary,
    paymentsText,
    source: "fallback",
  };
}

async function callAnthropicWithTimeout(
  facts: AvalancheScheduleFacts,
): Promise<ParsedLLMSummary | null> {
  const client = getClient();
  if (!client) return null;
  const userPrompt = `FACTS:\n${formatFactsForPrompt(facts)}\n\nWrite the JSON now.`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const res = await client.messages.create(
      {
        model: getModel(),
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: ctrl.signal },
    );
    const textBlock = res.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    return parseLLMResponse(textBlock.text, facts.proposedPayments.length);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate (and return) the Avalanche schedule narrative for the given
 * deterministic facts. Pure computation + AI call — does NOT persist;
 * the caller stores the result on forecast_settings.avalancheAdvisorSummary.
 *
 * Three-layer fallback, identical in spirit to generateDebriefSummary:
 *   1. AI call → usable JSON → return it (source "ai").
 *   2. Timeout / parse failure / no client → deterministic template
 *      (source "fallback").
 *   3. Any outer exception → single-line summary from facts (still
 *      source "fallback").
 */
export async function generateAvalancheSummary(
  facts: AvalancheScheduleFacts,
): Promise<AvalancheAdvisorSummary> {
  try {
    const llm = await callAnthropicWithTimeout(facts);
    if (llm) {
      return {
        generatedAt: new Date().toISOString(),
        summary: llm.summary,
        paymentsText: llm.paymentsText,
        source: "ai",
      };
    }
    logger.warn(
      "avalanche-advisor: LLM returned no usable summary, using fallback",
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "avalanche-advisor: LLM call failed, using fallback",
    );
  }
  try {
    return buildFallbackSummary(facts);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "avalanche-advisor: fallback template failed, using minimal summary",
    );
    return {
      generatedAt: new Date().toISOString(),
      summary: `Schedule ready: ${money(facts.totalProposed)} across ${facts.proposedPayments.length} payments.`,
      paymentsText: fallbackPaymentsText(facts),
      source: "fallback",
    };
  }
}
