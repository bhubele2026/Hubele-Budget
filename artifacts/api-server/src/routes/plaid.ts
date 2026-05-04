import { Router, type IRouter } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  plaidItemsTable,
  plaidAccountsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  plaid,
  PLAID_PRODUCTS,
  PLAID_OPTIONAL_PRODUCTS,
  PLAID_COUNTRY_CODES,
  institutionSlug,
  getPlaidEnv,
  isPlaidConfigured,
} from "../lib/plaid";

// Plaid issues access tokens prefixed with the environment they were
// minted in (e.g. `access-sandbox-...`, `access-development-...`,
// `access-production-...`). We use that prefix to detect which existing
// `plaid_items` rows came from a non-production environment so they can
// be cleaned up after the production cutover.
export function tokenEnv(token: string | null | undefined): string | null {
  if (!token) return null;
  const m = /^access-([^-]+)-/.exec(token);
  return m ? m[1].toLowerCase() : null;
}
import { syncPlaidItem, syncAllForUser } from "../lib/plaidSync";
import { fetchLiabilitiesForUser } from "../lib/plaidLiabilities";
import { debtsTable } from "@workspace/db";

const router: IRouter = Router();

router.post("/plaid/link-token", requireAuth, async (req, res): Promise<void> => {
  try {
    const redirectUri = process.env.PLAID_REDIRECT_URI?.trim();
    const resp = await plaid().linkTokenCreate({
      user: { client_user_id: req.userId! },
      client_name: "H2 Family Budget",
      products: PLAID_PRODUCTS,
      // Only include the field when there is at least one optional
      // product configured — Plaid rejects an empty array on some
      // versions of the API.
      ...(PLAID_OPTIONAL_PRODUCTS.length > 0
        ? { optional_products: PLAID_OPTIONAL_PRODUCTS }
        : {}),
      country_codes: PLAID_COUNTRY_CODES,
      language: "en",
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });
    res.json({
      linkToken: resp.data.link_token,
      expiration: resp.data.expiration,
    });
  } catch (e) {
    // Surface Plaid's structured error to the client so the toast on the
    // page shows the real reason (e.g. "Your account is not enabled for
    // liabilities") instead of a generic axios "Request failed with
    // status code 400" message.
    const ax = e as { response?: { data?: { error_code?: string; error_message?: string } } };
    const plaidCode = ax?.response?.data?.error_code;
    const plaidMsg = ax?.response?.data?.error_message;
    const msg = plaidMsg ?? (e instanceof Error ? e.message : "Plaid error");
    req.log.error({ err: e }, "Plaid link token failed");
    res.status(500).json({
      error: msg,
      ...(plaidCode ? { code: plaidCode } : {}),
    });
  }
});

// Plaid error codes that indicate the only fix is for the user to
// re-authenticate the bank via Plaid Link in update mode. The frontend
// keys off this set to decide when to render the "Reconnect" button.
export const PLAID_REAUTH_ERROR_CODES = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
]);

router.post(
  "/plaid/link-token/update",
  requireAuth,
  async (req, res): Promise<void> => {
    const { itemId } = req.body ?? {};
    if (!itemId || typeof itemId !== "string") {
      res.status(400).json({ error: "itemId is required" });
      return;
    }
    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.id, itemId),
          eq(plaidItemsTable.userId, req.userId!),
        ),
      );
    if (!item) {
      res.status(404).json({ error: "Plaid item not found" });
      return;
    }
    try {
      const redirectUri = process.env.PLAID_REDIRECT_URI?.trim();
      const resp = await plaid().linkTokenCreate({
        user: { client_user_id: req.userId! },
        client_name: "H2 Family Budget",
        // Update mode: pass the existing access_token, omit `products`.
        access_token: item.accessToken,
        country_codes: PLAID_COUNTRY_CODES,
        language: "en",
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      });
      res.json({
        linkToken: resp.data.link_token,
        expiration: resp.data.expiration,
      });
    } catch (e) {
      const ax = e as {
        response?: { data?: { error_code?: string; error_message?: string } };
      };
      const plaidCode = ax?.response?.data?.error_code;
      const plaidMsg = ax?.response?.data?.error_message;
      const msg = plaidMsg ?? (e instanceof Error ? e.message : "Plaid error");
      req.log.error({ err: e }, "Plaid update link token failed");
      res.status(500).json({
        error: msg,
        ...(plaidCode ? { code: plaidCode } : {}),
      });
    }
  },
);

