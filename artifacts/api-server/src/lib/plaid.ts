import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";
import type { Transaction as PlaidTxn, RemovedTransaction } from "plaid";

export const PLAID_VALID_ENVS = ["sandbox", "development", "production"] as const;
export type PlaidEnv = (typeof PLAID_VALID_ENVS)[number];

/**
 * (#366) Centralized guard for the shape of a stored Plaid access token.
 *
 * Plaid mints tokens of the form `access-<env>-<opaque>` where `<env>` is
 * one of the three PLAID_VALID_ENVS values and `<opaque>` is a non-empty
 * URL-safe blob (alphanumerics + hyphens). Any other shape — empty,
 * truncated, JSON-stringified, base64, etc. — has been seen in the wild
 * after env-mismatch incidents and earlier write-path bugs. Sending such
 * a value to /transactions/sync produces an opaque Plaid 400 that the
 * Settings → Linked Banks chip surfaces verbatim, which is both
 * unactionable for users and noisy for support.
 *
 * Every read/write site that touches `plaid_items.access_token` must
 * call this guard FIRST and short-circuit on `false` instead of calling
 * Plaid. The synthetic "needs reconnect" handling lives in plaidSync.ts
 * (`markItemMalformedToken` + `synthesizeMalformedTokenSyncResult`).
 */
// (#367) Plaid documents access tokens as opaque strings. The original
// `[A-Za-z0-9-]+` suffix was over-strict — real tokens containing
// underscores were being flagged "malformed", trapping users in a
// reconnect loop. The intermediate fix added a forbidden-character
// blocklist on top, but that still second-guesses Plaid's contract and
// would mis-flag any future token shape that happens to include `.` /
// `/` / `+` / `=` etc. (think base64 padding, URL-safe encodings).
// The guard's only job is to reject *clearly broken* shapes that we've
// actually seen poison rows from: empty values, wrong env segment,
// JSON-stringified-with-quotes, whitespace, control chars, multi-line.
// Anything that matches the prefix and is otherwise printable ASCII
// without whitespace is treated as opaque and accepted.
const PLAID_ACCESS_TOKEN_RE =
  /^access-(sandbox|development|production)-[!-~]+$/;

export function isValidPlaidAccessToken(
  token: string | null | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  return PLAID_ACCESS_TOKEN_RE.test(token);
}

/**
 * (#366) Friendly chip + toast copy used everywhere a malformed token is
 * caught by the guard. Mirrors the per-code reason rendered in the
 * frontend `PLAID_REAUTH_ERROR_REASONS["ITEM_LOGIN_REQUIRED"]` so the
 * user gets a single consistent "reconnect" CTA — never a leaked Plaid
 * 400 string.
 */
export const MALFORMED_PLAID_TOKEN_MESSAGE =
  "Stored Plaid credential is malformed — please reconnect this bank.";

/**
 * (#654) Friendlier chip + toast copy for the specific case where a
 * stored access token is well-formed but was issued for a different
 * Plaid environment than the server is currently running against
 * (e.g. an `access-sandbox-…` token while `PLAID_ENV=production`).
 * Plaid will reject every product call against such a token with
 * `INVALID_ACCESS_TOKEN`, so the only path forward is for the user to
 * reconnect via Plaid Link in the active environment. Worded so the
 * user sees what to do, not the env names (which leak infra details
 * a non-technical user can't act on anyway).
 */
export const ENV_MISMATCH_PLAID_TOKEN_MESSAGE =
  "This bank was linked from a different Plaid environment — please reconnect to refresh.";

/**
 * (#654) Pull the env segment out of a Plaid access token. Returns
 * `null` for any value that doesn't match the documented
 * `access-<env>-<opaque>` shape, including empty / non-string / wrong
 * env. Used by `isAccessTokenForCurrentEnv` to short-circuit syncs
 * before they ever reach Plaid when the stored token's env doesn't
 * match `PLAID_ENV`.
 */
export function accessTokenEnv(
  token: string | null | undefined,
): PlaidEnv | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const m = PLAID_ACCESS_TOKEN_RE.exec(token);
  if (!m) return null;
  return m[1] as PlaidEnv;
}

/**
 * (#654) True when `token` is well-formed AND its embedded env
 * (sandbox/development/production) matches the server's active
 * `PLAID_ENV`. False for malformed tokens, env mismatches, and any
 * value that fails `isValidPlaidAccessToken`. Callers should treat
 * `false` as "do not call Plaid; mark the item for reconnect" — even
 * a well-formed env-mismatched token will produce
 * `INVALID_ACCESS_TOKEN` on every product call until the user
 * re-links the bank in the active environment.
 */
