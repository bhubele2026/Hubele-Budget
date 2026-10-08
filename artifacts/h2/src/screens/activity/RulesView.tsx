import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useApplyLearnedRuleRetroactively,
  useDeleteLearnedRule,
  type MappingRule,
  useUpdateLearnedRule,
  type LearnedRule,
  type UpdateLearnedRuleInput,
} from "@workspace/api-client-react";
import { mappingRulesKey, useChangeMappingRule, useMappingRules, useRemoveMappingRule } from "@/data/automationApi";
import { useCategoryList, useInvalidateActivity, useLearnedRules } from "@/data/activityData";
import { useQueryClient } from "@tanstack/react-query";
import { Button, buttonClass } from "@/kit/Button";
import { Note } from "@/kit/Note";
import { SkeletonLine } from "@/kit/Skeleton";
import { useToast } from "@/kit/Toast";
import { shortDateOfInstant } from "@/lib/dates";
import { fmtMoney, toAmount } from "@/lib/money";
import { cx } from "@/lib/cx";
import { titleCase } from "./words";

const SCOPES: { key: LearnedRule["scope"]; label: string }[] = [
  { key: "merchant", label: "Any account, any amount" },
  { key: "merchant_account", label: "This account only" },
  { key: "merchant_amount", label: "Similar amounts only" },
];

const selectCls = "h-9 max-w-full rounded-1 border border-rule-strong bg-paper-0 px-2 type-body text-ink";

