import { Link } from "wouter";
import { getGetPeriodBreakdownQueryKey, useGetPeriodBreakdown } from "@workspace/api-client-react/features";
import { useSpine } from "@/hooks/useSpine";
import { useOwner } from "@/hooks/useOwner";
import { knownWithinPlan, withinOfRemaining } from "@/lib/weekFigures";
import { scoped } from "@/lib/queryState";
import { periodParams, PERIOD_MIN } from "@/pages/spending/periodParams";
import { overLinkView, type OverLinkInput, type OverLinkPlan } from "@/lib/amexSummaryView";

/**
 * ⭐ (P1) THE HOUSEHOLD LINK SAYS WHAT IS TRUE. "Why are we over? →" only when
 * the household plan IS over; otherwise it offers to view, review or set the
 * plan (`overLinkView`). The plan's state is read where Spending reads it — the
 * spine's `knownWithinPlan` for this week, the month's own breakdown for a
 * month — and never worked out here.
 *
 * Each source is its own small component, so only the one this period needs
 * mounts (and only it asks for anything). The owner is asked only when there
 * is no plan to point at. The href never changes with the words.
 */

const LINK = "font-semibold text-brand-navy underline";

function OverLinkFace({ href, input }: { href: string; input: OverLinkInput }) {
  const v = overLinkView(input);
  return (
    <Link href={href} className={LINK} data-testid="amex-household-link" data-state={v.state}>
      {v.text}
    </Link>
  );
}

/** No plan for the current period: the owner may set one, anyone else reviews. */
function NoPlanLink({ href, input }: { href: string; input: Extract<OverLinkInput, { period: "week" | "month" }> }) {
  const owner = useOwner();
  return <OverLinkFace href={href} input={{ ...input, owner }} />;
}

function PlanLink({ href, input }: { href: string; input: Extract<OverLinkInput, { period: "week" | "month" }> }) {
  if (input.plan === "none" && input.current) return <NoPlanLink href={href} input={input} />;
  return <OverLinkFace href={href} input={input} />;
}

function WeekLink({ href }: { href: string }) {
  const spine = useSpine();
  const plan: OverLinkPlan = spine.data
    ? (() => {
        const w = knownWithinPlan(spine.data.position);
        return w == null ? "none" : w === "over" ? "over" : "set";
      })()
    : spine.state === "failed"
      ? "failed"
      : "loading";
  return <PlanLink href={href} input={{ period: "week", current: true, plan }} />;
}

function MonthLink({ href, start, monthName }: { href: string; start: string; monthName: string }) {
  const params = periodParams("month", start);
  const q = useGetPeriodBreakdown(params, {
    query: { queryKey: getGetPeriodBreakdownQueryKey(params), staleTime: PERIOD_MIN },
  });
  // Another month's answer (kept while this one loads) is not this month's.
  const d = scoped(q, (r) => r.start === start && r.period === "month").data;
  const plan: OverLinkPlan = d
    ? d.plan.status === "not_set"
      ? "none"
      : withinOfRemaining(d.remaining) === "over"
        ? "over"
        : "set"
    : q.isError
      ? "failed"
      : "loading";
  return <PlanLink href={href} input={{ period: "month", monthName, current: d?.isCurrent ?? false, plan }} />;
}

/**
 * The link for the Summary's period: this week (`week`), a month (`month`,
 * with its first day), or a year (no plan state).
 */
export function AmexOverLink({
  href,
  period,
}: {
  href: string;
  period: { kind: "week" } | { kind: "month"; start: string; monthName: string } | { kind: "year" };
}) {
  if (period.kind === "year") return <OverLinkFace href={href} input={{ period: "year" }} />;
  if (period.kind === "week") return <WeekLink href={href} />;
  return <MonthLink href={href} start={period.start} monthName={period.monthName} />;
}
