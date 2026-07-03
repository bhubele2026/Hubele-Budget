// Merchant classifier — the "brain" behind the Banking insight buckets.
//
// The old buckets flagged Mooyah (a burger joint), Marcus Theatre (a cinema),
// and one-off card purchases as "recurring subscriptions to cancel" simply
// because a charge repeated weekly. A weekly MEAL is not a subscription. This
// module gives each merchant a TYPE so the buckets can tell:
//   - a real cancellable subscription (Hulu, Paramount, Netflix)  → "cancel"
//   - a discretionary habit (Mooyah dining, Starbucks coffee)     → behavioral nudge
//   - a real bill / utility / loan (Madison Gas, student loan)    → never "cancel"
//
// Per owner's explicit choice, the AI does the classification (it knows Hulu is
// streaming and Mooyah is a restaurant); our code still does every dollar.
// Classifying is judgment, not arithmetic — allowed under CLAUDE.md §1.
//
// Resilience mirrors merchantSuggest.ts: no key / disabled / timeout / parse
// failure → deterministic heuristic fallback, so a restaurant can NEVER land in
// "cancel" even when the AI is off. Results cache per merchantSignature so we
// don't re-spend tokens on the same merchant across runs.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

export type MerchantClass =
  | "subscription" // streaming / SaaS / membership you could cancel
  | "dining" // restaurants, fast food, bars
  | "coffee" // coffee shops
  | "shopping" // retail / online stores / general goods
  | "entertainment" // movies, events, games (pay-per-use, not a subscription)
  | "bill" // utilities, loans, insurance, rent, taxes, gas/fuel
  | "other";

export const MERCHANT_CLASSES: readonly MerchantClass[] = [
  "subscription",
  "dining",
  "coffee",
  "shopping",
  "entertainment",
  "bill",
  "other",
];

// Discretionary "habit" classes — the ones that belong in behavioral nudges
// ("eating out", "coffee runs") rather than in "cancel a subscription".
export const HABIT_CLASSES: ReadonlySet<MerchantClass> = new Set<MerchantClass>([
  "dining",
  "coffee",
  "shopping",
  "entertainment",
  "other",
]);

export interface ClassifyInput {
  signature: string;
  display: string;
  categoryName: string | null;
}

export interface ClassifyResult {
  signature: string;
  class: MerchantClass;
  source: "ai" | "fallback";
}

// Cheap/fast, high-volume mechanical labeling — Haiku, same knob as
// merchantSuggest.ts so both mechanical-cleanup calls tune together.
const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 900;
const ANTHROPIC_TIMEOUT_MS = 12_000;
const MAX_BATCH = 40; // cap merchants sent per call

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (process.env.ADVISOR_ENABLED === "false") return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}
function getModel(): string {
  return process.env.CATEGORIZE_MODEL || DEFAULT_MODEL;
}

// In-process cache keyed by signature (a household has a bounded merchant set).
const _cache = new Map<string, MerchantClass>();

// ---------------------------------------------------------------------------
// Deterministic heuristic fallback
// ---------------------------------------------------------------------------

// Bills / utilities / loans / fuel — never a "cancel this subscription".
const BILL_RE =
  /loan|mortgage|heloc|lending|leasing|\blease\b|servicing|credit\s*union|payroll|insur|geico|progressive|state\s*farm|allstate|utilit|\benergy\b|\bgas\s*(?:co|company|&|and)?\b|electric|\bmge\b|madison\s*gas|\bwe\s*energies\b|\bwater\b|sewer|waste|disposal|tuition|univ|college|\btax(es)?\b|\bhoa\b|escrow|\brent\b|property\s*mgmt|verizon|at&t|t-?mobile|comcast|xfinity|spectrum|cricket|internet|\bkwik\s*trip\b|casey|speedway|shell|exxon|mobil|chevron|marathon|\bbp\b|holiday\s*station|citgo|phillips\s*66|fuel|\bach\b|autopay/i;

