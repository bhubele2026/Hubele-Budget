import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAiUsageSummaryQueryKey,
  getGetMeQueryKey,
  useGetMe,
  useUpdateAiBudget,
  type AiUsageSummary,
  type MeResponse,
} from "@workspace/api-client-react";
import { OWN_INVALIDATION } from "@/data/mutationInvalidation";
import { readOf, type Read } from "@/data/todayData";
import { Button } from "@/kit/Button";
import { Figure } from "@/kit/Figure";
import { Meter, meterStatus, type MeterStatus } from "@/kit/Meter";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonLine } from "@/kit/Skeleton";
import { StatusWord } from "@/kit/StatusWord";
import { relativeTime, shortDateOfInstant } from "@/lib/dates";
import { useAiUsage } from "@/screens/ask/askData";
import { percent, RUN_STATUS_WORD, taskWord, usd } from "@/screens/ask/askWords";
import { Field, MoneyInput, inputClass, useToast } from "@/screens/plan/parts";
import { HouseholdFrame } from "./parts";
import { apiMessage } from "./words";

export interface AiCostData {
  usage: Read<AiUsageSummary>;
  me: Read<MeResponse>;
}

export function useAiCostData(): AiCostData {
  const usage = useAiUsage();
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000 } });
  return { usage: readOf(usage), me: readOf(me) };
}

export default function AiCost() {
  return <AiCostView data={useAiCostData()} />;
}

const CAP_WORDS: Record<MeterStatus, string> = { on: "Within the cap", tight: "Close to the cap", over: "Over the cap" };

