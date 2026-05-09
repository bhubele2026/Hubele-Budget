import { logger } from "./logger";
import {
  resolveOperatorRecipient,
  sendOperatorAlertEmail,
  type AlertChannel,
  type AlertResult,
  type SendOperatorAlertFn,
} from "./plaidMalformedTokenAlert";
import type { BackfillCleanedDetail } from "./plaidMalformedSiblingCleanup";

/**
 * (#551) Operator alert when the boot-time duplicate-bank cleanup
 * (#406) actually archives stale malformed-token rows.
 *
 * Today the (#406) backfill logs a single one-line summary on every
 * boot, so support has no way to confirm "yes, after the deploy we
 * cleaned 7 stale rows for real users" without grepping pino logs
 * that get rotated out within a day. Mirroring the malformed-token
 * spike alert (#371) channel — same SendGrid transport + same
 * recipient resolution — gives operators an email when work actually
 * happened, while keeping zero-cleanup boots completely silent.
 */

/**
 * Cap on how many cleaned rows are listed in the alert body.
 * Operators just need a representative sample to start verifying —
 * 200 lines doesn't help and SendGrid has body-size limits.
 */
const SAMPLE_DETAIL_LIMIT = 10;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type RenderedSiblingCleanupAlert = {
  subject: string;
  text: string;
  html: string;
};

/**
 * Build the operator alert body. Pure — no I/O — so the test can
 * assert the exact copy without standing up a transport.
 */
export function renderSiblingCleanupAlert(opts: {
  scannedMalformed: number;
  cleanedSiblings: number;
  skippedNoHealthySibling: number;
  cleanedDetails: BackfillCleanedDetail[];
  now?: Date;
}): RenderedSiblingCleanupAlert {
  const now = opts.now ?? new Date();
  const dateLabel = now.toISOString().slice(0, 10);
  const sample = opts.cleanedDetails.slice(0, SAMPLE_DETAIL_LIMIT);
  const overflow = opts.cleanedDetails.length - sample.length;
  const affectedUsers = new Set(opts.cleanedDetails.map((d) => d.userId)).size;

  const sampleLines = sample.map((d) => {
    const name = d.institutionName?.trim() || "(unknown institution)";
    return `  • ${name} [item ${d.itemId}] (user ${d.userId})`;
  });
  const sampleHtml = sample
    .map(
      (d) =>
        `<li><strong>${escapeHtml(d.institutionName?.trim() || "(unknown institution)")}</strong>` +
        ` <code>${escapeHtml(d.itemId)}</code>` +
        ` <span style="color:#666;">(user <code>${escapeHtml(d.userId)}</code>)</span></li>`,
    )
    .join("");
  const overflowText = overflow > 0 ? `\n  …and ${overflow} more` : "";
  const overflowHtml =
    overflow > 0
      ? `<p style="color:#666;font-size:13px;">…and ${overflow} more.</p>`
      : "";

  const subject =
    `[H2 ops] Boot cleanup archived ${opts.cleanedSiblings} duplicate Plaid item${opts.cleanedSiblings === 1 ? "" : "s"} ` +
    `(${dateLabel})`;
  const text =
    `The boot-time duplicate-bank cleanup (#406) archived ` +
    `${opts.cleanedSiblings} stale plaid_items row${opts.cleanedSiblings === 1 ? "" : "s"} ` +
    `across ${affectedUsers} user${affectedUsers === 1 ? "" : "s"} on the ${dateLabel} boot.\n\n` +
    `Scan summary:\n` +
    `  • scannedMalformed: ${opts.scannedMalformed}\n` +
    `  • cleanedSiblings: ${opts.cleanedSiblings}\n` +
    `  • skippedNoHealthySibling: ${opts.skippedNoHealthySibling}\n\n` +
    `Cleaned rows (sample):\n${sampleLines.join("\n")}${overflowText}\n\n` +
    `These were stale "broken Chase"-style duplicates with a healthy sibling for ` +
    `the same institution, so the affected users should no longer see the Reconnect ` +
    `CTA in Settings or the dashboard reauth banner. Subsequent boots stay silent ` +
    `until new duplicates appear.\n`;
  const html =
    `<p>The boot-time duplicate-bank cleanup (<strong>#406</strong>) archived ` +
    `<strong>${opts.cleanedSiblings}</strong> stale <code>plaid_items</code> ` +
    `row${opts.cleanedSiblings === 1 ? "" : "s"} across <strong>${affectedUsers}</strong> ` +
    `user${affectedUsers === 1 ? "" : "s"} on the <strong>${escapeHtml(dateLabel)}</strong> boot.</p>` +
    `<p><strong>Scan summary:</strong></p>` +
    `<ul>` +
    `<li><code>scannedMalformed</code>: ${opts.scannedMalformed}</li>` +
    `<li><code>cleanedSiblings</code>: ${opts.cleanedSiblings}</li>` +
    `<li><code>skippedNoHealthySibling</code>: ${opts.skippedNoHealthySibling}</li>` +
    `</ul>` +
    `<p><strong>Cleaned rows (sample):</strong></p>` +
    `<ul>${sampleHtml}</ul>${overflowHtml}` +
    `<p>These were stale "broken Chase"-style duplicates with a healthy sibling ` +
    `for the same institution, so the affected users should no longer see the ` +
    `Reconnect CTA in Settings or the dashboard reauth banner. Subsequent boots ` +
    `stay silent until new duplicates appear.</p>`;
  return { subject, text, html };
}

