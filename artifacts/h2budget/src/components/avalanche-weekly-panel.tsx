// ⭐ (AVAL-W) HOW THE AVALANCHE GOES OUT — monthly or weekly.
//
// Owner, 2026-11-10: "weekly is easier to maintain for avalanche payments" and
// "maximize how much I can pay on debt weekly". With Weekly on, each payment day
// pays the most the forecast says is safe that day — never below the cash
// buffer — and the monthly figure stays as the TARGET it is measured against
// ("Target $2,600/mo · this Friday $350").
//
// PRESENTATION ONLY. Every figure is the server's (`GET /avalanche/weekly`, the
// same plan the forecast puts on the curve); this file picks and formats, it
// never adds, rounds or re-derives a payment. The switch writes the setting
// (owner only — the server refuses a member's change too).

import { useMemo } from "react";
import type { AvalancheSettings, AvalancheSettingsInput } from "@workspace/api-client-react";
// The lazy `features` module: only lazy chunks read the weekly plan, so its hook
// never rides on the landing chunk.
import { useGetAvalancheWeekly } from "@workspace/api-client-react/features";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PillToggle } from "@/components/pill-toggle";
import { useOwner } from "@/hooks/useOwner";
import { Foot, Help, fieldLabel, td, tdNum, th } from "@/ui";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { householdToday } from "@/lib/householdDay";
// ⭐ "We paid it" / "Paid · Undo" for this week: the same state, writes and
// controls as the home page's avalanche box.
import { dayName, linkedNote, paidCardLabel, weekCardLabel, weekPayView } from "@/lib/avalancheWeekPay";
import { useAvalancheWeekPay } from "@/hooks/useAvalancheWeekPay";
import { WeekPayButton, WeekPayError, WeekUndoButton } from "@/components/avalanche-week-pay";

export { dayName, weekCardLabel };

const MIN = 60_000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** How many upcoming payments the list shows. */
export const WEEKLY_LIST_LENGTH = 12;

type Props = {
  settings: AvalancheSettings | undefined;
  onUpdate: (data: AvalancheSettingsInput) => void;
  saving?: boolean;
};

