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
function parseOptionalProductsFromEnv(): Products[] {
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
