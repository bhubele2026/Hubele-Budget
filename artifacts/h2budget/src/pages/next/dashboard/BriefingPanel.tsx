import { useMemo } from "react";
import { Link } from "wouter";
import { Panel } from "@/components/next";
import { attentionItems, billsDueSoon } from "@/lib/attention";
import { householdToday } from "@/lib/householdDay";
import { useSpine } from "@/hooks/useSpine";
import { useBillsSummaryQ, useRecapPreviewQ } from "./queries";
import { Gate, rise } from "./shared";

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
  const text = r ? (r.model?.text ?? r.template.text) : null;
  const badge = r ? (r.model ? (r.model.demo ? "Demo" : "Draft") : "Template") : null;
  const q = { data: s, isError: spine.state === "failed", refetch: spine.refetch };

  return (
    <Panel title="Today" span={12} className={rise(0)} data-testid="dash-briefing"
      actions={badge ? <span className="chip gray" data-testid="dash-recap-badge">{badge}</span> : null}>
      <Gate q={q} what="The briefing" rows={2}>
        {() => (
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
            <p className="text-body text-brand-ink" data-testid="dash-recap-text">
              {text ?? (recap.isError ? "The summary is not available right now." : "Writing today's summary…")}
            </p>
            {next ? (
              <div className="rounded-control bg-platinum-3 px-4 py-3" data-testid="dash-action" data-kind={next.kind}>
                <div className="text-micro uppercase tracking-wide text-neutral-500">Next</div>
                <div className="text-label font-semibold text-brand-navy">{next.title}</div>
                {next.detail ? <div className="text-micro text-neutral-600">{next.detail}</div> : null}
                {next.action ? (
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