export function AvalancheWeeklyPanel({ settings, onUpdate, saving = false }: Props) {
  const owner = useOwner();
  const cadence = settings?.extraCadence === "weekly" ? "weekly" : "monthly";
  const weekday = settings?.extraWeekday ?? 5;
  const q = useGetAvalancheWeekly({
    query: { enabled: cadence === "weekly", staleTime: 5 * MIN, gcTime: 30 * MIN } as never,
  });
  const plan = cadence === "weekly" ? q.data : undefined;
  const today = householdToday();
  const monthlyTarget = Number(settings?.manualExtra ?? 0) || 0;

  const thisWeek = plan?.weeks[0] ?? null;
  const pay = useAvalancheWeekPay();
  const view = weekPayView(plan);
  // Marked paid here: the week reads as answered (it pays $0 more), so the
  // amount and the cards are the press's own.
  const paidHere = view.kind === "paid" ? view.paid : null;
  const shown = paidHere ? paidHere.total : (thisWeek?.paid ?? 0);
  // The next payments that pay something, on the curve; weeks with nothing safe are left out.
  const upcoming = useMemo(
    () => (plan?.weeks ?? []).filter((w) => w.paid > 0).slice(0, WEEKLY_LIST_LENGTH),
    [plan],
  );
  const name = dayName(plan?.weekday ?? weekday);
  const isToday = !!thisWeek && thisWeek.date === today;
  const thisLabel = isToday ? "Today" : `This ${name}`;

  return (
    <div className="panel span-12" data-testid="panel-avalanche-weekly">
      <div className="panel-head">
        <span className="text-title font-semibold text-foreground">Avalanche payments</span>
        <Help className="ml-auto">
          Weekly pays the most the forecast says is safe each week, never taking checking below your cash
          cushion. The monthly amount stays as the target. When a debt is paid off, its minimum joins the
          weekly payment.
        </Help>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-12">
        <div className="space-y-3 md:col-span-4">
          {owner === true ? (
            <PillToggle
              value={cadence}
              onChange={(v) => {
                if (v !== cadence) onUpdate({ extraCadence: v });
              }}
              options={[
                { value: "weekly", label: "Weekly", sub: "Most that is safe" },
                { value: "monthly", label: "Monthly", sub: "One month-end payment" },
              ]}
            />
          ) : owner === false ? (
            <p className="text-body text-neutral-600" data-testid="avalanche-cadence-member">
              Paid {cadence === "weekly" ? `weekly, on ${name}s` : "monthly"}. The owner sets this.
            </p>
          ) : (
            <Skeleton className="h-12 w-full" />
          )}
          {owner === true && cadence === "weekly" && (
            <div>
              <div className={fieldLabel}>Pay on</div>
              <Select
                value={String(weekday)}
                onValueChange={(v) => {
                  const n = Number(v);
                  if (n !== weekday) onUpdate({ extraWeekday: n });
                }}
                disabled={saving}
              >
                <SelectTrigger aria-label="Payment day" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_NAMES.map((d, i) => (
                    <SelectItem key={d} value={String(i)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="min-w-0 md:col-span-8">
          {cadence === "monthly" ? (
            <p className="text-body text-neutral-600" data-testid="avalanche-monthly-line">
              Paying <span className="fig text-foreground">{formatCurrency(monthlyTarget)}</span> at
              the end of each month. Weekly pays the most that is safe every week instead.
            </p>
          ) : q.isLoading && !plan ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : !plan || plan.weeks.length === 0 ? (
            <p className="text-body text-neutral-600" data-testid="avalanche-weekly-empty">
              {q.isError ? "The weekly plan could not be read. Try again in a moment." : "No debt left for the avalanche to pay."}
            </p>
          ) : (
            <>
              <div data-testid="avalanche-this-week">
                <div className={fieldLabel}>{thisLabel}</div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <span className="fig text-kpi font-semibold text-foreground">
                    {formatCurrency(shown)}
                  </span>
                  <span className="text-body text-neutral-600">
                    {paidHere
                      ? `paid to ${paidCardLabel(paidHere)}`
                      : thisWeek!.paid > 0
                        ? `→ ${weekCardLabel(thisWeek!)}`
                        : thisWeek!.answered
                          ? "answered on the Forecast"
                          : "nothing is safe to pay this week"}
                  </span>
                </div>
                {view.kind === "toPay" && (
                  <div className="mt-2">
                    <WeekPayButton controls={pay} date={view.week.date} />
                  </div>
                )}
                {paidHere && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-label text-neutral-600" data-testid="avalanche-week-paid-row">
                    <span className="font-semibold text-brand-navy">Paid</span>
                    {paidHere.targets
                      .filter((t) => t.paidOff)
                      .map((t) => (
                        <span key={t.debtId} className="inline-flex items-center gap-1.5">
                          <span className="chip ok">PAID OFF</span>
                          <span className="text-neutral-500">{t.name}</span>
                        </span>
                      ))}
                    <WeekUndoButton controls={pay} paid={paidHere} />
                    {linkedNote(paidHere) && (
                      <span className="basis-full text-neutral-500" data-testid="avalanche-week-linked">
                        {linkedNote(paidHere)}
                      </span>
                    )}
                  </div>
                )}
                <WeekPayError controls={pay} />
                <p className="mt-1 text-label text-neutral-500" data-testid="avalanche-target-line">
                  Target <span className="fig">{formatCurrency(plan.monthlyTarget)}</span>/mo ·{" "}
                  {isToday ? "today" : `this ${name}`} <span className="fig">{formatCurrency(shown)}</span>
                  {" · "}
                  {plan.debtFreeDate ? (
                    <span data-testid="avalanche-debt-free-date">
                      debt-free <span className="fig">{formatDate(plan.debtFreeDate)}</span>
                    </span>
                  ) : (
                    <span data-testid="avalanche-debt-free-date">no debt-free date yet</span>
                  )}
                </p>
              </div>

              {upcoming.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full" data-testid="avalanche-weekly-list">
                    <thead>
                      <tr>
                        <th className={th}>Date</th>
                        <th className={`${th} text-right`}>Amount</th>
                        <th className={th}>Card</th>
                        <th className={th}>
                          <span className="sr-only">Notes</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {upcoming.map((w) => (
                        <tr key={w.date} data-testid={`avalanche-week-${w.date}`}>
                          <td className={cn(td, "whitespace-nowrap text-neutral-500")}>{formatDate(w.date)}</td>
                          <td className={tdNum}>{formatCurrency(w.paid)}</td>
                          <td className={cn(td, "text-neutral-600")}>{weekCardLabel(w)}</td>
                          <td className={cn(td, "text-micro")}>
                            <span className="flex flex-wrap items-center gap-1.5">
                              {w.paidOff.map((p) => (
                                <span key={p.debtId} className="inline-flex flex-wrap items-center gap-1.5">
                                  <span className="chip ok">PAID OFF</span>
                                  <span className="text-neutral-500">{p.name}</span>
                                  {p.freedWeekly > 0 && (
                                    <span className="text-neutral-500">
                                      goes up <span className="fig">{formatCurrency(p.freedWeekly)}</span> a
                                      week
                                    </span>
                                  )}
                                </span>
                              ))}
                              {w.basis === "target" && <span className="text-neutral-500">at the target pace</span>}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {cadence === "weekly" && plan && plan.weeks.length > 0 && (
        <Foot>
          Each payment keeps checking at or above your {formatCurrency(plan.cashBuffer)} cushion on the forecast; weeks
          with nothing safe to pay are left out.
          {plan.curveThrough ? ` Past ${formatDate(plan.curveThrough)} the dates assume the target pace.` : ""}
        </Foot>
      )}
    </div>
  );
}
