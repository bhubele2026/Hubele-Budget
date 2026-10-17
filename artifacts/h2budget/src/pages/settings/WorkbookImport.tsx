import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getImportRestorePreview,
  getListImportHistoryQueryKey,
  useImportWorkbook,
  useListImportHistory,
  usePreviewWorkbookImport,
  useRestoreImportSnapshot,
  type ImportHistoryItem,
  type ImportPreview,
  type ImportRestorePreview,
} from "@workspace/api-client-react/features";
import { Download, UploadCloud } from "lucide-react";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { apiMessage } from "@/lib/apiMessage";
import { buildRuleAttributionSummary } from "@/lib/rule-attribution-summary";
import {
  IMPORT_FAILED,
  INVALID_NEXT,
  INVALID_TITLE,
  READ_FAILED,
  RESTORE_CHECK_FAILED,
  RESTORE_FAILED,
  RESTORE_QUESTION,
  SAFETY_LINE,
  STALE_NOTICE,
  addsLine,
  confirmLabel,
  confirmQuestion,
  historyLine,
  historyNote,
  importedLine,
  keptEditsLine,
  keptLine,
  restoredLine,
  stateLine,
} from "@/lib/importWords";
import { btnDanger, btnLink, btnSecondary, fieldLabel } from "@/ui";

/**
 * ⭐ (W) SETTINGS › DATA › WORKBOOK IMPORT — preview, confirm, history, restore.
 *
 *   1. Upload → the server reads and checks the file and says what the import
 *      would add and replace (bank rows named, with their days). Nothing is
 *      written. A file with problems lists them; there is no confirm.
 *   2. "Replace N transactions, including M bank rows?" → Replace sends the
 *      preview's confirmation with the file. A preview gone stale (a sync since)
 *      is previewed again, with a note.
 *   3. History: the person's imports. The newest one still in place has
 *      Restore; the server says what it would put back and remove, or why it
 *      cannot (changes since it would lose, with the count) — never a silent loss.
 *
 * Every number is the server's. Hooks from the `features` client only (this is
 * a lazy page; the landing never carries them).
 */

const HISTORY_PARAMS = { limit: 10 } as const;

type Stage =
  | { kind: "idle" }
  | { kind: "reading"; file: File }
  | { kind: "preview"; file: File; preview: ImportPreview; notice: string | null }
  | { kind: "importing"; file: File; preview: ImportPreview }
  | { kind: "invalid"; problems: string[] }
  | { kind: "done"; line: string }
  | { kind: "failed"; message: string };

type RestoreState =
  | { kind: "checking"; item: ImportHistoryItem }
  | { kind: "check"; item: ImportHistoryItem; check: ImportRestorePreview; error: string | null }
  | { kind: "failed"; item: ImportHistoryItem; message: string };