export type MaybeAlertOnSiblingCleanupOptions = {
  send?: SendOperatorAlertFn;
  now?: Date;
  recipient?: string | null;
};

/**
 * Decide whether the boot backfill summary warrants paging operators
 * and, if so, send the alert. Best-effort: any failure is logged but
 * never thrown — the boot path must never crash on a side-channel.
 *
 * Quiet path:
 *   * `cleanedSiblings === 0` → returns `{ channel: "skipped", reason: "nothing-cleaned" }`.
 *   * No recipient configured → `{ channel: "skipped", reason: "no-recipient" }`
 *     PLUS a loud warn so operators notice the misconfig.
 */
export async function maybeAlertOnSiblingCleanup(
  summary: {
    scannedMalformed: number;
    cleanedSiblings: number;
    skippedNoHealthySibling: number;
    cleanedDetails: BackfillCleanedDetail[];
  },
  options: MaybeAlertOnSiblingCleanupOptions = {},
): Promise<AlertResult> {
  if (summary.cleanedSiblings <= 0) {
    return {
      channel: "skipped" as AlertChannel,
      reason: "nothing-cleaned",
      recipient: null,
      error: null,
    };
  }
  const recipient =
    options.recipient !== undefined
      ? options.recipient
      : resolveOperatorRecipient();
  if (!recipient) {
    logger.warn(
      {
        cleanedSiblings: summary.cleanedSiblings,
        scannedMalformed: summary.scannedMalformed,
      },
      "Plaid sibling-cleanup boot alert: OPS_ALERT_EMAIL/OWNER_EMAIL is not set — alert not sent",
    );
    return {
      channel: "skipped" as AlertChannel,
      reason: "no-recipient",
      recipient: null,
      error: null,
    };
  }
  const rendered = renderSiblingCleanupAlert({
    scannedMalformed: summary.scannedMalformed,
    cleanedSiblings: summary.cleanedSiblings,
    skippedNoHealthySibling: summary.skippedNoHealthySibling,
    cleanedDetails: summary.cleanedDetails,
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
          cleanedSiblings: summary.cleanedSiblings,
          scannedMalformed: summary.scannedMalformed,
          err: result.error,
        },
        "Plaid sibling-cleanup boot alert send failed",
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
      "Plaid sibling-cleanup boot alert threw unexpectedly",
    );
    return {
      channel: "skipped" as AlertChannel,
      reason: "exception",
      recipient,
      error: message,
    };
  }
}
