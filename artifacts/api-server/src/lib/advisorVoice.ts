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
export const VOICE_SYSTEM = `You are the household's money coach for Brad and Hannah, and you are FURIOUS about their debt. Savage, profane, brutally funny, and 100% on their side — you scream at the spending because you want them free. Brad and Hannah have explicitly told you to go full no-mercy: swear, roast hard, twist the knife. You ride the spending decisions into the ground and call Brad and Hannah out BY NAME the second they slip. Short, vicious, specific to the actual numbers. You never pad, never apologize, never hedge.

Hard rules:
- Be profane and brutal — but aim EVERY shot at the SPENDING and the DEBT: the receipts, the splurges, the payoff date. Swearing is encouraged; "what the fuck was that $40 DoorDash bender" energy. Still off-limits, no exceptions: nothing about their looks, body, intelligence, or worth as people; no slurs; nothing sexual. Roast the purchase like it personally wronged you — never the person.
- Every nudge points back at the goal: GET THE FUCK OUT OF DEBT. Tie a roast to a number AND a next action ("you're $40 over on Dining, you animals — skip two takeaways and that's days off the payoff date").
- Numbers stay TRUE. The figures are handed to you in the FACTS; never invent or round a number just to land a joke. If you cite a dollar amount, it must be one from the FACTS.
- Name names. "Hannah, that's the third goddamn week over." "Brad, the Gold card is not going to pay its own ass off."
- Keep it tight. 1–2 sentences for a nudge; a headline plus a few bullets for a summary. No filler, no preamble, no sign-off.`;

function money(n: number): string {
  const v = Math.round(Number(n) || 0);
  return `$${v.toLocaleString("en-US")}`;
}

// Rotated by a caller-supplied index so repeated fallbacks don't read
// identically. Savage-but-fond — aimed at the spending behaviour, never the
// people (see VOICE_SYSTEM rules).
const RIBS = [
  "you menaces",
  "you reckless gremlins",
  "you absolute disasters",
  "you debt-hoarding goblins",
  "you wallet-arsonists",
];
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
        return "Not a single charge on the Amex cards last week. The hell is this, a miracle? Did you two forget how to spend money for once?";
      }
      const parts = cards.map(
        (c) => `${c.brand[0].toUpperCase()}${c.brand.slice(1)} ${money(c.weekCharges)}`,
      );
      return `Right, here's the tally: ${parts.join(", ")}. That's ${money(
        f.combinedWeekCharges,
      )} on plastic last week — clear it before the interest does, and that's a chunk off the payoff date.`;
    }
    case "allowanceOver": {
      const weeks = Number(facts.weeksOver ?? 1);
      const over = Number(facts.amountOver ?? 0);
      return `${weeks > 1 ? `${weeks} weeks straight over` : "Over again"}${
        over > 0 ? ` by ${money(over)}` : ""
      } — what the hell, ${rib(weeks)}. Rein it in before the payoff date slips again.`;
    }
    case "allowanceUnder": {
      const weeks = Number(facts.weeksUnder ?? 1);
      return `${
        weeks > 1 ? `${weeks} weeks under` : "Under budget"
      }. Well, shit — actual restraint. Don't let it go to your heads. Keep it up.`;
    }
    case "avalanche": {
      const total = Number(facts.totalProposed ?? 0);
      const n = Number(facts.paymentCount ?? 0);
      if (n <= 0)
        return "No safe windows to throw extra at the debt this run — every paycheck gap dips too close to the buffer. Hold steady.";
      return `${n} safe windows to bury the highest-APR debt — ${money(
        total,
      )} total. Brad, that's the avalanche doing its damn job. Don't you dare blink.`;
    }
    case "debrief":
      return "Here's the week, warts and all. Read it, wince, and for fuck's sake do better.";
    case "budget":
      return "The budget doesn't give a damn about your feelings. Here's where the money actually went.";
    case "behavior":
      return "Patterns don't lie. Here's exactly when your wallet turns into a clown.";
    case "spending":
      return "Every dollar ratted you out. Here's the goddamn receipt.";
    case "cashflow":
      return "Money in, money out, and the gaping hole you keep pretending isn't there.";
    case "debt":
      return "The debt's still here, still ugly, still winning. So is the plan. Move.";
    default:
      return "Here are your numbers. No sugar-coating, no mercy — just the truth.";
  }
}
