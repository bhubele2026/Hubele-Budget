import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AllowancePlanDryRun, AllowancePlanPrefill } from "@workspace/api-client-react";
import {
  getGetPeriodBreakdownQueryKey,
  getListAllowancePlansQueryKey,
  useCreateAllowancePlan,
} from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { PlanDryRunPreview } from "@/components/plan/PlanDryRunPreview";
import { parsePositiveDollars, planErrorWords } from "@/lib/planWords";
import { formatCurrency } from "@/lib/utils";
import { btn, btnSecondary, fieldLabel, input } from "@/ui";
import type { Owner } from "@/hooks/useOwner";
import { startWords, type PeriodView } from "./periodDates";

/**
 * (W5) "Plan not set" and the one way out of it. Nothing is set silently: a tap
 * opens a dialog that says the amount, the start day and that past periods keep
 * their plan; only its Confirm sends `POST /allowance-plans`, from THIS period's
 * first day (this Sunday / the 1st). Past periods are never offered a plan.
 *
 * (F4) The dialog asks the server what the plan would do first (`dryRun=1`,
 * writes nothing) and shows it per Saturday; Set plan is enabled only once that
 * answer is in and the server allows the plan. A refused plan shows the
 * server's one-line reason and the button stays off.
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

/** How long a typed amount rests before its dry run is asked for. */
export const TYPED_DEBOUNCE_MS = 150;

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
  /** (Q4) true | false | "unknown": unknown shows a placeholder, never the denial. */
  canSet: Owner;
}) {
  const period = view === "week" ? "weekly" : "monthly";
  const w = WORD[view];
  const qc = useQueryClient();
  const { toast } = useToast();
  const create = useCreateAllowancePlan();
  // The dry run writes nothing: it must not refetch the spine and every screen (FixDialog does the same).
  const check = useCreateAllowancePlan({ mutation: { meta: OWN_INVALIDATION } });
  const [dry, setDry] = useState<{ amount: string; data: AllowancePlanDryRun | null; failed: boolean } | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const typedAmount = pick?.custom ? parsePositiveDollars(typed) : pick ? pick.amount : null;
  useEffect(() => {
    if (!typedAmount || canSet !== true) {
      setDry(null);
      return;
    }
    let live = true;
    const run = () =>
      check.mutate(
        { data: { period, amount: typedAmount, effectiveFrom: start }, params: { dryRun: "1" } },
        {
          onSuccess: (r) => live && setDry({ amount: typedAmount, data: r as AllowancePlanDryRun, failed: false }),
          onError: () => live && setDry({ amount: typedAmount, data: null, failed: true }),
        },
      );
    // A typed amount waits a beat (one request per pause); a tapped amount asks at once.
    const t = setTimeout(run, pick?.custom ? TYPED_DEBOUNCE_MS : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typedAmount, period, start, canSet]);

  const mine = prefills.filter((p) => p.period === period);
  const primary = view === "week" ? mine.find((p) => p.source === "hook_stored") ?? null : null;
  const seen = new Set<string>(primary ? [primary.amount] : []);
  const others = mine.filter((p) => (seen.has(p.amount) ? false : (seen.add(p.amount), true)));

  if (canSet === "unknown") {
    return <div className="skeleton h-6 w-2/3 rounded" aria-busy="true" data-testid="plan-prompt-owner-unknown" />;
  }
  if (!canSet) {
    return (
      <p className="text-body text-neutral-600" data-testid="plan-prompt-readonly">
        Only the household owner sets the {w.plan} plan.
      </p>
    );
  }

  const close = () => {
    setDry(null);
    setPick(null);
    setTyped("");
    setError(null);
  };

  const checked = dry != null && dry.amount === typedAmount ? dry : null;
  const refusal = checked?.data && !checked.data.allowed ? checked.data.reason ?? "This plan can't be set yet." : null;
  const ready = !!checked?.data && checked.data.allowed;

  const confirm = () => {
    if (!pick || !ready) return;
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
      {primary ? <p className="text-micro text-neutral-600">{primary.label}</p> : null}

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
          {typedAmount ? (
            <div className="border-t border-brand-line pt-2" data-testid="plan-effect">
              <h3 className="text-label font-semibold text-brand-navy">What it does to the forecast</h3>
              {checked?.data ? (
                <PlanDryRunPreview dry={checked.data} />
              ) : checked?.failed ? (
                <p className="text-label text-neutral-600" data-testid="plan-effect-failed">H2 couldn't check this plan. Try again.</p>
              ) : (
                <p className="text-label text-neutral-600" aria-busy="true" data-testid="plan-effect-loading">Checking the effect…</p>
              )}
            </div>
          ) : null}
          {refusal ? (
            <p className="text-label text-bad" role="alert" data-testid="plan-refused">{refusal}</p>
          ) : null}
          {error ? (
            <p className="text-label text-bad" role="alert">{error}</p>
          ) : null}
          <DialogFooter>
            <button type="button" className={btnSecondary} onClick={close} data-testid="plan-cancel">Cancel</button>
            <button type="button" className={btn} disabled={create.isPending || !ready} onClick={confirm} data-testid="plan-confirm-go">
              Set plan
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
