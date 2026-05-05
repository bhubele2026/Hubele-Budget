import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import {
  db,
  plaidConsentRemindersSentTable,
  plaidItemsTable,
  profilesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { PLAID_REAUTH_ERROR_CODES } from "./plaidReauthCodes";

/**
 * (#262) Email reminder for banks whose Plaid consent is about to
 * expire.
 *
 * The in-app "expiring soon" alert (#257) only catches users who happen
 * to open the dashboard before the cutoff hits. Users who don't visit
 * for two weeks still get blindsided. This module powers a daily cron
 * that emails (or, when no transport is configured, logs) a reminder a
 * few days before any of a user's banks is set to disconnect, naming
 * the bank and the cutoff date and linking straight to reconnect.
 *
 * De-dup: the `plaid_consent_reminders_sent` table is keyed on
 * (plaidItemId, cutoffSentFor). Same cutoff = already notified, skip.
 * A successful re-consent rolls Plaid's cutoff months out — well past
 * the alert window — so the next sweep no longer considers the item
 * and no second reminder fires. We never need to look up reconnect
 * events explicitly.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many days before the consent cutoff to send the email. Three days
 * is the smallest window that still leaves the user time to actually
 * sit down and re-consent (typical "I'll get to it tomorrow"
 * procrastination tolerated). The in-app banner already covers the
 * 14-day window — this email is the urgent nudge for the 0-3 day window
 * where Plaid is about to flip the item to PENDING_DISCONNECT.
 */
export const REMINDER_DAYS_BEFORE = 3;

/**
 * Permit a 1-day grace window for cutoffs that just slipped into the
 * past. Mirrors the in-app filter (#257): an item whose cutoff is
 * yesterday probably hasn't been flipped to a re-auth code by Plaid
 * yet, and the user still benefits from the reminder while the link
 * technically works.
 */
const GRACE_DAYS = 1;

export type ReminderTransport = "email" | "log";

export type ReminderResult = {
  itemRowId: string;
  itemId: string;
  institutionName: string | null;
  consentExpirationAt: string | null;
  daysUntil: number | null;
  /**
   * `email` — sent via the configured transport.
   * `log` — no transport configured; the body was written to the logs
   * so operators can still see what would have gone out (useful in
   * dev / before SENDGRID_API_KEY is set in prod).
   * `skipped` — eligible item that we deliberately did not notify on
   * (already sent for this cutoff, no email on file, etc.).
   */
  channel: ReminderTransport | "skipped";
  /** Human-readable explanation when `channel === "skipped"`. */
  reason: string | null;
  /** Email recipient (when known) — captured for support / debugging. */
  recipient: string | null;
  error: string | null;
};

/**
 * Pure-ish cutoff window helper — exported so the integration test can
 * exercise the same time math without re-deriving constants.
 */
export function computeReminderWindow(
  now: Date,
  withinDays: number = REMINDER_DAYS_BEFORE,
): { earliest: Date; latest: Date } {
  return {
    earliest: new Date(now.getTime() - GRACE_DAYS * MS_PER_DAY),
    latest: new Date(now.getTime() + withinDays * MS_PER_DAY),
  };
}

/**
 * Pure helper used by the sweep to decide whether an item is eligible
 * for a reminder *right now*. Mirrors the in-app filter (#257) so users
 * see the same set of items in the dashboard alert and the email.
 */
export function isItemEligibleForReminder(
  item: typeof plaidItemsTable.$inferSelect,
  now: Date,
  withinDays: number = REMINDER_DAYS_BEFORE,
): boolean {
  if (!item.consentExpirationAt) return false;
  if (
    item.lastSyncErrorCode &&
    PLAID_REAUTH_ERROR_CODES.has(item.lastSyncErrorCode)
  ) {
    // The page-top reauth banner already alerts these — we'd just
    // double-notify.
    return false;
  }
  const t = item.consentExpirationAt.getTime();
  const { earliest, latest } = computeReminderWindow(now, withinDays);
  return t >= earliest.getTime() && t <= latest.getTime();
}

/**
 * Find the candidate items inside the alert window. Filters out items
 * that already have a re-auth code (covered by the page-top banner)
 * and items whose cutoff is unparseable. Caller is responsible for
 * checking the de-dup table before sending.
 */
export async function findItemsDueForReminder(
  options: { now?: Date; withinDays?: number; userId?: string } = {},
): Promise<Array<typeof plaidItemsTable.$inferSelect>> {
  const now = options.now ?? new Date();
  const withinDays = options.withinDays ?? REMINDER_DAYS_BEFORE;
  const { earliest, latest } = computeReminderWindow(now, withinDays);
  const baseConds = [
    isNotNull(plaidItemsTable.consentExpirationAt),
    gte(plaidItemsTable.consentExpirationAt, earliest),
    lte(plaidItemsTable.consentExpirationAt, latest),
  ];
  const where = options.userId
    ? and(eq(plaidItemsTable.userId, options.userId), ...baseConds)
    : and(...baseConds);
  const rows = await db.select().from(plaidItemsTable).where(where);
  return rows.filter((it) => isItemEligibleForReminder(it, now, withinDays));
}

/**
 * Build the dated reconnect URL for the email body. Prefers an
 * explicit `APP_URL` (e.g. `https://h2budget.app`) and falls back to
 * `INVITATION_REDIRECT_URL`'s origin so a single deployed URL setting
 * is enough to wire both flows.
 *
 * Returns `null` when nothing absolute is configured. The caller
 * decides what to do:
 *   * Production: skip the item with a "no-app-url-configured" reason
 *     so the user does not receive a broken email with a relative
 *     `/settings` link that no email client can resolve. The sweep
 *     will retry daily and operators see the warning until APP_URL is
 *     set.
 *   * Dev/test: callers may substitute the relative `/settings` path
 *     so the cron stays a no-op-safe operation locally.
 */
export function buildReconnectUrl(): string | null {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) {
    try {
      return new URL("/settings", explicit).toString();
    } catch {
      // fall through
    }
  }
  const invitationUrl = process.env.INVITATION_REDIRECT_URL?.trim();
  if (invitationUrl) {
    try {
      const u = new URL(invitationUrl);
      return new URL("/settings", `${u.protocol}//${u.host}`).toString();
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Resolve the reminder recipient for a user. We prefer Clerk (always
 * the freshest primary address) but fall back to the cached `email`
 * column on `profiles` so the cron still has something to send to when
 * Clerk is briefly unavailable.
 */
export async function loadReminderRecipient(
  userId: string,
): Promise<string | null> {
  try {
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ??
      user.emailAddresses[0];
    if (primary?.emailAddress) return primary.emailAddress;
  } catch {
    // fall through to the profiles cache
  }
  try {
    const [row] = await db
      .select({ email: profilesTable.email })
      .from(profilesTable)
      .where(eq(profilesTable.id, userId));
    return row?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Format the cutoff date the same way the in-app banner does so the
 * email matches what users see in the dashboard. "May 21" when the
 * cutoff falls in the current calendar year (the common case),
 * otherwise "May 21, 2027" so a year-out cutoff is unambiguous.
 */
export function formatReminderDate(d: Date, now: Date = new Date()): string {
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return sameYear
    ? d.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : d.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY);
}

export type RenderedReminder = {
  subject: string;
  text: string;
  html: string;
};

/**
 * Build the reminder email body. Pure — no I/O — so the integration
 * test can assert the exact copy without standing up a transport.
 */
export function renderDisconnectReminder(opts: {
  institutionName: string | null;
  consentExpirationAt: Date;
  reconnectUrl: string;
  now?: Date;
}): RenderedReminder {
  const now = opts.now ?? new Date();
  const bank = opts.institutionName?.trim() || "Your bank";
  const dateLabel = formatReminderDate(opts.consentExpirationAt, now);
  const days = daysBetween(now, opts.consentExpirationAt);
  const relative =
    days < 0
      ? "today"
      : days === 0
        ? "today"
        : days === 1
          ? "tomorrow"
          : `in ${days} days`;
  const subject = `Reconnect ${bank} before ${dateLabel} to keep H2 in sync`;
  const text =
    `Heads up — ${bank} will disconnect from H2 Family Budget on ${dateLabel} ` +
    `(${relative}) unless you re-authorize the link.\n\n` +
    `When the link expires, transactions and balances stop syncing until you ` +
    `reconnect. Re-authorizing only takes a minute and uses Plaid's same secure flow.\n\n` +
    `Reconnect now: ${opts.reconnectUrl}\n\n` +
    `If you've already reconnected since you got this email, you can safely ignore it.`;
  const html =
    `<p>Heads up &mdash; <strong>${escapeHtml(bank)}</strong> will disconnect ` +
    `from H2 Family Budget on <strong>${escapeHtml(dateLabel)}</strong> ` +
    `(${escapeHtml(relative)}) unless you re-authorize the link.</p>` +
    `<p>When the link expires, transactions and balances stop syncing until ` +
    `you reconnect. Re-authorizing only takes a minute and uses Plaid's ` +
    `same secure flow.</p>` +
    `<p><a href="${escapeAttr(opts.reconnectUrl)}" ` +
    `style="display:inline-block;padding:10px 16px;background:#0f766e;color:#fff;` +
    `text-decoration:none;border-radius:6px;font-weight:600;">Reconnect ${escapeHtml(bank)}</a></p>` +
    `<p style="color:#666;font-size:13px;">If you've already reconnected since ` +
    `you got this email, you can safely ignore it.</p>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Pluggable transport. The default uses SendGrid's REST API when
 * `SENDGRID_API_KEY` is set; otherwise the body is written to the
 * pino logs so operators can still see what would have gone out (and
 * the daily sweep stays a no-op-safe operation in dev).
 *
 * Exported so the integration test can swap in a stub.
 */
export type SendReminderEmailFn = (args: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) => Promise<{ ok: boolean; channel: ReminderTransport; error: string | null }>;

export const sendReminderEmail: SendReminderEmailFn = async ({
  to,
  subject,
  text,
  html,
}) => {
  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  const fromEmail =
    process.env.SENDGRID_FROM_EMAIL?.trim() ||
    process.env.OWNER_EMAIL?.trim() ||
    null;
  if (!apiKey || !fromEmail) {
    // No transport configured. Two regimes:
    //   * Dev/test: log the body and report success on the "log"
    //     channel so the cron stays a no-op-safe operation locally
    //     and tests can exercise the de-dup table without needing a
    //     real SendGrid key.
    //   * Production: log a loud warning and return a failure so the
    //     de-dup row is NOT written. Otherwise a misconfigured prod
    //     would silently suppress every reminder forever — the user
    //     would never get notified AND the daily sweep would refuse
    //     to retry. Returning a failure means the next sweep retries
    //     and operators see a daily warning until SENDGRID_* is set.
    const isProd = process.env.NODE_ENV === "production";
    logger.warn(
      { to, subject, hasApiKey: !!apiKey, hasFrom: !!fromEmail, isProd },
      "Plaid disconnect reminder: SENDGRID_API_KEY/SENDGRID_FROM_EMAIL not set",
    );
    if (isProd) {
      return {
        ok: false,
        channel: "log",
        error: "transport-not-configured",
      };
    }
    logger.info(
      { to, subject, body: text },
      "Plaid disconnect reminder (log fallback)",
    );
    return { ok: true, channel: "log", error: null };
  }
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: "H2 Family Budget" },
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        channel: "email",
        error: `SendGrid responded ${resp.status}: ${body.slice(0, 500)}`,
      };
    }
    return { ok: true, channel: "email", error: null };
  } catch (e) {
    return {
      ok: false,
      channel: "email",
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

export type SweepOptions = {
  now?: Date;
  withinDays?: number;
  userId?: string;
  /** Override for tests. Defaults to `sendReminderEmail`. */
  send?: SendReminderEmailFn;
};

/**
 * Per-sweep cache of `userId -> recipient email`. Reused across every
 * item in a single sweep so a user with five linked banks does one
 * Clerk lookup instead of five. The cache lives only for the duration
 * of one `sendExpirationRemindersFor*` call so we never serve a stale
 * email across cron runs.
 */
type RecipientCache = Map<string, string | null>;

async function resolveRecipient(
  userId: string,
  cache: RecipientCache,
): Promise<string | null> {
  if (cache.has(userId)) return cache.get(userId)!;
  const recipient = await loadReminderRecipient(userId);
  cache.set(userId, recipient);
  return recipient;
}

/**
 * Process one item: check the de-dup table, resolve the recipient,
 * render and send the email, record the result. Wrapped in try/catch
 * so a single failure cannot abort the sweep.
 */
async function processItemForReminder(
  item: typeof plaidItemsTable.$inferSelect,
  now: Date,
  send: SendReminderEmailFn,
  recipientCache: RecipientCache,
): Promise<ReminderResult> {
  const cutoff = item.consentExpirationAt!;
  const days = daysBetween(now, cutoff);
  const base: Omit<ReminderResult, "channel" | "reason" | "recipient" | "error"> = {
    itemRowId: item.id,
    itemId: item.itemId,
    institutionName: item.institutionName,
    consentExpirationAt: cutoff.toISOString(),
    daysUntil: days,
  };

  // De-dup against `(plaidItemId, cutoffSentFor)` BEFORE doing any
  // other work — a successful re-consent that just bumped the cutoff
  // out of the window will already have caused this item to be
  // filtered out upstream, but we double-check here so the sweep is
  // safe to invoke ad-hoc on a single item too.
  const [existing] = await db
    .select()
    .from(plaidConsentRemindersSentTable)
    .where(
      and(
        eq(plaidConsentRemindersSentTable.plaidItemId, item.id),
        eq(plaidConsentRemindersSentTable.cutoffSentFor, cutoff),
      ),
    );
  if (existing) {
    return {
      ...base,
      channel: "skipped",
      reason: "already-sent-for-this-cutoff",
      recipient: existing.recipient,
      error: null,
    };
  }

  const recipient = await resolveRecipient(item.userId, recipientCache);
  if (!recipient) {
    return {
      ...base,
      channel: "skipped",
      reason: "no-email-on-file",
      recipient: null,
      error: null,
    };
  }

  // In production we MUST have an absolute reconnect URL — sending an
  // email with a relative `/settings` link would land the user on the
  // SendGrid tracking domain, not the app. Skip the item (don't
  // de-dup) so the next sweep retries once APP_URL is configured.
  // In dev/test we tolerate the relative fallback so the cron stays
  // a no-op-safe local operation.
  const isProd = process.env.NODE_ENV === "production";
  const reconnectUrl = buildReconnectUrl();
  if (!reconnectUrl && isProd) {
    return {
      ...base,
      channel: "skipped",
      reason: "no-app-url-configured",
      recipient,
      error: null,
    };
  }

  const rendered = renderDisconnectReminder({
    institutionName: item.institutionName,
    consentExpirationAt: cutoff,
    reconnectUrl: reconnectUrl ?? "/settings",
    now,
  });
  const result = await send({
    to: recipient,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });

  if (!result.ok) {
    // Do NOT write to plaid_consent_reminders_sent — we want the next
    // sweep to retry. Return the error so the cron summary surfaces it.
    return {
      ...base,
      channel: result.channel,
      reason: null,
      recipient,
      error: result.error,
    };
  }

  // `onConflictDoNothing` on (plaid_item_id, cutoff_sent_for) makes the
  // insert race-safe if two cron processes (or the manual trigger and
  // the cron) ever fire the same sweep simultaneously. The unique
  // index already enforces the de-dup contract; this just turns a
  // would-be exception into a no-op so a concurrent sweep doesn't
  // crash the whole batch.
  await db
    .insert(plaidConsentRemindersSentTable)
    .values({
      userId: item.userId,
      plaidItemId: item.id,
      cutoffSentFor: cutoff,
      channel: result.channel,
      recipient,
    })
    .onConflictDoNothing({
      target: [
        plaidConsentRemindersSentTable.plaidItemId,
        plaidConsentRemindersSentTable.cutoffSentFor,
      ],
    });

  return {
    ...base,
    channel: result.channel,
    reason: null,
    recipient,
    error: null,
  };
}

/**
 * Sweep one user — used by the manual-trigger endpoint so an operator
 * (or an integration test) can kick the reminder for the caller's
 * items on demand without waiting for the cron.
 */
export async function sendExpirationRemindersForUser(
  userId: string,
  options: SweepOptions = {},
): Promise<ReminderResult[]> {
  const now = options.now ?? new Date();
  const send = options.send ?? sendReminderEmail;
  const items = await findItemsDueForReminder({
    now,
    withinDays: options.withinDays,
    userId,
  });
  const recipientCache: RecipientCache = new Map();
  const out: ReminderResult[] = [];
  for (const item of items) {
    try {
      out.push(await processItemForReminder(item, now, send, recipientCache));
    } catch (err) {
      out.push({
        itemRowId: item.id,
        itemId: item.itemId,
        institutionName: item.institutionName,
        consentExpirationAt: item.consentExpirationAt
          ? item.consentExpirationAt.toISOString()
          : null,
        daysUntil: item.consentExpirationAt
          ? daysBetween(now, item.consentExpirationAt)
          : null,
        channel: "skipped",
        reason: "exception",
        recipient: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * Daily cron entry point — sweeps every active Plaid item across every
 * user. Best-effort: per-item failures are logged but never thrown so a
 * single bad item cannot poison the batch (mirrors the
 * `refreshConsentExpirationForAllItems` contract).
 */
export async function sendExpirationRemindersForAllUsers(
  options: SweepOptions = {},
): Promise<{
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  results: ReminderResult[];
}> {
  const now = options.now ?? new Date();
  const send = options.send ?? sendReminderEmail;
  const items = await findItemsDueForReminder({
    now,
    withinDays: options.withinDays,
  });
  const recipientCache: RecipientCache = new Map();
  const results: ReminderResult[] = [];
  for (const item of items) {
    try {
      const r = await processItemForReminder(item, now, send, recipientCache);
      results.push(r);
      if (r.error) {
        logger.warn(
          {
            itemRowId: r.itemRowId,
            itemId: r.itemId,
            institutionName: r.institutionName,
            err: r.error,
          },
          "Plaid disconnect reminder send failed",
        );
      }
    } catch (err) {
      results.push({
        itemRowId: item.id,
        itemId: item.itemId,
        institutionName: item.institutionName,
        consentExpirationAt: item.consentExpirationAt
          ? item.consentExpirationAt.toISOString()
          : null,
        daysUntil: item.consentExpirationAt
          ? daysBetween(now, item.consentExpirationAt)
          : null,
        channel: "skipped",
        reason: "exception",
        recipient: null,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.warn(
        { itemRowId: item.id, err },
        "Plaid disconnect reminder threw unexpectedly",
      );
    }
  }
  return {
    scanned: items.length,
    sent: results.filter((r) => !r.error && r.channel !== "skipped").length,
    skipped: results.filter((r) => r.channel === "skipped").length,
    failed: results.filter((r) => !!r.error).length,
    results,
  };
}
