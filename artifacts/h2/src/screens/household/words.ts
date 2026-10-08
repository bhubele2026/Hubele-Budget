import type { PlaidAccount, PlaidItemDetail, PlaidSyncResult } from "@workspace/api-client-react";
import { shortDateOfInstant, relativeTime } from "@/lib/dates";
import type { StatusTone } from "@/kit/StatusWord";

/**
 * The words the Household screens use for a bank. Ported from the classic
 * app's `plaid-reconnect-button`, `plaid-reauth-banner`, `use-plaid-sync` and
 * the linked-banks block of `pages/settings.tsx`; the rules are the same, only
 * the sentences are plainer. Nothing here is money.
 */

/** The only sentence that gates the billable pull. */
export const FORCE_SENTENCE = "This asks the bank for a fresh pull and may cost a small fee.";

/** Plaid error codes that mean "sign in to the bank again". */
const REAUTH_CODES = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "INVALID_ACCESS_TOKEN"]);

export function isReauthCode(code: string | null | undefined): boolean {
  return !!code && REAUTH_CODES.has(code);
}

/** Seed rows (`seed-…`) are placeholders for the balance tile, not real links. */
export function isSyntheticItem(item: { itemId?: string | null } | null | undefined): boolean {
  return (item?.itemId ?? "").startsWith("seed-");
}

export function needsReconnect(item: PlaidItemDetail): boolean {
  return isReauthCode(item.lastSyncErrorCode) && !isSyntheticItem(item);
}

/** The banks that need the owner to sign in again, by name. */
export function itemsNeedingReconnect(items: readonly PlaidItemDetail[] | undefined): PlaidItemDetail[] {
  return [...(items ?? [])]
    .filter(needsReconnect)
    .sort((a, b) => (a.institutionName ?? "").localeCompare(b.institutionName ?? "") || a.id.localeCompare(b.id));
}