router.post("/plaid/exchange", requireAuth, async (req, res): Promise<void> => {
  const { publicToken, institutionId, institutionName } = req.body ?? {};
  if (!publicToken || typeof publicToken !== "string") {
    res.status(400).json({ error: "publicToken is required" });
    return;
  }
  try {
    const exch = await plaid().itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = exch.data.access_token;
    const itemId = exch.data.item_id;

    let resolvedName: string | null =
      typeof institutionName === "string" ? institutionName : null;
    let resolvedInstId: string | null =
      typeof institutionId === "string" ? institutionId : null;
    try {
      const itemResp = await plaid().itemGet({ access_token: accessToken });
      resolvedInstId = itemResp.data.item.institution_id ?? resolvedInstId;
      if (resolvedInstId && !resolvedName) {
        const inst = await plaid().institutionsGetById({
          institution_id: resolvedInstId,
          country_codes: PLAID_COUNTRY_CODES,
        });
        resolvedName = inst.data.institution.name;
      }
    } catch (e) {
      req.log.warn({ err: e }, "Could not resolve institution metadata");
    }

    const slug = institutionSlug(resolvedName);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: req.userId!,
        itemId,
        accessToken,
        institutionId: resolvedInstId,
        institutionName: resolvedName,
        institutionSlug: slug,
      })
      .onConflictDoUpdate({
        target: plaidItemsTable.itemId,
        set: {
          accessToken,
          institutionId: resolvedInstId,
          institutionName: resolvedName,
          institutionSlug: slug,
        },
      })
      .returning();

    // Pull and persist accounts
    try {
      const acctResp = await plaid().accountsGet({ access_token: accessToken });
      for (const a of acctResp.data.accounts) {
        await db
          .insert(plaidAccountsTable)
          .values({
            userId: req.userId!,
            itemId: item!.id,
            accountId: a.account_id,
            name: a.name ?? null,
            officialName: a.official_name ?? null,
            mask: a.mask ?? null,
            type: a.type ?? null,
            subtype: a.subtype ?? null,
          })
          .onConflictDoUpdate({
            target: plaidAccountsTable.accountId,
            set: {
              itemId: item!.id,
              name: a.name ?? null,
              officialName: a.official_name ?? null,
              mask: a.mask ?? null,
              type: a.type ?? null,
              subtype: a.subtype ?? null,
            },
          });
      }
    } catch (e) {
      req.log.warn({ err: e }, "accountsGet failed");
    }

    // Initial sync (last 90 days come via /transactions/sync naturally)
    await syncPlaidItem(req.userId!, item!.id);

    // Auto-create debts for newly linked credit/loan accounts (#44)
    try {
      const newAccts = await db
        .select()
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.itemId, item!.id));
      const existingDebts = await db
        .select({ plaidAccountId: debtsTable.plaidAccountId })
        .from(debtsTable)
        .where(eq(debtsTable.userId, req.userId!));
      const linkedAcctIds = new Set(
        existingDebts.map((d) => d.plaidAccountId).filter(Boolean),
      );
      for (const acct of newAccts) {
        if (linkedAcctIds.has(acct.id)) continue;
        const t = (acct.type ?? "").toLowerCase();
        const st = (acct.subtype ?? "").toLowerCase();
        if (t !== "credit" && t !== "loan" && st !== "credit card") continue;
        await db.insert(debtsTable).values({
          userId: req.userId!,
          name: acct.officialName || acct.name || `${resolvedName ?? "Plaid"} ${acct.mask ?? ""}`.trim(),
          balance: "0",
          apr: "0",
          minPayment: "0",
          status: "active",
          plaidAccountId: acct.id,
        });
        req.log.info({ accountId: acct.accountId, name: acct.name }, "Auto-created debt from Plaid account");
      }
    } catch (e) {
      req.log.warn({ err: e }, "Auto-create debts failed (non-fatal)");
    }

    const accounts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.itemId, item!.id));

    res.json({
      id: item!.id,
      itemId: item!.itemId,
      institutionId: item!.institutionId,
      institutionName: item!.institutionName,
      institutionSlug: item!.institutionSlug,
      lastSyncedAt: item!.lastSyncedAt
        ? item!.lastSyncedAt.toISOString()
        : new Date().toISOString(),
      lastSyncError: null,
      lastSyncErrorCode: null,
      accounts: accounts.map((a) => ({
        id: a.id,
        accountId: a.accountId,
        name: a.name,
        officialName: a.officialName,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Plaid exchange failed";
    req.log.error({ err: e }, "Plaid exchange error");
    res.status(500).json({ error: msg });
  }
});

router.get("/plaid/items", requireAuth, async (req, res): Promise<void> => {
  const items = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, req.userId!));
  const accts = await db
    .select()
    .from(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, req.userId!));
  const byItem = new Map<string, typeof accts>();
  for (const a of accts) {
    const arr = byItem.get(a.itemId) ?? [];
    arr.push(a);
    byItem.set(a.itemId, arr);
  }
  res.json(
    items.map((it) => ({
      id: it.id,
      itemId: it.itemId,
      institutionId: it.institutionId,
      institutionName: it.institutionName,
      institutionSlug: it.institutionSlug,
      lastSyncedAt: it.lastSyncedAt ? it.lastSyncedAt.toISOString() : null,
      lastSyncError: it.lastSyncError,
      lastSyncErrorCode: it.lastSyncErrorCode,
      stillPreparing: it.stillPreparingSince != null,
      stillPreparingSince: it.stillPreparingSince
        ? it.stillPreparingSince.toISOString()
        : null,
      accounts: (byItem.get(it.id) ?? []).map((a) => ({
        id: a.id,
        accountId: a.accountId,
        name: a.name,
        officialName: a.officialName,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
      })),
    })),
  );
});

