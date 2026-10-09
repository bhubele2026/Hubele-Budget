import { useState } from "react";
import { History } from "lucide-react";
import {
  useGetMappingRuleHistory,
  getGetMappingRuleHistoryQueryKey,
  type MappingRuleHistory,
  type MappingRuleHistoryEntry,
  type MappingRuleSnapshot,
} from "@workspace/api-client-react/features";
import { householdDateOf } from "@workspace/avalanche-core/householdTime";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { shortDateOfInstant } from "@/lib/dates";
import { dataState } from "@/lib/queryState";
import { btnLink } from "@/ui";

/**
 * ⭐ (WP5b) WHAT HAPPENED TO THIS RULE. Every change to a mapping rule is
 * recorded server-side (`mapping_rule_history`): created, added by the starter
 * rules, edited, moved in the order, deleted — with the rule before and after,
 * who did it and the note they gave. This popover reads it back for one rule.
 *
 * - The request runs only while the popover is open, and is asked afresh each
 *   time (`staleTime: 0`): a history older than the row beside it would be a
 *   lie. Nothing is fetched for a closed popover, so the page pays nothing.
 * - The hook comes from the `features` sub-module (C0), never the main module:
 *   this page is lazy, and a main-module hook would land in the landing chunk.
 * - Words, not codes: a person's change reads "by you" or "by another household
 *   member", the seed reads "H2's starter rules", a script "a maintenance
 *   script", H2's own tidy-up "H2". A category that no longer exists is named
 *   as such, never as an id.
 */
export function RuleHistoryPopover({
  ruleId,
  pattern,
  categoryName,
}: {
  ruleId: string;
  pattern: string;
  /** The category's name; called with null for "no category". */
  categoryName: (id: string | null) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={btnLink}
          title="History"
          aria-label={`History of rule ${pattern}`}
          data-testid={`rule-history-btn-${ruleId}`}
        >
          <History className="h-3 w-3" />
          {/* On a phone the control has a line of its own, so it says what it is. */}
          <span className="sm:hidden">History</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        className="w-80 p-3"
        data-testid={`rule-history-${ruleId}`}
      >
        <p className="text-body font-semibold text-brand-navy">Rule history</p>
        <p className="mb-2 truncate font-mono text-micro text-neutral-500">{pattern}</p>
        {/* Mounted only while open, so the query never runs for a closed popover. */}
        <HistoryBody ruleId={ruleId} categoryName={categoryName} />
      </PopoverContent>
    </Popover>
  );
}

function HistoryBody({
  ruleId,
  categoryName,
}: {
  ruleId: string;
  categoryName: (id: string | null) => string;
}) {
  const query = useGetMappingRuleHistory(ruleId, {
    query: {
      queryKey: getGetMappingRuleHistoryQueryKey(ruleId),
      staleTime: 0,
      gcTime: 5 * 60_000,
    },
  });
  const state = dataState(query);
  const history = query.data as MappingRuleHistory | undefined;

  if (state === "failed") {
    return (
      <p className="text-micro text-neutral-500" data-testid="rule-history-failed">
        Couldn't load the history.{" "}
        <button type="button" className={btnLink} onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  }
  if (!history || state === "cold") {
    return <p className="text-micro text-neutral-500">Loading…</p>;
  }
  if (history.entries.length === 0) {
    return (
      <p className="text-micro text-neutral-500" data-testid="rule-history-empty">
        No changes recorded for this rule since its history began.
      </p>
    );
  }
  return (
    <div>
      {state === "refresh-failed" && (
        <p className="mb-1 text-micro text-neutral-500">
          Couldn't refresh; showing the last answer.
        </p>
      )}
      <ol
        className="max-h-72 divide-y divide-brand-line/70 overflow-y-auto"
        data-testid="rule-history-list"
      >
        {history.entries.map((e) => (
          <li key={e.id} className="py-2 text-micro" data-testid={`rule-history-entry-${e.id}`}>
            <p className="text-neutral-700">
              <span className="font-mono tabular-nums text-neutral-500">{whenWords(e.createdAt)}</span>
              {" · "}
              {headline(e)}
            </p>
            {details(e, categoryName).map((line) => (
              <p key={line} className="text-neutral-600">
                {line}
              </p>
            ))}
            {e.note && <p className="italic text-neutral-600">“{e.note}”</p>}
          </li>
        ))}
      </ol>
      {history.truncated && (
        <p className="mt-1 text-micro text-neutral-500" data-testid="rule-history-truncated">
          Showing the newest {history.entries.length} change
          {history.entries.length === 1 ? "" : "s"}.
        </p>
      )}
    </div>
  );
}

/** "Oct 13", with the year when it is not this year (household calendar). */
function whenWords(iso: string): string {
  const day = shortDateOfInstant(iso);
  const year = householdDateOf(new Date(iso)).slice(0, 4);
  const thisYear = householdDateOf(new Date()).slice(0, 4);
  return year === thisYear ? day : `${day}, ${year}`;
}

function actorWords(e: MappingRuleHistoryEntry): string {
  switch (e.actorKind) {
    case "person":
      return e.byYou ? "by you" : "by another household member";
    case "seed":
      return "by H2's starter rules";
    case "script":
      return "by a maintenance script";
    case "system":
      return "by H2";
  }
}

const ACTION_WORDS: Record<MappingRuleHistoryEntry["action"], string> = {
  created: "Created",
  seeded: "Added",
  updated: "Edited",
  reordered: "Moved in the order",
  deleted: "Deleted",
};

export function headline(e: MappingRuleHistoryEntry): string {
  return `${ACTION_WORDS[e.action]} ${actorWords(e)}`;
}

const MATCH_WORDS: Record<string, string> = {
  contains: "contains",
  starts_with: "starts with",
  exact: "exact",
};
const matchWords = (m: string) => MATCH_WORDS[m] ?? m;

function stateLine(s: MappingRuleSnapshot, categoryName: (id: string | null) => string): string {
  return `${s.pattern} · ${matchWords(s.matchType)} → ${categoryName(s.categoryId)} · priority ${s.priority}`;
}

/** The lines under the headline: what the rule was, became, or stopped being. */
export function details(
  e: MappingRuleHistoryEntry,
  categoryName: (id: string | null) => string,
): string[] {
  const { previous: p, next: n } = e;
  if (!p && n) return [stateLine(n, categoryName)];
  if (p && !n) return [`Was: ${stateLine(p, categoryName)}`];
  if (!p || !n) return [];
  const lines: string[] = [];
  if (p.pattern !== n.pattern) lines.push(`Pattern: ${p.pattern} → ${n.pattern}`);
  if (p.matchType !== n.matchType) lines.push(`Match: ${matchWords(p.matchType)} → ${matchWords(n.matchType)}`);
  if (p.categoryId !== n.categoryId)
    lines.push(`Category: ${categoryName(p.categoryId)} → ${categoryName(n.categoryId)}`);
  if (p.priority !== n.priority) lines.push(`Priority: ${p.priority} → ${n.priority}`);
  return lines;
}
