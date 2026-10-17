import type {
  ImportAddSummary,
  ImportHistoryItem,
  ImportPreview,
  ImportStateSummary,
} from "@workspace/api-client-react/features";
import { dayTimeOf } from "./checkingWords";

/**
 * (W) THE WORKBOOK IMPORT'S WORDS — Settings › Data. Short lines, every number
 * the server's (the preview, the import, the history and the restore check);
 * these functions only say them. Pure, so each line is pinned by a test.
 */

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const asDay = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** "Sep 1 – Oct 15" ("Sep 1, 2025 – Oct 15, 2026" across years); one day once; null without dates. */
export function daySpan(from: string | null, to: string | null, thisYear = new Date().getFullYear()): string | null {
  if (!from || !to) return null;
  const a = asDay(from);
  const b = asDay(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const fmt = a.getUTCFullYear() !== b.getUTCFullYear() || b.getUTCFullYear() !== thisYear ? DAY_YEAR : DAY;
  return from === to ? fmt.format(a) : `${fmt.format(a)} – ${fmt.format(b)}`;
}

/** The confirmation the import asks: "Replace 340 transactions, including 220 bank rows?" */
export function confirmQuestion(p: ImportPreview): string {
  const r = p.replaces;
  if (r.transactions === 0) return `Import ${count(p.adds.transactions, "transaction")}?`;
  return r.bankTransactions > 0
    ? `Replace ${count(r.transactions, "transaction")}, including ${count(r.bankTransactions, "bank row")}?`
    : `Replace ${count(r.transactions, "transaction")}?`;
}

/** The confirm button: "Replace" when anything of the person's goes, else "Import". */
export function confirmLabel(p: ImportPreview): "Replace" | "Import" {
  const r = p.replaces;
  return r.transactions + r.categories + r.debts + r.rules + r.recurring + r.budgetLines + r.monthlySnapshots > 0
    ? "Replace"
    : "Import";
}

const others = (s: { categories: number; rules: number; debts: number }) =>
  [count(s.categories, "category", "categories"), count(s.rules, "rule"), count(s.debts, "debt")].join(" · ");

/** What the file adds: "120 transactions, Sep 1 – Oct 15 · 12 categories · 8 rules · 3 debts". */
export function addsLine(a: ImportAddSummary): string {
  const span = daySpan(a.from, a.to);
  return `${count(a.transactions, "transaction")}${span ? `, ${span}` : ""} · ${others(a)}`;
}

/** What is there now: "340 transactions (220 bank rows, Jul 1 – Oct 16) · 10 categories · 5 rules · 2 debts". */
export function stateLine(s: ImportStateSummary): string {
  const span = daySpan(s.bankFrom, s.bankTo);
  const bank = s.bankTransactions > 0 ? ` (${count(s.bankTransactions, "bank row")}${span ? `, ${span}` : ""})` : "";
  return `${count(s.transactions, "transaction")}${bank} · ${others(s)}`;
}

/** The preview's "Kept" line: "2 of your rules" — null when none is kept. */
export function keptLine(rulesKept: number): string | null {
  return rulesKept > 0 ? `${rulesKept.toLocaleString("en-US")} of your rules` : null;
}

export const SAFETY_LINE = "H2 keeps a copy first. History can restore it.";
export const STALE_NOTICE = "Your data changed since the preview. Check the new numbers.";
export const INVALID_TITLE = "This file can't be imported:";
export const INVALID_NEXT = "Fix the file and upload it again.";
export const IMPORT_FAILED = "The import could not be saved, so nothing was changed.";
export const READ_FAILED = "The file could not be read. Nothing was changed.";

/** The success line: "Imported 120 rows · Restore available in History". */
export function importedLine(counts: Record<string, number>): string {
  return `Imported ${count(counts.transactions ?? 0, "row")} · Restore available in History`;
}

/** The toast's second sentence: what of the person's survived ("Kept 1 rule and 2 category edits."). */
export function keptEditsLine(counts: Record<string, number>): string | null {
  const rules = counts.mapping_rules_preserved ?? 0;
  const edits = counts.transactions_preserved ?? 0;
  if (!rules && !edits) return null;
  return `Kept ${count(rules, "rule")} and ${count(edits, "category edit")}.`;
}

/** A history row: "Oct 16, 7:12 PM · budget.xlsx · 120 rows". */
export function historyLine(item: ImportHistoryItem): string {
  const parts = [dayTimeOf(item.importedAt) ?? "—", item.fileName ?? "Workbook"];
  const rows = item.counts?.transactions;
  if (typeof rows === "number") parts.push(count(rows, "row"));
  return parts.join(" · ");
}

/** A history row's status when it has no Restore button. */
export function historyNote(item: ImportHistoryItem): string | null {
  switch (item.restore) {
    case "available":
      return null;
    case "restored":
      return item.restoredAt ? `Restored ${dayTimeOf(item.restoredAt)}` : "Restored";
    case "later_import":
      return "Restore the newer import first";
    case "too_old":
      return "Too old to restore";
    default:
      return "No copy kept";
  }
}

export const RESTORE_QUESTION = "Restore your data from before this import?";
export const RESTORE_CHECK_FAILED = "The restore check could not be made. Nothing was changed.";
export const RESTORE_FAILED = "The restore could not be saved, so nothing was changed.";

/** After a restore: "Restored · 340 transactions back". */
export function restoredLine(putsBack: ImportStateSummary): string {
  return `Restored · ${count(putsBack.transactions, "transaction")} back`;
}
