import * as z from "zod";
import { type MappingRule } from "@workspace/api-client-react";

export const formSchema = z.object({
  occurredOn: z.string().min(1, "Date is required"),
  description: z.string().min(1, "Description is required"),
  amount: z.string().min(1, "Amount is required"),
  kind: z.enum(["expense", "income"]).default("expense"),
  categoryId: z.string().nullable().optional(),
  weeklyAllowance: z.boolean().default(false),
  monthlyAllowance: z.boolean().default(false),
  unplannedAllowance: z.boolean().default(false),
  reimbursable: z.boolean().default(false),
  reimbursed: z.boolean().default(false),
  // (#479) Edit-dialog toggle that mirrors the row-level "Transfer" pill.
  // Sent on PATCH only when the value differs from the row's existing
  // `isTransfer`, so opening the dialog on a non-transfer row and saving
  // unrelated fields doesn't silently set `isTransferUserOverridden`.
  isTransfer: z.boolean().default(false),
});

/**
 * Mirrors the server-side `matchRule` (autoCategorize.ts) for the
 * Add-Transaction dialog's live "as you type" auto-pick. Walks the user's
 * mapping rules in priority-descending order and returns the rule whose
 * pattern matches the description (only rules with a non-null categoryId
 * count, matching server semantics). Returns null when nothing fires.
 *
 * Kept inline rather than imported from `@workspace/api-server` because
 * the client artifact doesn't depend on the api-server package and the
 * pure matching logic is small enough to duplicate.
 */
export function matchRuleClient(
  description: string,
  rules: readonly MappingRule[] | undefined,
): MappingRule | null {
  if (!description || !rules?.length) return null;
  const hay = description.toLowerCase();
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const r of sorted) {
    if (!r.categoryId) continue;
    const needle = r.pattern.toLowerCase();
    if (!needle) continue;
    let hit = false;
    if (r.matchType === "exact") hit = hay === needle;
    else if (r.matchType === "starts_with") hit = hay.startsWith(needle);
    else hit = hay.includes(needle);
    if (hit) return r;
  }
  return null;
}

export type FormValues = z.infer<typeof formSchema>;

export function normalizeAmount(raw: string, kind: "expense" | "income"): string {
  const num = Math.abs(parseFloat(raw));
  if (Number.isNaN(num)) return raw;
  return (kind === "income" ? num : -num).toFixed(2);
}

export function parseSigned(amount: string | number): number {
  return Number(amount) || 0;
}
