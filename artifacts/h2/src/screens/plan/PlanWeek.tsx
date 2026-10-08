import { useState } from "react";
import { useUpdateAllowancePlan, type AllowancePlan, type AllowancePlans } from "@workspace/api-client-react";
import { AffordLauncher } from "@/screens/afford/AffordLauncher";
import { Button } from "@/kit/Button";
import { Figure } from "@/kit/Figure";
import { FreshnessBadge } from "@/kit/FreshnessBadge";
import { Meter, type MeterStatus } from "@/kit/Meter";
import { Note, RefreshNote } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonFigure, SkeletonLine, SkeletonMeter } from "@/kit/Skeleton";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { weeklyLimit } from "@/screens/today/WeekSection";
import { errorWords, parsePositiveDollars, plainDollars } from "./format";
import { MoneyInput, PlanFrame, useToast } from "./parts";
import { usePlanInvalidate, usePlanWeekData, type WeekData } from "./planData";

const STATUS: Record<"yes" | "tight" | "over", MeterStatus> = { yes: "on", tight: "tight", over: "over" };
const ENTRY_HINT = "Enter a dollar amount above $0, like 350 or 350.50.";

/** The plan in force for a member (null = the shared pool) and period: the latest start, as Today reads it. */
export function planFor(plans: AllowancePlans | undefined, memberUserId: string | null, period: "weekly" | "monthly"): AllowancePlan | null {
  return (
    plans?.plans
      .filter((p) => p.memberUserId === memberUserId && p.period === period)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null
  );
}

function Money({ value }: { value: string | number | null | undefined }) {
  const n = toAmount(value);
  if (n == null) return <span className="text-ink-3">—</span>;
  return (
    <data value={centsValue(n)} className="tnum">
      {fmtMoney(n)}
    </data>
  );
}

export function WeekSkeleton() {
  return (
    <PlanFrame current="week">
      <div className="flex flex-col gap-2 pb-8" data-testid="plan-skeleton" aria-busy="true">
        <SkeletonLine className="w-24" />
        <SkeletonFigure size="xl" />
        <SkeletonLine className="w-48" />
      </div>
      <Section label="This week">
        <SkeletonMeter />
      </Section>
    </PlanFrame>
  );
}

function MemberRow({
  plan,
  name,
  canSet,
  busy,
  onSave,
}: {
  plan: AllowancePlan;
  name: string;
  canSet: boolean;
  busy: boolean;
  onSave: (plan: AllowancePlan, amount: string) => string | null;
}) {
  const [value, setValue] = useState(plainDollars(plan.amount));
  const [error, setError] = useState<string | null>(null);
  const word = plan.period === "weekly" ? "a week" : "a month";
  return (
    <li className="flex flex-col gap-2 border-t border-rule py-3 first:border-t-0" data-testid="member-plan">
      {canSet ? (
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <MoneyInput
              label={`${name}, ${word}`}
              value={value}
              onChange={(v) => {
                setValue(v);
                setError(null);
              }}
              error={error}
              onCommit={undefined}
            />
          </div>
          <Button
            size="md"
            disabled={busy}
            onClick={() => setError(onSave(plan, value))}
            aria-label={`Save ${name}'s allowance`}
          >
            Save
          </Button>
        </div>
      ) : (
        <p className="flex items-baseline justify-between gap-4 type-body text-ink">
          <span>
            {name}, {word}
          </span>
          <Money value={plan.amount} />
        </p>
      )}
    </li>
  );
}

export default function PlanWeek({ now }: { now?: Date }) {
  const data = usePlanWeekData();
  return <WeekView data={data} now={now} />;
}

/**
 * ⭐ THE WEEK — one figure: the weekly limit, and where it comes from. The
 * limit is the household's shared weekly plan as the server holds it; the
 * suggestion is the server's own working, shown as a short ledger. The
 * owner sets the number (or takes the suggestion); a member reads it.
 *
 * ⚠️ NOTHING IS WORKED OUT HERE. Every line of the ledger is a field of
 * `GET /allowance-plans`; the meter is Today's, on `GET /money/position`.
 */