router.delete("/plaid/items/:id", requireAuth, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(
      and(eq(plaidItemsTable.id, id), eq(plaidItemsTable.userId, req.userId!)),
    );
  if (!item) {
    res.sendStatus(204);
    return;
  }
  try {
    await plaid().itemRemove({ access_token: item.accessToken });
  } catch (e) {
    req.log.warn({ err: e }, "Plaid itemRemove failed");
  }
  // Reset source flags on any debts linked to accounts under this item.
  // The FK on debts.plaid_account_id has ON DELETE SET NULL, so the link
  // itself is cleared automatically; we just need to flip Plaid-sourced
  // fields back to manual so they no longer display Plaid badges/timestamps.
  const itemAccounts = await db
    .select({ id: plaidAccountsTable.id })
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.itemId, item.id),
        eq(plaidAccountsTable.userId, req.userId!),
      ),
    );
  const itemAcctIds = itemAccounts.map((a) => a.id);
  if (itemAcctIds.length > 0) {
    await db
      .update(debtsTable)
      .set({
        balanceSource: "manual",
        aprSource: "manual",
        minPaymentSource: "manual",
        plaidLastSyncedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(debtsTable.userId, req.userId!),
          inArray(debtsTable.plaidAccountId, itemAcctIds),
        ),
      );
  }
  await db
    .delete(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.itemId, item.id),
        eq(plaidAccountsTable.userId, req.userId!),
      ),
    );
  await db
    .delete(plaidItemsTable)
    .where(
      and(eq(plaidItemsTable.id, item.id), eq(plaidItemsTable.userId, req.userId!)),
    );
  res.sendStatus(204);
});

router.get(
  "/plaid/liability-accounts",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const refresh = String(req.query.refresh ?? "") === "true";
    if (refresh) {
      try {
        await fetchLiabilitiesForUser(userId);
      } catch (e) {
        req.log.warn({ err: e }, "fetchLiabilitiesForUser failed");
      }
    } else {
      // Opportunistic refresh if we have no cached liability data yet.
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.userId, userId),
            sql`${plaidAccountsTable.liabilityLastFetchedAt} is not null`,
          ),
        );
      if (Number(count ?? 0) === 0) {
        try {
          await fetchLiabilitiesForUser(userId);
        } catch (e) {
          req.log.warn({ err: e }, "initial liabilities fetch failed");
        }
      }
    }

    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, userId));
    const itemById = new Map(items.map((i) => [i.id, i]));
    const accts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, userId));
    const linkedDebts = await db
      .select({ id: debtsTable.id, name: debtsTable.name, plaidAccountId: debtsTable.plaidAccountId })
      .from(debtsTable)
      .where(eq(debtsTable.userId, userId));
    const linkedByAcct = new Map(
      linkedDebts
        .filter((d) => d.plaidAccountId)
        .map((d) => [d.plaidAccountId!, { id: d.id, name: d.name }]),
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
    const looksLikeDebt = (a: typeof accts[number]) => {
      if (a.liabilityKind) return true;
      if (a.type === "credit" || a.type === "loan") return true;
      const sub = (a.subtype ?? "").toLowerCase();
      return debtSubtypes.has(sub);
    };

    res.json(
      accts.filter(looksLikeDebt).map((a) => {
        const item = itemById.get(a.itemId);
        const linked = linkedByAcct.get(a.id);
        return {
          id: a.id,
          accountId: a.accountId,
          name: a.name,
          officialName: a.officialName,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          liabilityKind: a.liabilityKind,
          balance: a.liabilityBalance,
          apr: a.liabilityApr,
          minPayment: a.liabilityMinPayment,
          lastFetchedAt: a.liabilityLastFetchedAt
            ? a.liabilityLastFetchedAt.toISOString()
            : null,
          institutionId: item?.institutionId ?? null,
          institutionName: item?.institutionName ?? null,
          institutionSlug: item?.institutionSlug ?? null,
          linkedDebt: linked ?? null,
        };
      }),
    );
  },
);

