// Banking insights — smart, MERCHANT-LEVEL captions for the four reworked
// Banking buckets:
//   📉 spendingLess    — merchants you spent LESS on than the same point last
//                        month ("Starbucks −$18 · 3 fewer visits")
//   📈 creepingUp      — merchants creeping up + heavy dining/coffee habits,
//                        with an annual run-rate ("Mooyah ~$1,700/yr — cut back")
//   🚫 recurringToCut  — ONLY real cancellable subscriptions (Hulu, Paramount);
//                        restaurants/theaters are never here
//   ✨ newOrUnusual    — merchants new this month worth a glance
//
// Why this rework: the old buckets flagged a weekly burger (Mooyah) or a movie
// (Marcus Theatre) as a "subscription to cancel", leaked bills/Uncategorized/
// transfers into "wins", and were category-level (invisible to the advisor).
// Now every mover is a real merchant, grouped by the cross-month-stable
// merchantSignature(), classified by AI (Hulu = subscription, Mooyah = dining,
// Madison Gas = bill), with the noise filtered out by the shared isRealSpend().
//
// CLAUDE.md §1: EVERY dollar, %, count, and run-rate is computed in this file.
// The model does two language/judgment jobs only — classify each merchant
// (merchantClassify.ts) and write the headline + one-liner per bucket. It never
// does arithmetic. The per-row detail strings + figures are all code.
//
// Model note: the caption pass runs on Claude Fable 5 (its own DEFAULT_MODEL,
// not the shared ADVISOR_MODEL), same call shape as the other summary modules.

import Anthropic from "@anthropic-ai/sdk";
import { db, transactionsTable, budgetCategoriesTable } from "@workspace/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { logger } from "./logger";
import { VOICE_SYSTEM } from "./advisorVoice";
import { cleanMerchant, merchantSignature } from "./merchantNameExtract";
import { type SpendContext } from "./spendingFilter";
import { computeMerchantMom, type MerchantMomEntry } from "./merchantMomFacts";
import {
  classifyMerchants,
  HABIT_CLASSES,
  type ClassifyInput,
  type MerchantClass,
} from "./merchantClassify";
import {
  buildHouseholdFacts,
  formatDebtSliceForPrompt,
  type HouseholdFacts,
} from "./householdFacts";

const DEFAULT_MODEL = "claude-fable-5";
const MAX_OUTPUT_TOKENS = 700;
const ANTHROPIC_TIMEOUT_MS = 12_000;