// True consumer subscriptions — streaming, SaaS, memberships.
const SUBSCRIPTION_RE =
  /netflix|hulu|paramount|disney|\bhbo\b|\bmax\b|peacock|spotify|apple\s*(?:music|tv|one|icloud|\.com\/bill)|itunes|prime\s*video|amazon\s*prime|youtube\s*(?:premium|tv)|\bnyt\b|nytimes|wall\s*street\s*journal|\bwsj\b|washington\s*post|audible|kindle\s*unlimited|patreon|substack|adobe|dropbox|google\s*(?:one|storage)|github|notion|\bcanva\b|\bzoom\b|linkedin|chatgpt|openai|anthropic|claude|midjourney|xbox\s*(?:live|game)|playstation\s*(?:plus|network)|nintendo|\bpsn\b|planet\s*fitness|\banytime\s*fitness\b|\bgym\b|\blifetime\b|\bymca\b|peloton|\bhello\s*fresh\b|blue\s*apron|dollar\s*shave|instacart\+|walmart\+|doordash\s*dashpass|uber\s*one|ring\s*(?:protect)?|lastpass|1password|\bvpn\b/i;

const COFFEE_RE =
  /starbucks|dunkin|caribou|peet'?s|\bcoffee\b|espresso|\bcafe\b|\bcafé\b|dutch\s*bros|philz|scooter'?s|biggby/i;

const DINING_RE =
  /restaurant|grill|kitchen|\bpizza\b|\bpizzeria\b|burger|\bmooyah\b|\bculver'?s\b|mcdonald|wendy|\btaco\b|chipotle|qdoba|\bsushi\b|\bthai\b|\bramen\b|\bdiner\b|\bbar\s*&\s*grill\b|\bbistro\b|\bbrewing\b|\bbrewery\b|\bpub\b|\btavern\b|\beatery\b|\bdeli\b|bakery|\bsteakhouse\b|panera|subway|\bchick-?fil\b|jimmy\s*john|noodles?\s*&|\bfood\b|\bcantina\b|\bgrille\b|five\s*guys|\bihop\b|applebee|chili'?s|olive\s*garden|\bbbq\b|smokehouse|\bcatering\b|\bwings?\b/i;

const ENTERTAINMENT_RE =
  /theat(?:re|er)|cinema|\bmarcus\b|\bamc\b|\bimax\b|movie|fandango|ticketmaster|stubhub|\bconcert\b|\barcade\b|bowling|\bgolf\b|topgolf|\bmuseum\b|\bzoo\b|amusement|\bsix\s*flags\b|dave\s*&\s*buster|\bevent\b/i;

const SHOPPING_RE =
  /amazon(?!\s*prime)|\bwalmart\b|\btarget\b|\bcostco\b|\bbest\s*buy\b|\bkohl'?s\b|\bmacy'?s\b|\btj\s*maxx\b|marshalls|\bross\b|\bmenards\b|home\s*depot|\blowe'?s\b|\betsy\b|\bebay\b|\bstore\b|\bshop\b|\boutlet\b|\bmall\b|\bmarket\b|\bboutique\b|\bapparel\b|\bclothing\b|\bshoes?\b|\bnike\b|\badidas\b|\bulta\b|sephora|\bwalgreens\b|\bcvs\b|\bpharmacy\b/i;

/**
 * Deterministic classifier used as the AI fallback. Order matters: bills first
 * (so a "gas company" never looks like a subscription), then subscriptions,
 * then the discretionary buckets. Uses both the merchant name and its budget
 * category when available.
 */
export function classifyHeuristic(
  display: string,
  categoryName: string | null,
): MerchantClass {
  const hay = `${display} ${categoryName ?? ""}`.toLowerCase();
  const cat = (categoryName ?? "").toLowerCase();

  // Category is a strong signal when the app already tagged the txn.
  if (/util|electric|water|internet|phone|insurance|rent|mortgage|loan|fuel|\bgas\b/.test(cat))
    return "bill";
  if (/subscription|streaming/.test(cat)) return "subscription";
  if (/coffee/.test(cat)) return "coffee";
  if (/dining|restaurant|food\s*&|eating\s*out|fast\s*food/.test(cat)) return "dining";
  if (/entertain|movie/.test(cat)) return "entertainment";

  if (BILL_RE.test(hay)) return "bill";
  if (SUBSCRIPTION_RE.test(hay)) return "subscription";
  if (COFFEE_RE.test(hay)) return "coffee";
  if (ENTERTAINMENT_RE.test(hay)) return "entertainment";
  if (DINING_RE.test(hay)) return "dining";
  if (SHOPPING_RE.test(hay)) return "shopping";
  return "other";
}

