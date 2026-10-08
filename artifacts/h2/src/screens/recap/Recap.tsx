import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import {
  getGetRecapSettingsQueryKey,
  getHealthCheckQueryKey,
  getListRecapDeliveriesQueryKey,
  getListRecapHistoryQueryKey,
  useConfirmRecapVerification,
  useGetRecapSettings,
  useHealthCheck,
  useListRecapDeliveries,
  useListRecapHistory,
  usePauseRecap,
  usePreviewRecap,
  useSendRecapTest,
  useStartRecapVerification,
  useUnsubscribeRecap,
  useUpdateRecapSettings,
  type HealthStatus,
  type RecapDeliveryItem,
  type RecapHistoryItem,
  type RecapPreview,
  type RecapSettings,
} from "@workspace/api-client-react";
import { readOf, type Read } from "@/data/todayData";
import { OWN_INVALIDATION } from "@/data/mutationInvalidation";
import { Button } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { SkeletonLine } from "@/kit/Skeleton";
import { StatusWord, type StatusTone } from "@/kit/StatusWord";
import { shortDate, shortDateOfInstant } from "@/lib/dates";
import { apiMessage } from "@/screens/household/words";
import { SwitchRow } from "@/screens/household/parts";
import { Field, inputClass, useToast } from "@/screens/plan/parts";
import { TIMEZONES, clockWords, historyWords, isClock, isListedZone, isSixDigits, ladderRows, maskedPhone, statusLabel, testsLeft, toE164 } from "./recapWords";

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
  const history = useListRecapHistory(HISTORY_PARAMS, { query: { queryKey: getListRecapHistoryQueryKey(HISTORY_PARAMS), ...CACHE } });
  const deliveries = useListRecapDeliveries(HISTORY_PARAMS, { query: { queryKey: getListRecapDeliveriesQueryKey(HISTORY_PARAMS), ...CACHE } });
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), staleTime: 5 * 60_000, gcTime: 30 * 60_000 } });
  return { settings: readOf(settings), history: readOf(history), deliveries: readOf(deliveries), health: readOf(health) };
}

export default function Recap() {
  return <RecapView data={useRecapData()} />;
}

const STATUS_TONE: Record<string, StatusTone> = { sent: "on", delivered: "fresh", failed: "over", skipped: "stale", drafted: "neutral", previewed: "stale" };

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

/**
 * ⭐ MORNING RECAP — an opt-in text each morning. There is no money figure on
 * this page. Three steps (phone, schedule, preview), then what was sent. The
 * server decides everything; this page asks and reports the answer in words.
 */
