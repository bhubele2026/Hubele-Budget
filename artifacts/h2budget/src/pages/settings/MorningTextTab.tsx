import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import {
  getGetRecapSettingsQueryKey,
  getHealthCheckQueryKey,
  getListRecapDeliveriesQueryKey,
  getListRecapHistoryQueryKey,
  previewRecap,
  useConfirmRecapVerification,
  useGetRecapSettings,
  useHealthCheck,
  useListRecapDeliveries,
  useListRecapHistory,
  usePauseRecap,
  useSendRecapTest,
  useStartRecapVerification,
  useUnsubscribeRecap,
  useUpdateRecapSettings,
  type HealthStatus,
  type RecapDeliveryItem,
  type RecapHistoryItem,
  type RecapPreview,
  type RecapSettings,
} from "@workspace/api-client-react/features";
import { PageGrid, Panel } from "@/components/next";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { dataState, type DataState } from "@/lib/queryState";
import { shortDate, shortDateOfInstant } from "@/lib/dates";
import { apiMessage } from "@/lib/apiMessage";
import {
  TIMEZONES,
  clockWords,
  historyWords,
  isClock,
  isListedZone,
  isSixDigits,
  ladderRows,
  maskedPhone,
  statusLabel,
  testsLeft,
  toE164,
  type HistoryWords,
} from "@/lib/recapWords";
import { btn, btnDanger, btnLinkDanger, btnSecondary, btnSecondarySm, emptyNote, fieldLabel, input } from "@/ui";
import { RetryNote, SettingSwitch, StatusChip, TabSkeleton, type Tone } from "./parts";

/**
 * (D14) The dashboard's briefing reads the SAME cached preview: one POST per
 * ten minutes at most, wherever it is asked from, because a preview can spend
 * one of the six daily recap model calls. Must equal
 * `pages/next/dashboard/queries.ts` `RECAP_PREVIEW_KEY` (a test pins it); kept
 * here as a literal so this tab's chunk does not pull in the dashboard's.
 */
export const RECAP_PREVIEW_KEY = ["/api/recap/preview"] as const;
const PREVIEW_STALE = 10 * 60_000;

/** A read as this tab uses it: the data, its state, and how to ask again. */
export interface Read<T> {
  data: T | undefined;
  state: DataState;
  isFetching: boolean;
  refetch: () => unknown;
}
function readOf<T>(q: {
  data: T | undefined;
  isFetching: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  isPlaceholderData: boolean;
  refetch: () => unknown;
}): Read<T> {
  return { data: q.data, state: dataState(q), isFetching: q.isFetching, refetch: q.refetch };
}

export interface RecapData {
  settings: Read<RecapSettings>;
  history: Read<RecapHistoryItem[]>;
  deliveries: Read<RecapDeliveryItem[]>;
  health: Read<HealthStatus>;
}

const HISTORY_PARAMS = { limit: 30 } as const;
const CACHE = { staleTime: 60_000, gcTime: 30 * 60_000 } as const;

export function useRecapData(): RecapData {
  const settings = useGetRecapSettings({ query: { queryKey: getGetRecapSettingsQueryKey(), ...CACHE } });
  const history = useListRecapHistory(HISTORY_PARAMS, {
    query: { queryKey: getListRecapHistoryQueryKey(HISTORY_PARAMS), ...CACHE },
  });
  const deliveries = useListRecapDeliveries(HISTORY_PARAMS, {
    query: { queryKey: getListRecapDeliveriesQueryKey(HISTORY_PARAMS), ...CACHE },
  });
  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), staleTime: 5 * 60_000, gcTime: 30 * 60_000 },
  });
  return {
    settings: readOf(settings),
    history: readOf(history),
    deliveries: readOf(deliveries),
    health: readOf(health),
  };
}

export default function MorningTextTab() {
  return <RecapView data={useRecapData()} />;
}

const STATUS_TONE: Record<HistoryWords["status"], Tone> = {
  sent: "on",
  delivered: "fresh",
  failed: "over",
  skipped: "stale",
  drafted: "neutral",
  previewed: "stale",
};

interface Draft {
  sendTimeLocal: string;
  timezone: string;
  other: boolean;
  skipWeekends: boolean;
  extraAlerts: boolean;
}

