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

export type MaybeAlertOptions = {
  send?: SendOperatorAlertFn;
  now?: Date;
  threshold?: number;
  recipient?: string | null;
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
