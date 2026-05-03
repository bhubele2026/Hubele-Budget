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
} from "../lib/plaid";
import { syncPlaidItem, syncAllForUser } from "../lib/plaidSync";
import { fetchLiabilitiesForUser } from "../lib/plaidLiabilities";
import { debtsTable } from "@workspace/db";

const router: IRouter = Router();

router.post("/plaid/link-token", requireAuth, async (req, res): Promise<void> => {
  try {
    const resp = await plaid().linkTokenCreate({
      user: { client_user_id: req.userId! },
      client_name: "H2 Family Budget",
      products: PLAID_PRODUCTS,
      optional_products: PLAID_OPTIONAL_PRODUCTS,
      country_codes: PLAID_COUNTRY_CODES,
      language: "en",
    });
    res.json({
      linkToken: resp.data.link_token,
      expiration: resp.data.expiration,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Plaid error";
    req.log.error({ err: e }, "Plaid link token failed");
    res.status(500).json({ error: msg });
  }
});

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
