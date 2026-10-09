/**
 * (F9) The words on Settings › Morning text: phone formats, the status
 * ladder, history rows. Ported unchanged from the frozen h2 app
 * (`artifacts/h2/src/screens/recap/recapWords.ts`), with its tests; never
 * imported from it. There is no money figure on this page.
 */
import type { RecapDeliveryItem, RecapHistoryItem, RecapSettings } from "@workspace/api-client-react/features";

/** The sentence under "Send a test text": the server allows three a day. */
export const TEST_SENDS_PER_DAY = 3;

/** A short list; anything else is typed behind "Other". */
export const TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Phoenix", label: "Arizona (Phoenix)" },
];

export const isListedZone = (tz: string) => TIMEZONES.some((z) => z.value === tz);

/**
 * A US mobile number typed any common way, as E.164. 10 digits, or 11 starting
 * with 1; anything else is null. The server checks the area code and exchange.
 */
export function toE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export const maskedPhone = (last4: string | null | undefined) => (last4 ? `•••• ${last4}` : "A number on file");

export const isSixDigits = (s: string) => /^\d{6}$/.test(s.trim());

export const isClock = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** "7:00 AM" for an HH:MM, for the plain-words line. */
export function clockWords(hhmm: string): string {
  if (!isClock(hhmm)) return hhmm;
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3);
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/** How many test texts are left in the last 24 hours, from the delivery log. */
export function testsLeft(deliveries: readonly RecapDeliveryItem[] | undefined, now: Date = new Date()): number | null {
  if (!deliveries) return null;
  const since = now.getTime() - 24 * 3_600_000;
  const used = deliveries.filter((d) => d.kind === "test" && new Date(d.createdAt).getTime() >= since).length;
  return Math.max(0, TEST_SENDS_PER_DAY - used);
}

/** The word a history row (or the last delivery) shows. */
export const statusLabel = (s: HistoryWords["status"]) => (s === "previewed" ? "Preview — not sent" : s === "drafted" ? "Drafted" : s[0]!.toUpperCase() + s.slice(1));

/** "7:00 AM Chicago" for the schedule row. */
export function scheduleWords(hhmm: string, timezone: string): string {
  return `${clockWords(hhmm)} ${timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone}`;
}

export interface LadderRow {
  key: "preview" | "provider" | "phone" | "scheduled" | "accepted" | "delivered";
  label: string;
  word: string;
  tone: "on" | "fresh" | "over" | "stale" | "neutral";
  note?: string;
}

/** The six-row status ladder, in plain words, from the server's delivery block. */
export function ladderRows(d: RecapSettings["delivery"], last4: string | null | undefined): LadderRow[] {
  const rows: LadderRow[] = [];
  if (d.mode === "preview") {
    rows.push({
      key: "preview",
      label: "Preview mode",
      word: "Yes",
      tone: "stale",
      note: "Texts are written to the server log. Nothing is sent until SMS is set up.",
    });
  }
  rows.push({ key: "provider", label: "Provider configured", word: d.providerConfigured ? "Yes" : "No", tone: d.providerConfigured ? "fresh" : "neutral" });
  rows.push({
    key: "phone",
    label: d.phoneVerified ? `Phone verified — ${maskedPhone(last4)}` : "Phone verified",
    word: d.phoneVerified ? "Yes" : "No",
    tone: d.phoneVerified ? "fresh" : "neutral",
  });
  rows.push(
    d.scheduled
      ? { key: "scheduled", label: `Scheduled — ${scheduleWords(d.sendTimeLocal, d.timezone)}`, word: "Yes", tone: "fresh" }
      : { key: "scheduled", label: "Scheduled", word: "Off", tone: "neutral" },
  );
  const last = d.lastDelivery;
  const real = !!last && last.provider !== "console" && last.status !== "previewed";
  rows.push({
    key: "accepted",
    label: "Accepted by carrier",
    word: real && (last.status === "sent" || last.status === "delivered") ? "Yes" : "No",
    tone: real && (last.status === "sent" || last.status === "delivered") ? "fresh" : "neutral",
  });
  if (last && !real) {
    rows.push({ key: "delivered", label: "Delivered", word: "Preview — not sent", tone: "stale" });
  } else if (real && (last.status === "failed" || last.status === "undelivered")) {
    rows.push({ key: "delivered", label: "Failed", word: "Yes", tone: "over" });
  } else {
    rows.push({ key: "delivered", label: "Delivered", word: real && last.status === "delivered" ? "Yes" : "No", tone: real && last.status === "delivered" ? "fresh" : "neutral" });
  }
  return rows;
}

export interface HistoryWords {
  status: "sent" | "delivered" | "failed" | "skipped" | "drafted" | "previewed";
  source: string;
  /** Set only when the text did not arrive, in words. */
  problem: string | null;
}

export function historyWords(h: RecapHistoryItem): HistoryWords {
  const source = h.source === "model" ? "Written by the model" : "Template";
  const d = h.delivery?.status;
  if (h.status === "skipped") return { status: "skipped", source, problem: null };
  // A console row never left the server: never "Sent".
  if (h.status === "previewed" || d === "previewed" || h.delivery?.provider === "console") {
    return { status: "previewed", source, problem: null };
  }
  if (d === "delivered") return { status: "delivered", source, problem: null };
  if (d === "undelivered" || d === "failed") return { status: "failed", source, problem: "The carrier did not deliver it." };
  if (h.status === "failed") return { status: "failed", source, problem: "It could not be sent." };
  if (h.status === "sent" || d === "sent") return { status: "sent", source, problem: null };
  return { status: "drafted", source, problem: null };
}
