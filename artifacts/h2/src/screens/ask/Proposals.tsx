import { useMemo } from "react";
import type { AgentProposal } from "@workspace/api-client-react";
import { readOf, type Read } from "@/data/todayData";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonLine } from "@/kit/Skeleton";
import { PlanFrame } from "@/screens/plan/parts";
import { useAllProposals, useCategoryNames, useOpenProposals } from "./askData";
import { ProposalCard } from "./ProposalCard";

export interface ProposalsData {
  open: Read<AgentProposal[]>;
  all: Read<AgentProposal[]>;
  categories: ReadonlyMap<string, string>;
}

export function useProposalsData(): ProposalsData {
  const open = useOpenProposals();
  const all = useAllProposals();
  const cats = useCategoryNames();
  const categories = useMemo(() => new Map((cats.data ?? []).map((c) => [c.id, c.name] as const)), [cats.data]);
  const list = (q: typeof open): Read<AgentProposal[]> => {
    const r = readOf(q);
    return { ...r, data: q.data?.proposals };
  };
  return { open: list(open), all: list(all), categories };
}

export default function Proposals() {
  return <ProposalsView data={useProposalsData()} />;
}

/**
 * ⭐ PROPOSALS — changes Ask suggested and has NOT made. Open ones first with
 * Approve and Reject; what was decided or lapsed sits below as history. The
 * server applies an approval through the plan's own writer.
 */
export function ProposalsView({ data }: { data: ProposalsData }) {
  const { open, all, categories } = data;
  const history = (all.data ?? []).filter((p) => p.status !== "proposed");
  return (
    <PlanFrame current="proposals">
      <div className="flex flex-col" data-testid="proposals">
        <Section label="Waiting for you">
          {open.state === "cold" ? (
            <div aria-busy="true" data-testid="proposals-skeleton">
              <SkeletonLine className="w-64" />
            </div>
          ) : open.state === "failed" ? (
            <Note kind="error" onRetry={open.refetch} retrying={open.isFetching}>
              Couldn't load proposals.
            </Note>
          ) : (open.data ?? []).length === 0 ? (
            <Note kind="empty" data-testid="proposals-empty">
              Nothing is waiting. When Ask suggests a change, it shows up here.
            </Note>
          ) : (
            <div data-testid="proposals-open">
              {open.data!.map((p) => (
                <ProposalCard key={p.id} proposal={p} categories={categories} />
              ))}
            </div>
          )}
        </Section>
        {history.length > 0 && (
          <Section label="History">
            <div data-testid="proposals-history">
              {history.map((p) => (
                <ProposalCard key={p.id} proposal={p} categories={categories} />
              ))}
            </div>
          </Section>
        )}
      </div>
    </PlanFrame>
  );
}
