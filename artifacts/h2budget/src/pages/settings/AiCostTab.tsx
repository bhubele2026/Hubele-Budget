import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAiUsageSummaryQueryKey,
  useGetAiUsageSummary,
  useUpdateAiBudget,
  type AiUsageSummary,
  type UpdateAiBudgetBody,
} from "@workspace/api-client-react/features";
import { getGetMeQueryKey, useGetMe } from "@workspace/api-client-react";
import { PageGrid, Panel } from "@/components/next";
import { CssFillMeter } from "@/lib/cssBars";
import { useToast } from "@/hooks/use-toast";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { dataState, type DataState } from "@/lib/queryState";
import { relativeTime, shortDateOfInstant } from "@/lib/dates";
import { apiMessage } from "@/lib/apiMessage";
import { CAP_WORDS, RUN_STATUS_WORD, capOf, meterStatus, percent, taskWord, usd } from "@/lib/aiCostWords";
import { btnLink, btnSecondarySm, emptyNote, fieldLabel, input, td, tdNum, th } from "@/ui";
import { RetryNote, StatusChip, TabSkeleton, type Tone } from "./parts";

/**
 * ⭐ (F10) SETTINGS › AI COST — what Ask and the other AI work cost this
 * month, as the server counted it. Every figure is displayed as sent; this
 * tab adds nothing up (a test reads this file and refuses arithmetic on a
 * figure it was sent). Members read it; the owner changes the monthly cap, the
 * hard stop, and can pause AI for a while (`PUT /ai/budget`, owner only).
 * Behaviour ported from h2's `screens/household/AiCost.tsx` onto h2budget's
 * panels; hooks from the `features` sub-module.
 */

export interface AiCostData {
  usage: { data: AiUsageSummary | undefined; state: DataState; isFetching: boolean; refetch: () => unknown };
  owner: boolean | null;
}

const LIVE = { staleTime: 30_000, gcTime: 10 * 60_000 } as const;
const SLOW = { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as const;

export function useAiCostData(): AiCostData {
  const q = useGetAiUsageSummary({ query: { queryKey: getGetAiUsageSummaryQueryKey(), ...LIVE } });
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), ...SLOW } });
  return {
    usage: { data: q.data, state: dataState(q), isFetching: q.isFetching, refetch: q.refetch },
    owner: me.data ? me.data.isOwner === true : null,
  };
}

export default function AiCostTab() {
  return <AiCostView data={useAiCostData()} />;
}

const CAP_TONE: Record<ReturnType<typeof meterStatus>, Tone> = { on: "on", tight: "tight", over: "over" };

/** "October 2026" for the server's UTC month "2026-10". */
function monthWords(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? month
    : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(d);
}

function CapMeter({ label, spent, limit, id }: { label: string; spent: number; limit: number; id: string }) {
  if (!(limit > 0)) {
    return (
      <p className="text-body text-neutral-600" data-testid={`ai-cap-${id}`}>
        {label}: none set.
      </p>
    );
  }
  const status = meterStatus(spent, limit);
  return (
    <div data-testid={`ai-cap-${id}`} data-status={status}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={fieldLabel}>{label}</span>
        <StatusChip tone={CAP_TONE[status]} data-testid="meter-status">
          {CAP_WORDS[status]}
        </StatusChip>
      </div>
      <p className="mt-1 font-mono text-body tabular-nums text-brand-ink">
        {usd(spent)} <span className="text-neutral-500">of {usd(limit)}</span>
      </p>
      <CssFillMeter value={spent} ceiling={limit} className="mt-2" title={`${usd(spent)} of ${usd(limit)}`} />
    </div>
  );
}