export function WeekView({ data, now }: { data: WeekData; now?: Date }) {
  const { spine, plans, position, me, members } = data;
  const update = useUpdateAllowancePlan();
  const invalidate = usePlanInvalidate();
  const { say, node: toast } = useToast();
  const [own, setOwn] = useState("");
  const [ownError, setOwnError] = useState<string | null>(null);

  if (plans.state === "cold" && !plans.data) return <WeekSkeleton />;

  if (!plans.data) {
    return (
      <PlanFrame current="week">
        <Figure size="xl" label="Weekly limit" amount={null} state="failed" data-testid="figure-hero" />
        <div className="mt-4">
          <Note kind="error" onRetry={plans.refetch} retrying={plans.isFetching}>
            Couldn't load your plan.
          </Note>
        </div>
      </PlanFrame>
    );
  }

  const shared = planFor(plans.data, null, "weekly");
  const sharedMonthly = planFor(plans.data, null, "monthly");
  const suggested = plans.data.suggested;
  const suggestedWeekly = toAmount(suggested.weekly);
  const currentWeekly = toAmount(shared?.amount);
  const matches = suggestedWeekly != null && currentWeekly != null && Math.round(suggestedWeekly * 100) === Math.round(currentWeekly * 100);
  // Cold: wait for the answer. Failed: try, and handle a 403.
  const canSet = me.data ? me.data.isOwner : me.state !== "cold";
  const ownerName =
    members.data?.find((m) => m.isOwner)?.displayName ?? members.data?.find((m) => m.isOwner)?.email ?? "the owner";
  const sourceWord = shared?.source === "derived" ? "suggested" : me.data && !me.data.isOwner ? `set by ${ownerName}` : "set by you";

  const save = (id: string, amount: string, done: string) => {
    update.mutate(
      { id, data: { amount } },
      {
        onSuccess: () => {
          invalidate();
          say(done);
        },
        onError: (e) => say(errorWords(e), "error"),
      },
    );
  };

  const saveOwn = () => {
    const amount = parsePositiveDollars(own);
    if (!amount) return setOwnError(ENTRY_HINT);
    if (!shared) return setOwnError("There is no weekly plan to change yet.");
    setOwnError(null);
    save(shared.id, amount, "Weekly limit saved.");
    setOwn("");
  };

  const saveMember = (plan: AllowancePlan, raw: string): string | null => {
    const amount = parsePositiveDollars(raw);
    if (!amount) return ENTRY_HINT;
    save(plan.id, amount, "Allowance saved.");
    return null;
  };

  // The latest plan per member and period.
  const memberPlans = plans.data.plans
    .filter((p) => p.memberUserId !== null)
    .filter((p, _i, all) => planFor({ ...plans.data!, plans: all }, p.memberUserId, p.period) === p);
  const nameOf = (id: string | null) => {
    const m = members.data?.find((x) => x.id === id);
    return m?.displayName ?? m?.email ?? "A member";
  };

  const pos = position.data;
  const { limit } = weeklyLimit(pos, plans.data, undefined);
  const spent = toAmount(pos?.spentWeekDiscretionary);
  const within = spine.data?.position.withinPlan ?? pos?.withinPlan ?? null;
  const remaining = toAmount(spine.data?.position.remainingWeek ?? pos?.remainingWeek);
  const words = within === "over" && remaining != null && remaining < 0 ? `Over by ${fmtMoney(-remaining)}` : undefined;

  const ledger: Array<[string, string, boolean]> = [
    ["Take-home pay, per month", suggested.derivation.takeHomeMonthly, false],
    ["Less bills", suggested.derivation.committedMonthly, false],
    ["Less debt minimums", suggested.derivation.debtMinimumsMonthly, false],
    ["Less extra toward debt", suggested.derivation.extraMonthly, false],
    ["Less goals", suggested.derivation.goalsMonthly, false],
    ["Left to spend, per month", suggested.derivation.discretionaryMonthly, true],
    ["A week, rounded down to $5", suggested.weekly, true],
  ];

  return (
    <PlanFrame current="week">
      {(plans.state === "refresh-failed" || position.state === "refresh-failed") && (
        <div className="mb-6">
          <RefreshNote state="refresh-failed" updatedAt={spine.updatedAt} onRetry={plans.refetch} retrying={plans.isFetching} now={now} />
        </div>
      )}

      <div className="pb-8">
        <Figure
          size="xl"
          label="Weekly limit"
          amount={currentWeekly}
          state={plans.state}
          suffix="a week"
          sub={
            shared ? (
              <>
                <span data-testid="limit-source-word">{sourceWord}</span>
                {sharedMonthly && (
                  <>
                    {" "}
                    · <Money value={sharedMonthly.amount} /> a month
                  </>
                )}
              </>
            ) : (
              "No weekly plan is set yet."
            )
          }
          data-testid="figure-hero"
        />
      </div>

      <Section label="This week" data-testid="section-week" action={<FreshnessBadge bank={spine.data?.bank} state={spine.state} now={now} />}>
        {position.state === "cold" && !pos ? (
          <SkeletonMeter />
        ) : spent == null ? (
          <Note kind="error" onRetry={position.refetch} retrying={position.isFetching}>
            Couldn't load this week.
          </Note>
        ) : (
          <Meter label="Spent so far" spent={spent} limit={limit} status={within ? STATUS[within] : "on"} words={words} data-testid="meter-week" />
        )}
        <div className="mt-4">
          <AffordLauncher variant="link" data-testid="afford-open-week" />
        </div>
      </Section>

      <Section label="Where the suggestion comes from" data-testid="section-suggestion">
        <ul className="flex flex-col" data-testid="suggestion-ledger">
          {ledger.map(([label, value, strong]) => (
            <li key={label} className="flex items-baseline justify-between gap-4 border-t border-rule py-2 first:border-t-0">
              <span className={strong ? "type-label text-ink" : "type-body text-ink-2"}>{label}</span>
              <span className={strong ? "type-figure-sm text-ink" : "type-figure-sm text-ink-2"}>
                <Money value={value} />
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {canSet && shared && !matches && suggestedWeekly != null && (
            <Button
              variant="primary"
              disabled={update.isPending}
              onClick={() => save(shared.id, suggested.weekly, "Using the suggestion.")}
              data-testid="use-suggestion"
            >
              Use the suggestion
            </Button>
          )}
          {matches && (
            <p className="type-body text-ink-2" data-testid="matches-suggestion">
              Your limit matches the suggestion.
            </p>
          )}
        </div>
      </Section>

      <Section label="Set your own" data-testid="section-set">
        {canSet ? (
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <MoneyInput
                label="Weekly limit"
                value={own}
                onChange={(v) => {
                  setOwn(v);
                  setOwnError(null);
                }}
                error={ownError}
                placeholder={currentWeekly != null ? plainDollars(currentWeekly) : "350"}
                data-testid="input-own"
              />
            </div>
            <Button variant="quiet" disabled={update.isPending} onClick={saveOwn} data-testid="save-own">
              Save
            </Button>
          </div>
        ) : (
          <p className="type-body text-ink-2" data-testid="read-only">
            {sourceWord.startsWith("set by") ? `The limit is ${sourceWord}.` : "Only the household owner sets the limit."}
          </p>
        )}
      </Section>

      <Section label="Personal allowances" data-testid="section-personal">
        {memberPlans.length === 0 ? (
          <Note kind="empty">No personal allowances are set up.</Note>
        ) : (
          <ul className="flex flex-col">
            {memberPlans.map((p) => (
              <MemberRow key={p.id} plan={p} name={nameOf(p.memberUserId)} canSet={canSet} busy={update.isPending} onSave={saveMember} />
            ))}
          </ul>
        )}
        <p className="mt-3 type-caption text-ink-3">
          Personal spending is counted against the member on the row, or against the account's owner when a row has no member.
        </p>
      </Section>
      {toast}
    </PlanFrame>
  );
}
