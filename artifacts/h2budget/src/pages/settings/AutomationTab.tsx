import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  getGetCategorizationSettingsQueryKey,
  getListLearnedRulesQueryKey,
  useGetCategorizationSettings,
  useRunCategorization,
  useUndoCategoryDecision,
  useUpdateCategorizationSettings,
  type CategorizationRecentDecision,
  type CategorizationRunResult,
  type CategorizationSettings,
} from "@workspace/api-client-react/features";
import {
  getGetMeQueryKey,
  getListCategoriesQueryKey,
  getListCategorizationReviewQueryKey,
  useGetMe,
  useListCategories,
  useUpdateTransaction,
} from "@workspace/api-client-react";
import { ChevronRight, GitMerge } from "lucide-react";
import { PageGrid, Panel } from "@/components/next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { dataState } from "@/lib/queryState";
import { shortDate } from "@/lib/dates";
import { fmtMoney, toAmount, centsValue } from "@/lib/money";
import { ownerOnlyOr } from "@/lib/apiMessage";
import {
  AI_STATUS,
  BACKLOG,
  JUDGED_NOTE,
  MODE_LADDER,
  UNREVIEWED_HINT,
  backlogLine,
  bandWord,
  bankLine,
  engineLine,
  requirementFigure,
  resolutionWord,
  runResultLine,
  sourceWord,
  unreviewedLine,
} from "@/lib/automationWords";
import { Foot, btnLink, emptyNote, input } from "@/ui";
import { RetryNote, SettingSwitch, StatusChip, TabSkeleton } from "./parts";

/**
 * ⭐ (F5) SETTINGS › AUTOMATION — the one place that says how new charges get
 * filed: the owner's two switches, the backlog with "File everything up to
 * today", each bank's data date, whether AI is on, what the model may do, the
 * record it has to earn (verified only; left unchanged is counted apart), and
 * the last twenty decisions with Undo and Change.
 *
 * Every word and number is the server's (`GET /categorization/settings`); this
 * tab only lays them out. Members read it; the switches and the backlog run
 * are the owner's (the server refuses anyone else with a 403, said in words).
 *
 * Behaviour ported from h2's `screens/household/Automation.tsx` onto
 * h2budget's panels; hooks from the `features` sub-module (C0). h2's
 * hand-written `automationApi.ts` is not ported: it existed only because h2's
 * 400 KB landing cap was full.
 */

const CACHE = { staleTime: 60_000, gcTime: 30 * 60_000 } as const;
const SLOW = { staleTime: 30 * 60_000, gcTime: 60 * 60_000 } as const;

/** The view, what H2 learned, and the review queue: what any write here moves. */
function refreshAutomation(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: getGetCategorizationSettingsQueryKey() });
  void qc.invalidateQueries({ queryKey: getListLearnedRulesQueryKey() });
  void qc.invalidateQueries({ queryKey: getListCategorizationReviewQueryKey().slice(0, 1) });
}

/** A write that files charges also moves every transaction list. */
function refreshFiled(qc: QueryClient): void {
  refreshAutomation(qc);
  void qc.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/transactions"),
  });
}

/** The fields of the settings read this view uses (a TanStack result satisfies it). */
export interface SettingsRead {
  data: CategorizationSettings | undefined;
  isFetching: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  isPlaceholderData: boolean;
  refetch: () => unknown;
}

