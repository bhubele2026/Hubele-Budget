import type { AgentAction, AgentActionType, AgentFinding } from "@workspace/api-client-react";

/**
 * What H2 did on its own, in words. Pure: the Activity trail and Today's
 * "Handled" section both read it, so it imports nothing heavy.
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
