import { createHash } from "node:crypto";
import { desc } from "drizzle-orm";
import { db, plaidMalformedTokenAlertsSentTable } from "@workspace/db";
import { logger } from "./logger";
import type { FlaggedMalformedItem } from "./plaidSync";

/**
 * (#371) Operator alert when the daily malformed-token sweep flags a
 * spike in poisoned `plaid_items` rows.
 *
 * The daily sweep (#369) logs `{ scanned, flagged }` at 03:02 UTC, but
 * a config change that suddenly poisons many rows (env-var swap,
 * truncated migration, manual DB edit) can climb from 0 to dozens
 * overnight without any human-facing signal until users complain. This
 * module fires an email (or, when no transport is configured, a loud
 * warn-level log) so operators see the spike the morning it happens
 * and can roll back the bad config before users notice stale balances.
 *
 * Trigger: `flagged >= MALFORMED_TOKEN_ALERT_THRESHOLD` (env override,
 * default 3). A flagged count of 0–1 stays silent — one bad row from a
 * single user is the steady-state noise floor and doesn't warrant
 * paging anyone. Three+ in one morning means something systemic broke.
 */

/**
 * Default threshold. Three is the smallest count that's clearly above
 * the steady-state "one user mangled their own row" noise floor — a
 * single broken token can happen organically, three in one day almost
 * always points at a config-level cause worth investigating.
 */
export const DEFAULT_ALERT_THRESHOLD = 3;

/**
 * Cap on how many institution names go into the alert body. Operators
 * just need a representative sample to start triaging — emailing 200
 * names doesn't help, and SendGrid has body-size limits.
 */
const SAMPLE_INSTITUTION_LIMIT = 10;

export function getAlertThreshold(): number {
  const raw = process.env.MALFORMED_TOKEN_ALERT_THRESHOLD?.trim();
  if (!raw) return DEFAULT_ALERT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ALERT_THRESHOLD;
  return Math.floor(n);
}

export type AlertChannel = "email" | "log" | "skipped";

export type AlertResult = {
  channel: AlertChannel;
  /** Reason when channel === "skipped" */
  reason: string | null;
  /** Recipient email when known */
  recipient: string | null;
  error: string | null;
};

export type SendOperatorAlertFn = (args: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) => Promise<{ ok: boolean; channel: "email" | "log"; error: string | null }>;

/**
 * Default transport — same SendGrid REST shape as the disconnect
 * reminder (#262) so operators only need to configure SENDGRID_API_KEY
 * + SENDGRID_FROM_EMAIL once. Falls back to a loud log warn in dev so
 * the cron stays a no-op-safe local operation.
 *
 * Exported so the integration test can swap in a stub.
 */
