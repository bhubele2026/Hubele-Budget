/**
 * Centralized, fail-fast environment configuration. (8-phase plan, Phase 1.)
 *
 * Before this module, ~70 `process.env.X` reads were scattered across the
 * server and only Plaid was validated at boot — a typo'd or missing var
 * surfaced as a confusing failure on the first request that happened to
 * need it. Here we parse `process.env` once, with a single Zod schema, so:
 *
 *   - `env`           — a typed, coerced snapshot, safe to import anywhere.
 *                       Lenient on purpose so importing it (incl. in tests)
 *                       never throws; numeric/boolean coercion happens here.
 *   - `validateEnv()` — the strict boot gate. Aggregates EVERY missing or
 *                       invalid required var into one readable error and
 *                       throws. Call this once, at server boot, BEFORE
 *                       `app.listen`. A bad config fails at boot, not on the
 *                       first request.
 *
 * Money is never read here. Keep this module dependency-light (zod only).
 */
import { z } from "zod";

/** "true"/"1"/"yes" → true; everything else (incl. unset) → false. */
const boolish = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return false;
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  });

/** Optional positive integer from a string env var. */
const intish = z
  .string()
  .optional()
  .transform((v) => (v == null || v.trim() === "" ? undefined : Number(v)))
  .refine((v) => v == null || (Number.isFinite(v) && v > 0), {
    message: "must be a positive integer",
  });

const PLAID_ENVS = ["sandbox", "development", "production"] as const;

/**
 * Lenient schema — used for the always-importable `env` snapshot. Required
 * invariants are enforced separately in `validateEnv()` so that importing
 * `env` (e.g. from a unit test that pulls in a route) never explodes.
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
  PLAID_ENV: z.enum(PLAID_ENVS).optional(),
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

  // Error monitoring (Phase 1 follow-up). Absent → monitoring disabled.
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof lenient>;

/**
 * Typed, coerced snapshot of the environment. Safe to import anywhere; does
 * NOT enforce required-ness (that's `validateEnv`). Prefer this over raw
 * `process.env.X` reads so coercion/typing is consistent.
 */
export const env: Env = lenient.parse(process.env);

/**
 * Strict boot gate. Throws a single aggregated error naming every missing or
 * invalid required var. Plaid rules mirror the historical boot behavior:
 *   - production: PLAID_CLIENT_ID + PLAID_SECRET + PLAID_ENV all required,
 *     and PLAID_ENV must be "production" (never serve sandbox data live).
 *   - non-production: all-or-nothing — set all three or none.
 */
export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const problems: string[] = [];

  const require = (key: keyof Env, why?: string) => {
    const v = raw[key as string];
    if (!v || v.trim() === "") {
      problems.push(`  - ${key} is required${why ? ` (${why})` : ""}`);
    }
  };

  require("DATABASE_URL", "Postgres connection string");
  require("CLERK_PUBLISHABLE_KEY", "auth");
  require("CLERK_SECRET_KEY", "auth");

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
        `  - PLAID_ENV must be "production" when NODE_ENV=production (got "${raw.PLAID_ENV}") — refusing to serve sandbox data live`,
      );
    }
  } else if (anyPlaid) {
    if (!raw.PLAID_CLIENT_ID || !raw.PLAID_SECRET || !raw.PLAID_ENV) {
      problems.push(
        "  - Plaid is partially configured: set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV together, or none",
      );
    } else if (!PLAID_ENVS.includes(raw.PLAID_ENV as (typeof PLAID_ENVS)[number])) {
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