// ---------------------------------------------------------------------------
// AI classification
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You label consumer merchants by TYPE for a personal budgeting app. Given a list of merchants (name + optional budget category), return the single best type for each.

Types (use EXACTLY one of these strings):
- "subscription": a recurring service you could cancel — streaming (Netflix, Hulu, Paramount, Disney+, Spotify), SaaS/apps (Adobe, iCloud, GitHub), memberships/gyms, news/audio subscriptions.
- "dining": restaurants, fast food, bars, delis, bakeries — anywhere you buy a meal. A weekly meal is NOT a subscription.
- "coffee": coffee shops (Starbucks, Dunkin, local cafes).
- "shopping": retail and online stores, pharmacies, general goods (Amazon, Target, Walmart, Best Buy).
- "entertainment": pay-per-use fun — movie theaters (Marcus, AMC), concerts, events, bowling, arcades. NOT a subscription.
- "bill": utilities, gas/fuel stations, insurance, loans, mortgage/rent, taxes, phone/internet — real obligations.
- "other": anything you can't confidently place.

Rules:
- A restaurant, coffee shop, movie theater, or store is NEVER a "subscription", even if it's charged often.
- Only streaming/SaaS/membership-style services are "subscription".
- Respond with ONLY a JSON array, no markdown fence, no preamble.
- Schema: [{"signature": string, "class": string}] — echo back each input's signature exactly, with its class.`;

function parseClassResponse(
  raw: string,
): Map<string, MerchantClass> | null {
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
  if (!Array.isArray(parsed)) return null;
  const out = new Map<string, MerchantClass>();
  const valid = new Set<string>(MERCHANT_CLASSES);
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const sig = typeof rec.signature === "string" ? rec.signature : null;
    const cls = typeof rec.class === "string" ? rec.class.trim().toLowerCase() : null;
    if (!sig || !cls || !valid.has(cls)) continue;
    out.set(sig, cls as MerchantClass);
  }
  return out;
}

async function callAnthropicWithTimeout(
  inputs: ClassifyInput[],
): Promise<Map<string, MerchantClass> | null> {
  const client = getClient();
  if (!client) return null;
  const list = inputs
    .map(
      (i) =>
        `- signature: ${JSON.stringify(i.signature)} | name: ${JSON.stringify(
          i.display,
        )}${i.categoryName ? ` | category: ${JSON.stringify(i.categoryName)}` : ""}`,
    )
    .join("\n");
  const userPrompt = `Merchants:\n${list}\n\nReturn the JSON array now.`;
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
    return parseClassResponse(textBlock.text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a set of merchants. Always resolves (never throws): AI first (cached
 * per signature), deterministic heuristic for anything the AI didn't cover or
 * when the AI is unavailable. Returns a map signature → result.
 */
export async function classifyMerchants(
  inputs: ClassifyInput[],
): Promise<Map<string, ClassifyResult>> {
  const out = new Map<string, ClassifyResult>();
  const seen = new Set<string>();
  const pending: ClassifyInput[] = [];

  for (const input of inputs) {
    if (!input.signature || seen.has(input.signature)) continue;
    seen.add(input.signature);
    const cached = _cache.get(input.signature);
    if (cached) {
      out.set(input.signature, {
        signature: input.signature,
        class: cached,
        source: "ai",
      });
    } else {
      pending.push(input);
    }
  }

  // Resolve the uncached ones via AI, in bounded batches.
  for (let i = 0; i < pending.length; i += MAX_BATCH) {
    const batch = pending.slice(i, i + MAX_BATCH);
    let aiMap: Map<string, MerchantClass> | null = null;
    try {
      aiMap = await callAnthropicWithTimeout(batch);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "merchant-classify: LLM call failed, using heuristic",
      );
      aiMap = null;
    }
    for (const input of batch) {
      const aiClass = aiMap?.get(input.signature);
      if (aiClass) {
        _cache.set(input.signature, aiClass); // cache successful AI labels only
        out.set(input.signature, {
          signature: input.signature,
          class: aiClass,
          source: "ai",
        });
      } else {
        out.set(input.signature, {
          signature: input.signature,
          class: classifyHeuristic(input.display, input.categoryName),
          source: "fallback",
        });
      }
    }
  }

  return out;
}
