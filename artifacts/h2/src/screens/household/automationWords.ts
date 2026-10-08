import type {
  CategorizationBacklog,
  CategorizationBank,
  CategorizationRecentDecision,
  CategorizationRequirement,
  CategorizationRunResult,
  CategorizationSettingsModelMode,
} from "@workspace/api-client-react";

/** The words on the Automation screen, in one place so the tests can read them. */

export const MODE_LADDER: ReadonlyArray<{ key: CategorizationSettingsModelMode; text: string }> = [
  { key: "off", text: "Off — rules and memory only" },
  { key: "suggest", text: "Suggests — files what it is sure about as provisional and queues the rest; you confirm" },
  { key: "auto", text: "Files on its own — only after the record below holds" },
];

export const JUDGED_NOTE =
  "Verified = a suggestion you accepted or corrected in Review. One left unchanged for 14 days is not verified.";

/** (V7) The Requirements line for suggestions left unchanged. */
export const unreviewedLine = (n: number): string => `Left unchanged, not verified: ${n}`;
export const UNREVIEWED_HINT = "Left unchanged 14 days. Not verified.";

const FULL = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
/** "Oct 7, 2026" for a YYYY-MM-DD date. */
export function fullDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : FULL.format(d);
}

/** (V7) The Backlog section. */
export const BACKLOG = {
  label: "Backlog",
  button: "File everything up to today",
  running: "Filing…",
  ownerOnly: "Owner only",
  failed: "Couldn't finish filing. Try again.",
} as const;

/** "Unfiled charges: 23 · oldest Mar 14, 2026"; no date when nothing is unfiled. */
export function backlogLine(b: Pick<CategorizationBacklog, "unfiled" | "oldestUnfiledOn">): string {
  if (b.unfiled === 0 || !b.oldestUnfiledOn) return `Unfiled charges: ${b.unfiled}`;
  return `Unfiled charges: ${b.unfiled} · oldest ${fullDate(b.oldestUnfiledOn)}`;
}

/** After "File everything up to today". */
export function runResultLine(r: Pick<CategorizationRunResult, "filed" | "suggested" | "queued" | "unreviewed">): string {
  return `Filed ${r.filed} · Suggested ${r.suggested} (provisional) · ${r.queued} need a look · ${r.unreviewed} left unchanged`;
}

/** (V7) The Bank data section: one line per bank. */
export function bankLine(b: Pick<CategorizationBank, "name" | "lastDataOn" | "autoUpdates">): string {
  const through = b.lastDataOn ? fullDate(b.lastDataOn) : "not yet";
  return `${b.name ?? "Bank"} · data through ${through} · Automatic updates ${b.autoUpdates.on ? "On" : "Off"}`;
}

export const AI_STATUS = {
  configured: { yes: "Configured", no: "Not configured" },
  enabled: { yes: "On", no: "Off — turn on AI_ENABLED on the server" },
} as const;

export function engineLine(e: { rules: number; learned: number; recurring: number }): string {
  return `Rules you wrote: ${e.rules} · Learned from your corrections: ${e.learned} · Recurring bills: ${e.recurring}`;
}

/** "18 of 30 verified", "19 of 20 right"; the two switch rows carry no figure. */
export function requirementFigure(r: Pick<CategorizationRequirement, "key" | "current" | "target">): string | null {
  switch (r.key) {
    case "judged":
      return `${r.current} of ${r.target} verified`;
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
  // (V7) Left unchanged is not accepted: it reads "Unreviewed", with UNREVIEWED_HINT.
  if (d.resolution === "unreviewed") return "Unreviewed";
  if (d.resolution === "accepted") return "Accepted";
  if (d.resolution === "corrected") return "Corrected";
  if (d.resolution === "skipped") return "Skipped";
  return "Waiting";
}