export function isAccessTokenForCurrentEnv(
  token: string | null | undefined,
): boolean {
  const env = accessTokenEnv(token);
  if (!env) return false;
  return env === getPlaidEnv();
}

/**
 * (#398) Sentinel access_token written by the April-2026 Chase seed
 * (`aprilChaseSeed.ts`) to anchor the bank-snapshot tile when the user
 * has not yet completed real Plaid OAuth. Synthetic seed rows are not
 * real Plaid connections — they exist only as a foreign-key target
 * for plaid_accounts so the dashboard snapshot has a stable home.
 *
 * Combined with `isSyntheticPlaidItem` below, every code path that
 * would otherwise try to call Plaid with this value (sync sweep,
 * /transactions/sync, consent /item/get, daily malformed-token
 * scan) silently skips these rows. They never appear in /plaid/items
 * either, so the reauth banner / "needs reconnecting" chip cannot
 * fire on a row that was never a real connection in the first place.
 */
export const SYNTHETIC_PLAID_ACCESS_TOKEN_SENTINEL = "synthetic-no-access";

/**
 * Identifies a synthetic seed row (Chase placeholder created by
 * aprilChaseSeed.ts before the user has completed real Plaid OAuth).
 * Two independent signals so cleanup of either column alone still
 * classifies the row correctly:
 *   - `itemId` text starts with `seed-` (matches SYNTHETIC_ITEM_ID
 *     constants in seed scripts), OR
 *   - `accessToken` equals SYNTHETIC_PLAID_ACCESS_TOKEN_SENTINEL.
 */
export function isSyntheticPlaidItem(
  item: { itemId: string | null | undefined; accessToken: string | null | undefined },
): boolean {
  const id = item.itemId ?? "";
  const tok = item.accessToken ?? "";
  return id.startsWith("seed-") || tok === SYNTHETIC_PLAID_ACCESS_TOKEN_SENTINEL;
}

export function getPlaidEnv(): PlaidEnv {
  const raw = process.env.PLAID_ENV;
  if (!raw) {
    throw new Error(
      "PLAID_ENV is required. Set it to one of: sandbox, development, production.",
    );
  }
  const env = raw.toLowerCase() as PlaidEnv;
  if (!(PLAID_VALID_ENVS as readonly string[]).includes(env)) {
    throw new Error(
      `PLAID_ENV="${raw}" is invalid. Must be one of: ${PLAID_VALID_ENVS.join(", ")}.`,
    );
  }
  return env;
}

export function isPlaidConfigured(): boolean {
  return Boolean(
    process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && process.env.PLAID_ENV,
  );
}

let _client: PlaidApi | null = null;

export function plaid(): PlaidApi {
  if (_client) return _client;
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error(
      "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET (and PLAID_ENV) in Secrets.",
    );
  }
  const env = getPlaidEnv();
  const basePath = PlaidEnvironments[env];
  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
        "Plaid-Version": "2020-09-14",
      },
    },
  });
  _client = new PlaidApi(config);
  return _client;
}

export const PLAID_PRODUCTS = [Products.Transactions];

// Optional products are only requested when this Plaid client is approved
// for them. Plaid hard-fails /link/token/create with INVALID_PRODUCT even
// when a product is listed as *optional* if the calling client isn't
// approved for it (e.g. liabilities requires manual approval in the Plaid
// Dashboard). Default to none so bank-only Link flows succeed; opt in via
// the PLAID_OPTIONAL_PRODUCTS_CSV env var (e.g. "liabilities") once the
// product is approved on the Plaid client. Unknown product names are
// silently dropped so a typo can't break Link.
const VALID_OPTIONAL_PRODUCT_NAMES = new Set<string>(
  Object.values(Products) as string[],
);
export function parseOptionalProductsFromEnv(): Products[] {
  const raw = process.env.PLAID_OPTIONAL_PRODUCTS_CSV?.trim();
  if (!raw) return [];
  const out: Products[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (VALID_OPTIONAL_PRODUCT_NAMES.has(name)) {
      out.push(name as Products);
    }
  }
  return out;
}
export const PLAID_OPTIONAL_PRODUCTS: Products[] = parseOptionalProductsFromEnv();
export const PLAID_COUNTRY_CODES = [CountryCode.Us];

export type { PlaidTxn, RemovedTransaction };

const SLUG_OVERRIDES: Record<string, string> = {
  "american express": "amex",
  "amex": "amex",
};

export function institutionSlug(name: string | null | undefined): string {
  if (!name) return "bank";
  const lower = name.toLowerCase().trim();
  for (const [needle, slug] of Object.entries(SLUG_OVERRIDES)) {
    if (lower.includes(needle)) return slug;
  }
  return lower
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "bank";
}