router.get("/plaid/environment", requireAuth, async (req, res): Promise<void> => {
  let env: string | null = null;
  let configured = false;
  let configError: string | null = null;
  try {
    configured = isPlaidConfigured();
    if (configured) env = getPlaidEnv();
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
  }
  const items = await db
    .select({ id: plaidItemsTable.id, accessToken: plaidItemsTable.accessToken, institutionName: plaidItemsTable.institutionName })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, req.userId!));
  const nonProdItems = items
    .map((it) => ({ id: it.id, institutionName: it.institutionName, env: tokenEnv(it.accessToken) }))
    .filter((it) => it.env !== null && it.env !== "production");
  res.json({
    env,
    configured,
    configError,
    nonProdItemCount: nonProdItems.length,
    nonProdItems,
  });
});

router.post(
  "/plaid/cleanup-non-prod",
  requireAuth,
  async (req, res): Promise<void> => {
    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, req.userId!));
    const targets = items.filter((it) => {
      const env = tokenEnv(it.accessToken);
      return env !== null && env !== "production";
    });
    let removed = 0;
    for (const item of targets) {
      try {
        // Best-effort: a sandbox/development token will be rejected by the
        // production Plaid host, but we still want to free the local rows.
        await plaid().itemRemove({ access_token: item.accessToken });
      } catch (e) {
        req.log.warn({ err: e, itemId: item.id }, "itemRemove failed during non-prod cleanup");
      }
      const itemAccounts = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.itemId, item.id),
            eq(plaidAccountsTable.userId, req.userId!),
          ),
        );
      const itemAcctIds = itemAccounts.map((a) => a.id);
      if (itemAcctIds.length > 0) {
        await db
          .update(debtsTable)
          .set({
            balanceSource: "manual",
            aprSource: "manual",
            minPaymentSource: "manual",
            plaidLastSyncedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(debtsTable.userId, req.userId!),
              inArray(debtsTable.plaidAccountId, itemAcctIds),
            ),
          );
      }
      await db
        .delete(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.itemId, item.id),
            eq(plaidAccountsTable.userId, req.userId!),
          ),
        );
      await db
        .delete(plaidItemsTable)
        .where(
          and(
            eq(plaidItemsTable.id, item.id),
            eq(plaidItemsTable.userId, req.userId!),
          ),
        );
      removed++;
    }
    res.json({ removed });
  },
);

router.post("/plaid/webhook", async (req, res): Promise<void> => {
  const { webhook_type, webhook_code, item_id } = req.body ?? {};
  req.log.info({ webhook_type, webhook_code, item_id }, "Plaid webhook received");
  if (!item_id) {
    res.sendStatus(400);
    return;
  }
  const items = await db
    .select()
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.itemId, String(item_id)));
  if (items.length === 0) {
    res.sendStatus(404);
    return;
  }
  const item = items[0];
  if (
    webhook_type === "TRANSACTIONS" &&
    (webhook_code === "SYNC_UPDATES_AVAILABLE" ||
      webhook_code === "DEFAULT_UPDATE" ||
      webhook_code === "INITIAL_UPDATE" ||
      webhook_code === "HISTORICAL_UPDATE")
  ) {
    try {
      await syncPlaidItem(item.userId, item.id);
    } catch (e) {
      req.log.error({ err: e }, "Webhook-triggered sync failed");
    }
  }
  res.sendStatus(200);
});

router.post("/plaid/sync", requireAuth, async (req, res): Promise<void> => {
  const { itemId } = req.body ?? {};
  try {
    const results = itemId
      ? [await syncPlaidItem(req.userId!, String(itemId))]
      : await syncAllForUser(req.userId!);
    res.json({ items: results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Sync failed";
    req.log.error({ err: e }, "Plaid sync failed");
    res.status(500).json({ error: msg });
  }
});

export default router;
