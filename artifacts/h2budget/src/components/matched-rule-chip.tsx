import { Link } from "wouter";
import { Wand2, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
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
            // `.chip` — but `normal-case` so the stored pattern reads as it
            // was actually written; upper-casing it would misrepresent the
            // rule the user has to go and find.
            className={cn(
              "chip gray press inline-flex max-w-[200px] items-center gap-1 truncate normal-case hover:bg-platinum-5 hover:text-brand-navy",
              !compact && "max-w-[280px]",
            )}
            data-testid={`link-matched-rule-${testIdSuffix}`}
            data-matched-rule-id={matched.id}
            title={`Matched by rule "${matched.pattern}" (${label}). Jump to it.`}
          >
            <Wand2 className={compact ? "h-2.5 w-2.5 shrink-0" : "h-3 w-3 shrink-0"} />
            <span className="truncate font-mono font-normal">{matched.pattern}</span>
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
          className="chip gray inline-flex items-center gap-1"
          data-testid={`text-no-rule-${testIdSuffix}`}
        >
          <UserRound className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
          Manual
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