/** A dollar box → a number for the server, or null when it is not an amount. */
export function capOf(raw: string): number | null {
  const s = raw.replace(/[$,\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : null;
}

/**
 * ⭐ AI COST — what Ask and the other AI work cost this month, as the server
 * counted it. Every figure here is displayed as sent; the page adds nothing up.
 * The owner can change the monthly cap, the hard stop, and pause AI for a while.
 */
export function AiCostView({ data, now }: { data: AiCostData; now?: Date }) {
  const { usage, me } = data;
  const qc = useQueryClient();
  const save = useUpdateAiBudget({ mutation: { meta: OWN_INVALIDATION } });
  const { say, node: toast } = useToast();
  const [monthly, setMonthly] = useState<string | null>(null);
  const [hard, setHard] = useState<string | null>(null);
  const [until, setUntil] = useState("");
  const owner = me.data?.isOwner === true;
  const u = usage.data;
  const budget = u?.budget;

  const put = async (data: Parameters<typeof save.mutateAsync>[0]["data"], ok: string) => {
    try {
      await save.mutateAsync({ data });
      say(ok);
      setMonthly(null);
      setHard(null);
      setUntil("");
      void qc.invalidateQueries({ queryKey: getGetAiUsageSummaryQueryKey() });
    } catch (e) {
      say(apiMessage(e, "Those weren't accepted. Check the amounts. Nothing changed."), "error");
    }
  };
  const saveCaps = () => {
    const m = monthly == null ? undefined : capOf(monthly);
    const h = hard == null ? undefined : capOf(hard);
    if (m === null || h === null) return say("Use dollars, like 20 or 20.50.", "error");
    void put({ ...(m !== undefined ? { monthlyCapUsd: m } : {}), ...(h !== undefined ? { hardCapUsd: h } : {}) }, "Caps saved.");
  };
  const pause = () => {
    if (!until) return say("Pick the day to pause until.", "error");
    void put({ pausedUntil: new Date(`${until}T00:00:00`).toISOString() }, "AI is paused.");
  };

  const paused = budget?.pausedUntil != null && Date.parse(budget.pausedUntil) > (now ?? new Date()).getTime();

  return (
    <HouseholdFrame current="ai">
      <div className="flex flex-col" data-testid="ai-cost">
        {usage.state === "cold" ? (
          <div className="flex flex-col gap-3" aria-busy="true" data-testid="ai-cost-skeleton">
            <SkeletonLine className="w-48" />
            <SkeletonLine className="w-64" />
          </div>
        ) : usage.state === "failed" || !u || !budget ? (
          <Note kind="error" onRetry={usage.refetch} retrying={usage.isFetching}>
            Couldn't load the AI cost.
          </Note>
        ) : (
          <>
            <div className="pb-8" data-testid="ai-month">
              <Figure size="md" label={`Spent so far in ${u.month}`} amount={u.monthToDateUsd} state={usage.state} format={usd} data-testid="figure-ai-month" />
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 type-body text-ink-2" data-testid="ai-counts">
                <div className="flex gap-1">
                  <dd className="tnum font-mono text-ink" data-testid="ai-calls">{u.calls ?? 0}</dd>
                  <dt>calls</dt>
                </div>
                <div className="flex gap-1">
                  <dd className="tnum font-mono text-ink" data-testid="ai-failures">{u.failures ?? 0}</dd>
                  <dt>failed</dt>
                </div>
                <div className="flex gap-1">
                  <dd className="tnum font-mono text-ink" data-testid="ai-blocked">{u.blocked ?? 0}</dd>
                  <dt>stopped by the cap</dt>
                </div>
                {u.cacheHitRatio != null && (
                  <div className="flex gap-1">
                    <dd className="tnum font-mono text-ink" data-testid="ai-cache">{percent(u.cacheHitRatio)}</dd>
                    <dt>reused from cache</dt>
                  </div>
                )}
              </dl>
            </div>

            <Section label="By task">
              {u.byTask.length === 0 ? (
                <Note kind="empty">No AI work this month.</Note>
              ) : (
                <table className="w-full text-left type-body" data-testid="ai-by-task">
                  <thead>
                    <tr className="type-caption text-ink-3">
                      <th scope="col" className="py-1 font-normal">Task</th>
                      <th scope="col" className="py-1 text-right font-normal">Cost</th>
                      <th scope="col" className="py-1 text-right font-normal">Calls</th>
                      <th scope="col" className="py-1 text-right font-normal">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.byTask.map((t) => (
                      <tr key={t.task} className="border-t border-rule" data-testid="ai-task-row">
                        <th scope="row" className="py-2 font-normal text-ink">{taskWord(t.task)}</th>
                        <td className="py-2 text-right tnum font-mono text-ink">
                          <data value={String(t.costUsd)}>{usd(t.costUsd)}</data>
                        </td>
                        <td className="py-2 text-right tnum font-mono text-ink-2">{t.calls}</td>
                        <td className="py-2 text-right tnum font-mono text-ink-2">{t.failures}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section label="Caps">
              <div className="flex flex-col gap-6" data-testid="ai-caps">
                {[
                  { label: "Monthly cap", limit: budget.monthlyCapUsd, id: "monthly" },
                  { label: "Hard stop", limit: budget.hardCapUsd, id: "hard" },
                ].map((c) =>
                  c.limit > 0 ? (
                    <Meter
                      key={c.id}
                      label={c.label}
                      spent={u.monthToDateUsd}
                      limit={c.limit}
                      status={meterStatus(u.monthToDateUsd, c.limit)}
                      words={CAP_WORDS[meterStatus(u.monthToDateUsd, c.limit)]}
                      data-testid={`ai-cap-${c.id}`}
                    />
                  ) : (
                    <p key={c.id} className="type-body text-ink-2" data-testid={`ai-cap-${c.id}`}>
                      {c.label}: none set.
                    </p>
                  ),
                )}
              </div>
              {owner ? (
                <form
                  className="mt-6 flex flex-col gap-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveCaps();
                  }}
                  data-testid="ai-caps-form"
                >
                  <MoneyInput label="Monthly cap" value={monthly ?? String(budget.monthlyCapUsd)} onChange={setMonthly} data-testid="ai-monthly-input" />
                  <MoneyInput label="Hard stop" value={hard ?? String(budget.hardCapUsd)} onChange={setHard} data-testid="ai-hard-input" />
                  <Button type="submit" variant="quiet" size="sm" className="self-start" disabled={save.isPending || (monthly == null && hard == null)} data-testid="ai-caps-save">
                    Save caps
                  </Button>
                </form>
              ) : (
                <p className="mt-4 type-caption text-ink-3">The household owner sets the caps.</p>
              )}
            </Section>

            <Section label="Pause">
              <p className="type-body text-ink" data-testid="ai-pause-state">
                {paused ? (
                  <>
                    AI is paused until <span data-testid="ai-paused-until">{shortDateOfInstant(budget.pausedUntil!)}</span>.
                  </>
                ) : (
                  "AI is running."
                )}
              </p>
              {owner && (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {paused ? (
                    <Button variant="quiet" size="sm" onClick={() => void put({ pausedUntil: null }, "AI is running again.")} disabled={save.isPending} data-testid="ai-resume">
                      Resume
                    </Button>
                  ) : (
                    <>
                      <Field label="Pause until">
                        {(a) => <input {...a} type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={`${inputClass} w-auto`} data-testid="ai-pause-date" />}
                      </Field>
                      <Button variant="quiet" size="sm" onClick={pause} disabled={save.isPending} data-testid="ai-pause">
                        Pause
                      </Button>
                    </>
                  )}
                </div>
              )}
            </Section>

            <Section label="Last runs">
              {u.recentRuns.length === 0 ? (
                <Note kind="empty">No runs yet.</Note>
              ) : (
                <ul data-testid="ai-runs">
                  {u.recentRuns.slice(0, 20).map((r) => (
                    <li key={r.id} className="flex flex-col gap-0.5 border-t border-rule py-2 first:border-t-0" data-testid="ai-run">
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="type-body text-ink">{taskWord(r.kind)}</span>
                        <span className="tnum font-mono type-body text-ink">{r.costUsd == null ? "—" : usd(r.costUsd)}</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-4 type-caption text-ink-3">
                        <span>{relativeTime(r.startedAt, now)}</span>
                        <StatusWord tone={r.status === "succeeded" ? "fresh" : r.status === "running" ? "neutral" : "stale"}>{RUN_STATUS_WORD[r.status] ?? r.status}</StatusWord>
                      </div>
                      {r.summary && <p className="type-caption text-ink-3">{r.summary}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
      {toast}
    </HouseholdFrame>
  );
}
