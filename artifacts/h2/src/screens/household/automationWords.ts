import type {
  CategorizationRecentDecision,
  CategorizationRequirement,
  CategorizationSettingsModelMode,
} from "@workspace/api-client-react";

/** The words on the Automation screen, in one place so the tests can read them. */

export const MODE_LADDER: ReadonlyArray<{ key: CategorizationSettingsModelMode; text: string }> = [
  { key: "off", text: "Off — rules and memory only" },
  { key: "suggest", text: "Suggests — files what it is sure about as provisional and queues the rest; you confirm" },
  { key: "auto", text: "Files on its own — only after the record below holds" },
];

export const JUDGED_NOTE =
  "Judged = accepted or corrected in Review, or a provisional filing you left unchanged for 14 days.";

export const AI_STATUS = {
  configured: { yes: "Configured", no: "Not configured" },
  enabled: { yes: "On", no: "Off — turn on AI_ENABLED on the server" },
} as const;

export function engineLine(e: { rules: number; learned: number; recurring: number }): string {
  return `Rules you wrote: ${e.rules} · Learned from your corrections: ${e.learned} · Recurring bills: ${e.recurring}`;
}

/** "18 of 30 judged", "19 of 20 right"; the two switch rows carry no figure. */
export function requirementFigure(r: Pick<CategorizationRequirement, "key" | "current" | "target">): string | null {
  switch (r.key) {
    case "judged":
      return `${r.current} of ${r.target} judged`;
    case "accuracy":
    case "holding":
    case "floor":
      return `${r.current} of ${r.target} right`;
    default:
      return null;
  }
}

const SOURCE: Record<CategorizationRecentDecision["source"], string> = {
  rule: "Rule",
  memory: "Memory",
  recurring: "Recurring",
  inherited: "Carried over",
  model: "Model",
  user: "You",
  locked: "You",
  heuristic: "Pattern",
  refund: "Refund",
};
export const sourceWord = (s: CategorizationRecentDecision["source"]): string => SOURCE[s] ?? "Rule";

const BAND: Record<CategorizationRecentDecision["band"], string> = { auto: "Filed", provisional: "Provisional", queue: "Queued" };
export const bandWord = (b: CategorizationRecentDecision["band"]): string => BAND[b] ?? "Queued";

export function resolutionWord(d: Pick<CategorizationRecentDecision, "resolution" | "resolvedBy">): string {
  if (d.resolution === "accepted") return d.resolvedBy === "silent" ? "Accepted after 14 days" : "Accepted";
  if (d.resolution === "corrected") return "Corrected";
  if (d.resolution === "skipped") return "Skipped";
  return "Waiting";
}