function problemsOf(err: unknown): string[] {
  const list = (err as { data?: { errors?: unknown } } | null)?.data?.errors;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

export function WorkbookImport() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const preview = usePreviewWorkbookImport();
  const importer = useImportWorkbook();
  const restorer = useRestoreImportSnapshot();
  const history = useListImportHistory(HISTORY_PARAMS, {
    query: { queryKey: getListImportHistoryQueryKey(HISTORY_PARAMS), staleTime: 30_000 },
  });
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [restore, setRestore] = useState<RestoreState | null>(null);
  const [restoredMsg, setRestoredMsg] = useState<string | null>(null);
  const questionRef = useRef<HTMLHeadingElement>(null);
  const restoreRef = useRef<HTMLHeadingElement>(null);

  // Keyboard and screen-reader users land on the question they must answer.
  useEffect(() => {
    if (stage.kind === "preview") questionRef.current?.focus();
  }, [stage.kind]);
  useEffect(() => {
    if (restore?.kind === "check") restoreRef.current?.focus();
  }, [restore?.kind]);

  const runPreview = (file: File, notice: string | null) => {
    setStage({ kind: "reading", file });
    setRestore(null);
    setRestoredMsg(null);
    preview.mutate(
      { data: { file } },
      {
        onSuccess: (p) => setStage({ kind: "preview", file, preview: p, notice }),
        onError: (err) => {
          const problems = problemsOf(err);
          setStage(problems.length ? { kind: "invalid", problems } : { kind: "failed", message: apiMessage(err, READ_FAILED) });
        },
      },
    );
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) runPreview(file, null);
  };

  const confirmImport = () => {
    if (stage.kind !== "preview") return;
    const { file, preview: p } = stage;
    setStage({ kind: "importing", file, preview: p });
    importer.mutate(
      { data: { file, confirm: p.confirmToken } },
      {
        onSuccess: (res) => {
          const line = importedLine(res.counts);
          setStage({ kind: "done", line });
          // Everything the person sees came from the rows just replaced.
          void qc.invalidateQueries();
          const summary = buildRuleAttributionSummary(res.ruleAttributions ?? []);
          const parts = [`${line}.`];
          const kept = keptEditsLine(res.counts);
          if (kept) parts.push(kept);
          if (summary.totalAttributed > 0) {
            parts.push(
              `Auto-categorized ${summary.totalAttributed} ${summary.totalAttributed === 1 ? "transaction" : "transactions"}: ${summary.top
                .map((r) => `${r.count} via '${r.pattern}'`)
                .join(", ")}${summary.extraRules > 0 ? `, +${summary.extraRules} more` : ""}.`,
            );
          }
          toast({
            title: "Import complete",
            description: parts.join(" "),
            action:
              summary.totalAttributed > 0 && summary.ruleIds.length > 0 ? (
                <ToastAction
                  altText="View matched rules"
                  onClick={() => navigate(`/mapping-rules?focus=${summary.ruleIds.map((id) => encodeURIComponent(id)).join(",")}`)}
                  data-testid="button-toast-view-import-matched-rules"
                >
                  View
                </ToastAction>
              ) : undefined,
          });
        },
        onError: (err) => {
          const status = (err as { status?: number } | null)?.status;
          // The data (or the file) changed since the preview: show the new numbers.
          if (status === 409) {
            runPreview(file, STALE_NOTICE);
            return;
          }
          const problems = problemsOf(err);
          setStage(problems.length ? { kind: "invalid", problems } : { kind: "failed", message: apiMessage(err, IMPORT_FAILED) });
        },
      },
    );
  };

  const openRestore = (item: ImportHistoryItem) => {
    if (!item.snapshotId) return;
    setRestore({ kind: "checking", item });
    setRestoredMsg(null);
    getImportRestorePreview(item.snapshotId).then(
      (check) => setRestore({ kind: "check", item, check, error: null }),
      (err) => setRestore({ kind: "failed", item, message: apiMessage(err, RESTORE_CHECK_FAILED) }),
    );
  };

  const confirmRestore = () => {
    if (restore?.kind !== "check" || restore.check.status !== "ready") return;
    const { item, check } = restore;
    restorer.mutate(
      { snapshotId: check.snapshotId },
      {
        onSuccess: () => {
          setRestore(null);
          setRestoredMsg(restoredLine(check.putsBack));
          setStage({ kind: "idle" });
          void qc.invalidateQueries();
        },
        onError: (err) => setRestore({ kind: "check", item, check, error: apiMessage(err, RESTORE_FAILED) }),
      },
    );
  };

  const busy = stage.kind === "reading" || stage.kind === "importing" || restorer.isPending;
  const items = history.data?.items ?? [];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 p-4">
        <span className={`${btnSecondary} relative inline-flex cursor-pointer items-center`}>
          <UploadCloud className="mr-1.5 inline h-4 w-4 align-[-3px]" aria-hidden />
          {stage.kind === "reading" ? "Reading…" : stage.kind === "importing" ? "Importing…" : "Upload .xlsx"}
          <input
            type="file"
            accept=".xlsx"
            aria-label="Upload workbook"
            className="absolute inset-0 cursor-pointer opacity-0"
            onChange={onFile}
            disabled={busy}
            data-testid="input-workbook-file"
          />
        </span>
        <a href={`${import.meta.env.BASE_URL}sample/Hubele_Family_Budget_v36.xlsx`} download className={btnLink}>
          <Download className="h-3 w-3" aria-hidden />
          Sample workbook
        </a>
      </div>

      <div aria-live="polite">
        {(stage.kind === "preview" || stage.kind === "importing") && (
          <section className="mx-4 mb-4 rounded-control px-3 py-3 ring-1 ring-brand-line" data-testid="import-preview" aria-labelledby="import-question">
            {stage.kind === "preview" && stage.notice && (
              <p className="mb-2 text-micro font-semibold text-bad" data-testid="import-preview-notice">{stage.notice}</p>
            )}
            <h3 id="import-question" ref={questionRef} tabIndex={-1} className="text-body font-semibold text-brand-navy focus:outline-none" data-testid="import-question">
              {confirmQuestion(stage.preview)}
            </h3>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label">
              <dt className={fieldLabel}>File</dt>
              <dd className="min-w-0 break-words text-neutral-700">{stage.preview.fileName ?? "Workbook"}</dd>
              <dt className={fieldLabel}>Adds</dt>
              <dd className="min-w-0 text-neutral-700" data-testid="import-adds">{addsLine(stage.preview.adds)}</dd>
              <dt className={fieldLabel}>Replaces</dt>
              <dd className="min-w-0 text-neutral-700" data-testid="import-replaces">{stateLine(stage.preview.replaces)}</dd>
              {keptLine(stage.preview.rulesKept) && (
                <>
                  <dt className={fieldLabel}>Kept</dt>
                  <dd className="min-w-0 text-neutral-700">{keptLine(stage.preview.rulesKept)}</dd>
                </>
              )}
            </dl>
            <p className="mt-2 text-micro text-neutral-600">{SAFETY_LINE}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={btnDanger}
                onClick={confirmImport}
                disabled={stage.kind === "importing"}
                data-testid="button-confirm-import"
              >
                {stage.kind === "importing" ? "Importing…" : confirmLabel(stage.preview)}
              </button>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => setStage({ kind: "idle" })}
                disabled={stage.kind === "importing"}
                data-testid="button-cancel-import"
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        {stage.kind === "invalid" && (
          <section className="mx-4 mb-4 rounded-control bg-bad-bg px-3 py-3 ring-1 ring-bad/15" data-testid="import-errors">
            <p className="text-body font-semibold text-bad">{INVALID_TITLE}</p>
            <ul className="mt-1 list-disc pl-5 text-label text-neutral-700">
              {stage.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            <p className="mt-2 text-micro text-neutral-600">{INVALID_NEXT}</p>
          </section>
        )}

        {stage.kind === "failed" && (
          <p className="mx-4 mb-4 text-label text-bad" data-testid="import-failed">{stage.message}</p>
        )}
        {stage.kind === "done" && (
          <p className="mx-4 mb-4 text-label font-semibold text-brand-navy" data-testid="import-result">{stage.line}</p>
        )}
        {restoredMsg && (
          <p className="mx-4 mb-4 text-label font-semibold text-brand-navy" data-testid="restore-result">{restoredMsg}</p>
        )}
      </div>

      <div className="border-t border-brand-line px-4 py-3" data-testid="import-history">
        <h3 className={fieldLabel}>History</h3>
        {history.isLoading ? (
          <p className="mt-2 text-label text-neutral-600">Loading…</p>
        ) : history.isError && !history.data ? (
          <p className="mt-2 text-label text-bad">History could not be read.</p>
        ) : items.length === 0 ? (
          <p className="mt-2 text-label text-neutral-600" data-testid="import-history-empty">No imports yet.</p>
        ) : (
          <ul className="mt-1 divide-y divide-brand-line/70">
            {items.map((item) => {
              const note = historyNote(item);
              return (
                <li key={item.batchId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2" data-testid="import-history-row">
                  <span className="min-w-0 break-words text-label text-neutral-700">{historyLine(item)}</span>
                  {note === null ? (
                    <button
                      type="button"
                      className={btnLink}
                      onClick={() => openRestore(item)}
                      disabled={busy || restore?.kind === "checking"}
                      data-testid="button-restore-import"
                    >
                      Restore
                    </button>
                  ) : (
                    <span className="text-micro text-neutral-600" data-testid="import-history-note">{note}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {restore?.kind === "checking" && <p className="mt-2 text-label text-neutral-600">Checking…</p>}
        {restore?.kind === "failed" && (
          <p className="mt-2 text-label text-bad" data-testid="restore-failed">{restore.message}</p>
        )}
        {restore?.kind === "check" && (
          <section className="mt-2 rounded-control px-3 py-3 ring-1 ring-brand-line" data-testid="restore-preview" aria-labelledby="restore-question">
            {restore.check.status === "ready" ? (
              <>
                <h4 id="restore-question" ref={restoreRef} tabIndex={-1} className="text-body font-semibold text-brand-navy focus:outline-none">
                  {RESTORE_QUESTION}
                </h4>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label">
                  <dt className={fieldLabel}>Puts back</dt>
                  <dd className="min-w-0 text-neutral-700" data-testid="restore-puts-back">{stateLine(restore.check.putsBack)}</dd>
                  {restore.check.removes && (
                    <>
                      <dt className={fieldLabel}>Removes</dt>
                      <dd className="min-w-0 text-neutral-700" data-testid="restore-removes">{stateLine(restore.check.removes)}</dd>
                    </>
                  )}
                </dl>
              </>
            ) : (
              <h4 id="restore-question" ref={restoreRef} tabIndex={-1} className="text-body font-semibold text-bad focus:outline-none" data-testid="restore-blocked">
                {restore.check.reason}
              </h4>
            )}
            {restore.error && (
              <p className="mt-2 text-label text-bad" data-testid="restore-error">{restore.error}</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {restore.check.status === "ready" && (
                <button
                  type="button"
                  className={btnDanger}
                  onClick={confirmRestore}
                  disabled={restorer.isPending}
                  data-testid="button-confirm-restore"
                >
                  {restorer.isPending ? "Restoring…" : "Restore"}
                </button>
              )}
              <button
                type="button"
                className={btnSecondary}
                onClick={() => setRestore(null)}
                disabled={restorer.isPending}
                data-testid="button-cancel-restore"
              >
                {restore.check.status === "ready" ? "Cancel" : "Close"}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
