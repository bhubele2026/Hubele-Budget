import { Link } from "wouter";
import { Wand2, UserRound } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MappingRule } from "@workspace/api-client-react";

const MATCH_TYPE_LABEL: Record<string, string> = {
  contains: "contains",
  exact: "equals",
  starts_with: "starts with",
};

function matchTypeLabel(matchType: string): string {
  return MATCH_TYPE_LABEL[matchType] ?? matchType.replace("_", " ");
}

/**
 * Tiny inline chip surfaced under each Transactions / Amex row that explains
 * which mapping rule landed it in its current category — the obvious
 * follow-up question whenever a row ends up in the "wrong" bucket. The chip
 * has three states:
 *
 *   - Auto-categorized: a small "rule: 'PATTERN' (contains)" link that jumps
 *     straight to that row on the Mapping Rules page (`?focus=<id>`).
 *   - Manually categorized (categoryId set, no matching rule, or the
 *     winning rule disagrees with the current category): a muted "manually
 *     categorized" hint so the user knows no rule is responsible.
 *   - Uncategorized: nothing — the existing "Categorize" prompt already
 *     covers that case.
 */
export function MatchedRuleChip({
  categoryId,
  matchedRuleId,
  rules,
  testIdSuffix,
  variant = "row",
}: {
  categoryId: string | null | undefined;
  matchedRuleId: string | null | undefined;
  rules: readonly MappingRule[] | undefined;
  testIdSuffix: string;
  variant?: "row" | "compact";
}) {
  if (!categoryId) return null;
  const matched = matchedRuleId
    ? (rules ?? []).find((r) => r.id === matchedRuleId) ?? null
    : null;
  const compact = variant === "compact";
  if (matched) {
    const label = matchTypeLabel(matched.matchType);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={`/mapping-rules?focus=${encodeURIComponent(matched.id)}`}
            className={
              compact
                ? "inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 max-w-[200px] truncate"
                : "inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 max-w-[280px] truncate"
            }
            data-testid={`link-matched-rule-${testIdSuffix}`}
            data-matched-rule-id={matched.id}
            title={`Matched by rule "${matched.pattern}" (${label}). Jump to it.`}
          >
            <Wand2 className={compact ? "w-2.5 h-2.5 shrink-0" : "w-3 h-3 shrink-0"} />
            <span className="truncate font-mono">{matched.pattern}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px] max-w-xs">
          Auto-categorized by mapping rule
          {" "}
          <span className="font-mono">{matched.pattern}</span>
          {" "}
          ({label}). Click to jump to it on the Mapping Rules page.
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={
            compact
              ? "inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/70 italic"
              : "inline-flex items-center gap-1 text-[11px] text-muted-foreground/80 italic"
          }
          data-testid={`text-no-rule-${testIdSuffix}`}
        >
          <UserRound className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
          manually categorized
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px] max-w-xs">
        No mapping rule matched this transaction in its current category.
        Add one on the Mapping Rules page if you want similar charges to
        auto-categorize the same way.
      </TooltipContent>
    </Tooltip>
  );
}