// Tuning: below these a move is noise, not a story worth telling.
const MIN_DELTA = 8; // $ change vs last month to count as up/down
const RUNRATE_FLAG = 600; // annual $ that makes a dining/coffee habit worth surfacing
const MIN_NEW = 15; // $ a new merchant must clear to be "worth a glance"
const ROWS_PER_BUCKET = 8;

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (process.env.ADVISOR_ENABLED === "false") return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}
function getModel(): string {
  return process.env.BANKING_ADVISOR_MODEL || DEFAULT_MODEL;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${Math.abs(n) === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Output shapes (match openapi BankingInsightsSummary)
// ---------------------------------------------------------------------------

export type MoverTone = "positive" | "negative" | "neutral";

/** One pre-formatted merchant row — the client renders it verbatim. */
export interface BankingMoverRow {
  display: string; // merchant name
  detail: string; // secondary line ("$120 vs $138 last mo · 3 fewer visits")
  amount: number; // primary figure
  amountLabel: string; // "saved" | "more" | "/yr" | "spent"
  tone: MoverTone;
}

export interface BankingBucketCaption {
  headline: string;
  caption: string;
}

export interface BankingInsightsBucket extends BankingBucketCaption {
  rows: BankingMoverRow[];
}

export interface BankingInsightsSummaryRow {
  spendingLess: BankingInsightsBucket;
  creepingUp: BankingInsightsBucket;
  recurringToCut: BankingInsightsBucket;
  newOrUnusual: BankingInsightsBucket;
  summarySource: "ai" | "fallback";
  generatedAt: string;
}

const BUCKET_KEYS = [
  "spendingLess",
  "creepingUp",
  "recurringToCut",
  "newOrUnusual",
] as const;
type BucketKey = (typeof BUCKET_KEYS)[number];

// ---------------------------------------------------------------------------
// Deterministic facts
// ---------------------------------------------------------------------------

interface SubFact {
  signature: string;
  display: string;
  typical: number;
  monthly: number;
  annual: number;
  count: number;
  cadence: string;
}

export interface BankingInsightsFacts {
  monthLabel: string;
  daysElapsed: number;
  daysInMonth: number;
  spendingLess: { rows: BankingMoverRow[]; movers: MerchantMomEntry[]; totalSaved: number };
  creepingUp: { rows: BankingMoverRow[]; movers: MerchantMomEntry[]; totalIncrease: number };
  recurringToCut: { rows: BankingMoverRow[]; subs: SubFact[]; totalAnnual: number };
  newOrUnusual: { rows: BankingMoverRow[]; movers: MerchantMomEntry[] };
  /** Cross-tile debt-payoff picture so captions route saved dollars to the
   *  highest-APR debt (the household's North Star). Never affects any row. */
  household: HouseholdFacts;
  /** Narration-relevant subset used for the cache hash. */
  hashInput: unknown;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Recurring charges that are bills/debt/life expenses — a cheap pre-filter
// before classification so we don't even consider them as subscriptions.
const NOT_A_SUBSCRIPTION =
  /loan|mortgage|heloc|lending|leasing|\blease\b|servicing|credit\s*union|payroll|insur|utilit|electric|\bwater\b|sewer|tuition|univ|college|\btax(es)?\b|\bhoa\b|escrow|\brent\b|car\s*payment|card\s*payment|verizon|at&t|t-?mobile|comcast|xfinity|spectrum|cricket|kwik\s*trip|casey|speedway|shell|exxon|mobil|chevron|marathon|\bbp\b|holiday\s*station|grocer|kroger|aldi|costco|hy-?vee|woodman|metro\s*market|festival\s*foods|pick\s*n\s*save|walmart|target|\bach\b|autopay|transfer|wells\s*fargo|capital\s*one|\bdiscover\b|synchrony|barclays|comenity|navient|nelnet|sofi|venmo|paypal|zelle|cash\s*app/i;

function cadenceLabel(perYear: number): string {
  if (perYear === 52) return "weekly";
  if (perYear === 26) return "every 2 weeks";
  if (perYear === 12) return "monthly";
  if (perYear === 6) return "every 2 months";
  if (perYear === 4) return "quarterly";
  return "recurring";
}

interface RecurringCandidate {
  signature: string;
  display: string;
  typical: number;
  perYear: number;
  monthly: number;
  annual: number;
  count: number;
}

/**
 * Compact server-side recurring detector: same merchant signature, near-constant
 * amount, regular cadence over the last ~200 days. Deterministic. Only feeds the
 * "recurring to cut" bucket AFTER the merchant is classified as a subscription,
 * so a weekly Mooyah never survives to "cancel".
 */
function detectRecurring(
  txns: { occurredOn: string; description: string | null; amount: string; source: string | null }[],
): RecurringCandidate[] {
  const groups = new Map<
    string,
    { dates: string[]; amounts: number[]; display: string }
  >();
  for (const t of txns) {
    const raw = Number(t.amount) || 0;
    const spend = t.source === "amex" ? (raw > 0 ? raw : 0) : raw < 0 ? -raw : 0;
    if (spend <= 0) continue;
    const name = (t.description || "").trim();
    if (!name || NOT_A_SUBSCRIPTION.test(name)) continue;
    const sig = merchantSignature(name);
    if (!sig) continue;
    const g = groups.get(sig) ?? { dates: [], amounts: [], display: cleanMerchant(name) || name };
    g.dates.push(t.occurredOn.slice(0, 10));
    g.amounts.push(spend);
    groups.set(sig, g);
  }

  const out: RecurringCandidate[] = [];
  for (const [sig, g] of groups) {
    const dates = [...new Set(g.dates)].sort();
    if (dates.length < 3) continue;
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(
        (new Date(`${dates[i]}T00:00:00Z`).getTime() -
          new Date(`${dates[i - 1]}T00:00:00Z`).getTime()) /
          86_400_000,
      );
    }
    const gap = median(gaps);
    let perYear: number | null = null;
    if (gap >= 5 && gap <= 9) perYear = 52;
    else if (gap >= 12 && gap <= 18) perYear = 26;
    else if (gap >= 25 && gap <= 38) perYear = 12;
    else if (gap >= 55 && gap <= 70) perYear = 6;
    else if (gap >= 80 && gap <= 100) perYear = 4;
    if (perYear == null) continue;
    const typical = median(g.amounts);
    const varies = g.amounts.some((a) => Math.abs(a - typical) > typical * 0.25);
    if (varies) continue;
    const annual = round2(typical * perYear);
    out.push({
      signature: sig,
      display: g.display,
      typical: round2(typical),
      perYear,
      monthly: round2(annual / 12),
      annual,
      count: dates.length,
    });
  }
  return out.sort((a, b) => b.annual - a.annual);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Row builders (all formatting/arithmetic lives here, not in the model) ──

function momDetail(m: MerchantMomEntry, opts: { runRate?: boolean } = {}): string {
  const parts: string[] = [`${money(m.curSpend)} vs ${money(m.lastSpend)} last mo`];
  if (m.deltaVisits < 0) parts.push(`${plural(Math.abs(m.deltaVisits), "fewer visit", "fewer visits")}`);
  else if (m.deltaVisits > 0) parts.push(`${plural(m.deltaVisits, "more visit", "more visits")}`);
  if (opts.runRate && m.annualRunRate >= RUNRATE_FLAG)
    parts.push(`~${money(m.annualRunRate)}/yr`);
  return parts.join(" · ");
}

export async function buildBankingInsightsFacts(
  householdId: string,
  ownerUserId?: string,
): Promise<BankingInsightsFacts> {
  const today = new Date();
  const monthStart = isoDate(
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
  );
  const prevMonthStart = isoDate(
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
  );
  const daysInMonth = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const monthLabel = today.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  // ── Spend context: categories + debt linkage (shared noise filter) ──
  const cats = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      debtId: budgetCategoriesTable.debtId,
      kind: budgetCategoriesTable.kind,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));
  const categoriesById = new Map<
    string,
    { name: string; debtId: string | null; kind: string }
  >();
  const debtCategoryIds = new Set<string>();
  for (const c of cats) {
    categoriesById.set(c.id, { name: c.name, debtId: c.debtId, kind: c.kind });
    if (c.debtId) debtCategoryIds.add(c.id);
  }
  const ctx: SpendContext = { categoriesById, debtCategoryIds };

  // ── Merchant month-over-month (one scoped query, prevMonthStart → today) ──
  const momRows = await db
    .select({
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      source: transactionsTable.source,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, prevMonthStart),
      ),
    );
  const mom = computeMerchantMom(momRows, ctx, { now: today });

  // ── Recurring detection over ~200 days (for the subscription bucket) ──
  const from200 = isoDate(new Date(today.getTime() - 200 * 86_400_000));
  const recentTxns = await db
    .select({
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      source: transactionsTable.source,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, from200),
        lt(transactionsTable.occurredOn, isoDate(new Date(today.getTime() + 86_400_000))),
        eq(transactionsTable.isTransfer, false),
      ),
    );
  const recurring = detectRecurring(recentTxns);

  // ── Classify every merchant we might surface (AI, cached per signature) ──
  const classInputs = new Map<string, ClassifyInput>();
  for (const m of mom)
    classInputs.set(m.signature, {
      signature: m.signature,
      display: m.display,
      categoryName: m.categoryName,
    });
  for (const r of recurring)
    if (!classInputs.has(r.signature))
      classInputs.set(r.signature, {
        signature: r.signature,
        display: r.display,
        categoryName: null,
      });
  const classMap = await classifyMerchants([...classInputs.values()]);
  const classOf = (sig: string): MerchantClass =>
    classMap.get(sig)?.class ?? "other";
  const isHabit = (sig: string) => HABIT_CLASSES.has(classOf(sig));

  // ── 📉 Spending less: habit merchants down vs last month, biggest saves ──
  const lessMovers = mom
    .filter((m) => m.deltaAmount < -MIN_DELTA && isHabit(m.signature))
    .sort((a, b) => a.deltaAmount - b.deltaAmount); // most negative first
  const spendingLessRows: BankingMoverRow[] = lessMovers
    .slice(0, ROWS_PER_BUCKET)
    .map((m) => ({
      display: m.display,
      detail: momDetail(m),
      amount: Math.abs(m.deltaAmount),
      amountLabel: "saved",
      tone: "positive",
    }));
  const totalSaved = round2(
    lessMovers.reduce((s, m) => s + Math.abs(m.deltaAmount), 0),
  );

  // ── 📈 Creeping up: habits going up, plus heavy dining/coffee run-rates ──
  const creepMovers = mom
    .filter((m) => {
      if (!isHabit(m.signature)) return false;
      const cls = classOf(m.signature);
      const goingUp = m.deltaAmount > MIN_DELTA;
      const heavyHabit =
        (cls === "dining" || cls === "coffee") &&
        m.annualRunRate >= RUNRATE_FLAG;
      return goingUp || heavyHabit;
    })
    // Rank by the bigger of "how much it rose" and "how heavy the habit is".
    .sort(
      (a, b) =>
        Math.max(b.deltaAmount, b.annualRunRate / 12) -
        Math.max(a.deltaAmount, a.annualRunRate / 12),
    );
  const creepingUpRows: BankingMoverRow[] = creepMovers
    .slice(0, ROWS_PER_BUCKET)
    .map((m) => {
      const cls = classOf(m.signature);
      const runRate = cls === "dining" || cls === "coffee";
      const up = m.deltaAmount > MIN_DELTA;
      return {
        display: m.display,
        detail: momDetail(m, { runRate }),
        amount: up ? m.deltaAmount : m.curSpend,
        amountLabel: up ? "more" : "this mo",
        tone: "negative",
      };
    });
  const totalIncrease = round2(
    creepMovers.reduce((s, m) => s + Math.max(0, m.deltaAmount), 0),
  );

  // ── 🚫 Recurring to cut: ONLY merchants classified as subscriptions ──
  const subCandidates = recurring.filter(
    (r) => classOf(r.signature) === "subscription",
  );
  const subs: SubFact[] = subCandidates.slice(0, ROWS_PER_BUCKET).map((r) => ({
    signature: r.signature,
    display: r.display,
    typical: r.typical,
    monthly: r.monthly,
    annual: r.annual,
    count: r.count,
    cadence: cadenceLabel(r.perYear),
  }));
  const recurringToCutRows: BankingMoverRow[] = subs.map((s) => ({
    display: s.display,
    detail: `${money(s.monthly)}/mo · ${s.cadence} · ${plural(s.count, "charge")}`,
    amount: s.annual,
    amountLabel: "/yr",
    tone: "negative",
  }));
  const totalAnnual = round2(subCandidates.reduce((s, r) => s + r.annual, 0));

  // ── ✨ New or unusual: merchants new this month, above the noise floor ──
  const newMovers = mom
    .filter(
      (m) =>
        m.isNew &&
        m.curSpend >= MIN_NEW &&
        classOf(m.signature) !== "bill",
    )
    .sort((a, b) => b.curSpend - a.curSpend);
  const newOrUnusualRows: BankingMoverRow[] = newMovers
    .slice(0, ROWS_PER_BUCKET)
    .map((m) => ({
      display: m.display,
      detail: `first charge this month · ${plural(m.curVisits, "visit")}${
        m.categoryName ? ` · ${m.categoryName}` : ""
      }`,
      amount: m.curSpend,
      amountLabel: "spent",
      tone: "neutral",
    }));

  // Cross-tile debt-payoff picture (never throws; all-zeros fallback).
  const household = await buildHouseholdFacts(householdId, ownerUserId);

  const facts: BankingInsightsFacts = {
    monthLabel,
    daysElapsed: today.getUTCDate(),
    daysInMonth,
    spendingLess: { rows: spendingLessRows, movers: lessMovers.slice(0, ROWS_PER_BUCKET), totalSaved },
    creepingUp: { rows: creepingUpRows, movers: creepMovers.slice(0, ROWS_PER_BUCKET), totalIncrease },
    recurringToCut: { rows: recurringToCutRows, subs, totalAnnual },
    newOrUnusual: { rows: newOrUnusualRows, movers: newMovers.slice(0, ROWS_PER_BUCKET) },
    household,
    hashInput: null,
  };
  facts.hashInput = {
    m: monthLabel,
    sl: spendingLessRows.map((r) => [r.display, r.amount]),
    cu: creepingUpRows.map((r) => [r.display, r.amount]),
    rc: recurringToCutRows.map((r) => [r.display, r.amount]),
    nu: newOrUnusualRows.map((r) => [r.display, r.amount]),
    // Refresh captions when the target debt or safe-extra changes materially.
    dt: [household.targetDebt?.name ?? null, Math.round(household.maxSafeExtra)],
  };
  return facts;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `${VOICE_SYSTEM}

TASK: Caption four MERCHANT-LEVEL insight buckets on the household budget app's Banking page. The app has already computed every number and every row from the household's real transactions — you only write ONE short headline + ONE punchy one-line caption per bucket, narrating the merchant behavior in the FACTS. Never compute, never invent.

The four buckets:
- spendingLess: merchants they spent LESS on than the same point last month (real behavioral wins, e.g. "Starbucks down $18, 3 fewer visits"). Reinforce the pullback by name.
- creepingUp: merchants creeping UP, plus heavy eating-out / coffee habits with an annual run-rate. Call out the habit by name and the yearly pace; nudge them to cut back. This is dining/coffee/shopping behavior — NOT bills.
- recurringToCut: TRUE subscriptions worth cancelling (streaming/apps/memberships like Netflix, Hulu, Paramount). These are already filtered to real subscriptions — never call a restaurant, coffee shop, or store a subscription. Recommend cancelling and redirecting the money to debt payoff.
- newOrUnusual: merchants that showed up for the first time this month — worth a quick glance.

Output requirements:
- Respond with ONLY a JSON object, no markdown fence, no preamble.
- Schema: {"spendingLess": {"headline": string, "caption": string}, "creepingUp": {...}, "recurringToCut": {...}, "newOrUnusual": {...}}
- headline: ≤ 7 words.
- caption: ONE sentence, ≤ 25 words, referencing real merchant names/amounts from the FACTS only.

Rules:
- Whole dollars only (no cents).
- Be time-aware: it may be early in the month — frame partial-month numbers as "so far / on pace", never a partial period against a full one.
- NEVER invent numbers, names, or dates — only values in the FACTS block.
- If a bucket's facts are empty, write an honest one-liner saying it's clean / nothing to show yet.
- North Star: when spendingLess or recurringToCut has real dollars, tie the freed-up money back to the debt payoff — name the target debt from the DEBT-PAYOFF PICTURE and point the saved dollars at it (echo the Directive). Only do this when there's real savings; never fabricate a payoff figure — use only the DEBT-PAYOFF PICTURE numbers.`;

