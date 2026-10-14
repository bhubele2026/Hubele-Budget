import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AllowancePlanPrefill } from "@workspace/api-client-react";
import {
  getGetPeriodBreakdownQueryKey,
  getListAllowancePlansQueryKey,
  useCreateAllowancePlan,
} from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { parsePositiveDollars, planErrorWords } from "@/lib/planWords";
import { formatCurrency } from "@/lib/utils";
import { btn, btnSecondary, fieldLabel, input } from "@/ui";
import { startWords, type PeriodView } from "./periodDates";

/**
 * (W5) "Plan not set" and the one way out of it. Nothing is set silently: a tap
 * opens a dialog that says the amount, the start day and that past periods keep
 * their plan; only its Confirm sends `POST /allowance-plans`, from THIS period's
 * first day (this Sunday / the 1st). Past periods are never offered a plan.
 *
 * Every amount here is one the server offered (`prefills[]`) or one the owner
 * types. The weekly default is the `hook_stored` prefill (the Weekly Spend
 * reserve) and nothing else.
 */
interface Pick {
  amount: string;
  /** The owner types the amount in the dialog. */
  custom: boolean;
}

const WORD: Record<PeriodView, { plan: string; noun: string }> = {
  week: { plan: "weekly", noun: "this week" },
  month: { plan: "monthly", noun: "this month" },
};

export function PlanPrompt({
  view,
  start,
  prefills,
  canSet,
}: {
  view: PeriodView;
  /** The current period's first day: the plan's `effectiveFrom`. */
  start: string;
  prefills: readonly AllowancePlanPrefill[];
  canSet: boolean;
}) {
  const period = view === "week" ? "weekly" : "monthly";
  const w = WORD[view];
  const qc = useQueryClient();
  const { toast } = useToast();
  const create = useCreateAllowancePlan();
  const [pick, setPick] = useState<Pick | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mine = prefills.filter((p) => p.period === period);
  const primary = view === "week" ? mine.find((p) => p.source === "hook_stored") ?? null : null;
  const seen = new Set<string>(primary ? [primary.amount] : []);
  const others = mine.filter((p) => (seen.has(p.amount) ? false : (seen.add(p.amount), true)));

  if (!canSet) {
    return (
      <p className="text-body text-neutral-600" data-testid="plan-prompt-readonly">
        Only the household owner sets the {w.plan} plan.
      </p>
    );
  }

  const close = () => {
    setPick(null);
    setTyped("");
    setError(null);
  };

  const confirm = () => {
    if (!pick) return;
    const amount = pick.custom ? parsePositiveDollars(typed) : pick.amount;
    if (!amount) {
      setError("Enter a dollar amount above $0, like 350 or 350.50.");
      return;
    }
    create.mutate(
      { data: { period, amount, effectiveFrom: start } },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: getListAllowancePlansQueryKey() });
          void qc.invalidateQueries({ queryKey: getGetPeriodBreakdownQueryKey().slice(0, 1) });
          toast({ title: `The ${w.plan} plan is set.` });
          close();
        },
        onError: (e) => setError(planErrorWords(e)),
      },
    );
  };

  return (
    <div className="space-y-2" data-testid="plan-prompt">
      <div className="flex flex-wrap gap-2">
        {primary ? (
          <button type="button" className={btn} data-testid="plan-use-primary" onClick={() => setPick({ amount: primary.amount, custom: false })}>
            Use {formatCurrency(primary.amount)} as the {w.plan} plan from {view === "week" ? "this week" : "this month"}
          </button>
        ) : null}
        {others.map((p) => (
          <button key={`${p.source}-${p.amount}`} type="button" className={btnSecondary} data-testid={`plan-use-${p.source}`} onClick={() => setPick({ amount: p.amount, custom: false })}>
            Use {formatCurrency(p.amount)} · {p.label}
          </button>
        ))}
        <button
          type="button"
          className={primary || others.length ? btnSecondary : btn}
          data-testid="plan-different"
          onClick={() => setPick({ amount: "", custom: true })}
        >
          Different amount
        </button>
      </div>
      {primary ? <p className="text-micro text-neutral-500">{primary.label}</p> : null}

      <Dialog open={pick != null} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent data-testid="plan-confirm">
          <DialogHeader>
            <DialogTitle>Set the {w.plan} plan</DialogTitle>
            <DialogDescription>Nothing changes until you confirm.</DialogDescription>
          </DialogHeader>
          <dl className="space-y-2 text-body">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-600">Amount</dt>
              <dd className="font-mono font-semibold tabular-nums text-brand-ink" data-testid="plan-confirm-amount">
                {pick?.custom ? null : pick ? formatCurrency(pick.amount) : null}
              </dd>
            </div>
            {pick?.custom ? (
              <label className="block">
                <span className={fieldLabel}>Dollars</span>
                <input
                  className={`${input} mt-1 font-mono tabular-nums`}
                  inputMode="decimal"
                  value={typed}
                  placeholder="350"
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setError(null);
                  }}
                  data-testid="plan-input"
                />
              </label>
            ) : null}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-600">Starts</dt>
              <dd className="font-medium text-brand-ink" data-testid="plan-confirm-start">{startWords(start)}</dd>
            </div>
          </dl>
          <p className="text-label text-neutral-600">Past {view === "week" ? "weeks" : "months"} keep their plan.</p>
          <p className="text-label text-neutral-600">Left or over for {w.noun} updates once it is saved.</p>
          {error ? (
            <p className="text-label text-bad" role="alert">{error}</p>
          ) : null}
          <DialogFooter>
            <button type="button" className={btnSecondary} onClick={close} data-testid="plan-cancel">Cancel</button>
            <button type="button" className={btn} disabled={create.isPending} onClick={confirm} data-testid="plan-confirm-go">
              Set plan
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
