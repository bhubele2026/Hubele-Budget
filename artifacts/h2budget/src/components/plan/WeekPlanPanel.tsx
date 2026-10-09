import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useListMembers, useUpdateAllowancePlan } from "@workspace/api-client-react";
import {
  getListAllowancePlansQueryKey,
  useListAllowancePlans,
  type AllowancePlan,
} from "@workspace/api-client-react/features";
import { Panel } from "@/components/next";
import { Help, btn, btnSecondary, emptyNote, fieldLabel, input } from "@/ui";
import { OWN_INVALIDATION, invalidateAfterWrite } from "@/lib/mutationInvalidation";
import { useToast } from "@/hooks/use-toast";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import {
  latestMemberPlans,
  matchesSuggestion,
  parsePositiveDollars,
  plainDollars,
  planErrorWords,
  planFor,
} from "@/lib/planWords";

const ENTRY_HINT = "Enter a dollar amount above $0, like 350 or 350.50.";

function Money({ value }: { value: string | number | null | undefined }) {
  const n = toAmount(value);
  if (n == null) return <span className="text-neutral-400">—</span>;
  return (
    <data value={centsValue(n)} className="font-mono tabular-nums">
      {fmtMoney(n)}
    </data>
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
    <li className="flex flex-col gap-1 border-t border-brand-line py-3 first:border-t-0" data-testid="member-plan">
      {canSet ? (
        <div className="flex items-end gap-3">
          <label className="min-w-0 flex-1">
            <span className={fieldLabel}>{`${name}, ${word}`}</span>
            <input
              className={`${input} mt-1 font-mono tabular-nums`}
              inputMode="decimal"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
          </label>
          <button
            type="button"
            className={btnSecondary}
            disabled={busy}
            onClick={() => setError(onSave(plan, value))}
            aria-label={`Save ${name}'s allowance`}
          >
            Save
          </button>
        </div>
      ) : (
        <p className="flex items-baseline justify-between gap-4 text-body text-brand-navy">
          <span>
            {name}, {word}
          </span>
          <Money value={plan.amount} />
        </p>
      )}
      {error && (
        <p className="text-micro text-bad" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * ⭐ THE WEEKLY PLAN (F11) — the household's shared weekly limit as the server
 * holds it, the server's own suggestion shown as a short ledger, the owner's
 * own number, and per-member allowances. A member reads; the owner sets.
 *
 * ⚠️ NOTHING IS WORKED OUT HERE. Every line of the ledger is a field of
 * `GET /allowance-plans`. This is the SERVER's plan (it drives the weekly
 * position on the dashboard); the cards above keep their own per-week figures.
 */
export function WeekPlanPanel() {
  const qc = useQueryClient();
  const plans = useListAllowancePlans({
    query: { queryKey: getListAllowancePlansQueryKey(), staleTime: 5 * 60_000, gcTime: 30 * 60_000 },
  });
  const me = useGetMe({ query: { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as never });
  const members = useListMembers({ query: { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as never });
  // The write marks the plan list itself; the spine and money position by the shared rule.
  const update = useUpdateAllowancePlan({ mutation: { meta: OWN_INVALIDATION } });
  const { toast } = useToast();
  const [own, setOwn] = useState("");
  const [ownError, setOwnError] = useState<string | null>(null);

  const say = (title: string, bad = false) => toast({ title, ...(bad ? { variant: "destructive" as const } : {}) });
  const data = plans.data;

  if (!data) {
    return (
      <Panel title="Weekly plan" span={12} variant="static" data-testid="week-plan">
        <div className={emptyNote} aria-busy={plans.isLoading}>
          {plans.isError ? (
            <>
              Couldn't load your plan.{" "}
              <button type="button" className="underline" onClick={() => void plans.refetch()}>
                Try again
              </button>
            </>
          ) : (
            "Loading…"
          )}
        </div>
      </Panel>
    );
  }

  const shared = planFor(data.plans, null, "weekly");
  const sharedMonthly = planFor(data.plans, null, "monthly");
  const suggested = data.suggested;
  const suggestedWeekly = toAmount(suggested.weekly);
  const currentWeekly = toAmount(shared?.amount);
  const matches = matchesSuggestion(suggestedWeekly, currentWeekly);
  const meData = me.data as { isOwner?: boolean } | undefined;
  const canSet = meData ? meData.isOwner === true : !me.isLoading;
  const memberList = (members.data ?? []) as Array<{ id: string; isOwner?: boolean; displayName?: string | null; email?: string | null }>;
  const ownerMember = memberList.find((m) => m.isOwner);
  const ownerName = ownerMember?.displayName ?? ownerMember?.email ?? "the owner";
  const sourceWord = shared?.source === "derived" ? "suggested" : meData && !meData.isOwner ? `set by ${ownerName}` : "set by you";
  const nameOf = (id: string | null) => {
    const m = memberList.find((x) => x.id === id);
    return m?.displayName ?? m?.email ?? "A member";
  };

  const save = (id: string, amount: string, done: string) => {
    update.mutate(
      { id, data: { amount } },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: getListAllowancePlansQueryKey() });
          invalidateAfterWrite(qc);
          say(done);
        },
        onError: (e) => say(planErrorWords(e), true),
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

  const memberPlans = latestMemberPlans(data.plans);
  const d = suggested.derivation;
  const ledger: Array<[string, string, boolean]> = [
    ["Take-home pay, per month", d.takeHomeMonthly, false],
    ["Less bills", d.committedMonthly, false],
    ["Less debt minimums", d.debtMinimumsMonthly, false],
    ["Less extra toward debt", d.extraMonthly, false],
    ["Less goals", d.goalsMonthly, false],
    ["Left to spend, per month", d.discretionaryMonthly, true],
    ["A week, rounded down to $5", suggested.weekly, true],
  ];

  return (
    <Panel
      title="Weekly plan"
      sub="The household's limit as the server holds it"
      span={12}
      variant="static"
      data-testid="week-plan"
      actions={<Help>The weekly limit here drives the weekly position on the dashboard. The cards above keep their own per-week figures.</Help>}
    >
      <div className="grid gap-6 lg:grid-cols-3">
        <section data-testid="plan-limit">
          <div className={fieldLabel}>Weekly limit</div>
          <div className="mt-1 font-mono text-display font-semibold tabular-nums text-brand-navy" data-testid="plan-limit-figure">
            {currentWeekly == null ? "—" : <Money value={currentWeekly} />}
          </div>
          <p className="mt-1 text-micro text-neutral-500">
            {shared ? (
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
            )}
          </p>

          <div className="mt-4">
            {canSet ? (
              <div className="flex items-end gap-3">
                <label className="min-w-0 flex-1">
                  <span className={fieldLabel}>Set your own</span>
                  <input
                    className={`${input} mt-1 font-mono tabular-nums`}
                    inputMode="decimal"
                    value={own}
                    placeholder={currentWeekly != null ? plainDollars(currentWeekly) : "350"}
                    onChange={(e) => {
                      setOwn(e.target.value);
                      setOwnError(null);
                    }}
                    data-testid="input-own"
                  />
                </label>
                <button type="button" className={btnSecondary} disabled={update.isPending} onClick={saveOwn} data-testid="save-own">
                  Save
                </button>
              </div>
            ) : (
              <p className="text-body text-neutral-600" data-testid="read-only">
                {sourceWord.startsWith("set by") ? `The limit is ${sourceWord}.` : "Only the household owner sets the limit."}
              </p>
            )}
            {ownError && (
              <p className="mt-1 text-micro text-bad" role="alert">
                {ownError}
              </p>
            )}
          </div>
        </section>

        <section data-testid="plan-suggestion">
          <div className={fieldLabel}>Where the suggestion comes from</div>
          <ul className="mt-1 flex flex-col" data-testid="suggestion-ledger">
            {ledger.map(([label, value, strong]) => (
              <li key={label} className="flex items-baseline justify-between gap-4 border-t border-brand-line py-1.5 first:border-t-0">
                <span className={strong ? "text-label font-semibold text-brand-navy" : "text-body text-neutral-600"}>{label}</span>
                <span className="text-label text-brand-navy">
                  <Money value={value} />
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {canSet && shared && !matches && suggestedWeekly != null && (
              <button
                type="button"
                className={btn}
                disabled={update.isPending}
                onClick={() => save(shared.id, suggested.weekly, "Using the suggestion.")}
                data-testid="use-suggestion"
              >
                Use the suggestion
              </button>
            )}
            {matches && (
              <p className="text-body text-neutral-600" data-testid="matches-suggestion">
                Your limit matches the suggestion.
              </p>
            )}
          </div>
        </section>

        <section data-testid="plan-personal">
          <div className={fieldLabel}>Personal allowances</div>
          {memberPlans.length === 0 ? (
            <p className="mt-1 text-body text-neutral-500">No personal allowances are set up.</p>
          ) : (
            <ul className="mt-1 flex flex-col">
              {memberPlans.map((p) => (
                <MemberRow key={p.id} plan={p} name={nameOf(p.memberUserId)} canSet={canSet} busy={update.isPending} onSave={saveMember} />
              ))}
            </ul>
          )}
          <p className="mt-3 text-micro text-neutral-500">
            Personal spending is counted against the member on the row, or against the account's owner when a row has no member.
          </p>
        </section>
      </div>
    </Panel>
  );
}
