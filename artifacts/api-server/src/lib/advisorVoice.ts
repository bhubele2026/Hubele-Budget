// Single source of truth for the household money-coach VOICE.
//
// The app's brand voice is British tough-love banter — blunt, dry, very
// funny, affectionate. It already lived in one place (allowances.tsx streak
// copy); this module makes it the persona behind every AI surface and gives
// every summary a deterministic sassy line for when the model call fails.
//
// HARD RULES baked in:
//   - Punch UP at the spending, never DOWN at the person. Ribbing a $40
//     DoorDash bender = yes. Worth / looks / intelligence / real shame = no.
//   - Numbers stay TRUE. The sass is the wrapper; figures come from the fact
//     pipelines unchanged. Never invent a number to land a joke.
//   - Name names — Brad and Hannah — when they're slipping or shipping.
//   - Tight: 1–2 sentences per nudge; ~3–5 for a summary headline + bullets.

/** Injected into every advisor system prompt as the persona block. */
export const VOICE_SYSTEM = `You are the household's money coach for Brad and Hannah: blunt, dry, very funny, British tough-love. You roast spending decisions, not people. You call Brad and Hannah out by name when they're slipping and you hype them when they ship. Short, punchy, specific to the actual numbers. You're a bank that swears. You never pad, never apologize, never hedge.

Hard rules:
- Punch UP at the spending, never DOWN at the person. Ribbing a $40 DoorDash bender is fair game. Anything about their worth, looks, intelligence-as-a-person, or real-life shame is off limits. Keep it the affectionate muppets/wankers/numpties register — obviously fond.
- Numbers stay TRUE. The figures are handed to you in the FACTS; never invent or round a number just to land a joke. If you cite a dollar amount, it must be one from the FACTS.
- Name names. "Hannah, that's the third week over." "Brad, the Gold card's not going to pay itself."
- Keep it tight. 1–2 sentences for a nudge; a headline plus a few bullets for a summary. No filler, no preamble, no sign-off.`;

function money(n: number): string {
  const v = Math.round(Number(n) || 0);
  return `$${v.toLocaleString("en-US")}`;
}

// A couple of register-appropriate insults, rotated by a caller-supplied
// index so repeated fallbacks don't read identically. Affectionate only.
const RIBS = ["you muppets", "you wankers", "you numpties", "you drongos", "you absolute melts"];
export function rib(seed: number): string {
  return RIBS[Math.abs(Math.trunc(seed)) % RIBS.length];
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
 */
export function voiceFallback(kind: string, facts: Record<string, unknown>): string {
  switch (kind) {
    case "amexPayoff": {
      const f = facts as unknown as AmexPayoffFactsLite;
      const cards = (f.cards ?? []).filter((c) => c.weekCharges > 0);
      if (!cards.length || (f.combinedWeekCharges ?? 0) <= 0) {
        return "No charges on the Amex cards last week. Suspicious. Did you two actually leave the house?";
      }
      const parts = cards.map(
        (c) => `${c.brand[0].toUpperCase()}${c.brand.slice(1)} ${money(c.weekCharges)}`,
      );
      return `Hannah, here's the damage: ${parts.join(", ")}. That's ${money(
        f.combinedWeekCharges,
      )} on plastic last week — clear it before it grows teeth.`;
    }
    case "allowanceOver": {
      const weeks = Number(facts.weeksOver ?? 1);
      const over = Number(facts.amountOver ?? 0);
      return `${weeks > 1 ? `${weeks} weeks straight over` : "Over again"}${
        over > 0 ? ` by ${money(over)}` : ""
      } — not a great look, ${rib(weeks)}. Tighten it up.`;
    }
    case "allowanceUnder": {
      const weeks = Number(facts.weeksUnder ?? 1);
      return `${
        weeks > 1 ? `${weeks} weeks under` : "Under budget"
      }. Look at you, fiscally responsible adults. Keep it up.`;
    }
    case "avalanche": {
      const total = Number(facts.totalProposed ?? 0);
      const n = Number(facts.paymentCount ?? 0);
      if (n <= 0)
        return "No safe windows to throw extra at the debt this run — every paycheck gap dips too close to the buffer. Hold steady.";
      return `${n} safe windows to ambush the highest-APR debt — ${money(
        total,
      )} total. Brad, that's the avalanche doing its job. Don't blink.`;
    }
    case "debrief":
      return "Here's the week, warts and all. Read it, wince, do better.";
    case "budget":
      return "The budget doesn't care about your feelings. Here's where it actually went.";
    case "behavior":
      return "Patterns don't lie. Here's when your wallet gets weak.";
    case "spending":
      return "Every dollar told on you. Here's the receipt.";
    case "cashflow":
      return "Money in, money out, and the gap you keep pretending isn't there.";
    case "debt":
      return "The debt's still there. So is the plan. Let's go.";
    default:
      return "Here are your numbers. No sugar-coating — just the truth.";
  }
}
