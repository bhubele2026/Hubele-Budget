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
export const PLAID_OPTIONAL_PRODUCTS = [Products.Liabilities];
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