export function RecapView({ data, now }: { data: RecapData; now?: Date }) {
  const { settings, history, deliveries, health } = data;
  const qc = useQueryClient();
  const { say, node: toast } = useToast();
  const s = settings.data;

  const mutOpts = { mutation: { meta: OWN_INVALIDATION } } as const;
  const update = useUpdateRecapSettings(mutOpts);
  const start = useStartRecapVerification(mutOpts);
  const confirm = useConfirmRecapVerification(mutOpts);
  const testSend = useSendRecapTest(mutOpts);
  const pause = usePauseRecap(mutOpts);
  const unsub = useUnsubscribeRecap(mutOpts);
  const preview = usePreviewRecap(mutOpts);

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
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<{ text: string; kind: "ok" | "error"; shown?: string } | null>(null);
  const [pauseDate, setPauseDate] = useState("");
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const put = (next: RecapSettings) => qc.setQueryData(getGetRecapSettingsQueryKey(), next);

  if (settings.state === "failed") {
    return (
      <Frame>
        <Note kind="error" onRetry={settings.refetch} retrying={settings.isFetching} data-testid="recap-error">
          Couldn't load your recap settings.
        </Note>
      </Frame>
    );
  }
  if (!s) {
    return (
      <Frame>
        <div className="flex flex-col gap-3" data-testid="recap-skeleton" aria-busy="true">
          <SkeletonLine className="w-48" />
          <SkeletonLine className="w-64" />
          <SkeletonLine className="w-56" />
        </div>
      </Frame>
    );
  }

  const verified = s.verified;
  const showForm = !verified || changing;
  const canEnable = verified && !!s.consentedAt && !s.optedOutAt;
  const cur = draft ?? draftOf(s);
  const dirty = draft !== null;
  const timeBad = !isClock(cur.sendTimeLocal);
  const paused = s.pausedUntil && new Date(s.pausedUntil).getTime() > (now ?? new Date()).getTime() ? s.pausedUntil : null;
  const left = testsLeft(deliveries.data, now);
  const aiOff = health.data ? !health.data.ai.enabled : false;

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
          say("Number verified.");
        },
        onError: (e) => setCodeError(apiMessage(e, "That code did not work. Try again.")),
      },
    );
  };

  const save = () => {
    setSaveError(null);
    if (timeBad || !cur.timezone.trim()) return;
    update.mutate(
      { data: { sendTimeLocal: cur.sendTimeLocal, timezone: cur.timezone.trim(), skipWeekends: cur.skipWeekends, extraAlerts: cur.extraAlerts } },
      {
        onSuccess: (r) => {
          put(r);
          setDraft(null);
          say("Schedule saved.");
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
          say(next ? "The morning recap is on." : "The morning recap is off.");
        },
        onError: (e) => setEnableError(apiMessage(e, "Couldn't change that. Try again.")),
      },
    );
  };

  const runPreview = () => {
    setPreviewError(null);
    preview.mutate(
      { data: {} },
      {
        onSuccess: (r) => setShown(r),
        onError: (e) => setPreviewError(apiMessage(e, "Couldn't draft a preview. Try again.")),
      },
    );
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
          say(until ? "Paused." : "Resumed.");
        },
        onError: (e) => setPauseError(apiMessage(e, "Couldn't change the pause. Try again.")),
      },
    );
  };

  const today = householdToday(now);

  return (
    <Frame>
      <Section label="Status" data-testid="status-ladder">
        <ul className="flex flex-col">
          {ladderRows(s.delivery, s.phoneLast4).map((row) => (
            <li key={row.key} className="flex flex-col gap-1 border-t border-rule py-2 first:border-t-0" data-testid="ladder-row" data-row={row.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="type-body text-ink">{row.label}</span>
                <StatusWord tone={row.tone} data-testid="ladder-word">
                  {row.word}
                </StatusWord>
              </div>
              {row.note && (
                <span className="type-caption text-ink-3" data-testid="preview-note">
                  {row.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>
      {s.optedOutAt && (
        <div className="mb-6">
          <Note kind="stale" data-testid="opted-out">
            You opted out by text. Verify your number again to get the recap back.
          </Note>
        </div>
      )}

      <Section label="1. Your phone" data-testid="section-phone">
        {verified && !changing ? (
          <div className="flex items-center justify-between gap-3" data-testid="phone-verified">
            <p className="type-body text-ink">
              <StatusWord tone="fresh" className="mr-3">
                Verified
              </StatusWord>
              <span className="font-mono tnum" data-testid="phone-mask">
                {maskedPhone(s.phoneLast4)}
              </span>
            </p>
            <Button size="sm" onClick={() => setChanging(true)} data-testid="phone-change">
              Change
            </Button>
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
            <Field label="Mobile number (US)" error={phoneTried && !toE164(phone) ? "Enter a 10-digit US mobile number, like (555) 555-0100." : null}>
              {(a) => (
                <input {...a} type="tel" inputMode="tel" autoComplete="tel" placeholder="(555) 555-0100" className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="phone-input" />
              )}
            </Field>
            <div className="flex flex-col gap-2">
              <p className="type-caption text-ink-2" data-testid="consent-text">
                {s.consentText}
              </p>
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" className="mt-1 size-4 accent-[var(--color-moss)]" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="consent-check" />
                <span className="type-body text-ink">I agree to get these texts.</span>
              </label>
              {phoneTried && !agreed && (
                <p className="type-caption text-clay" role="alert" data-testid="consent-error">
                  Agree to the consent to get texts.
                </p>
              )}
            </div>
            {phoneError && (
              <p className="type-caption text-clay" role="alert" data-testid="phone-error">
                {phoneError}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="primary" disabled={start.isPending} data-testid="send-code">
                Send code
              </Button>
              {changing && (
                <Button
                  onClick={() => {
                    setChanging(false);
                    setPhoneTried(false);
                  }}
                >
                  Keep my number
                </Button>
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
            <Field label="6-digit code" hint="We texted it to your number. It works for 10 minutes." error={codeError ?? (codeTried && !isSixDigits(code) ? "Enter the 6-digit code." : null)}>
              {(a) => (
                <input {...a} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className={`${inputClass} font-mono tnum`} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} data-testid="code-input" />
              )}
            </Field>
            {sent.devCode && (
              <p className="type-caption text-ink-3" data-testid="dev-code">
                Preview mode: the code is {sent.devCode}.
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="primary" disabled={confirm.isPending} data-testid="confirm-code">
                Confirm
              </Button>
              <Button onClick={() => setSent(null)} data-testid="code-back">
                Use a different number
              </Button>
            </div>
          </form>
        )}
      </Section>

      <Section label="2. Schedule" data-testid="section-schedule">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-4">
            <Field label="Send at" error={timeBad ? "Pick a time." : null}>
              {(a) => (
                <input {...a} type="time" className={`${inputClass} w-36`} value={cur.sendTimeLocal} onChange={(e) => setDraft({ ...cur, sendTimeLocal: e.target.value })} data-testid="time-input" />
              )}
            </Field>
            <Field label="Time zone">
              {(a) => (
                <select
                  {...a}
                  className={`${inputClass} w-56`}
                  value={cur.other ? "__other" : cur.timezone}
                  onChange={(e) => (e.target.value === "__other" ? setDraft({ ...cur, other: true }) : setDraft({ ...cur, other: false, timezone: e.target.value }))}
                  data-testid="tz-select"
                >
                  {TIMEZONES.map((z) => (
                    <option key={z.value} value={z.value}>
                      {z.label}
                    </option>
                  ))}
                  <option value="__other">Other…</option>
                </select>
              )}
            </Field>
          </div>
          {cur.other && (
            <Field label="Other time zone" hint="A name like Europe/London or America/Anchorage.">
              {(a) => <input {...a} className={inputClass} value={cur.timezone} onChange={(e) => setDraft({ ...cur, timezone: e.target.value })} data-testid="tz-other" />}
            </Field>
          )}
          <SwitchRow label="Skip weekends" on={cur.skipWeekends} onChange={(v) => setDraft({ ...cur, skipWeekends: v })} data-testid="skip-weekends" />
          <SwitchRow label="Extra alerts" on={cur.extraAlerts} onChange={(v) => setDraft({ ...cur, extraAlerts: v })} hint="A text when something needs you before the next morning." data-testid="extra-alerts" />
          {saveError && (
            <p className="type-caption text-clay" role="alert" data-testid="save-error">
              {saveError}
            </p>
          )}
          <Button variant="quiet" className="self-start" onClick={save} disabled={!dirty || update.isPending} data-testid="save-schedule">
            Save schedule
          </Button>
          <div className="border-t border-rule pt-4">
            <SwitchRow
              label="Morning recap"
              on={s.enabled}
              onChange={setEnabled}
              disabled={update.isPending || (!canEnable && !s.enabled)}
              hint={
                canEnable || s.enabled
                  ? s.enabled
                    ? `A text arrives at ${clockWords(s.sendTimeLocal)} ${s.timezone.split("/").pop()?.replace(/_/g, " ")}${s.skipWeekends ? ", weekdays only" : ""}.`
                    : "Turn it on to start the morning text."
                  : "Verify your number and agree to the consent first."
              }
              data-testid="enabled"
            />
            {enableError && (
              <p className="mt-2 type-caption text-clay" role="alert" data-testid="enable-error">
                {enableError}
              </p>
            )}
          </div>
        </div>
      </Section>

      <Section label="3. Preview" data-testid="section-preview">
        <div className="flex flex-col gap-4">
          <Button variant="quiet" className="self-start" onClick={runPreview} disabled={preview.isPending} data-testid="preview-run">
            {preview.isPending ? "Drafting…" : "Preview today's recap"}
          </Button>
          {previewError && (
            <p className="type-caption text-clay" role="alert" data-testid="preview-error">
              {previewError}
            </p>
          )}
          {shown && (
            <div className="flex flex-col gap-4" data-testid="preview-result">
              {shown.model ? (
                <div data-testid="preview-model">
                  <p className="mb-1 flex items-center gap-2 type-label text-ink-2">
                    Model draft
                    {shown.model.demo && (
                      <span className="rounded-1 border border-rule-strong px-2 py-0.5 type-caption text-ink-2" data-testid="demo-label">
                        Demo
                      </span>
                    )}
                  </p>
                  <p className="type-body text-ink" data-testid="preview-model-text">
                    {shown.model.text}
                  </p>
                </div>
              ) : (
                aiOff && (
                  <p className="type-caption text-ink-3" data-testid="ai-off-note">
                    A live model draft needs AI turned on.
                  </p>
                )
              )}
              <div data-testid="preview-template">
                <p className="mb-1 type-label text-ink-2">Template</p>
                <p className="type-body text-ink" data-testid="preview-template-text">
                  {shown.template.text}
                </p>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-2 border-t border-rule pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={runTest} disabled={!verified || testSend.isPending || left === 0} data-testid="test-send">
                {testSend.isPending ? "Sending…" : "Send a test text"}
              </Button>
              {left != null && (
                <span className="type-caption text-ink-3" data-testid="tests-left">
                  {left} left today
                </span>
              )}
            </div>
            {!verified && <p className="type-caption text-ink-3">Verify your number first.</p>}
            {testNote && (
              <p className={`type-caption ${testNote.kind === "error" ? "text-clay" : "text-ink-2"}`} role={testNote.kind === "error" ? "alert" : "status"} data-testid="test-note">
                {testNote.text}
              </p>
            )}
            {testNote?.shown && (
              <p className="type-body text-ink" data-testid="test-shown">
                {testNote.shown}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3 border-t border-rule pt-4" data-testid="pause-block">
            {paused ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="type-body text-ink" data-testid="paused-line">
                  Paused until {shortDateOfInstant(paused)}.
                </p>
                <Button size="sm" onClick={() => doPause(null)} disabled={pause.isPending} data-testid="resume">
                  Resume
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Pause until">
                  {(a) => <input {...a} type="date" min={today} className={`${inputClass} w-44`} value={pauseDate} onChange={(e) => setPauseDate(e.target.value)} data-testid="pause-date" />}
                </Field>
                <Button size="sm" onClick={() => pauseDate && doPause(new Date(`${pauseDate}T00:00:00`).toISOString())} disabled={!pauseDate || pause.isPending} data-testid="pause-go">
                  Pause
                </Button>
              </div>
            )}
            {pauseError && (
              <p className="type-caption text-clay" role="alert" data-testid="pause-error">
                {pauseError}
              </p>
            )}
            <Button variant="danger" className="self-start" size="sm" onClick={() => setLeaving(true)} data-testid="unsubscribe">
              Unsubscribe
            </Button>
          </div>
        </div>
      </Section>

      <Section label="History" data-testid="section-history">
        {history.state === "failed" ? (
          <Note kind="error" onRetry={history.refetch} retrying={history.isFetching}>
            Couldn't load the history.
          </Note>
        ) : history.data === undefined ? (
          <SkeletonLine className="w-56" />
        ) : history.data.length === 0 ? (
          <Note kind="empty" data-testid="history-empty">
            No recap has been drafted yet.
          </Note>
        ) : (
          <ul className="flex flex-col" data-testid="history-list">
            {history.data.map((h) => {
              const w = historyWords(h);
              return (
                <li key={h.id} className="flex flex-col gap-1 border-t border-rule py-3 first:border-t-0" data-testid="history-row" data-status={w.status}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="type-body text-ink">{shortDate(h.forDate)}</span>
                    <StatusWord tone={STATUS_TONE[w.status] ?? "neutral"} data-testid="history-status">
                      {statusLabel(w.status)}
                    </StatusWord>
                  </div>
                  <span className="type-caption text-ink-3" data-testid="history-source">
                    {w.source}
                  </span>
                  {w.problem && (
                    <span className="type-caption text-clay" data-testid="history-problem">
                      {w.problem}
                    </span>
                  )}
                  <Disclosure summary="The text">
                    <p data-testid="history-text">{h.text}</p>
                  </Disclosure>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {leaving && (
        <Sheet open onOpenChange={(o) => !o && setLeaving(false)} title="Unsubscribe from the morning text?" description="The texts stop and the recap turns off. To get them again, verify your number once more.">
          <div className="flex flex-col gap-3" data-testid="unsubscribe-sheet">
            <Button
              variant="danger"
              disabled={unsub.isPending}
              onClick={() =>
                unsub.mutate(undefined, {
                  onSuccess: (r) => {
                    put(r);
                    setLeaving(false);
                    say("You are unsubscribed.");
                  },
                  onError: (e) => {
                    setLeaving(false);
                    say(apiMessage(e, "Couldn't unsubscribe. Try again."), "error");
                  },
                })
              }
              data-testid="unsubscribe-confirm"
            >
              Unsubscribe
            </Button>
            <Button onClick={() => setLeaving(false)}>Keep the texts</Button>
          </div>
        </Sheet>
      )}
      {toast}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col" data-testid="recap">
      <header className="mb-6 flex flex-col gap-2">
        <h1 className="type-headline text-ink">Morning recap</h1>
        <p className="type-body text-ink-2">A short text each morning: how today looks. You choose the time, and you can stop it any time.</p>
      </header>
      {children}
    </div>
  );
}
