import { useMemo } from "react";
import { Link } from "wouter";
import { Panel } from "@/components/next";
import { WaysBackLauncher } from "@/components/ways-back/WaysBackLauncher";
import { attentionItems, billsDueSoon } from "@/lib/attention";
import { householdToday } from "@/lib/householdDay";
import { useSpine } from "@/hooks/useSpine";
import { useBillsSummaryQ, useRecapPreviewQ } from "./queries";
import { dayLabel, Gate, rise } from "./shared";

const URL_RE = /https?:\/\/\S+/g;
/** The recap ends with a link by design; the page shows the sentences only,
 *  and keeps the date the link carried as a quiet "for <date>". */
export function cleanRecap(text: string, facts?: Record<string, unknown>): { body: string; forDate: string | null } {
  const link = text.match(URL_RE)?.[0] ?? "";
  const fromLink = /[?&]d=(\d{4}-\d{2}-\d{2})/.exec(link)?.[1] ?? null;
  const fromFacts = [facts?.forDate, facts?.date].find((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) as string | undefined;
  return { body: text.replace(URL_RE, "").replace(/[ \t]+\n/g, "\n").trim(), forDate: fromFacts?.slice(0, 10) ?? fromLink };
}

export default function BriefingPanel() {
  const spine = useSpine();
  const bills = useBillsSummaryQ();
  const recap = useRecapPreviewQ();
  const today = householdToday(new Date());
  const s = spine.data;
  const next = useMemo(() => {
    if (!s) return null;
    const rem = s.position.remainingWeek == null ? null : Number(s.position.remainingWeek);
    return attentionItems({
      bank: s.bank,
      withinPlan: s.position.withinPlan,
      overBy: rem != null && rem < 0 ? -rem : null,
      dueSoon: billsDueSoon(bills.data, today),
      today,
      reviewCount: s.reviewCount,
    })[0]!;
  }, [s, bills.data, today]);

  const r = recap.data;
  const cleaned = r ? cleanRecap(r.model?.text ?? r.template.text, r.facts as Record<string, unknown>) : null;
  const text = cleaned?.body ?? null;
  const forDay = dayLabel(cleaned?.forDate);
  const badge = r ? (r.model ? (r.model.demo ? "Demo" : "Draft") : "Template") : null;
  const q = { data: s, isError: spine.state === "failed", refetch: spine.refetch };

  return (
    <Panel title="Today" span={12} className={rise(0)} data-testid="dash-briefing"
      actions={badge ? <span className="chip gray" data-testid="dash-recap-badge">{badge}</span> : null}>
      <Gate q={q} what="The briefing" rows={2}>
        {() => (
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="text-body text-brand-ink" data-testid="dash-recap-text">
                {text ?? (recap.isError ? "The summary is not available right now." : "Writing today's summary…")}
              </p>
              {forDay ? <p className="mt-1 text-micro text-neutral-500" data-testid="dash-recap-for">for {forDay}</p> : null}
            </div>
            {next ? (
              <div className="rounded-control bg-platinum-3 px-4 py-3" data-testid="dash-action" data-kind={next.kind}>
                <div className="text-micro uppercase tracking-wide text-neutral-500">Next</div>
                <div className="text-label font-semibold text-brand-navy">{next.title}</div>
                {next.detail ? <div className="text-micro text-neutral-600">{next.detail}</div> : null}
                {next.wayBack ? (
                  <WaysBackLauncher className="mt-2" />
                ) : next.action ? (
                  <Link href={next.action.href} className="mt-1 inline-block text-label font-semibold text-brand-navy underline" data-testid="dash-action-link">
                    {next.action.label}
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Gate>
    </Panel>
  );
}
