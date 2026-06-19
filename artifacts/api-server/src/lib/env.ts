/**
 * Centralized, fail-fast environment configuration. (8-phase plan, Phase 1.)
 *
 *   - `env`           — a typed, coerced snapshot, safe to import anywhere.
 *                       The parse NEVER throws (no enum/range refinements), so
 *                       importing this module can't crash the process.
 *   - `validateEnv()` — the strict boot gate. Enforces ONLY what the original
 *                       boot path enforced — PORT (present + positive) and the
 *                       Plaid production / all-or-nothing rules — and throws a
 *                       single aggregated, readable error. DATABASE_URL is
 *                       validated by the db package itself; Clerk keys are
 *                       handled by the Clerk middleware — neither is forced
 *                       here, so this gate can't break a previously-booting
 *                       deploy.
 *
 * Money is never read here. Keep this module dependency-light (zod only).
 */
import { z } from "zod";

/** "true"/"1"/"yes"/"on" → true; everything else (incl. unset) → false. */
const boolish = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return false;
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  });

/**
 * Optional number from a string env var. NEVER throws — blank/non-numeric →
 * undefined. No range refinement: env vars like `*_MS=0` are legitimate and
 * must not crash boot. (Range checks that matter, e.g. PORT, live in
 * validateEnv.)
 */
const intish = z
  .string()
  .optional()
  .transform((v) => {
    if (v == null || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  });

const PLAID_ENVS = ["sandbox", "development", "production"] as const;

/**
 * Lenient schema for the always-importable `env` snapshot. Every field is
 * optional/coerced and NOTHING throws on parse (PLAID_ENV is a plain string
 * here; its allowed values are checked in validateEnv, not at parse time).
 */
const lenient = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: intish,
  DATABASE_URL: z.string().optional(),
  APP_URL: z.string().optional(),
  INVITATION_REDIRECT_URL: z.string().optional(),
  LOG_LEVEL: z.string().optional(),

  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ADVISOR_ENABLED: boolish,
  ADVISOR_MODEL: z.string().optional(),

  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().optional(),
  OWNER_EMAIL: z.string().optional(),
  OPS_ALERT_EMAIL: z.string().optional(),

  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_ENV: z.string().optional(),
  PLAID_REDIRECT_URI: z.string().optional(),
  PLAID_WEBHOOK_URL: z.string().optional(),
  PLAID_OPTIONAL_PRODUCTS_CSV: z.string().optional(),
  PLAID_AUTO_SYNC_ENABLED: boolish,
  PLAID_FREQUENT_REFRESH_ENABLED: boolish,
  PLAID_FREQUENT_REFRESH_CRON: z.string().optional(),
  PLAID_WEBHOOK_VERIFICATION_DISABLED: boolish,
  PLAID_SYNC_DEBOUNCE_MS: intish,
  PLAID_SYNC_GRACE_DEBOUNCE_MS: intish,
  PLAID_SYNC_GRACE_WINDOW_MS: intish,
  PLAID_REFRESH_POLL_ATTEMPTS: intish,

  ENABLE_APRIL_CHASE_SEED: boolish,
  APRIL_CHASE_SEED_HOUSEHOLD_ALLOWLIST: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof lenient>;

/**
 * Typed, coerced snapshot of the environment. Safe to import anywhere; the
 * parse cannot throw. Prefer this over raw `process.env.X` reads.
 */
export const env: Env = lenient.safeParse(process.env).data ?? lenient.parse({});

/**
 * Strict boot gate. Throws a single aggregated error if PORT is missing/invalid
 * or Plaid is misconfigured. Mirrors the ORIGINAL boot validation exactly — it
 * does not add new required vars, so it cannot break a deploy that booted
 * before. Plaid rules:
 *   - production: PLAID_CLIENT_ID + PLAID_SECRET + PLAID_ENV all required, and
 *     PLAID_ENV must be "production" (never serve sandbox data live).
 *   - non-production: all-or-nothing — set all three or none.
 */
export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const problems: string[] = [];

  const rawPort = raw.PORT;
  if (!rawPort || rawPort.trim() === "") {
    problems.push("  - PORT is required");
  } else if (!(Number(rawPort) > 0)) {
    problems.push(`  - PORT must be a positive integer (got "${rawPort}")`);
  }

  const isProd = (raw.NODE_ENV ?? "development") === "production";
  const anyPlaid = raw.PLAID_CLIENT_ID || raw.PLAID_SECRET || raw.PLAID_ENV;
  if (isProd) {
    if (!raw.PLAID_CLIENT_ID || !raw.PLAID_SECRET || !raw.PLAID_ENV) {
      problems.push(
        "  - Plaid is required in production: set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV",
      );
    } else if (raw.PLAID_ENV !== "production") {
      problems.push(
        `  - PLAID_ENV must be "production" when NODE_ENV=production (got "${raw.PLAID_ENV}")`,
      );
    }
  } else if (anyPlaid) {
    if (!raw.PLAID_CLIENT_ID || !raw.PLAID_SECRET || !raw.PLAID_ENV) {
      problems.push(
        "  - Plaid is partially configured: set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV together, or none",
      );
    } else if (
      !PLAID_ENVS.includes(raw.PLAID_ENV as (typeof PLAID_ENVS)[number])
    ) {
      problems.push(
        `  - PLAID_ENV must be one of ${PLAID_ENVS.join(", ")} (got "${raw.PLAID_ENV}")`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration — fix the following before boot:\n${problems.join("\n")}`,
    );
  }

  return lenient.parse(raw);
}