export function AiCostView({ data, now }: { data: AiCostData; now?: Date }) {
  const { usage, owner } = data;
  const qc = useQueryClient();
  const save = useUpdateAiBudget({ mutation: { meta: OWN_INVALIDATION } });
  const { toast } = useToast();
  const [monthly, setMonthly] = useState<string | null>(null);
  const [hard, setHard] = useState<string | null>(null);
  const [until, setUntil] = useState("");
  const isOwner = owner === true;
  const u = usage.data;
  const budget = u?.budget;

  const put = (body: UpdateAiBudgetBody, ok: string) =>
    save.mutate(
      { data: body },
      {
        onSuccess: () => {
          toast({ title: ok });
          setMonthly(null);
          setHard(null);
          setUntil("");
          void qc.invalidateQueries({ queryKey: getGetAiUsageSummaryQueryKey() });
        },
        onError: (e) =>
          toast({
            title: apiMessage(e, "Those weren't accepted. Check the amounts. Nothing changed."),
            variant: "destructive",
          }),
      },
    );

  const saveCaps = () => {
    const m = monthly == null ? undefined : capOf(monthly);
    const h = hard == null ? undefined : capOf(hard);
    if (m === null || h === null) {
      toast({ title: "Use dollars, like 20 or 20.50.", variant: "destructive" });
      return;
    }
    put({ ...(m !== undefined ? { monthlyCapUsd: m } : {}), ...(h !== undefined ? { hardCapUsd: h } : {}) }, "Caps saved.");
  };

  const pause = () => {
    if (!until) {
      toast({ title: "Pick the day to pause until.", variant: "destructive" });
      return;
    }
    put({ pausedUntil: new Date(`${until}T00:00:00`).toISOString() }, "AI is paused.");
  };

  if (usage.state === "cold") {
    return (
      <PageGrid>
        <Panel title="AI cost" span={12} variant={["static", "flush"]}>
          <TabSkeleton testId="ai-cost-skeleton" />
        </Panel>
      </PageGrid>
    );
  }
  if (!u || !budget) {
    return (
      <PageGrid>
        <Panel title="AI cost" span={12} variant={["static", "flush"]}>
          <RetryNote onRetry={() => void usage.refetch()} retrying={usage.isFetching} data-testid="ai-cost-error">
            Couldn't load the AI cost.
          </RetryNote>
        </Panel>
      </PageGrid>
    );
  }

  const paused = budget.pausedUntil != null && Date.parse(budget.pausedUntil) > (now ?? new Date()).getTime();

  return (
    <PageGrid data-testid="ai-cost">
      <Panel title="This month" sub={`Spent so far in ${monthWords(u.month)}`} span={4} variant="static" data-testid="ai-month">
        <data
          value={String(u.monthToDateUsd)}
          className="block font-mono text-display font-semibold tabular-nums text-brand-navy"
          data-testid="figure-ai-month"
        >
          {usd(u.monthToDateUsd)}
        </data>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-body text-neutral-600" data-testid="ai-counts">
          <div className="flex gap-1">
            <dd className="font-mono tabular-nums text-brand-ink" data-testid="ai-calls">
              {u.calls ?? 0}
            </dd>
            <dt>calls</dt>
          </div>
          <div className="flex gap-1">
            <dd className="font-mono tabular-nums text-brand-ink" data-testid="ai-failures">
              {u.failures ?? 0}
            </dd>
            <dt>failed</dt>
          </div>
          <div className="flex gap-1">
            <dd className="font-mono tabular-nums text-brand-ink" data-testid="ai-blocked">
              {u.blocked ?? 0}
            </dd>
            <dt>stopped by the cap</dt>
          </div>
          {u.cacheHitRatio != null && (
            <div className="flex gap-1">
              <dd className="font-mono tabular-nums text-brand-ink" data-testid="ai-cache">
                {percent(u.cacheHitRatio)}
              </dd>
              <dt>reused from cache</dt>
            </div>
          )}
        </dl>
      </Panel>

      <Panel title="By task" span={8} variant={["static", "flush"]} data-testid="ai-by-task-panel">
        {u.byTask.length === 0 ? (
          <p className={emptyNote}>No AI work this month.</p>
        ) : (
          <table className="w-full" data-testid="ai-by-task">
            <thead>
              <tr>
                <th scope="col" className={th}>Task</th>
                <th scope="col" className={`${th} text-right`}>Cost</th>
                <th scope="col" className={`${th} text-right`}>Calls</th>
                <th scope="col" className={`${th} text-right`}>Failed</th>
              </tr>
            </thead>
            <tbody>
              {u.byTask.map((t) => (
                <tr key={t.task} data-testid="ai-task-row">
                  <th scope="row" className={`${td} text-left font-normal text-brand-ink`}>
                    {taskWord(t.task)}
                  </th>
                  <td className={tdNum}>
                    <data value={String(t.costUsd)}>{usd(t.costUsd)}</data>
                  </td>
                  <td className={tdNum}>{t.calls}</td>
                  <td className={tdNum}>{t.failures}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Caps" span={6} variant="static" data-testid="ai-caps-panel">
        <div className="flex flex-col gap-5" data-testid="ai-caps">
          <CapMeter label="Monthly cap" spent={u.monthToDateUsd} limit={budget.monthlyCapUsd} id="monthly" />
          <CapMeter label="Hard stop" spent={u.monthToDateUsd} limit={budget.hardCapUsd} id="hard" />
        </div>
        {isOwner ? (
          <form
            className="mt-5 flex flex-wrap items-end gap-3 border-t border-brand-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              saveCaps();
            }}
            data-testid="ai-caps-form"
          >
            <label className="flex w-28 flex-col gap-1">
              <span className={fieldLabel}>Monthly cap</span>
              <input
                className={`${input} font-mono`}
                inputMode="decimal"
                value={monthly ?? String(budget.monthlyCapUsd)}
                onChange={(e) => setMonthly(e.target.value)}
                data-testid="ai-monthly-input"
              />
            </label>
            <label className="flex w-28 flex-col gap-1">
              <span className={fieldLabel}>Hard stop</span>
              <input
                className={`${input} font-mono`}
                inputMode="decimal"
                value={hard ?? String(budget.hardCapUsd)}
                onChange={(e) => setHard(e.target.value)}
                data-testid="ai-hard-input"
              />
            </label>
            <button
              type="submit"
              className={btnSecondarySm}
              disabled={save.isPending || (monthly == null && hard == null)}
              data-testid="ai-caps-save"
            >
              Save caps
            </button>
          </form>
        ) : (
          <p className="mt-4 text-micro text-neutral-500">The household owner sets the caps.</p>
        )}
      </Panel>

      <Panel title="Pause" span={6} variant="static" data-testid="ai-pause-panel">
        <p className="text-body text-brand-ink" data-testid="ai-pause-state">
          {paused ? (
            <>
              AI is paused until <span data-testid="ai-paused-until">{shortDateOfInstant(budget.pausedUntil!)}</span>.
            </>
          ) : (
            "AI is running."
          )}
        </p>
        {isOwner && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            {paused ? (
              <button
                type="button"
                className={btnSecondarySm}
                onClick={() => put({ pausedUntil: null }, "AI is running again.")}
                disabled={save.isPending}
                data-testid="ai-resume"
              >
                Resume
              </button>
            ) : (
              <>
                <label className="flex w-44 flex-col gap-1">
                  <span className={fieldLabel}>Pause until</span>
                  <input
                    type="date"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                    className={input}
                    data-testid="ai-pause-date"
                  />
                </label>
                <button
                  type="button"
                  className={btnLink}
                  onClick={pause}
                  disabled={save.isPending}
                  data-testid="ai-pause"
                >
                  Pause
                </button>
              </>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Last runs" span={12} variant={["static", "flush"]} data-testid="ai-runs-panel">
        {u.recentRuns.length === 0 ? (
          <p className={emptyNote}>No runs yet.</p>
        ) : (
          <ul className="divide-y divide-brand-line/70" data-testid="ai-runs">
            {u.recentRuns.slice(0, 20).map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5 px-4 py-2" data-testid="ai-run">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-body text-brand-ink">{taskWord(r.kind)}</span>
                  <span className="font-mono text-label tabular-nums text-brand-ink">
                    {r.costUsd == null ? "—" : usd(r.costUsd)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-4 text-micro text-neutral-500">
                  <span>{relativeTime(r.startedAt, now)}</span>
                  <StatusChip tone={r.status === "succeeded" ? "fresh" : r.status === "running" ? "neutral" : "stale"}>
                    {RUN_STATUS_WORD[r.status] ?? r.status}
                  </StatusChip>
                </div>
                {r.summary && <p className="text-micro text-neutral-500">{r.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PageGrid>
  );
}
