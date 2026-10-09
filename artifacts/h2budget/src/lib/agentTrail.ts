import type { AgentAction, AgentActionType, AgentFinding } from "@workspace/api-client-react/features";

/**
 * (F3) What H2 did on its own, in words. Ported from the frozen h2 app's
 * `screens/activity/trailWords.ts` (never imported from it). Pure: the
 * "Handled by H2" panel and the dashboard's "Needs attention" panel both read
 * it, and it imports no generated hook (types only).
 *
 * Consecutive actions from one run of one type read as one line ("Filed 6
 * charges"); the line is undoable while any of them still can be.
 */
export interface TrailGroup {
  key: string;
  type: AgentActionType;
  title: string;
  /** The newest action's time (ISO). */
  at: string;
  actions: AgentAction[];
  /** Every action in the line has been undone. */
  undone: boolean;
  /** The ones Undo would reverse: reversible and not yet undone. */
  undoable: AgentAction[];
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace("{n}", String(n));
}

export function trailTitle(type: AgentActionType, n: number, findings: AgentFinding[] = [], targetIds: (string | null)[] = []): string {
  switch (type) {
    case "set_category":
      return plural(n, "Filed 1 charge", "Filed {n} charges");
    case "remember":
      return plural(n, "Remembered 1 merchant", "Remembered {n} merchants");
    case "propose":
      return plural(n, "Suggested a change", "Suggested {n} changes");
    case "wishlist":
      return plural(n, "Noted a wishlist item", "Noted {n} wishlist items");
    case "recap":
      return plural(n, "Sent a recap", "Sent {n} recaps");
    case "finding": {
      if (n === 1) {
        const f = findings.find((x) => x.id === targetIds[0]);
        return f?.kind === "duplicate_charge" ? "Flagged a possible duplicate" : "Flagged something to look at";
      }
      return `Flagged ${n} things to look at`;
    }
  }
}

export function groupTrail(actions: readonly AgentAction[], findings: AgentFinding[] = []): TrailGroup[] {
  const out: TrailGroup[] = [];
  for (const a of actions) {
    const last = out[out.length - 1];
    if (last && last.type === a.type && last.actions[0]!.runId === a.runId) {
      last.actions.push(a);
      continue;
    }
    out.push({ key: a.id, type: a.type, title: "", at: a.createdAt, actions: [a], undone: false, undoable: [] });
  }
  for (const g of out) {
    g.title = trailTitle(g.type, g.actions.length, findings, g.actions.map((a) => a.targetId));
    g.undone = g.actions.every((a) => a.undoneAt != null);
    g.undoable = g.actions.filter((a) => a.reversible && !a.undoneAt);
  }
  return out;
}

export const FINDING_TITLE: Record<AgentFinding["kind"], string> = {
  bill_increase: "A bill went up",
  category_acceleration: "Spending in a category is speeding up",
  shortfall_before_income: "Cash may run short before payday",
  duplicate_charge: "Possible duplicate charge",
  goal_behind: "A goal is behind",
  limit_near: "A spending limit is close",
  bank_stale: "Bank data is out of date",
};

const MONEY_KEY = /amount|total|shortfall|short|balance|cost|price|delta|increase|spent|limit|gap|buffer|payment/i;
const REF_KEY = /(^|[a-z])(id|ids|ref|refs)$/i;

function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface PayloadLine {
  label: string;
  value: string | number;
  /** The value is a money amount the server sent; render it as dollars. */
  money: boolean;
}

/**
 * A finding's payload as words and figures. The server sends ids (refs) and
 * numbers only; refs are left out, a number under a money-ish key reads as
 * dollars, anything else as a plain figure. Nothing is added up or derived.
 */
export function payloadLines(payload: Record<string, unknown>): PayloadLine[] {
  const lines: PayloadLine[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (REF_KEY.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) lines.push({ label: humanize(k), value: v, money: MONEY_KEY.test(k) });
    else if (typeof v === "string" && v !== "" && !/^[0-9a-f-]{16,}$/i.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(v)) lines.push({ label: humanize(k), value: n, money: MONEY_KEY.test(k) });
      else lines.push({ label: humanize(k), value: v, money: false });
    }
  }
  return lines;
}

/** The outcome of an action, as the person reads it. */
export const OUTCOME = {
  applied: "Done",
  proposed: "Suggested, waiting for you",
  needs_attention: "Needs you",
} as const;

/** The request and cache options for the trail and the open findings: one key, one set of options for every reader (CLAUDE.md section 2). */
export const TRAIL_LIMIT = 10;
export const FINDINGS_LIMIT = 10;
export const trailParams = { limit: TRAIL_LIMIT } as const;
export const findingsParams = { status: "open", limit: FINDINGS_LIMIT } as const;
export const AGENT_CACHE = { staleTime: 60_000, gcTime: 10 * 60_000 } as const;

/** Where a finding is worked on, when there is a page for it. */
export const FINDING_LINK: Partial<Record<AgentFinding["kind"], { href: string; label: string }>> = {
  shortfall_before_income: { href: "/forecast", label: "See forecast" },
  duplicate_charge: { href: "/transactions", label: "See charges" },
  bill_increase: { href: "/bills", label: "See bills" },
  category_acceleration: { href: "/budget", label: "See budget" },
  limit_near: { href: "/budget", label: "See budget" },
  bank_stale: { href: "/settings", label: "Open settings" },
};

export const SEVERITY_WORD: Record<AgentFinding["severity"], string> = { high: "Important", watch: "Watch", info: "Note" };

export function isStatus(e: unknown, status: number): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === status;
}
