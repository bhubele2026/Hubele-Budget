import { Link } from "wouter";
import type { AgentProposal } from "@workspace/api-client-react/features";
import { PageGrid, Panel } from "@/components/next";
import { dataState, type DataState } from "@/lib/queryState";
import { Crumbs, btnLink, emptyNote } from "@/ui";
import { RetryNote, TabSkeleton } from "@/pages/settings/parts";
import { useAllProposals, useCategoryNames, useOpenProposals } from "./askData";
import { ProposalCard } from "./ProposalCard";

interface ListRead {
  data: AgentProposal[] | undefined;
  state: DataState;
  isFetching: boolean;
  refetch: () => unknown;
}

export interface SuggestionsData {
  open: ListRead;
  all: ListRead;
  categories: ReadonlyMap<string, string>;
}

export function useSuggestionsData(): SuggestionsData {
  const open = useOpenProposals();
  const all = useAllProposals();
  const categories = useCategoryNames();
  const list = (q: typeof open): ListRead => ({
    data: q.data?.proposals,
    state: dataState(q),
    isFetching: q.isFetching,
    refetch: q.refetch,
  });
  return { open: list(open), all: list(all), categories };
}

export default function SuggestionsPage() {
  return <SuggestionsView data={useSuggestionsData()} />;
}

/**
 * ⭐ (F8) REVIEW › SUGGESTIONS — changes Ask suggested and has NOT made. Open
 * ones first with Approve and Reject; what was decided or lapsed sits beside
 * them as history. The server applies an approval through the plan's own
 * writer. Ported from h2's `ask/Proposals.tsx`. Its own route under the Review
 * area (`/review/suggestions`); the ribbon tab for it is C12's.
 */
export function SuggestionsView({ data }: { data: SuggestionsData }) {
  const { open, all, categories } = data;
  const history = (all.data ?? []).filter((p) => p.status !== "proposed");
  return (
    <div className="space-y-4" data-testid="suggestions-page">
      <div>
        <Crumbs trail={[{ label: "Review", href: "/review" }, { label: "Suggestions" }]} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-display font-semibold text-brand-navy">Suggestions</h1>
          <Link href="/ask" className={btnLink} data-testid="suggestions-ask-link">
            Ask
          </Link>
        </div>
        <p className="mt-1 text-label text-neutral-500">Changes Ask suggested. Nothing changes until you approve it.</p>
      </div>
      <PageGrid className="items-start">
        <Panel title="Waiting for you" span={history.length > 0 ? 8 : 12} variant="static" data-testid="proposals-open-panel">
          {open.state === "cold" ? (
            <TabSkeleton testId="proposals-skeleton" rows={2} />
          ) : open.state === "failed" ? (
            <RetryNote onRetry={() => void open.refetch()} retrying={open.isFetching}>
              Couldn't load suggestions.
            </RetryNote>
          ) : (open.data ?? []).length === 0 ? (
            <p className={emptyNote} data-testid="proposals-empty">
              Nothing is waiting. When Ask suggests a change, it shows up here.
            </p>
          ) : (
            <div className="space-y-3" data-testid="proposals-open">
              {open.data!.map((p) => (
                <ProposalCard key={p.id} proposal={p} categories={categories} />
              ))}
            </div>
          )}
        </Panel>
        {history.length > 0 && (
          <Panel title="History" span={4} variant="static" data-testid="proposals-history-panel">
            <div className="space-y-3" data-testid="proposals-history">
              {history.map((p) => (
                <ProposalCard key={p.id} proposal={p} categories={categories} />
              ))}
            </div>
          </Panel>
        )}
      </PageGrid>
    </div>
  );
}
