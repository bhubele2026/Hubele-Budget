import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  useGetMe,
  useUndoCategoryDecision,
  useUpdateTransaction,
  type Category,
  type CategorizationRecentDecision,
  type CategorizationRunResult,
  type CategorizationSettings,
} from "@workspace/api-client-react";
import { settingsKey, useCategorizationSettings, useRunCategorization, useSaveCategorizationSettings } from "@/data/automationApi";
import { invalidateActivity, useCategoryList } from "@/data/activityData";
import { readOf } from "@/data/todayData";
import { Button, buttonClass } from "@/kit/Button";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonLine } from "@/kit/Skeleton";
import { StatusWord } from "@/kit/StatusWord";
import { shortDate } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { CategoryPickerSheet } from "@/screens/activity/CategoryPickerSheet";
import { useToast } from "@/screens/plan/parts";
import { SwitchRow } from "./parts";
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
} from "./automationWords";

/** A refusal in words; the server's `owner_only` code never reaches the screen. */
function errWords(e: unknown, fallback: string): string {
  const status = (e as { status?: number } | null)?.status;
  return status === 403 ? "Only the household owner can do this." : fallback;
}

const CACHE = { staleTime: 60_000, gcTime: 30 * 60_000 } as const;

function Row({ d, onChange, onUndo, busy }: { d: CategorizationRecentDecision; onChange: () => void; onUndo: () => void; busy: boolean }) {
  const amt = toAmount(d.amount);
  return (
    <li className="flex flex-col gap-2 border-t border-rule py-3 first:border-t-0" data-testid="decision" data-source={d.source} data-band={d.band}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate type-body text-ink" data-testid="decision-name">
            {d.description}
          </span>
          <span className="type-caption text-ink-3" data-testid="decision-when">
            {shortDate(d.occurredOn)}
          </span>
        </div>
        {amt == null ? (
          <span className="type-figure-sm text-ink-3">—</span>
        ) : (
          <data value={centsValue(amt)} className="type-figure-sm shrink-0 text-ink" data-testid="decision-amount">
            {amt > 0 ? `+${fmtMoney(amt)}` : fmtMoney(amt)}
          </data>
        )}
      </div>
      <p className="type-caption text-ink-2" data-testid="decision-words">
        <span data-testid="decision-category">{d.categoryName ?? "Not filed"}</span> · <span data-testid="decision-source">{sourceWord(d.source)}</span> ·{" "}
        <span data-testid="decision-band">{bandWord(d.band)}</span> · <span data-testid="decision-resolution">{resolutionWord(d)}</span>
      </p>
      {d.resolution === "unreviewed" && (
        <p className="type-caption text-ink-3" data-testid="decision-hint">
          {UNREVIEWED_HINT}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="quiet" onClick={onChange} disabled={busy} data-testid="decision-change" aria-label={`Change category for ${d.description}`}>
          Change
        </Button>
        {d.undoable && (
          <Button size="sm" variant="quiet" onClick={onUndo} disabled={busy} data-testid="decision-undo" aria-label={`Undo ${d.description}`}>
            Undo
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * ⭐ AUTOMATION — the one place that says how new charges get filed: the
 * owner's two switches, (V7) the backlog with "File everything up to today",
 * each bank's data date, whether AI is on, what the model may do, the record
 * it has to earn (verified only; left unchanged is counted apart), and the
 * last twenty decisions with Undo and Change. Every word
 * and number is the server's (`GET /categorization/settings`); the screen only
 * lays them out. Members read it; the switches are the owner's.
 */
export default function Automation() {
  const qc = useQueryClient();
  const { say, node: toast } = useToast();
  const q = useCategorizationSettings(CACHE);
  const settings = readOf(q);
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000 } });
  const owner = me.data?.isOwner === true;
  const categories = useCategoryList();
  const save = useSaveCategorizationSettings();
  const undo = useUndoCategoryDecision();
  const update = useUpdateTransaction();
  const run = useRunCategorization();
  const [changing, setChanging] = useState<CategorizationRecentDecision | null>(null);
  const [ran, setRan] = useState<CategorizationRunResult | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: settingsKey() });
    invalidateActivity(qc);
  };

  // (V7) The whole backlog. The global write rule refreshes the spine, the
  // ledger and the reports; this refreshes the view, the review queue and the
  // transaction lists.
  const fileAll = () =>
    run.mutate(
      { scope: "all" },
      {
        onSuccess: (out) => {
          setRan(out);
          refresh();
          void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/transactions") });
        },
        onError: (e) => say(errWords(e, BACKLOG.failed), "error"),
      },
    );

  const put = (patch: { autoCategorize?: boolean; modelAutoCategorize?: boolean }, ok: string) =>
    save.mutate(
      patch,
      {
        onSuccess: (view: CategorizationSettings) => {
          qc.setQueryData(settingsKey(), view);
          refresh();
          say(ok);
        },
        onError: (e) => say(errWords(e, "Couldn't save that. It's as it was."), "error"),
      },
    );

  const undoOne = (d: CategorizationRecentDecision) =>
    undo.mutate(
      { id: d.id },
      {
        onSuccess: () => {
          refresh();
          say("Put back.");
        },
        onError: (e) => say(errWords(e, "Couldn't undo that."), "error"),
      },
    );

  const pick = (c: Category) => {
    const d = changing;
    setChanging(null);
    if (!d) return;
    update.mutate(
      { id: d.transactionId, data: { categoryId: c.id } },
      {
        onSuccess: () => {
          refresh();
          say(`Filed under ${c.name}.`);
        },
        onError: (e) => say(errWords(e, "Couldn't file that charge. It's as it was."), "error"),
      },
    );
  };

  const s = settings.data;
  const busy = save.isPending || undo.isPending || update.isPending || run.isPending;
  const canSwitch = owner && !!s && !busy;
  const ownerOnly = me.data && !owner ? "Owner only" : null;

  let body;
  if (settings.state === "cold") {
    body = (
      <div className="flex flex-col gap-3 pt-4" data-testid="automation-skeleton" aria-busy="true">
        <SkeletonLine className="w-64" />
        <SkeletonLine className="w-80" />
      </div>
    );
  } else if (!s) {
    body = (
      <Note kind="error" onRetry={settings.refetch} retrying={settings.isFetching} data-testid="automation-error">
        Couldn't load the automation settings.
      </Note>
    );
  } else {
    body = (
      <>
        <Section label="Filing" data-testid="section-filing">
          <SwitchRow
            label="File new charges automatically"
            on={s.autoCategorize}
            onChange={(next) => put({ autoCategorize: next }, next ? "H2 will file new charges for you." : "H2 will leave new charges for you to file.")}
            disabled={!canSwitch}
            hint={ownerOnly}
            data-testid="auto-file"
          />
          <p className="mt-3 type-caption text-ink-2" data-testid="engine-line">
            {engineLine(s.engine)}
          </p>
        </Section>

        <Section label={BACKLOG.label} data-testid="section-backlog">
          <p className="type-body text-ink" data-testid="backlog-line">
            {backlogLine(s.backlog)}
          </p>
          <div className="mt-3 flex flex-col gap-1">
            <Button
              size="sm"
              variant="quiet"
              className="self-start"
              onClick={fileAll}
              disabled={!owner || busy}
              data-testid="backlog-run"
            >
              {run.isPending ? BACKLOG.running : BACKLOG.button}
            </Button>
            {ownerOnly && (
              <span className="type-caption text-ink-3" data-testid="backlog-owner-only">
                {BACKLOG.ownerOnly}
              </span>
            )}
          </div>
          {ran && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
              <p className="type-caption text-ink-2" data-testid="backlog-result">
                {runResultLine(ran)}
              </p>
              <Link href="/activity/review" className={buttonClass({ variant: "link", size: "sm" })} data-testid="backlog-review">
                Review queue ({s.reviewCount})
              </Link>
            </div>
          )}
        </Section>

        <Section label="Bank data" data-testid="section-banks">
          {s.banks.length === 0 ? (
            <Note kind="empty" data-testid="banks-empty">
              No bank linked.
            </Note>
          ) : (
            <ul>
              {s.banks.map((b) => (
                <li key={b.itemId} className="border-t border-rule py-3 type-body text-ink first:border-t-0" data-testid="bank" data-on={b.autoUpdates.on ? "true" : "false"}>
                  {bankLine(b)}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section label="AI" data-testid="section-ai">
          <ul className="flex flex-col gap-2">
            <li className="flex items-center justify-between gap-4" data-testid="ai-configured">
              <span className="type-body text-ink">Key</span>
              <StatusWord tone={s.ai.configured ? "on" : "neutral"}>{s.ai.configured ? AI_STATUS.configured.yes : AI_STATUS.configured.no}</StatusWord>
            </li>
            <li className="flex items-center justify-between gap-4" data-testid="ai-enabled">
              <span className="type-body text-ink">Switch</span>
              <StatusWord tone={s.ai.enabled ? "on" : "neutral"}>{s.ai.enabled ? AI_STATUS.enabled.yes : AI_STATUS.enabled.no}</StatusWord>
            </li>
          </ul>
        </Section>

        <Section label="What the model may do" data-testid="section-model">
          <ul className="mb-4 flex flex-col" data-testid="mode-ladder">
            {MODE_LADDER.map((m) => {
              const now = s.model.mode === m.key;
              return (
                <li
                  key={m.key}
                  className="flex items-start justify-between gap-4 border-t border-rule py-3 first:border-t-0"
                  data-testid={`mode-${m.key}`}
                  aria-current={now ? "true" : undefined}
                  data-current={now ? "true" : undefined}
                >
                  <span className={now ? "type-body text-ink" : "type-body text-ink-3"}>{m.text}</span>
                  {now && <StatusWord tone="on">Now</StatusWord>}
                </li>
              );
            })}
          </ul>
          <SwitchRow
            label="Let the model file on its own"
            on={s.modelAutoCategorize}
            onChange={(next) =>
              put({ modelAutoCategorize: next }, next ? "The model may file on its own once the record holds." : "The model will only suggest.")
            }
            disabled={!canSwitch}
            hint={ownerOnly ? `${ownerOnly}. Takes effect when every requirement is met.` : "Takes effect when every requirement is met."}
            data-testid="model-auto"
          />
        </Section>

        <Section label="Requirements" data-testid="section-requirements" foot={JUDGED_NOTE}>
          <ul data-testid="requirements">
            {s.model.requirements.map((r) => (
              <li key={r.key} className="flex flex-col gap-1 border-t border-rule py-3 first:border-t-0" data-testid={`req-${r.key}`} data-met={r.met ? "true" : "false"}>
                <div className="flex items-start justify-between gap-4">
                  <span className="type-body text-ink">{r.label}</span>
                  <StatusWord tone={r.met ? "on" : "neutral"}>{r.met ? "Met" : "Not met"}</StatusWord>
                </div>
                {requirementFigure(r) && (
                  <span className="type-figure-sm text-ink-2" data-testid="req-figure">
                    {requirementFigure(r)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="border-t border-rule pt-3 type-caption text-ink-2" data-testid="unreviewed-line">
            {unreviewedLine(s.model.unreviewed)}
          </p>
        </Section>

        <Section
          label="Recent decisions"
          data-testid="section-recent"
          action={
            <span className="flex items-center gap-4">
              <Link href="/activity/review" className={buttonClass({ variant: "link", size: "sm" })} data-testid="link-review">
                Review queue ({s.reviewCount})
              </Link>
              <Link href="/activity/rules" className={buttonClass({ variant: "link", size: "sm" })} data-testid="link-rules">
                Rules
              </Link>
            </span>
          }
        >
          {s.recent.length === 0 ? (
            <Note kind="empty" data-testid="recent-empty">
              Nothing has been filed yet.
            </Note>
          ) : (
            <ul data-testid="recent">
              {s.recent.slice(0, 20).map((d) => (
                <Row key={d.id} d={d} busy={busy} onChange={() => setChanging(d)} onUndo={() => undoOne(d)} />
              ))}
            </ul>
          )}
        </Section>
      </>
    );
  }

  return (
    <div className="flex flex-col" data-testid="automation">
      <header className="mb-6 flex flex-col gap-2">
        <h1 className="type-headline text-ink">Automation</h1>
        <Link href="/household" className={buttonClass({ variant: "link", size: "sm" })}>
          ← Household
        </Link>
      </header>
      {settings.state === "refresh-failed" && (
        <div className="mb-4">
          <Note kind="error" onRetry={settings.refetch} retrying={settings.isFetching}>
            Couldn't refresh. Showing what was here before.
          </Note>
        </div>
      )}
      {body}
      <CategoryPickerSheet
        open={changing !== null}
        onOpenChange={(o) => !o && setChanging(null)}
        title="File under"
        description={changing?.description}
        categories={categories.data ?? []}
        currentId={changing?.categoryId}
        onPick={pick}
      />
      {toast}
    </div>
  );
}
