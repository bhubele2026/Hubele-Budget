import { useEffect, useMemo, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  useListLearnedRules,
  getListLearnedRulesQueryKey,
  useUpdateLearnedRule,
  useDeleteLearnedRule,
  useApplyLearnedRuleRetroactively,
  type LearnedRule,
  type UpdateLearnedRuleInput,
  type ApplyRetroactivelyResult,
} from "@workspace/api-client-react/features";
import {
  useListPlaidItems,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  getListCategorizationReviewQueryKey,
  type Category,
  type PlaidItemDetail,
  type PlaidAccount,
} from "@workspace/api-client-react";
import { AccountChip, Panel } from "@/components/next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { dataState, hasData } from "@/lib/queryState";
import { cardOrderOf, identityOf, type AccountIdentity } from "@/lib/accountIdentity";
import {
  LEARNED_SCOPES,
  amountBandWords,
  confirmedWords,
  filedWords,
  merchantName,
  previewTail,
  scopeAvailable,
  sortLearnedRules,
} from "@/lib/learnedRules";
import { shortDate } from "@/lib/dates";
import { fmtMoney } from "@/lib/money";
import { btnLink, btnLinkDanger, btnSm, emptyNote, fieldLabel, input } from "@/ui";
import { cn } from "@/lib/utils";

/**
 * ⭐ F2 — WHAT H2 LEARNED, ON THE SAME RULES SCREEN.
 *
 * Every time someone files a charge by hand, H2 remembers the merchant and the
 * category (the server's merchant memory). Until now no screen showed it. This
 * panel lists it beside the pattern rules above: change the category or how
 * far it applies, turn it off, delete it, or file the merchant's past charges.
 *
 * - Filing past charges is never automatic and never blind: the press asks the
 *   server for a DRY RUN first (`dryRun=true` writes nothing) and shows how many
 *   charges would move, with up to five of them; only "File them" writes.
 * - A learned rule edit moves no money, so those writes opt out of the app-wide
 *   after-write refresh (`OWN_INVALIDATION`) and refresh this list only. The
 *   dry run opts out too — it writes nothing. The real run keeps the app-wide
 *   refresh (spine, reports, ledger) and also marks the transaction lists,
 *   budget months and the review queue stale, since filing moves categories.
 * - Hooks come from the `features` sub-module (C0), never the main module.
 *
 * Behaviour ported from h2's `screens/activity/RulesView.tsx` (not imported).
 * Its "Rules you wrote" half is not ported: the pattern rules above are the
 * superset (parity review F2).
 */

const RULES_CACHE = { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } as const;
const ACCOUNTS_CACHE = { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as const;

const selectTrigger = `${input} h-8 py-0 text-micro`;

/** Row geometry: merchant · category · applies to · actions (one column on a phone). */
const ROW_GRID =
  "grid gap-x-4 gap-y-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] lg:items-center";

function replaceRule(qc: QueryClient, next: LearnedRule): void {
  qc.setQueryData<LearnedRule[]>(getListLearnedRulesQueryKey(), (prev) =>
    prev ? prev.map((r) => (r.id === next.id ? next : r)) : prev,
  );
}

function refreshLearned(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: getListLearnedRulesQueryKey() });
}

/** Filing past charges moves categories: every list that shows them is stale. */
function refreshAfterFiling(qc: QueryClient): void {
  refreshLearned(qc);
  void qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  void qc.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/budget/months/"),
  });
  void qc.invalidateQueries({ queryKey: getListCategorizationReviewQueryKey().slice(0, 1) });
}

type Preview = { count: number; sample: NonNullable<ApplyRetroactivelyResult["sample"]> };