export const sendOperatorAlertEmail: SendOperatorAlertFn = async ({
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
    const isProd = process.env.NODE_ENV === "production";
    logger.warn(
      { to, subject, hasApiKey: !!apiKey, hasFrom: !!fromEmail, isProd },
      "Plaid malformed-token operator alert: SENDGRID_API_KEY/SENDGRID_FROM_EMAIL not set",
    );
    if (isProd) {
      // In production, refusing to write a "sent" record means the
      // next sweep will retry the alert — operators get a daily warn
      // until they configure SendGrid, instead of silent suppression.
      return { ok: false, channel: "log", error: "transport-not-configured" };
    }
    logger.info(
      { to, subject, body: text },
      "Plaid malformed-token operator alert (log fallback)",
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
        from: { email: fromEmail, name: "H2 Family Budget Ops" },
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type RenderedAlert = { subject: string; text: string; html: string };

/**
 * Build the operator alert body. Pure — no I/O — so the integration
 * test can assert the exact copy without standing up a transport.
 */
export function renderMalformedTokenAlert(opts: {
  scanned: number;
  flagged: number;
  flaggedItems: FlaggedMalformedItem[];
  threshold: number;
  now?: Date;
}): RenderedAlert {
  const now = opts.now ?? new Date();
  const dateLabel = now.toISOString().slice(0, 10);
  const sample = opts.flaggedItems.slice(0, SAMPLE_INSTITUTION_LIMIT);
  const overflow = opts.flaggedItems.length - sample.length;
  const sampleLines = sample.map((it) => {
    const name = it.institutionName?.trim() || "(unknown institution)";
    return `  • ${name} [item ${it.itemId}]`;
  });
  const sampleHtml = sample
    .map(
      (it) =>
        `<li><strong>${escapeHtml(it.institutionName?.trim() || "(unknown institution)")}</strong>` +
        ` <code>${escapeHtml(it.itemId)}</code></li>`,
    )
    .join("");
  const overflowText =
    overflow > 0 ? `\n  …and ${overflow} more` : "";
  const overflowHtml =
    overflow > 0
      ? `<p style="color:#666;font-size:13px;">…and ${overflow} more.</p>`
      : "";

  const subject = `[H2 ops] ${opts.flagged} Plaid items flagged with bad access tokens (${dateLabel})`;
  const text =
    `The daily Plaid bank-login health check (${dateLabel} 03:02 UTC) flagged ` +
    `${opts.flagged} of ${opts.scanned} plaid_items rows as having a malformed ` +
    `access_token (threshold: ${opts.threshold}).\n\n` +
    `This is usually caused by a config-level event — a PLAID_ENV swap, a ` +
    `truncated migration, or a bad manual DB edit — and every flagged row is ` +
    `now showing the Reconnect CTA to its owner.\n\n` +
    `Affected institutions (sample):\n${sampleLines.join("\n")}${overflowText}\n\n` +
    `Next steps:\n` +
    `  1. Check recent deploys / env-var changes around 03:02 UTC.\n` +
    `  2. Verify PLAID_ENV matches the access_token prefix on these rows.\n` +
    `  3. If a bad config caused the spike, roll back and run the boot scan ` +
    `to clear the synthetic ITEM_LOGIN_REQUIRED state once the tokens parse again.\n`;
  const html =
    `<p>The daily Plaid bank-login health check ` +
    `(<strong>${escapeHtml(dateLabel)} 03:02 UTC</strong>) flagged ` +
    `<strong>${opts.flagged}</strong> of ${opts.scanned} <code>plaid_items</code> ` +
    `rows as having a malformed <code>access_token</code> (threshold: ${opts.threshold}).</p>` +
    `<p>This is usually caused by a config-level event — a <code>PLAID_ENV</code> swap, ` +
    `a truncated migration, or a bad manual DB edit — and every flagged row is now ` +
    `showing the Reconnect CTA to its owner.</p>` +
    `<p><strong>Affected institutions (sample):</strong></p>` +
    `<ul>${sampleHtml}</ul>${overflowHtml}` +
    `<p><strong>Next steps:</strong></p>` +
    `<ol>` +
    `<li>Check recent deploys / env-var changes around 03:02 UTC.</li>` +
    `<li>Verify <code>PLAID_ENV</code> matches the access_token prefix on these rows.</li>` +
    `<li>If a bad config caused the spike, roll back and run the boot scan to ` +
    `clear the synthetic <code>ITEM_LOGIN_REQUIRED</code> state once the tokens parse again.</li>` +
    `</ol>`;
  return { subject, text, html };
}

/**
 * Resolve the operator recipient. Prefers an explicit
 * `OPS_ALERT_EMAIL` so a team alias can receive ops alerts without
 * also being the SendGrid `from` address, then falls back to
 * `OWNER_EMAIL` (already used by the owner-only routes / SendGrid
 * default `from`) so a single env var configures both.
 */
export function resolveOperatorRecipient(): string | null {
  return (
    process.env.OPS_ALERT_EMAIL?.trim() ||
    process.env.OWNER_EMAIL?.trim() ||
    null
  );
}

/**
 * (#396) Default growth thresholds that re-arm the alert after a
 * suppressed day-over-day repeat.
 *
 * If the same set of items keeps showing up, we stay silent — but the
 * moment the spike *grows* meaningfully (an additional N rows OR an
 * X% increase day-over-day) we want operators paged again because
 * "the cleanup isn't keeping up" or "a second wave just hit" is a
 * different signal from "we already know about this batch".
 *
 * Defaults:
 *   * +2 absolute — one extra flagged user can be noise (their token
 *     happened to break today). Two extras is a trend.
 *   * +25% — at small counts (4 → 5) the absolute rule fires first;
 *     this kicks in at larger ones (20 → 26).
 *
 * Both are env-overridable so on-call can dial the noise up or down
 * without a redeploy.
 */
export const DEFAULT_GROWTH_ABSOLUTE = 2;
export const DEFAULT_GROWTH_PERCENT = 25;

export function getGrowthAbsolute(): number {
  const raw = process.env.MALFORMED_TOKEN_ALERT_GROWTH_ABSOLUTE?.trim();
  if (!raw) return DEFAULT_GROWTH_ABSOLUTE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GROWTH_ABSOLUTE;
  return Math.floor(n);
}

export function getGrowthPercent(): number {
  const raw = process.env.MALFORMED_TOKEN_ALERT_GROWTH_PERCENT?.trim();
  if (!raw) return DEFAULT_GROWTH_PERCENT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GROWTH_PERCENT;
  return n;
}

/**
 * Hash the flagged item set into a stable digest. Sorted so the order
 * of `flaggedItems` (which mirrors the DB scan order and isn't
 * guaranteed stable across runs) doesn't accidentally re-fire the
 * alert. We hash `itemRowId` (DB primary key) rather than the Plaid
 * `itemId` so a re-link that creates a fresh row is correctly seen
 * as a new flagged entry.
 */
export function computeAlertDigest(items: FlaggedMalformedItem[]): string {
  const sorted = items.map((it) => it.itemRowId).sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export type LastAlertSnapshot = {
  digest: string;
  flaggedItemRowIds: string[];
  flagged: number;
  sentAt: Date;
};

export type LoadLastAlertFn = () => Promise<LastAlertSnapshot | null>;

export type RecordAlertFn = (record: {
  digest: string;
  flaggedItemRowIds: string[];
  flagged: number;
  scanned: number;
  threshold: number;
  channel: "email" | "log";
  recipient: string | null;
}) => Promise<void>;

/**
 * Default DB-backed loader for the last alert digest. Best-effort:
 * if the read fails we let the alert through rather than silently
 * suppressing it (a duplicate alert is recoverable; a missed alert
 * during a real spike is the bug we're trying to prevent).
 */
export const loadLastAlertFromDb: LoadLastAlertFn = async () => {
  const [row] = await db
    .select()
    .from(plaidMalformedTokenAlertsSentTable)
    .orderBy(desc(plaidMalformedTokenAlertsSentTable.sentAt))
    .limit(1);
  if (!row) return null;
  const ids = Array.isArray(row.flaggedItemRowIds)
    ? (row.flaggedItemRowIds as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  return {
    digest: row.digest,
    flaggedItemRowIds: ids,
    flagged: row.flagged,
    sentAt: row.sentAt,
  };
};

export const recordAlertToDb: RecordAlertFn = async (rec) => {
  await db.insert(plaidMalformedTokenAlertsSentTable).values({
    digest: rec.digest,
    flaggedItemRowIds: rec.flaggedItemRowIds,
    flagged: rec.flagged,
    scanned: rec.scanned,
    threshold: rec.threshold,
    channel: rec.channel,
    recipient: rec.recipient,
  });
};

/**
 * Decide whether the current spike is a duplicate of the last one we
 * already paged operators about. Returns `null` (do not suppress) when
 * the alert should fire, or a string reason when it should be muted.
 *
 * Re-arms when:
 *   * any flagged itemRowId is new (a different bank broke since the
 *     last alert — operators need to know the failure mode is still
 *     spreading, not just lingering),
 *   * the count grew by `>= growthAbsolute`, OR
 *   * the count grew by `>= growthPercent` percent over the prior
 *     alert's count.
 */
export function shouldSuppressDuplicateAlert(args: {
  current: { digest: string; flaggedItemRowIds: string[]; flagged: number };
  last: LastAlertSnapshot;
  growthAbsolute: number;
  growthPercent: number;
}): string | null {
  const { current, last, growthAbsolute, growthPercent } = args;
  if (current.digest === last.digest) {
    return "duplicate-of-prior-alert";
  }
  const lastSet = new Set(last.flaggedItemRowIds);
  const hasNewItem = current.flaggedItemRowIds.some((id) => !lastSet.has(id));
  if (hasNewItem) return null;
  // Subset (or equal) of the prior set — only re-fire if the count
  // grew enough to represent a genuine escalation.
  const delta = current.flagged - last.flagged;
  if (delta >= growthAbsolute) return null;
  if (last.flagged > 0 && (delta / last.flagged) * 100 >= growthPercent) {
    return null;
  }
  return "duplicate-of-prior-alert";
}

export type MaybeAlertOptions = {
  send?: SendOperatorAlertFn;
  now?: Date;
  threshold?: number;
  recipient?: string | null;
  /**
   * (#396) De-dup hooks. Default to a Postgres-backed implementation
   * (`loadLastAlertFromDb` / `recordAlertToDb`) so the cron path
   * gets repeat-suppression for free; tests can swap them in-memory.
   * Pass `null` to disable suppression entirely (e.g. an integration
   * test that wants to assert the unsuppressed render path).
   */
  loadLastAlert?: LoadLastAlertFn | null;
  recordAlert?: RecordAlertFn | null;
  growthAbsolute?: number;
  growthPercent?: number;
};

/**
 * Decide whether the daily sweep summary warrants paging operators
 * and, if so, send the alert. Best-effort: any failure is logged but
 * never thrown — the cron must never crash on a side-channel.
 *
 * Quiet path:
 *   * `flagged < threshold` → returns `{ channel: "skipped", reason: "below-threshold" }`.
 *   * No recipient configured → `{ channel: "skipped", reason: "no-recipient" }`
 *     PLUS a loud warn so operators notice the misconfig.
 */
export async function maybeAlertOnMalformedTokenSpike(
  summary: {
    scanned: number;
    flagged: number;
    flaggedItems: FlaggedMalformedItem[];
  },
  options: MaybeAlertOptions = {},
): Promise<AlertResult> {
  const threshold = options.threshold ?? getAlertThreshold();
  if (summary.flagged < threshold) {
    return {
      channel: "skipped",
      reason: "below-threshold",
      recipient: null,
      error: null,
    };
  }
  const recipient =
    options.recipient !== undefined ? options.recipient : resolveOperatorRecipient();
  if (!recipient) {
    logger.warn(
      { flagged: summary.flagged, scanned: summary.scanned, threshold },
      "Plaid malformed-token spike detected but OPS_ALERT_EMAIL/OWNER_EMAIL is not set — alert not sent",
    );
    return {
      channel: "skipped",
      reason: "no-recipient",
      recipient: null,
      error: null,
    };
  }
  // (#396) Suppress repeats of the same spike day-over-day. Done after
  // the threshold + recipient gates so a misconfig still surfaces, and
  // before the render/send work so a duplicate day is genuinely silent
  // (no SendGrid call, no log spam) instead of "rendered then dropped".
  const loadLastAlert =
    options.loadLastAlert === undefined ? loadLastAlertFromDb : options.loadLastAlert;
  const recordAlert =
    options.recordAlert === undefined ? recordAlertToDb : options.recordAlert;
  const growthAbsolute = options.growthAbsolute ?? getGrowthAbsolute();
  const growthPercent = options.growthPercent ?? getGrowthPercent();
  const digest = computeAlertDigest(summary.flaggedItems);
  const flaggedItemRowIds = summary.flaggedItems.map((it) => it.itemRowId);
  if (loadLastAlert) {
    let lastAlert: LastAlertSnapshot | null = null;
    try {
      lastAlert = await loadLastAlert();
    } catch (err) {
      // Best-effort: a read failure must not silently suppress the
      // alert — let it through and log so we notice the de-dup table
      // is unreachable. Better a duplicate page than a missed real
      // spike during an outage.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Plaid malformed-token alert: failed to load last-alert digest, sending without de-dup",
      );
    }
    if (lastAlert) {
      const suppressReason = shouldSuppressDuplicateAlert({
        current: { digest, flaggedItemRowIds, flagged: summary.flagged },
        last: lastAlert,
        growthAbsolute,
        growthPercent,
      });
      if (suppressReason) {
        logger.info(
          {
            flagged: summary.flagged,
            scanned: summary.scanned,
            threshold,
            lastFlagged: lastAlert.flagged,
            lastSentAt: lastAlert.sentAt.toISOString(),
            digest,
          },
          "Plaid malformed-token spike alert suppressed (duplicate of prior alert)",
        );
        return {
          channel: "skipped",
          reason: suppressReason,
          recipient,
          error: null,
        };
      }
    }
  }
  const rendered = renderMalformedTokenAlert({
    scanned: summary.scanned,
    flagged: summary.flagged,
    flaggedItems: summary.flaggedItems,
    threshold,
    now: options.now,
  });
  const send = options.send ?? sendOperatorAlertEmail;
  try {
    const result = await send({
      to: recipient,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (!result.ok) {
      logger.warn(
        {
          recipient,
          flagged: summary.flagged,
          scanned: summary.scanned,
          err: result.error,
        },
        "Plaid malformed-token operator alert send failed",
      );
    } else if (recordAlert) {
      // (#396) Only persist on a successful send so a transient
      // SendGrid outage doesn't tombstone the spike and silence the
      // *next* day's retry — same idempotency logic the disconnect
      // reminder (#262) uses.
      try {
        await recordAlert({
          digest,
          flaggedItemRowIds,
          flagged: summary.flagged,
          scanned: summary.scanned,
          threshold,
          channel: result.channel,
          recipient,
        });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Plaid malformed-token alert: failed to persist de-dup digest (alert was sent)",
        );
      }
    }
    return {
      channel: result.channel,
      reason: null,
      recipient,
      error: result.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { recipient, err: message },
      "Plaid malformed-token operator alert threw unexpectedly",
    );
    return {
      channel: "skipped",
      reason: "exception",
      recipient,
      error: message,
    };
  }
}