function bucketFactLines(title: string, rows: BankingMoverRow[]): string[] {
  const lines = [`${title}:`];
  if (rows.length === 0) {
    lines.push("  (nothing to show)");
    return lines;
  }
  for (const r of rows)
    lines.push(`  ${r.display}: ${money(r.amount)} ${r.amountLabel} — ${r.detail}`);
  return lines;
}

function formatFactsForPrompt(f: BankingInsightsFacts): string {
  const lines: string[] = [];
  lines.push(`MONTH: ${f.monthLabel} (day ${f.daysElapsed} of ${f.daysInMonth})`);
  lines.push("");
  lines.push(...bucketFactLines("SPENDING LESS (merchants down vs last month)", f.spendingLess.rows));
  if (f.spendingLess.totalSaved > 0)
    lines.push(`  Total pulled back: ${money(f.spendingLess.totalSaved)}`);
  lines.push("");
  lines.push(...bucketFactLines("CREEPING UP (habits climbing / heavy run-rate)", f.creepingUp.rows));
  lines.push("");
  lines.push(...bucketFactLines("RECURRING TO CUT (true subscriptions only)", f.recurringToCut.rows));
  if (f.recurringToCut.totalAnnual > 0)
    lines.push(`  Total subscription burn: ${money(f.recurringToCut.totalAnnual)}/yr`);
  lines.push("");
  lines.push(...bucketFactLines("NEW OR UNUSUAL (first-seen this month)", f.newOrUnusual.rows));
  const debtSlice = formatDebtSliceForPrompt(f.household);
  if (debtSlice) {
    lines.push("");
    lines.push(debtSlice);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

type ParsedCaptions = Record<BucketKey, BankingBucketCaption>;

function parseLLMResponse(raw: string): ParsedCaptions | null {
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
  const out = {} as ParsedCaptions;
  for (const key of BUCKET_KEYS) {
    const b = p[key];
    if (!b || typeof b !== "object") return null;
    const headline = String((b as Record<string, unknown>).headline ?? "").trim();
    const caption = String((b as Record<string, unknown>).caption ?? "").trim();
    if (!headline || !caption) return null;
    out[key] = { headline, caption };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic fallback captions (no AI) — merged with the code-built rows.
// ---------------------------------------------------------------------------

function fallbackCaptions(f: BankingInsightsFacts): ParsedCaptions {
  const sl = f.spendingLess.rows[0];
  const cu = f.creepingUp.rows[0];
  const rc = f.recurringToCut.rows[0];
  const nu = f.newOrUnusual.rows[0];
  return {
    spendingLess: sl
      ? {
          headline: "You pulled back here",
          caption: `${sl.display} is down ${money(sl.amount)} vs the same point last month${
            f.spendingLess.totalSaved > 0
              ? ` — ${money(f.spendingLess.totalSaved)} less across these merchants so far`
              : ""
          }.`,
        }
      : {
          headline: "Nothing down yet",
          caption: "No merchant is below last month's pace this early — check back as the month fills in.",
        },
    creepingUp: cu
      ? {
          headline: "Watch these creeping up",
          caption: `${cu.display} is running ${money(cu.amount)} ${cu.amountLabel} this month — worth easing off.`,
        }
      : {
          headline: "Nothing creeping up",
          caption: "No merchant is climbing versus last month right now. Keep it there.",
        },
    recurringToCut: rc
      ? {
          headline: "Subscriptions you could cut",
          caption: `${f.recurringToCut.subs.length} real subscription${f.recurringToCut.subs.length === 1 ? "" : "s"} detected — ${money(f.recurringToCut.totalAnnual)}/yr, led by ${rc.display}.`,
        }
      : {
          headline: "No subscriptions to cut",
          caption: "Nothing recurring-and-cancellable turned up — restaurants and stores don't count.",
        },
    newOrUnusual: nu
      ? {
          headline: "New this month",
          caption: `${nu.display} showed up for the first time this month at ${money(nu.amount)} — worth a glance.`,
        }
      : {
          headline: "Nothing new",
          caption: "No first-time merchants this month.",
        },
  };
}

export function buildFallbackSummary(
  f: BankingInsightsFacts,
): BankingInsightsSummaryRow {
  return mergeSummary(f, fallbackCaptions(f), "fallback");
}

function mergeSummary(
  f: BankingInsightsFacts,
  captions: ParsedCaptions,
  source: "ai" | "fallback",
): BankingInsightsSummaryRow {
  const bucket = (key: BucketKey, rows: BankingMoverRow[]): BankingInsightsBucket => ({
    headline: captions[key].headline,
    caption: captions[key].caption,
    rows,
  });
  return {
    spendingLess: bucket("spendingLess", f.spendingLess.rows),
    creepingUp: bucket("creepingUp", f.creepingUp.rows),
    recurringToCut: bucket("recurringToCut", f.recurringToCut.rows),
    newOrUnusual: bucket("newOrUnusual", f.newOrUnusual.rows),
    summarySource: source,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Anthropic call
// ---------------------------------------------------------------------------

async function callAnthropicWithTimeout(
  facts: BankingInsightsFacts,
): Promise<ParsedCaptions | null> {
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
    return parseLLMResponse(textBlock.text);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate the four bucket captions and merge them with the code-built rows.
 * Three-layer fallback: AI JSON → deterministic captions → minimal captions.
 * Rows are ALWAYS the code-computed merchant facts regardless of the caption
 * source, so the numbers never depend on the model.
 */
export async function generateBankingInsightsSummary(
  facts: BankingInsightsFacts,
): Promise<BankingInsightsSummaryRow> {
  try {
    const llm = await callAnthropicWithTimeout(facts);
    if (llm) return mergeSummary(facts, llm, "ai");
    logger.warn("banking-insights: LLM returned no usable captions, using fallback");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "banking-insights: LLM call failed, using fallback",
    );
  }
  try {
    return buildFallbackSummary(facts);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "banking-insights: fallback template failed, using minimal captions",
    );
    const minimal: BankingInsightsBucket = {
      headline: "Insights ready",
      caption: "The merchant movers are on the cards below.",
      rows: [],
    };
    return {
      spendingLess: { ...minimal, rows: facts.spendingLess.rows },
      creepingUp: { ...minimal, rows: facts.creepingUp.rows },
      recurringToCut: { ...minimal, rows: facts.recurringToCut.rows },
      newOrUnusual: { ...minimal, rows: facts.newOrUnusual.rows },
      summarySource: "fallback",
      generatedAt: new Date().toISOString(),
    };
  }
}