/** Why Plaid wants a fresh sign-in, in a sentence. */
export function reconnectReason(
  code: string | null | undefined,
  opts: { consentExpirationAt?: string | null; institutionName?: string | null } = {},
): string {
  const bank = opts.institutionName?.trim() || "This bank";
  if ((code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT") && opts.consentExpirationAt) {
    const day = shortDateOfInstant(opts.consentExpirationAt);
    if (day) return `${bank} will ${code === "PENDING_DISCONNECT" ? "disconnect" : "expire"} on ${day}. Reconnect to keep it linked.`;
  }
  switch (code) {
    case "ITEM_LOGIN_REQUIRED":
      return "Your saved login expired. Sign in again to keep transactions coming.";
    case "PENDING_EXPIRATION":
      return "This connection is about to expire. Reconnect to keep it linked.";
    case "PENDING_DISCONNECT":
      return "The bank will disconnect this soon. Reconnect to keep it linked.";
    case "INVALID_ACCESS_TOKEN":
      return "The saved login is no longer valid. Reconnect to bring in new transactions.";
    default:
      return "The bank needs you to sign in again.";
  }
}

/** A raw bank error, without the "Plaid:" prefix the classic app put on it. */
export function bankErrorWords(message: string | null | undefined): string {
  const m = (message ?? "").replace(/^Plaid:\s*/i, "").trim();
  return m || "The bank did not answer.";
}

export type ItemStatusKind = "ok" | "reconnect" | "preparing" | "stopped";

export interface ItemStatus {
  kind: ItemStatusKind;
  word: string;
  tone: StatusTone;
  /** A sentence under the word, when there is something to explain. */
  detail: string | null;
}

/** One word per bank: ok, needs reconnect, preparing, or feed stopped. */
export function itemStatus(item: PlaidItemDetail): ItemStatus {
  if (needsReconnect(item)) {
    return {
      kind: "reconnect",
      word: "Needs reconnect",
      tone: "over",
      detail: reconnectReason(item.lastSyncErrorCode, {
        consentExpirationAt: item.consentExpirationAt,
        institutionName: item.institutionName,
      }),
    };
  }
  if (item.stillPreparing) {
    return { kind: "preparing", word: "Preparing", tone: "neutral", detail: "The bank is still getting your history ready. Check back in a few minutes." };
  }
  if (item.lastSyncError || item.errorKind) {
    return { kind: "stopped", word: "Feed stopped", tone: "stale", detail: item.lastSyncError ? bankErrorWords(item.lastSyncError) : "The last pull did not work." };
  }
  return { kind: "ok", word: "Working", tone: "fresh", detail: null };
}

export function lastSyncedWords(item: PlaidItemDetail, now?: Date): string {
  const when = relativeTime(item.lastSyncedAt, now);
  return when ? `Synced ${when}` : "Not synced yet";
}

/** "Checking · ending 0100 · checking" */
export function accountLine(a: PlaidAccount): string {
  const kind = a.subtype ?? a.type ?? null;
  return [a.name ?? a.officialName ?? "Account", a.mask ? `ending ${a.mask}` : null, kind].filter(Boolean).join(" · ");
}

export interface SyncSummary {
  added: number;
  modified: number;
  removed: number;
  errors: string[];
  preparing: boolean;
  /** True when at least one item came back asking for a fresh sign-in. */
  reauth: boolean;
  importedDateRange: { min: string; max: string } | null;
  lastOccurredOn: string | null;
}

export function summarizeSync(res: PlaidSyncResult | undefined): SyncSummary {
  const out: SyncSummary = { added: 0, modified: 0, removed: 0, errors: [], preparing: false, reauth: false, importedDateRange: null, lastOccurredOn: null };
  for (const r of res?.items ?? []) {
    out.added += r.added ?? 0;
    out.modified += r.modified ?? 0;
    out.removed += r.removed ?? 0;
    if (r.stillPreparing) out.preparing = true;
    if (r.error) {
      out.errors.push(bankErrorWords(r.plaidDisplayMessage || r.error));
      if (r.kind === "reauth" || isReauthCode(r.plaidErrorCode)) out.reauth = true;
    }
    if (r.importedDateRange) {
      const { min, max } = r.importedDateRange;
      out.importedDateRange = {
        min: out.importedDateRange && out.importedDateRange.min < min ? out.importedDateRange.min : min,
        max: out.importedDateRange && out.importedDateRange.max > max ? out.importedDateRange.max : max,
      };
    }
    if (r.lastOccurredOn && (!out.lastOccurredOn || r.lastOccurredOn > out.lastOccurredOn)) out.lastOccurredOn = r.lastOccurredOn;
  }
  return out;
}

/** What a finished Sync says: the new-row count, or why not. */
export function syncResultWords(s: SyncSummary): string {
  if (s.errors.length > 0) return s.errors.join(" ");
  if (s.preparing && s.added === 0 && s.modified === 0) return "The bank is still preparing. Try again in a minute.";
  if (s.added === 0 && s.modified === 0) return "Up to date. No new transactions.";
  const parts = [`${s.added} new`];
  if (s.modified > 0) parts.push(`${s.modified} updated`);
  return parts.join(", ");
}

/** The backoff the classic post-link poll used: about 91 seconds in all. */
export const POST_LINK_POLL_DELAYS_MS: readonly number[] = [3_000, 4_000, 6_000, 8_000, 10_000, 12_000, 15_000, 15_000, 18_000];

export type PostLinkPhase = "preparing" | "polling" | "ready" | "still-preparing" | "error";

export interface PostLinkStatus {
  phase: PostLinkPhase;
  attempt: number;
  total: number;
  bank: string;
  added: number;
  modified: number;
  error: string | null;
  /** The linked item still needs a fresh sign-in; "ready" must not say all is well. */
  needsReconnect: boolean;
}

export function postLinkWords(s: PostLinkStatus): { title: string; detail: string } {
  const bank = s.bank.trim() || "your bank";
  if (s.needsReconnect) return { title: `${bank} still needs reconnecting`, detail: `Sign in again to finish syncing ${bank}.` };
  switch (s.phase) {
    case "preparing":
      return { title: `Linked ${bank}`, detail: "Preparing your transactions." };
    case "polling":
      return { title: `Pulling transactions from ${bank}`, detail: `Checking. Try ${s.attempt} of ${s.total}.` };
    case "ready": {
      if (s.added === 0 && s.modified === 0) return { title: "No new transactions yet", detail: `${bank} answered with nothing new.` };
      const parts = [`${s.added} added`];
      if (s.modified > 0) parts.push(`${s.modified} updated`);
      return { title: `Ready. ${parts.join(", ")}.`, detail: `Imported from ${bank}.` };
    }
    case "still-preparing":
      return { title: "Still preparing", detail: `${bank} has not finished its first export. Press Sync in a minute; new charges also arrive on their own.` };
    case "error":
      return { title: "The first pull had a problem", detail: s.error ?? `Could not pull from ${bank}.` };
  }
}

/** The message an API error carries, else a plain fallback. */
export function apiMessage(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error.trim()) return data.error;
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return "Only the household owner can do this.";
  return fallback;
}