const draftOf = (s: RecapSettings): Draft => ({
  sendTimeLocal: s.sendTimeLocal,
  timezone: s.timezone,
  other: !isListedZone(s.timezone),
  skipWeekends: s.skipWeekends,
  extraAlerts: s.extraAlerts,
});

const zoneWord = (tz: string) => tz.split("/").pop()?.replace(/_/g, " ") ?? tz;

function FieldBox({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className={fieldLabel}>
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-micro text-neutral-500">{hint}</p> : null}
      {error ? (
        <p className="text-micro text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const errLine = "text-micro text-bad";

/**
 * ⭐ (F9) SETTINGS › MORNING TEXT — an opt-in text each morning. There is no
 * money figure on this tab. Three steps (phone, schedule, preview), then what
 * was sent. The server decides everything; this tab asks and reports the
 * answer in words. Behaviour ported from h2's `screens/recap/Recap.tsx` onto
 * h2budget's panels; hooks from the `features` sub-module. Every write opts out
 * of the app-wide after-write refresh: none of them moves a figure.
 */
export function RecapView({ data, now }: { data: RecapData; now?: Date }) {
  const { settings, history, deliveries, health } = data;
  const qc = useQueryClient();
  const { toast } = useToast();
  const s = settings.data;

  const mutOpts = { mutation: { meta: OWN_INVALIDATION } } as const;
  const update = useUpdateRecapSettings(mutOpts);
  const start = useStartRecapVerification(mutOpts);
  const confirm = useConfirmRecapVerification(mutOpts);
  const testSend = useSendRecapTest(mutOpts);
  const pause = usePauseRecap(mutOpts);
  const unsub = useUnsubscribeRecap(mutOpts);

  // Phone step
  const [changing, setChanging] = useState(false);
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [phoneTried, setPhoneTried] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [codeTried, setCodeTried] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  // Schedule step
  const [draft, setDraft] = useState<Draft | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Preview step
  const [shown, setShown] = useState<RecapPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<{ text: string; kind: "ok" | "error"; shown?: string } | null>(null);
  const [pauseDate, setPauseDate] = useState("");
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const put = (next: RecapSettings) => qc.setQueryData(getGetRecapSettingsQueryKey(), next);

  if (settings.state === "failed") {
    return (
      <PageGrid>
        <Panel title="Morning text" span={12} variant={["static", "flush"]}>
          <RetryNote onRetry={() => void settings.refetch()} retrying={settings.isFetching} data-testid="recap-error">
            Couldn't load your recap settings.
          </RetryNote>
        </Panel>
      </PageGrid>
    );
  }
  if (!s) {
    return (
      <PageGrid>
        <Panel title="Morning text" span={12} variant={["static", "flush"]}>
          <TabSkeleton testId="recap-skeleton" />
        </Panel>
      </PageGrid>
    );
  }

  const verified = s.verified;
  const showForm = !verified || changing;
  const canEnable = verified && !!s.consentedAt && !s.optedOutAt;
  const cur = draft ?? draftOf(s);
  const dirty = draft !== null;
  const timeBad = !isClock(cur.sendTimeLocal);
  const paused =
    s.pausedUntil && new Date(s.pausedUntil).getTime() > (now ?? new Date()).getTime() ? s.pausedUntil : null;
  const left = testsLeft(deliveries.data, now);
  const aiOff = health.data ? !health.data.ai.enabled : false;
  const today = householdToday(now);
  const phoneBad = phoneTried && !toE164(phone);

  const sendCode = () => {
    setPhoneTried(true);
    setPhoneError(null);
    const e164 = toE164(phone);
    if (!e164 || !agreed) return;
    start.mutate(
      { data: { phoneE164: e164, consent: true } },
      {
        onSuccess: (r) => {
          setSent({ devCode: r.devCode });
          setCode("");
          setCodeTried(false);
          setCodeError(null);
          void qc.invalidateQueries({ queryKey: getGetRecapSettingsQueryKey() });
        },
        onError: (e) => setPhoneError(apiMessage(e, "Couldn't send the code. Try again.")),
      },
    );
  };

  const confirmCode = () => {
    setCodeTried(true);
    setCodeError(null);
    if (!isSixDigits(code)) return;
    confirm.mutate(
      { data: { code: code.trim() } },
      {
        onSuccess: (r) => {
          put(r);
          setSent(null);
          setChanging(false);
          setPhone("");
          setAgreed(false);
          setPhoneTried(false);
          toast({ title: "Number verified." });
        },
        onError: (e) => setCodeError(apiMessage(e, "That code did not work. Try again.")),
      },
    );
  };

  const save = () => {
    setSaveError(null);
    if (timeBad || !cur.timezone.trim()) return;
    update.mutate(
      {
        data: {
          sendTimeLocal: cur.sendTimeLocal,
          timezone: cur.timezone.trim(),
          skipWeekends: cur.skipWeekends,
          extraAlerts: cur.extraAlerts,
        },
      },
      {
        onSuccess: (r) => {
          put(r);
          setDraft(null);
          toast({ title: "Schedule saved." });
        },
        onError: (e) => setSaveError(apiMessage(e, "Couldn't save the schedule. Try again.")),
      },
    );
  };

  const setEnabled = (next: boolean) => {
    setEnableError(null);
    update.mutate(
      { data: { enabled: next } },
      {
        onSuccess: (r) => {
          put(r);
          toast({ title: next ? "The morning recap is on." : "The morning recap is off." });
        },
        onError: (e) => setEnableError(apiMessage(e, "Couldn't change that. Try again.")),
      },
    );
  };

  const runPreview = async () => {
    setPreviewError(null);
    setPreviewing(true);
    try {
      const r = await qc.fetchQuery({
        queryKey: RECAP_PREVIEW_KEY,
        queryFn: ({ signal }) => previewRecap({}, { signal }),
        staleTime: PREVIEW_STALE,
      });
      setShown(r);
    } catch (e) {
      setPreviewError(apiMessage(e, "Couldn't draft a preview. Try again."));
    } finally {
      setPreviewing(false);
    }
  };

  const runTest = () => {
    setTestNote(null);
    testSend.mutate(undefined, {
      onSuccess: (r) => {
        void qc.invalidateQueries({ queryKey: getListRecapDeliveriesQueryKey(HISTORY_PARAMS) });
        void qc.invalidateQueries({ queryKey: getGetRecapSettingsQueryKey() });
        setTestNote(
          r?.mode === "preview"
            ? { text: "Preview shown. No text was sent.", kind: "ok", shown: r.text ?? undefined }
            : { text: "Test text sent.", kind: "ok" },
        );
      },
      onError: (e) => {
        void qc.invalidateQueries({ queryKey: getListRecapDeliveriesQueryKey(HISTORY_PARAMS) });
        setTestNote({ text: apiMessage(e, "The test text did not send. Try again."), kind: "error" });
      },
    });
  };

  const doPause = (until: string | null) => {
    setPauseError(null);
    pause.mutate(
      { data: { until } },
      {
        onSuccess: (r) => {
          put(r);
          setPauseDate("");
          toast({ title: until ? "Paused." : "Resumed." });
        },
        onError: (e) => setPauseError(apiMessage(e, "Couldn't change the pause. Try again.")),
      },
    );
  };

  const leave = () =>
    unsub.mutate(undefined, {
      onSuccess: (r) => {
        put(r);
        setLeaving(false);
        toast({ title: "You are unsubscribed." });
      },
      onError: (e) => {
        setLeaving(false);
        toast({ title: apiMessage(e, "Couldn't unsubscribe. Try again."), variant: "destructive" });
      },
    });

  return (
    <PageGrid className="items-start" data-testid="recap">
      <Panel
        title="Morning text"
        sub="A short text each morning: how today looks. You choose the time, and you can stop it any time."
        span={4}
        variant={["static", "flush"]}
        data-testid="status-ladder"
      >
        <ul className="divide-y divide-brand-line/70">
          {ladderRows(s.delivery, s.phoneLast4).map((row) => (
            <li key={row.key} className="flex flex-col gap-1 px-4 py-2.5" data-testid="ladder-row" data-row={row.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body text-brand-ink">{row.label}</span>
                <StatusChip tone={row.tone} data-testid="ladder-word">
                  {row.word}
                </StatusChip>
              </div>
              {row.note && (
                <span className="text-micro text-neutral-500" data-testid="preview-note">
                  {row.note}
                </span>
              )}
            </li>
          ))}
        </ul>
        {s.optedOutAt && (
          <p className="border-t border-brand-line bg-bad-bg px-4 py-2.5 text-micro text-bad" data-testid="opted-out">
            You opted out by text. Verify your number again to get the recap back.
          </p>
        )}
      </Panel>

      {/* Phone and schedule stack beside the status ladder. */}
      <div className="span-8 space-y-4">
      <Panel title="1. Your phone" variant="static" data-testid="section-phone">
        {verified && !changing ? (
          <div className="flex flex-wrap items-center justify-between gap-3" data-testid="phone-verified">
            <p className="flex items-center gap-3 text-body text-brand-ink">
              <StatusChip tone="fresh">Verified</StatusChip>
              <span className="font-mono tabular-nums" data-testid="phone-mask">
                {maskedPhone(s.phoneLast4)}
              </span>
            </p>
            <button type="button" className={btnSecondarySm} onClick={() => setChanging(true)} data-testid="phone-change">
              Change
            </button>
          </div>
        ) : null}
        {showForm && !sent && (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
            data-testid="phone-form"
          >
            <FieldBox
              label="Mobile number (US)"
              htmlFor="recap-phone"
              error={phoneBad ? "Enter a 10-digit US mobile number, like (555) 555-0100." : null}
            >
              <input
                id="recap-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="(555) 555-0100"
                className={`${input} max-w-xs font-mono`}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-invalid={phoneBad || undefined}
                data-testid="phone-input"
              />
            </FieldBox>
            <div className="flex flex-col gap-2">
              <p className="text-micro text-neutral-600" data-testid="consent-text">
                {s.consentText}
              </p>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--color-brand-navy)]"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  data-testid="consent-check"
                />
                <span className="text-body text-brand-ink">I agree to get these texts.</span>
              </label>
              {phoneTried && !agreed && (
                <p className={errLine} role="alert" data-testid="consent-error">
                  Agree to the consent to get texts.
                </p>
              )}
            </div>
            {phoneError && (
              <p className={errLine} role="alert" data-testid="phone-error">
                {phoneError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={btn} disabled={start.isPending} data-testid="send-code">
                Send code
              </button>
              {changing && (
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => {
                    setChanging(false);
                    setPhoneTried(false);
                  }}
                >
                  Keep my number
                </button>
              )}
            </div>
          </form>
        )}
        {showForm && sent && (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              confirmCode();
            }}
            data-testid="code-form"
          >
            <FieldBox
              label="6-digit code"
              htmlFor="recap-code"
              hint="We texted it to your number. It works for 10 minutes."
              error={codeError ?? (codeTried && !isSixDigits(code) ? "Enter the 6-digit code." : null)}
            >
              <input
                id="recap-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className={`${input} max-w-[10rem] font-mono tabular-nums`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                data-testid="code-input"
              />
            </FieldBox>
            {sent.devCode && (
              <p className="text-micro text-neutral-500" data-testid="dev-code">
                Preview mode: the code is {sent.devCode}.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={btn} disabled={confirm.isPending} data-testid="confirm-code">
                Confirm
              </button>
              <button type="button" className={btnSecondary} onClick={() => setSent(null)} data-testid="code-back">
                Use a different number
              </button>
            </div>
          </form>
        )}
      </Panel>

      <Panel title="2. Schedule" variant="static" data-testid="section-schedule">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-4">
            <FieldBox label="Send at" htmlFor="recap-time" error={timeBad ? "Pick a time." : null}>
              <input
                id="recap-time"
                type="time"
                className={`${input} w-36 font-mono`}
                value={cur.sendTimeLocal}
                onChange={(e) => setDraft({ ...cur, sendTimeLocal: e.target.value })}
                data-testid="time-input"
              />
            </FieldBox>
            <FieldBox label="Time zone" htmlFor="recap-tz">
              <select
                id="recap-tz"
                className={`${input} w-56`}
                value={cur.other ? "__other" : cur.timezone}
                onChange={(e) =>
                  e.target.value === "__other"
                    ? setDraft({ ...cur, other: true })
                    : setDraft({ ...cur, other: false, timezone: e.target.value })
                }
                data-testid="tz-select"
              >
                {TIMEZONES.map((z) => (
                  <option key={z.value} value={z.value}>
                    {z.label}
                  </option>
                ))}
                <option value="__other">Other…</option>
              </select>
            </FieldBox>
          </div>
          {cur.other && (
            <FieldBox label="Other time zone" htmlFor="recap-tz-other" hint="A name like Europe/London or America/Anchorage.">
              <input
                id="recap-tz-other"
                className={`${input} max-w-xs`}
                value={cur.timezone}
                onChange={(e) => setDraft({ ...cur, timezone: e.target.value })}
                data-testid="tz-other"
              />
            </FieldBox>
          )}
          <SettingSwitch
            label="Skip weekends"
            on={cur.skipWeekends}
            onChange={(v) => setDraft({ ...cur, skipWeekends: v })}
            data-testid="skip-weekends"
          />
          <SettingSwitch
            label="Extra alerts"
            on={cur.extraAlerts}
            onChange={(v) => setDraft({ ...cur, extraAlerts: v })}
            hint="A text when something needs you before the next morning."
            data-testid="extra-alerts"
          />
          {saveError && (
            <p className={errLine} role="alert" data-testid="save-error">
              {saveError}
            </p>
          )}
          <button
            type="button"
            className={`${btnSecondary} self-start`}
            onClick={save}
            disabled={!dirty || update.isPending}
            data-testid="save-schedule"
          >
            Save schedule
          </button>
          <div className="border-t border-brand-line pt-4">
            <SettingSwitch
              label="Morning recap"
              on={s.enabled}
              onChange={setEnabled}
              disabled={update.isPending || (!canEnable && !s.enabled)}
              hint={
                canEnable || s.enabled
                  ? s.enabled
                    ? `A text arrives at ${clockWords(s.sendTimeLocal)} ${zoneWord(s.timezone)}${s.skipWeekends ? ", weekdays only" : ""}.`
                    : "Turn it on to start the morning text."
                  : "Verify your number and agree to the consent first."
              }
              data-testid="enabled"
            />
            {enableError && (
              <p className={`mt-2 ${errLine}`} role="alert" data-testid="enable-error">
                {enableError}
              </p>
            )}
          </div>
        </div>
      </Panel>

      </div>

      <Panel title="3. Preview" span={6} variant="static" data-testid="section-preview">
        <div className="flex flex-col gap-4">
          <button
            type="button"
            className={`${btnSecondary} self-start`}
            onClick={() => void runPreview()}
            disabled={previewing}
            data-testid="preview-run"
          >
            {previewing ? "Drafting…" : "Preview today's recap"}
          </button>
          {previewError && (
            <p className={errLine} role="alert" data-testid="preview-error">
              {previewError}
            </p>
          )}
          {shown && (
            <div className="section-enter flex flex-col gap-3" data-testid="preview-result">
              {shown.model ? (
                <div className="rounded-control bg-platinum-2 px-3 py-2 ring-1 ring-brand-line" data-testid="preview-model">
                  <p className={`mb-1 flex items-center gap-2 ${fieldLabel}`}>
                    Model draft
                    {shown.model.demo && (
                      <span className="chip gray" data-testid="demo-label">
                        Demo
                      </span>
                    )}
                  </p>
                  <p className="text-body text-brand-ink" data-testid="preview-model-text">
                    {shown.model.text}
                  </p>
                </div>
              ) : (
                aiOff && (
                  <p className="text-micro text-neutral-500" data-testid="ai-off-note">
                    A live model draft needs AI turned on.
                  </p>
                )
              )}
              <div className="rounded-control bg-platinum-2 px-3 py-2 ring-1 ring-brand-line" data-testid="preview-template">
                <p className={`mb-1 ${fieldLabel}`}>Template</p>
                <p className="text-body text-brand-ink" data-testid="preview-template-text">
                  {shown.template.text}
                </p>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-2 border-t border-brand-line pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={btnSecondary}
                onClick={runTest}
                disabled={!verified || testSend.isPending || left === 0}
                data-testid="test-send"
              >
                {testSend.isPending ? "Sending…" : "Send a test text"}
              </button>
              {left != null && (
                <span className="font-mono text-micro tabular-nums text-neutral-500" data-testid="tests-left">
                  {left} left today
                </span>
              )}
            </div>
            {!verified && <p className="text-micro text-neutral-500">Verify your number first.</p>}
            {testNote && (
              <p
                className={testNote.kind === "error" ? errLine : "text-micro text-neutral-600"}
                role={testNote.kind === "error" ? "alert" : "status"}
                data-testid="test-note"
              >
                {testNote.text}
              </p>
            )}
            {testNote?.shown && (
              <p className="text-body text-brand-ink" data-testid="test-shown">
                {testNote.shown}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3 border-t border-brand-line pt-4" data-testid="pause-block">
            {paused ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-body text-brand-ink" data-testid="paused-line">
                  Paused until {shortDateOfInstant(paused)}.
                </p>
                <button
                  type="button"
                  className={btnSecondarySm}
                  onClick={() => doPause(null)}
                  disabled={pause.isPending}
                  data-testid="resume"
                >
                  Resume
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <FieldBox label="Pause until" htmlFor="recap-pause">
                  <input
                    id="recap-pause"
                    type="date"
                    min={today}
                    className={`${input} w-44`}
                    value={pauseDate}
                    onChange={(e) => setPauseDate(e.target.value)}
                    data-testid="pause-date"
                  />
                </FieldBox>
                <button
                  type="button"
                  className={btnSecondarySm}
                  onClick={() => pauseDate && doPause(new Date(`${pauseDate}T00:00:00`).toISOString())}
                  disabled={!pauseDate || pause.isPending}
                  data-testid="pause-go"
                >
                  Pause
                </button>
              </div>
            )}
            {pauseError && (
              <p className={errLine} role="alert" data-testid="pause-error">
                {pauseError}
              </p>
            )}
            <button
              type="button"
              className={`${btnLinkDanger} self-start`}
              onClick={() => setLeaving(true)}
              data-testid="unsubscribe"
            >
              Unsubscribe
            </button>
          </div>
        </div>
      </Panel>

      <Panel title="History" span={6} variant={["static", "flush"]} data-testid="section-history">
        {history.state === "failed" ? (
          <RetryNote onRetry={() => void history.refetch()} retrying={history.isFetching}>
            Couldn't load the history.
          </RetryNote>
        ) : history.data === undefined ? (
          <TabSkeleton testId="history-skeleton" rows={2} />
        ) : history.data.length === 0 ? (
          <p className={emptyNote} data-testid="history-empty">
            No recap has been drafted yet.
          </p>
        ) : (
          <ul className="divide-y divide-brand-line/70" data-testid="history-list">
            {history.data.map((h) => {
              const w = historyWords(h);
              return (
                <li key={h.id} className="flex flex-col gap-1 px-4 py-2.5" data-testid="history-row" data-status={w.status}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-body tabular-nums text-brand-ink">{shortDate(h.forDate)}</span>
                    <StatusChip tone={STATUS_TONE[w.status] ?? "neutral"} data-testid="history-status">
                      {statusLabel(w.status)}
                    </StatusChip>
                  </div>
                  <span className="text-micro text-neutral-500" data-testid="history-source">
                    {w.source}
                  </span>
                  {w.problem && (
                    <span className="text-micro text-bad" data-testid="history-problem">
                      {w.problem}
                    </span>
                  )}
                  <details className="text-micro text-neutral-600">
                    <summary className="cursor-pointer select-none font-semibold text-neutral-500 hover:text-brand-navy">
                      The text
                    </summary>
                    <p className="mt-1 text-body text-brand-ink" data-testid="history-text">
                      {h.text}
                    </p>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <AlertDialog open={leaving} onOpenChange={(o) => !o && setLeaving(false)}>
        <AlertDialogContent data-testid="unsubscribe-sheet">
          <AlertDialogHeader>
            <AlertDialogTitle>Unsubscribe from the morning text?</AlertDialogTitle>
            <AlertDialogDescription>
              The texts stop and the recap turns off. To get them again, verify your number once more.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the texts</AlertDialogCancel>
            <button
              type="button"
              className={btnDanger}
              disabled={unsub.isPending}
              onClick={leave}
              data-testid="unsubscribe-confirm"
            >
              Unsubscribe
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageGrid>
  );
}