function DecisionRow({
  d,
  categories,
  busy,
  onChange,
  onUndo,
}: {
  d: CategorizationRecentDecision;
  categories: ReadonlyArray<{ id: string; name: string }>;
  busy: boolean;
  onChange: (categoryId: string) => void;
  onUndo: () => void;
}) {
  const amt = toAmount(d.amount);
  return (
    <li
      className="grid gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      data-testid="decision"
      data-source={d.source}
      data-band={d.band}
    >
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3 md:justify-start">
          <span className="truncate text-body font-medium text-brand-navy" data-testid="decision-name">
            {d.description}
          </span>
          {amt == null ? (
            <span className="font-mono text-label text-neutral-400">—</span>
          ) : (
            <data
              value={centsValue(amt)}
              className="shrink-0 font-mono text-label tabular-nums text-brand-ink"
              data-testid="decision-amount"
            >
              {amt > 0 ? `+${fmtMoney(amt)}` : fmtMoney(amt)}
            </data>
          )}
        </div>
        <p className="text-micro text-neutral-500" data-testid="decision-words">
          <span className="font-mono tabular-nums" data-testid="decision-when">
            {shortDate(d.occurredOn)}
          </span>{" "}
          · <span data-testid="decision-category">{d.categoryName ?? "Not filed"}</span> ·{" "}
          <span data-testid="decision-source">{sourceWord(d.source)}</span> ·{" "}
          <span data-testid="decision-band">{bandWord(d.band)}</span> ·{" "}
          <span data-testid="decision-resolution">{resolutionWord(d)}</span>
        </p>
        {d.resolution === "unreviewed" && (
          <p className="text-micro text-neutral-400" data-testid="decision-hint">
            {UNREVIEWED_HINT}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value="" onValueChange={onChange} disabled={busy}>
          <SelectTrigger
            className={`${input} h-7 w-[150px] py-0 text-micro`}
            aria-label={`Change category for ${d.description}`}
            data-testid="decision-change"
          >
            <SelectValue placeholder="Change…" />
          </SelectTrigger>
          <SelectContent className="max-h-[280px]">
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {d.undoable && (
          <button
            type="button"
            className={btnLink}
            onClick={onUndo}
            disabled={busy}
            aria-label={`Undo ${d.description}`}
            data-testid="decision-undo"
          >
            Undo
          </button>
        )}
      </div>
    </li>
  );
}

export function AutomationView({
  settings,
  owner,
  categories,
}: {
  settings: SettingsRead;
  owner: boolean | null;
  categories: ReadonlyArray<{ id: string; name: string }>;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const save = useUpdateCategorizationSettings({ mutation: { meta: OWN_INVALIDATION } });
  const undo = useUndoCategoryDecision();
  const update = useUpdateTransaction();
  const run = useRunCategorization();
  const [ran, setRan] = useState<CategorizationRunResult | null>(null);
  const state = dataState(settings);
  const s = settings.data;
  const busy = save.isPending || undo.isPending || update.isPending || run.isPending;
  const isOwner = owner === true;
  const canSwitch = isOwner && !!s && !busy;
  const ownerOnly = owner === false ? BACKLOG.ownerOnly : null;
  const fail = (e: unknown, fallback: string) =>
    toast({ title: ownerOnlyOr(e, fallback), variant: "destructive" });

  // The whole backlog. The app-wide write rule refreshes the spine, the
  // ledger and the reports; this refreshes the view, the review queue and the
  // transaction lists.
  const fileAll = () =>
    run.mutate(
      { data: { scope: "all" } },
      {
        onSuccess: (out) => {
          setRan(out);
          refreshFiled(qc);
        },
        onError: (e) => fail(e, BACKLOG.failed),
      },
    );

  const put = (patch: { autoCategorize?: boolean; modelAutoCategorize?: boolean }, ok: string) =>
    save.mutate(
      { data: patch },
      {
        onSuccess: (view: CategorizationSettings) => {
          qc.setQueryData(getGetCategorizationSettingsQueryKey(), view);
          refreshAutomation(qc);
          toast({ title: ok });
        },
        onError: (e) => fail(e, "Couldn't save that. It's as it was."),
      },
    );

  const undoOne = (d: CategorizationRecentDecision) =>
    undo.mutate(
      { id: d.id },
      {
        onSuccess: () => {
          refreshFiled(qc);
          toast({ title: "Put back." });
        },
        onError: (e) => fail(e, "Couldn't undo that."),
      },
    );

  const changeOne = (d: CategorizationRecentDecision, categoryId: string) => {
    const name = categories.find((c) => c.id === categoryId)?.name ?? "that category";
    update.mutate(
      { id: d.transactionId, data: { categoryId } },
      {
        onSuccess: () => {
          refreshFiled(qc);
          toast({ title: `Filed under ${name}.` });
        },
        onError: (e) => fail(e, "Couldn't file that charge. It's as it was."),
      },
    );
  };

  if (state === "cold") {
    return (
      <PageGrid>
        <Panel title="Automation" span={12} variant={["static", "flush"]}>
          <TabSkeleton testId="automation-skeleton" />
        </Panel>
      </PageGrid>
    );
  }
  if (!s) {
    return (
      <PageGrid>
        <Panel title="Automation" span={12} variant={["static", "flush"]}>
          <RetryNote onRetry={() => void settings.refetch()} retrying={settings.isFetching} data-testid="automation-error">
            Couldn't load the automation settings.
          </RetryNote>
        </Panel>
      </PageGrid>
    );
  }

  return (
    <PageGrid data-testid="automation">
      {state === "refresh-failed" && (
        <div className="span-12">
          <RetryNote onRetry={() => void settings.refetch()} retrying={settings.isFetching}>
            Couldn't refresh. Showing what was here before.
          </RetryNote>
        </div>
      )}

      <Panel title="Filing" span={6} variant="static" data-testid="section-filing">
        <SettingSwitch
          label="File new charges automatically"
          on={s.autoCategorize}
          onChange={(next) =>
            put(
              { autoCategorize: next },
              next ? "H2 will file new charges for you." : "H2 will leave new charges for you to file.",
            )
          }
          disabled={!canSwitch}
          hint={ownerOnly}
          data-testid="auto-file"
        />
        <p className="mt-3 text-micro text-neutral-600" data-testid="engine-line">
          {engineLine(s.engine)}
        </p>
        <Link href="/mapping-rules" className="mt-3 block">
          <div
            className="press flex items-center gap-3 rounded-control bg-platinum-2 px-3 py-2.5 ring-1 ring-brand-line hover:ring-brand-navy/25"
            data-testid="card-mapping-rules"
          >
            <GitMerge className="h-4 w-4 shrink-0 text-brand-navy" />
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold text-brand-navy">Mapping rules</div>
              <div className="text-micro text-neutral-500">
                Merchant → category, and what H2 learned from your corrections
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
          </div>
        </Link>
      </Panel>

      <Panel title={BACKLOG.label} span={6} variant="static" data-testid="section-backlog">
        <p className="text-body text-brand-ink" data-testid="backlog-line">
          {backlogLine(s.backlog)}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnLink}
            onClick={fileAll}
            disabled={!isOwner || busy}
            data-testid="backlog-run"
          >
            {run.isPending ? BACKLOG.running : BACKLOG.button}
          </button>
          {ownerOnly && (
            <span className="text-micro text-neutral-500" data-testid="backlog-owner-only">
              {ownerOnly}
            </span>
          )}
        </div>
        {ran && (
          <div className="section-enter mt-3 space-y-1">
            <p className="text-micro text-neutral-600" data-testid="backlog-result">
              {runResultLine(ran)}
            </p>
            <p className="text-micro text-neutral-500" data-testid="backlog-review">
              Waiting for review: {s.reviewCount}
            </p>
          </div>
        )}
      </Panel>

      <Panel title="Bank data" span={6} variant={["static", "flush"]} data-testid="section-banks">
        {s.banks.length === 0 ? (
          <p className={emptyNote} data-testid="banks-empty">
            No bank linked.
          </p>
        ) : (
          <ul className="divide-y divide-brand-line/70">
            {s.banks.map((b) => (
              <li
                key={b.itemId}
                className="px-4 py-2.5 text-body text-brand-ink"
                data-testid="bank"
                data-on={b.autoUpdates.on ? "true" : "false"}
              >
                {bankLine(b)}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="AI" span={6} variant="static" data-testid="section-ai">
        <ul className="space-y-2">
          <li className="flex items-center justify-between gap-4" data-testid="ai-configured">
            <span className="text-body text-brand-ink">Key</span>
            <StatusChip tone={s.ai.configured ? "on" : "neutral"}>
              {s.ai.configured ? AI_STATUS.configured.yes : AI_STATUS.configured.no}
            </StatusChip>
          </li>
          <li className="flex items-center justify-between gap-4" data-testid="ai-enabled">
            <span className="text-body text-brand-ink">Switch</span>
            <StatusChip tone={s.ai.enabled ? "on" : "neutral"}>
              {s.ai.enabled ? AI_STATUS.enabled.yes : AI_STATUS.enabled.no}
            </StatusChip>
          </li>
        </ul>
      </Panel>

      <Panel title="What the model may do" span={6} variant="static" data-testid="section-model">
        <ul className="mb-4 divide-y divide-brand-line/70" data-testid="mode-ladder">
          {MODE_LADDER.map((m) => {
            const now = s.model.mode === m.key;
            return (
              <li
                key={m.key}
                className="flex items-start justify-between gap-4 py-2.5 first:pt-0"
                data-testid={`mode-${m.key}`}
                aria-current={now ? "true" : undefined}
                data-current={now ? "true" : undefined}
              >
                <span className={now ? "text-body text-brand-navy" : "text-body text-neutral-400"}>{m.text}</span>
                {now && <StatusChip tone="on">Now</StatusChip>}
              </li>
            );
          })}
        </ul>
        <SettingSwitch
          label="Let the model file on its own"
          on={s.modelAutoCategorize}
          onChange={(next) =>
            put(
              { modelAutoCategorize: next },
              next ? "The model may file on its own once the record holds." : "The model will only suggest.",
            )
          }
          disabled={!canSwitch}
          hint={
            ownerOnly
              ? `${ownerOnly}. Takes effect when every requirement is met.`
              : "Takes effect when every requirement is met."
          }
          data-testid="model-auto"
        />
      </Panel>

      <Panel title="Requirements" span={6} variant={["static", "flush"]} data-testid="section-requirements">
        <ul className="divide-y divide-brand-line/70" data-testid="requirements">
          {s.model.requirements.map((r) => (
            <li
              key={r.key}
              className="flex flex-col gap-0.5 px-4 py-2.5"
              data-testid={`req-${r.key}`}
              data-met={r.met ? "true" : "false"}
            >
              <div className="flex items-start justify-between gap-4">
                <span className="text-body text-brand-ink">{r.label}</span>
                <StatusChip tone={r.met ? "on" : "neutral"}>{r.met ? "Met" : "Not met"}</StatusChip>
              </div>
              {requirementFigure(r) && (
                <span className="font-mono text-micro tabular-nums text-neutral-600" data-testid="req-figure">
                  {requirementFigure(r)}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="border-t border-brand-line px-4 py-2.5 text-micro text-neutral-600" data-testid="unreviewed-line">
          {unreviewedLine(s.model.unreviewed)}
        </p>
        <Foot>{JUDGED_NOTE}</Foot>
      </Panel>

      <Panel
        title="Recent decisions"
        span={12}
        variant={["static", "flush"]}
        data-testid="section-recent"
        actions={
          <span className="flex items-center gap-2">
            <span className="text-micro text-neutral-500" data-testid="review-count">
              Waiting for review: {s.reviewCount}
            </span>
            <Link href="/mapping-rules" className={btnLink} data-testid="link-rules">
              Rules
            </Link>
          </span>
        }
      >
        {s.recent.length === 0 ? (
          <p className={emptyNote} data-testid="recent-empty">
            Nothing has been filed yet.
          </p>
        ) : (
          <ul className="divide-y divide-brand-line/70" data-testid="recent">
            {s.recent.slice(0, 20).map((d) => (
              <DecisionRow
                key={d.id}
                d={d}
                categories={categories}
                busy={busy}
                onChange={(id) => changeOne(d, id)}
                onUndo={() => undoOne(d)}
              />
            ))}
          </ul>
        )}
      </Panel>
    </PageGrid>
  );
}

export default function AutomationTab() {
  const settings = useGetCategorizationSettings({
    query: { queryKey: getGetCategorizationSettingsQueryKey(), ...CACHE },
  });
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), ...SLOW } });
  const cats = useListCategories({ query: { queryKey: getListCategoriesQueryKey(), ...SLOW } });
  const categories = (cats.data ?? []).filter((c) => !c.excludeFromBudget);
  return (
    <AutomationView
      settings={settings}
      owner={me.data ? me.data.isOwner === true : null}
      categories={categories}
    />
  );
}
