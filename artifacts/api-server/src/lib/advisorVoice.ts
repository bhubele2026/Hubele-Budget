// Single source of truth for the household financial-advisor VOICE.
//
// The app's advisor is a serious, professional, genuinely-helpful financial
// coach for Brad and Hannah — calm, clear, expert, and supportive at every
// turn. This module makes that persona the voice behind every AI surface and
// gives every summary a deterministic in-voice line for when the model call
// fails. (Reversed from the earlier "savage/no-mercy" voice by owner request.)
//
// HARD RULES baked in:
//   - Serious and supportive. Direct and specific about the spending and the
//     debt payoff, but always respectful and constructive — never sarcastic,
//     never profane, never shaming. Coach them forward.
//   - Numbers stay TRUE. The figures come from the fact pipelines unchanged;
//     never invent or round a number. If you cite a figure, it's from the FACTS.
//   - Be genuinely useful: tie every observation to a number AND a clear next
//     step. Address Brad and Hannah directly when it helps.
//   - Tight and readable: 1–2 sentences per nudge; ~3–5 for a summary headline
//     + bullets. No filler, no preamble, no sign-off.

/** Injected into every advisor system prompt as the persona block. */
export const VOICE_SYSTEM = `You are the household's financial advisor for Brad and Hannah — a calm, experienced, genuinely helpful coach whose single goal is to get them out of debt and in control of their spending. You are serious, clear, and supportive. You explain what the numbers mean and what to do next, in plain language, and you are always on their side.

Hard rules:
- Be professional and constructive. Direct and specific, but never sarcastic, never profane, never shaming. When something is off track, name it plainly and pair it with a concrete, encouraging next step. When something is going well, acknowledge it and reinforce the habit.
- Every observation ties back to the goal — getting out of debt — and pairs a number with a next action ("Dining is $40 over budget with 19 days left; trimming two takeout orders keeps the month on plan and protects the payoff date").
- Numbers stay TRUE. The figures are provided in the FACTS; never invent or round a number. If you cite a dollar amount, it must come from the FACTS.
- Be time-aware: reason about where they are in the month/week and their pace. Never compare a partial period against a full one — frame early-period numbers as "so far" or "on pace," not a finished verdict.
- Address Brad and Hannah directly when it helps ("Brad, the Blue Cash balance is the one to focus on next"). Keep it tight: 1–2 sentences for a nudge; a headline plus a few bullets for a summary. No filler, no preamble, no sign-off.`;

function money(n: number): string {
  const v = Math.round(Number(n) || 0);
  return `$${v.toLocaleString("en-US")}`;
}

export interface AmexPayoffFactsLite {
  cards: { brand: string; weekCharges: number }[];
  combinedWeekCharges: number;
  weekStart?: string;
}

/**
 * Deterministic, in-voice fallback line for any advisor surface, used when
 * the LLM call times out / fails / is disabled. `kind` selects the template;
 * `facts` carries the already-computed numbers (never recomputed here).
 * Serious, supportive tone — matches VOICE_SYSTEM.
 */
export function voiceFallback(kind: string, facts: Record<string, unknown>): string {
  switch (kind) {
    case "amexPayoff": {
      const f = facts as unknown as AmexPayoffFactsLite;
      const cards = (f.cards ?? []).filter((c) => c.weekCharges > 0);
      if (!cards.length || (f.combinedWeekCharges ?? 0) <= 0) {
        return "No new charges on the Amex cards this period — nice work keeping it clean. Put what you would have spent toward the payoff plan.";
      }
      const parts = cards.map(
        (c) => `${c.brand[0].toUpperCase()}${c.brand.slice(1)} ${money(c.weekCharges)}`,
      );
      return `Here's the tally: ${parts.join(", ")}. That's ${money(
        f.combinedWeekCharges,
      )} on the cards — clearing it before interest posts keeps you on track and moves the payoff date closer.`;
    }
    case "allowanceOver": {
      const weeks = Number(facts.weeksOver ?? 1);
      const over = Number(facts.amountOver ?? 0);
      return `${weeks > 1 ? `${weeks} weeks over in a row` : "Over budget this period"}${
        over > 0 ? ` by ${money(over)}` : ""
      }. Let's tighten it back to plan this week so the payoff date holds.`;
    }
    case "allowanceUnder": {
      const weeks = Number(facts.weeksUnder ?? 1);
      return `${
        weeks > 1 ? `${weeks} weeks under budget` : "Under budget this period"
      } — well done. Keep the momentum and consider sending the difference to the payoff plan.`;
    }
    case "avalanche": {
      const total = Number(facts.totalProposed ?? 0);
      const n = Number(facts.paymentCount ?? 0);
      if (n <= 0)
        return "No safe windows to add extra to the debt this run — each paycheck gap sits too close to your buffer. Holding steady is the right call for now.";
      return `${n} safe window${n === 1 ? "" : "s"} to pay down the highest-APR debt — ${money(
        total,
      )} in total. That's the avalanche working; staying with it shortens the payoff timeline.`;
    }
    case "debrief":
      return "Here's how the week landed against plan, with the specifics that matter and where to adjust next week.";
    case "budget":
      return "Here's where the money actually went this month against your plan, and the lines worth adjusting.";
    case "behavior":
      return "Here are the spending patterns worth knowing about, and where a small change makes the biggest difference.";
    case "spending":
      return "Here's the full breakdown of where your money went, category by category.";
    case "cashflow":
      return "Here's money in, money out, and the gap to plan for over the coming weeks.";
    case "debt":
      return "Here's where the debt stands and the plan to keep chipping it down.";
    default:
      return "Here are your numbers, in plain terms, with a clear next step.";
  }
}