function LearnedRuleRow({
  rule,
  categories,
  categoryName,
  account,
}: {
  rule: LearnedRule;
  categories: readonly Category[];
  categoryName: (id: string) => string;
  account: AccountIdentity | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateLearnedRule({ mutation: { meta: OWN_INVALIDATION } });
  const remove = useDeleteLearnedRule({ mutation: { meta: OWN_INVALIDATION } });
  const dryRun = useApplyLearnedRuleRetroactively({ mutation: { meta: OWN_INVALIDATION } });
  const apply = useApplyLearnedRuleRetroactively();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const busy = update.isPending || remove.isPending || dryRun.isPending || apply.isPending;
  const name = merchantName(rule.signature);
  const band = amountBandWords(rule);
  const catName = categoryName(rule.categoryId);

  // A preview was computed for one category and scope; any change makes it stale.
  useEffect(() => {
    setPreview(null);
  }, [rule.categoryId, rule.scope, rule.disabled]);

  const change = (patch: UpdateLearnedRuleInput, failed: string) => {
    update.mutate(
      { id: rule.id, data: patch },
      {
        onSuccess: (next) => {
          replaceRule(qc, next);
          refreshLearned(qc);
        },
        onError: () => toast({ title: failed, variant: "destructive" }),
      },
    );
  };

  const checkPast = () => {
    dryRun.mutate(
      { id: rule.id, params: { dryRun: true } },
      {
        onSuccess: (res) => {
          const count = res.count ?? 0;
          if (count === 0) {
            setPreview(null);
            toast({ title: filedWords(0) });
            return;
          }
          setPreview({ count, sample: res.sample ?? [] });
        },
        onError: () =>
          toast({ title: "Couldn't check past charges. Nothing was changed.", variant: "destructive" }),
      },
    );
  };

  const fileThem = () => {
    apply.mutate(
      { id: rule.id },
      {
        onSuccess: (res) => {
          setPreview(null);
          refreshAfterFiling(qc);
          toast({ title: filedWords(res.updated) });
        },
        onError: () =>
          toast({ title: "Couldn't apply it to past charges.", variant: "destructive" }),
      },
    );
  };

  const deleteIt = () => {
    remove.mutate(
      { id: rule.id },
      {
        onSuccess: () => {
          qc.setQueryData<LearnedRule[]>(getListLearnedRulesQueryKey(), (prev) =>
            prev ? prev.filter((r) => r.id !== rule.id) : prev,
          );
          refreshLearned(qc);
        },
        onError: () => {
          setConfirmingDelete(false);
          toast({ title: "Couldn't delete that rule. It's still here.", variant: "destructive" });
        },
      },
    );
  };

  const knownCategory = categories.some((c) => c.id === rule.categoryId);

  return (
    <li
      className="px-4 py-3"
      data-testid={`learned-rule-${rule.id}`}
      data-disabled={rule.disabled ? "true" : undefined}
    >
      <div className={ROW_GRID}>
        <div className="min-w-0">
          <p
            className={cn(
              "flex min-w-0 items-center gap-2 text-body font-medium",
              rule.disabled ? "text-neutral-400" : "text-brand-navy",
            )}
          >
            <span className="truncate" data-testid={`learned-rule-name-${rule.id}`}>
              {name}
            </span>
            {rule.disabled ? <span className="chip gray shrink-0">Off</span> : null}
          </p>
          <p className="text-micro text-neutral-500" data-testid={`learned-rule-confirmed-${rule.id}`}>
            {confirmedWords(rule)}
          </p>
        </div>

        <div className="min-w-0">
          <span className={cn(fieldLabel, "lg:hidden")}>Category</span>
          <Select
            value={rule.categoryId}
            onValueChange={(v) =>
              v !== rule.categoryId &&
              change({ categoryId: v }, "Couldn't change the category. It's as it was.")
            }
            disabled={busy}
          >
            <SelectTrigger
              className={selectTrigger}
              aria-label={`Category for ${name}`}
              data-testid={`learned-rule-category-${rule.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[280px]">
              {!knownCategory ? (
                <SelectItem value={rule.categoryId}>{catName}</SelectItem>
              ) : null}
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0">
          <span className={cn(fieldLabel, "lg:hidden")}>Applies to</span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="min-w-[11rem] flex-1">
              <Select
                value={rule.scope}
                onValueChange={(v) =>
                  v !== rule.scope &&
                  change(
                    { scope: v as NonNullable<UpdateLearnedRuleInput["scope"]> },
                    "Couldn't change where it applies. It's as it was.",
                  )
                }
                disabled={busy}
              >
                <SelectTrigger
                  className={selectTrigger}
                  aria-label={`Where ${name} applies`}
                  data-testid={`learned-rule-scope-${rule.id}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEARNED_SCOPES.map((s) => (
                    <SelectItem key={s.key} value={s.key} disabled={!scopeAvailable(rule, s.key)}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {rule.scope === "merchant_account" && account ? (
              <span data-testid={`learned-rule-account-${rule.id}`}>
                <AccountChip identity={account} size="sm" />
              </span>
            ) : null}
            {band ? (
              <span
                className="whitespace-nowrap font-mono text-micro tabular-nums text-neutral-600"
                data-testid={`learned-rule-band-${rule.id}`}
              >
                {band}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
          <button
            type="button"
            className={btnLink}
            disabled={busy || rule.disabled}
            onClick={checkPast}
            data-testid={`learned-rule-apply-${rule.id}`}
            title="Shows how many past charges would move before anything changes"
          >
            {dryRun.isPending ? "Checking…" : "Apply to past charges"}
          </button>
          <button
            type="button"
            className={btnLink}
            disabled={busy}
            onClick={() =>
              change({ disabled: !rule.disabled }, "Couldn't change that rule. It's as it was.")
            }
            data-testid={`learned-rule-toggle-${rule.id}`}
          >
            {rule.disabled ? "Turn on" : "Turn off"}
          </button>
          {confirmingDelete ? (
            <span className="flex items-center gap-1.5" data-testid={`learned-rule-delete-ask-${rule.id}`}>
              <span className="text-micro font-semibold text-neutral-700">Delete this rule?</span>
              <button
                type="button"
                className={btnLinkDanger}
                disabled={busy}
                onClick={deleteIt}
                data-testid={`learned-rule-delete-confirm-${rule.id}`}
              >
                Delete
              </button>
              <button
                type="button"
                className={btnLink}
                onClick={() => setConfirmingDelete(false)}
                data-testid={`learned-rule-delete-keep-${rule.id}`}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={btnLinkDanger}
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
              data-testid={`learned-rule-delete-${rule.id}`}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {preview ? (
        <div
          className="section-enter mt-2 rounded-control bg-platinum-2 px-3 py-2 ring-1 ring-brand-line"
          data-testid={`learned-rule-preview-${rule.id}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-micro text-neutral-600">
              <span
                className="font-mono font-semibold tabular-nums text-brand-navy"
                data-testid={`learned-rule-preview-count-${rule.id}`}
              >
                {preview.count}
              </span>{" "}
              {previewTail(preview.count, catName)}
            </p>
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                className={btnSm}
                disabled={apply.isPending}
                onClick={fileThem}
                data-testid={`learned-rule-file-${rule.id}`}
              >
                {apply.isPending ? "Filing…" : `File ${preview.count === 1 ? "it" : "them"}`}
              </button>
              <button
                type="button"
                className={btnLink}
                disabled={apply.isPending}
                onClick={() => setPreview(null)}
                data-testid={`learned-rule-preview-cancel-${rule.id}`}
              >
                Cancel
              </button>
            </span>
          </div>
          {preview.sample.length > 0 ? (
            <ul className="mt-1.5 divide-y divide-brand-line/70" data-testid={`learned-rule-sample-${rule.id}`}>
              {preview.sample.map((s) => (
                <li key={s.transactionId} className="flex items-center gap-3 py-1 text-micro">
                  <span className="w-12 shrink-0 font-mono tabular-nums text-neutral-500">
                    {shortDate(s.occurredOn)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-neutral-700">{s.description}</span>
                  <span className="shrink-0 font-mono tabular-nums text-neutral-700">{fmtMoney(s.amount)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {preview.sample.length < preview.count ? (
            <p className="mt-1 text-micro text-neutral-400">
              Showing the {preview.sample.length} most recent of {preview.count}.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Plaid account id (row id or Plaid's own) → identity, for "This account only" rules. */
function useAccountIdentities(enabled: boolean): Map<string, AccountIdentity> {
  const items = useListPlaidItems({
    query: { queryKey: getListPlaidItemsQueryKey(), enabled, ...ACCOUNTS_CACHE },
  });
  return useMemo(() => {
    const out = new Map<string, AccountIdentity>();
    const list: Array<{ item: PlaidItemDetail; acct: PlaidAccount }> = [];
    for (const item of (items.data ?? []) as PlaidItemDetail[]) {
      for (const acct of item.accounts ?? []) list.push({ item, acct });
    }
    const asInput = ({ item, acct }: { item: PlaidItemDetail; acct: PlaidAccount }) => ({
      id: acct.id,
      name: acct.name,
      mask: acct.mask,
      type: acct.type,
      subtype: acct.subtype,
      institutionName: item.institutionName,
      institutionSlug: item.institutionSlug,
    });
    const cardOrder = cardOrderOf(list.map(asInput));
    for (const row of list) {
      const identity = identityOf(asInput(row), { cardOrder });
      out.set(row.acct.id, identity);
      out.set(row.acct.accountId, identity);
    }
    return out;
  }, [items.data]);
}

export function LearnedRulesPanel({
  categories,
  allCategories,
}: {
  /** The categories a rule may point at (the page already hides `excludeFromBudget`). */
  categories: readonly Category[];
  /** Every category, so a rule pointing outside the list still shows its name. */
  allCategories: readonly Category[];
}) {
  const q = useListLearnedRules({ query: { queryKey: getListLearnedRulesQueryKey(), ...RULES_CACHE } });
  const state = dataState(q);
  const rules = useMemo(() => sortLearnedRules(q.data ?? []), [q.data]);
  const needsAccounts = rules.some((r) => r.scope === "merchant_account" && !!r.plaidAccountId);
  const accounts = useAccountIdentities(needsAccounts);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of allCategories) m.set(c.id, c.name);
    return m;
  }, [allCategories]);
  const categoryName = (id: string) => nameById.get(id) ?? "Unknown category";
  const onCount = rules.filter((r) => !r.disabled).length;

  let body;
  if (state === "cold") {
    body = (
      <div className="space-y-2 p-4" data-testid="learned-rules-skeleton" aria-busy="true">
        <div className="skeleton h-5 w-2/3 rounded-control" />
        <div className="skeleton h-5 w-1/2 rounded-control" />
      </div>
    );
  } else if (state === "failed") {
    body = (
      <div className="flex flex-wrap items-center gap-3 px-4 py-4 text-body text-neutral-600" role="alert" data-testid="learned-rules-error">
        <span>Couldn't load what H2 learned.</span>
        <button
          type="button"
          className={btnLink}
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
          data-testid="learned-rules-retry"
        >
          {q.isFetching ? "Trying…" : "Try again"}
        </button>
      </div>
    );
  } else if (rules.length === 0) {
    body = (
      <p className={emptyNote} data-testid="learned-rules-empty">
        H2 hasn't learned a merchant yet. File a charge by hand and it will remember.
      </p>
    );
  } else {
    body = (
      <>
        <div
          className={cn(
            ROW_GRID,
            "hidden border-b border-brand-line bg-platinum-2 px-4 py-2 lg:grid",
            fieldLabel,
          )}
          aria-hidden
        >
          <span>Merchant</span>
          <span>Category</span>
          <span>Applies to</span>
          <span className="text-right">Actions</span>
        </div>
        <ul className="divide-y divide-brand-line/70" data-testid="learned-rules">
          {rules.map((r) => (
            <LearnedRuleRow
              key={r.id}
              rule={r}
              categories={categories}
              categoryName={categoryName}
              account={r.plaidAccountId ? accounts.get(r.plaidAccountId) ?? null : null}
            />
          ))}
        </ul>
      </>
    );
  }

  return (
    <Panel
      title="Learned from your corrections"
      sub="Each time a charge is filed by hand, H2 remembers the merchant and the category."
      span={12}
      variant={["static", "flush"]}
      data-testid="learned-rules-panel"
      actions={
        hasData(state) && rules.length > 0 ? (
          <span className="font-mono text-micro tabular-nums text-neutral-400" data-testid="learned-rules-count">
            {rules.length} learned{onCount !== rules.length ? ` · ${onCount} on` : ""}
          </span>
        ) : null
      }
    >
      {body}
    </Panel>
  );
}
