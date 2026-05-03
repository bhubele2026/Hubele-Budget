import { and, eq } from "drizzle-orm";
import {
  db,
  plaidItemsTable,
  plaidAccountsTable,
} from "@workspace/db";
import { plaid } from "./plaid";

export type LiabilityRow = {
  accountId: string;
  kind: "credit" | "student" | "mortgage";
  balance: number | null;
  apr: number | null; // decimal, e.g. 0.1999
  minPayment: number | null;
};

function pickBestApr(aprs: Array<{ apr_percentage: number; apr_type?: string }> | undefined): number | null {
  if (!aprs || aprs.length === 0) return null;
  const purchase = aprs.find((a) => a.apr_type === "purchase_apr");
  if (purchase && purchase.apr_percentage > 0) return purchase.apr_percentage / 100;
  const max = aprs.reduce(
    (best, a) => (a.apr_percentage > best ? a.apr_percentage : best),
    0,
  );
  return max > 0 ? max / 100 : null;
}

export class PlaidLiabilitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidLiabilitiesError";
  }
}

export async function fetchLiabilitiesForItem(
  userId: string,
  itemRowId: string,
): Promise<LiabilityRow[]> {
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(
      and(eq(plaidItemsTable.id, itemRowId), eq(plaidItemsTable.userId, userId)),
    );
  if (!item) return [];
  let acctErr: unknown = null;
  let liabErr: unknown = null;
  // Always fetch latest balances via /accounts/get so debt-like accounts
  // that aren't returned by /liabilities/get (e.g. unsupported subtypes,
  // generic loans) still get a fresh balance.
  let acctResp;
  try {
    acctResp = await plaid().accountsGet({ access_token: item.accessToken });
  } catch (e) {
    acctResp = null;
    acctErr = e;
  }
  let resp = null as Awaited<ReturnType<ReturnType<typeof plaid>["liabilitiesGet"]>> | null;
  try {
    resp = await plaid().liabilitiesGet({ access_token: item.accessToken });
  } catch (e) {
    resp = null;
    liabErr = e;
  }
  if (!acctResp && !resp) {
    throw new PlaidLiabilitiesError(
      `Plaid fetch failed: ${String(acctErr ?? liabErr)}`,
    );
  }
  const liab = resp?.data.liabilities;
  const accountsById = new Map(
    (acctResp?.data.accounts ?? resp?.data.accounts ?? []).map((a) => [
      a.account_id,
      a,
    ]),
  );
  const debtSubtypes = new Set([
    "credit card",
    "paypal",
    "line of credit",
    "student",
    "mortgage",
    "home equity",
    "auto",
    "loan",
    "commercial",
    "construction",
    "consumer",
    "overdraft",
  ]);
  const now = new Date();

  // Step 1: refresh balance for every debt-like account.
  for (const a of accountsById.values()) {
    const sub = (a.subtype ?? "").toLowerCase();
    const isDebt = a.type === "credit" || a.type === "loan" || debtSubtypes.has(sub);
    if (!isDebt) continue;
    const bal = a.balances?.current;
    if (bal == null) continue;
    await db
      .update(plaidAccountsTable)
      .set({
        liabilityBalance: bal.toFixed(2),
        liabilityLastFetchedAt: now,
      })
      .where(
        and(
          eq(plaidAccountsTable.userId, userId),
          eq(plaidAccountsTable.accountId, a.account_id),
        ),
      );
  }

  // Step 2: enrich with APR + min payment from /liabilities/get when present.
  const out: LiabilityRow[] = [];
  if (!liab) return out;

  for (const c of liab.credit ?? []) {
    if (!c.account_id) continue;
    const acc = accountsById.get(c.account_id);
    out.push({
      accountId: c.account_id,
      kind: "credit",
      balance: acc?.balances?.current ?? null,
      apr: pickBestApr(c.aprs),
      minPayment: c.minimum_payment_amount ?? null,
    });
  }
  for (const s of liab.student ?? []) {
    if (!s.account_id) continue;
    const acc = accountsById.get(s.account_id);
    const aprPct = (s as { interest_rate_percentage?: number }).interest_rate_percentage;
    out.push({
      accountId: s.account_id,
      kind: "student",
      balance: acc?.balances?.current ?? null,
      apr: aprPct != null ? aprPct / 100 : null,
      minPayment: s.minimum_payment_amount ?? null,
    });
  }
  for (const m of liab.mortgage ?? []) {
    if (!m.account_id) continue;
    const acc = accountsById.get(m.account_id);
    const irPct = m.interest_rate?.percentage;
    out.push({
      accountId: m.account_id,
      kind: "mortgage",
      balance: acc?.balances?.current ?? null,
      apr: irPct != null ? irPct / 100 : null,
      minPayment: m.next_monthly_payment ?? null,
    });
  }

  for (const r of out) {
    // Balance was already cached in Step 1 from /accounts/get; here we only
    // enrich kind/APR/min payment so a missing field doesn't clobber state.
    const patch: Record<string, unknown> = {
      liabilityKind: r.kind,
      liabilityLastFetchedAt: now,
    };
    if (r.apr != null) patch.liabilityApr = r.apr.toFixed(4);
    if (r.minPayment != null)
      patch.liabilityMinPayment = r.minPayment.toFixed(2);
    await db
      .update(plaidAccountsTable)
      .set(patch)
      .where(
        and(
          eq(plaidAccountsTable.userId, userId),
          eq(plaidAccountsTable.accountId, r.accountId),
        ),
      );
  }
  return out;
}

export async function fetchLiabilitiesForUser(
  userId: string,
): Promise<LiabilityRow[]> {
  const items = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, userId));
  const out: LiabilityRow[] = [];
  for (const it of items) {
    const rows = await fetchLiabilitiesForItem(userId, it.id);
    out.push(...rows);
  }
  return out;
}