function Rule({ rule, categories }: { rule: LearnedRule; categories: { id: string; name: string }[] }) {
  const toast = useToast();
  const refresh = useInvalidateActivity();
  const update = useUpdateLearnedRule();
  const remove = useDeleteLearnedRule();
  const apply = useApplyLearnedRuleRetroactively();
  const [confirming, setConfirming] = useState(false);
  const name = titleCase(rule.signature);
  const busy = update.isPending || remove.isPending || apply.isPending;

  const change = async (patch: UpdateLearnedRuleInput, failed: string) => {
    try {
      await update.mutateAsync({ id: rule.id, data: patch });
      refresh();
    } catch {
      toast.show({ message: failed, tone: "error" });
    }
  };
  const band =
    rule.scope === "merchant_amount" && rule.amountBandLo != null && rule.amountBandHi != null
      ? `${fmtMoney(toAmount(rule.amountBandLo))} to ${fmtMoney(toAmount(rule.amountBandHi))}`
      : null;

  return (
    <li className="border-t border-rule py-4 first:border-t-0" data-testid="rule" data-disabled={rule.disabled ? "" : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className={cx("type-body", rule.disabled ? "text-ink-3" : "text-ink")}>
          {name}
          {rule.disabled && <span className="ml-2 type-caption text-ink-2">Off</span>}
        </p>
        <p className="type-caption text-ink-3">
          Confirmed <span className="tnum">{rule.count}</span> {rule.count === 1 ? "time" : "times"}
          {rule.lastConfirmedAt ? ` · last ${shortDateOfInstant(rule.lastConfirmedAt)}` : ""}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 type-label text-ink-2">
          Category
          <select
            aria-label={`Category for ${name}`}
            value={rule.categoryId}
            disabled={busy}
            onChange={(e) => change({ categoryId: e.target.value }, "Couldn't change the category. It's as it was.")}
            className={selectCls}
            data-testid="rule-category"
          >
            {!categories.some((c) => c.id === rule.categoryId) && <option value={rule.categoryId}>Unknown category</option>}
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 type-label text-ink-2">
          Applies to
          <select
            aria-label={`Scope for ${name}`}
            value={rule.scope}
            disabled={busy}
            onChange={(e) =>
              change({ scope: e.target.value as NonNullable<UpdateLearnedRuleInput["scope"]> }, "Couldn't change where it applies. It's as it was.")
            }
            className={selectCls}
            data-testid="rule-scope"
          >
            {SCOPES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {band && <span className="type-caption text-ink-2 tnum">{band}</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="quiet"
          size="sm"
          disabled={busy || rule.disabled}
          onClick={async () => {
            try {
              const done = await apply.mutateAsync({ id: rule.id });
              refresh();
              toast.show({
                message: done.updated === 0 ? "No past charges to file." : `Filed ${done.updated} past ${done.updated === 1 ? "charge" : "charges"}.`,
              });
            } catch {
              toast.show({ message: "Couldn't apply it to past charges.", tone: "error" });
            }
          }}
          data-testid="rule-apply"
        >
          Apply to past charges
        </Button>
        <Button
          variant="quiet"
          size="sm"
          disabled={busy}
          onClick={() => change({ disabled: !rule.disabled }, "Couldn't change that rule. It's as it was.")}
          data-testid="rule-toggle"
        >
          {rule.disabled ? "Turn on" : "Turn off"}
        </Button>
        {confirming ? (
          <span className="flex items-center gap-2">
            <span className="type-label text-ink">Delete this rule?</span>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={async () => {
                try {
                  await remove.mutateAsync({ id: rule.id });
                  refresh();
                } catch {
                  setConfirming(false);
                  toast.show({ message: "Couldn't delete that rule. It's still here.", tone: "error" });
                }
              }}
              data-testid="rule-delete-confirm"
            >
              Delete
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => setConfirming(true)} data-testid="rule-delete">
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

/** A rule the household wrote: pattern → category. Change the category or delete it. */
function HandRule({ rule, categories }: { rule: MappingRule; categories: { id: string; name: string }[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const update = useChangeMappingRule();
  const remove = useRemoveMappingRule();
  const [confirming, setConfirming] = useState(false);
  const busy = update.isPending || remove.isPending;
  const reload = () => void qc.invalidateQueries({ queryKey: mappingRulesKey() });
  const catName = categories.find((c) => c.id === rule.categoryId)?.name;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-rule py-3 first:border-t-0" data-testid="hand-rule">
      <p className="type-body text-ink" data-testid="hand-rule-pattern">
        {rule.pattern} <span className="text-ink-3">→</span> <span data-testid="hand-rule-category">{catName ?? "Not filed"}</span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label={`Category for ${rule.pattern}`}
          value={rule.categoryId ?? ""}
          disabled={busy}
          onChange={async (e) => {
            try {
              await update.mutateAsync({ id: rule.id, data: { pattern: rule.pattern, matchType: rule.matchType, priority: rule.priority, categoryId: e.target.value } });
              reload();
            } catch {
              toast.show({ message: "Couldn't change that rule. It's as it was.", tone: "error" });
            }
          }}
          className={selectCls}
          data-testid="hand-rule-select"
        >
          {!rule.categoryId && <option value="">Not filed</option>}
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {confirming ? (
          <span className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={async () => {
                try {
                  await remove.mutateAsync({ id: rule.id });
                  reload();
                } catch {
                  setConfirming(false);
                  toast.show({ message: "Couldn't delete that rule. It's still here.", tone: "error" });
                }
              }}
              data-testid="hand-rule-delete-confirm"
            >
              Delete
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => setConfirming(true)} data-testid="hand-rule-delete">
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * ⭐ RULES H2 LEARNED — a merchant, the category you chose for it, how far it
 * applies and how often you confirmed it. Change either, turn a rule off,
 * delete it, or press Apply to past charges to file the merchant's older
 * charges (never done by itself). Rules you wrote sit below, with the
 * category and delete the API allows (PATCH and DELETE /mapping-rules/:id), so
 * nothing here sends you to the classic app.
 */
export function RulesView() {
  const rules = useLearnedRules();
  const categories = useCategoryList();
  const hand = useMappingRules();
  const cats = useMemo(() => (categories.data ?? []).map((c) => ({ id: c.id, name: c.name })), [categories.data]);
  const sorted = useMemo(
    () =>
      [...(rules.data ?? [])].sort(
        (a, b) =>
          Number(a.disabled) - Number(b.disabled) ||
          (b.lastConfirmedAt ?? "").localeCompare(a.lastConfirmedAt ?? "") ||
          a.signature.localeCompare(b.signature),
      ),
    [rules.data],
  );

  let body;
  if (rules.state === "cold") {
    body = (
      <div className="flex flex-col gap-4 py-2" data-testid="rules-skeleton" aria-busy="true">
        <SkeletonLine className="w-64" />
        <SkeletonLine className="w-80" />
      </div>
    );
  } else if (rules.state === "failed") {
    body = (
      <Note kind="error" onRetry={rules.refetch} retrying={rules.isFetching}>
        Couldn't load what H2 learned.
      </Note>
    );
  } else if (sorted.length === 0) {
    body = (
      <Note kind="empty" data-testid="rules-empty">
        H2 hasn't learned a merchant yet. File a charge and it will remember.
      </Note>
    );
  } else {
    body = (
      <ul data-testid="rules">
        {sorted.map((r) => (
          <Rule key={r.id} rule={r} categories={cats} />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="rules-view">
      <p className="type-caption text-ink-3" data-testid="automation-link">
        <Link href="/household/automation" className={buttonClass({ variant: "link", size: "sm" })}>
          How filing works and what the model may do → Automation
        </Link>
      </p>
      {body}
      <div className="border-t border-rule pt-4" data-testid="hand-rules">
        <h2 className="mb-2 type-section text-ink-2">Rules you wrote</h2>
        {hand.isError && !hand.data ? (
          <Note kind="error" onRetry={() => void hand.refetch()} retrying={hand.isFetching}>
            Couldn't load your rules.
          </Note>
        ) : !hand.data ? (
          <SkeletonLine className="w-64" />
        ) : hand.data.length === 0 ? (
          <Note kind="empty" data-testid="hand-rules-empty">
            You haven't written a rule.
          </Note>
        ) : (
          <ul>
            {[...hand.data]
              .sort((a, b) => a.priority - b.priority || a.pattern.localeCompare(b.pattern))
              .map((r) => (
                <HandRule key={r.id} rule={r} categories={cats} />
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
