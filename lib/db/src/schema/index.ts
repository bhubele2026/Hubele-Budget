import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  boolean,
  date,
  timestamp,
  uuid,
  jsonb,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const profilesTable = pgTable("profiles", {
  id: text("id").primaryKey(),
  email: text("email"),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const debtsTable = pgTable(
  "debts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
    originalBalance: numeric("original_balance", { precision: 12, scale: 2 }),
    apr: numeric("apr", { precision: 6, scale: 4 }).notNull().default("0"),
    minPayment: numeric("min_payment", { precision: 12, scale: 2 }).notNull().default("0"),
    payment: numeric("payment", { precision: 12, scale: 2 }).notNull().default("0"),
    type: text("type"),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    dueDay: integer("due_day"),
    statementDay: integer("statement_day"),
    notes: text("notes"),
    lastBalanceUpdate: timestamp("last_balance_update", { withTimezone: true }),
    plaidAccountId: uuid("plaid_account_id").references(
      (): AnyPgColumn => plaidAccountsTable.id,
      { onDelete: "set null" },
    ),
    plaidLastSyncedAt: timestamp("plaid_last_synced_at", { withTimezone: true }),
    balanceSource: text("balance_source").notNull().default("manual"),
    aprSource: text("apr_source").notNull().default("manual"),
    minPaymentSource: text("min_payment_source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("debts_user_idx").on(t.userId),
    plaidAcctIdx: index("debts_plaid_account_idx").on(t.plaidAccountId),
    // (#44) One Plaid account → at most one debt. Partial uniqueness so
    // the many manual debts (plaid_account_id IS NULL) are unaffected.
    // The api-server catches the resulting 23505 and returns 409.
    plaidAcctUnique: uniqueIndex("debts_plaid_account_unique")
      .on(t.plaidAccountId)
      .where(sql`${t.plaidAccountId} IS NOT NULL`),
  }),
);

export const debtBalanceHistoryTable = pgTable(
  "debt_balance_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    debtId: uuid("debt_id")
      .notNull()
      .references(() => debtsTable.id, { onDelete: "cascade" }),
    recordedOn: date("recorded_on").notNull(),
    balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userDebtDayUnique: uniqueIndex("debt_balance_history_user_debt_day_uq").on(
      t.userId,
      t.debtId,
      t.recordedOn,
    ),
    userDebtIdx: index("debt_balance_history_user_debt_idx").on(t.userId, t.debtId),
  }),
);

export const avalancheSettingsTable = pgTable("avalanche_settings", {
  userId: text("user_id").primaryKey(),
  strategy: text("strategy").notNull().default("avalanche"),
  extraSource: text("extra_source").notNull().default("manual"),
  extraBudgetCategoryId: uuid("extra_budget_category_id"),
  manualExtra: numeric("manual_extra", { precision: 12, scale: 2 }).notNull().default("0"),
  budgetMode: text("budget_mode").notNull().default("budgeted"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const budgetCategoriesTable = pgTable(
  "budget_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("expense"),
    groupName: text("group_name").notNull().default("Other"),
    sourceKind: text("source_kind").notNull().default("manual"),
    sortOrder: integer("sort_order").notNull().default(0),
    debtId: uuid("debt_id").references(() => debtsTable.id, { onDelete: "cascade" }),
    // (#474) When true the category is omitted from the Budget page entirely:
    // its planned line is never rendered, its actuals do not roll up into any
    // group/summary total, and the mapping-rules UI hides it from category
    // pickers (and the API rejects rules pointing at it). Used by the
    // system-managed "Uncategorized" category so users can mark a row as
    // triaged without contaminating budget math.
    excludeFromBudget: boolean("exclude_from_budget").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userNameUnique: uniqueIndex("budget_categories_user_name_uq").on(t.userId, t.name),
    userDebtUnique: uniqueIndex("budget_categories_user_debt_uq").on(t.userId, t.debtId),
  }),
);

export const budgetMonthsTable = pgTable(
  "budget_months",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    monthStart: date("month_start").notNull(),
    note: text("note"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userMonthUnique: uniqueIndex("budget_months_user_month_uq").on(t.userId, t.monthStart),
  }),
);

export const budgetLinesTable = pgTable(
  "budget_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    monthStart: date("month_start").notNull(),
    categoryId: uuid("category_id").notNull(),
    plannedAmount: numeric("planned_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    note: text("note"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("budget_lines_user_idx").on(t.userId, t.monthStart),
    userMonthCatUq: uniqueIndex("budget_lines_user_month_cat_uq").on(
      t.userId,
      t.monthStart,
      t.categoryId,
    ),
  }),
);

export const recurringItemsTable = pgTable(
  "recurring_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("bill"),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    frequency: text("frequency").notNull().default("monthly"),
    dayOfMonth: integer("day_of_month"),
    anchorDate: date("anchor_date"),
    active: text("active").notNull().default("true"),
    categoryId: uuid("category_id"),
    debtId: uuid("debt_id").references(() => debtsTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("recurring_items_user_idx").on(t.userId),
  }),
);

export const transactionsTable = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    occurredOn: date("occurred_on").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    account: text("account"),
    categoryId: uuid("category_id"),
    forecastFlag: boolean("forecast_flag").notNull().default(false),
    weeklyAllowance: boolean("weekly_allowance").notNull().default(false),
    weeklyBucket: text("weekly_bucket"),
    monthlyAllowance: boolean("monthly_allowance").notNull().default(false),
    unplannedAllowance: boolean("unplanned_allowance").notNull().default(false),
    reimbursable: boolean("reimbursable").notNull().default(false),
    reimbursed: boolean("reimbursed").notNull().default(false),
    reviewed: boolean("reviewed").notNull().default(false),
    isTransfer: boolean("is_transfer").notNull().default(false),
    // (#479) When true, the user has explicitly toggled `isTransfer`
    // (cleared the auto-flag from the row's "Transfer" pill, picked a real
    // category on a transfer row, or flipped the toggle in the Edit dialog).
    // The Plaid sync / XLSX import / aprilChaseSeed re-categorize paths
    // honor this flag and skip the description/PFC transfer heuristic so
    // future syncs of the same row don't silently re-flag it as a transfer.
    isTransferUserOverridden: boolean("is_transfer_user_overridden")
      .notNull()
      .default(false),
    importBatchId: uuid("import_batch_id"),
    notes: text("notes"),
    source: text("source").notNull().default("manual"),
    member: text("member"),
    owedBy: text("owed_by"),
    plaidTransactionId: text("plaid_transaction_id"),
    plaidAccountId: text("plaid_account_id"),
    debtId: uuid("debt_id").references((): AnyPgColumn => debtsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("transactions_user_idx").on(t.userId, t.occurredOn),
    sourceIdx: index("transactions_user_source_idx").on(t.userId, t.source),
    plaidTxnUq: uniqueIndex("transactions_plaid_txn_uq").on(t.plaidTransactionId),
    debtIdx: index("transactions_debt_idx").on(t.userId, t.debtId),
  }),
);

export const plaidItemsTable = pgTable(
  "plaid_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    accessToken: text("access_token").notNull(),
    institutionId: text("institution_id"),
    institutionName: text("institution_name"),
    institutionSlug: text("institution_slug").notNull().default("bank"),
    cursor: text("cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    lastSyncErrorCode: text("last_sync_error_code"),
    // Set whenever a Plaid call returns PRODUCT_NOT_READY (the bank is still
    // staging the historical batch for a freshly linked item) and cleared on
    // the next successful sync. Lets the Settings page show a per-item
    // "Still preparing" badge so the user knows which institution is in the
    // transient warm-up window vs. genuinely healthy.
    stillPreparingSince: timestamp("still_preparing_since", { withTimezone: true }),
    // (#238) Plaid's `consent_expiration_time` from /item/get — the cutoff
    // date after which the bank link will be auto-disconnected unless the
    // user re-consents. Captured at exchange time and refreshed during
    // every sync (the value can move forward as the user re-consents).
    // Null when Plaid does not report a date for this item (most non-OAuth
    // institutions). Powers the dated PENDING_EXPIRATION /
    // PENDING_DISCONNECT subline copy on the reconnect banners.
    consentExpirationAt: timestamp("consent_expiration_at", { withTimezone: true }),
    // (#258) Wall-clock timestamp of when we last successfully verified
    // `consent_expiration_at` against Plaid (any path: exchange, on-sync
    // refresh, or the daily cron). Updated on every successful /item/get
    // call regardless of whether the cutoff value actually changed, so
    // support can answer "did the daily refresh run today?" and "is the
    // disconnect countdown the user is seeing fresh?" without diffing
    // logs. Null until the first successful refresh (e.g. for items
    // linked before this column existed).
    consentExpirationLastRefreshedAt: timestamp(
      "consent_expiration_last_refreshed_at",
      { withTimezone: true },
    ),
    // (#265) Latest /item/get failure message captured during the
    // consent_expiration refresh path (manual trigger, on-sync
    // PENDING_EXPIRATION refresh, or daily cron). Cleared on the
    // next successful refresh. Lets the Settings page render an
    // inline "why" under the per-item "Disconnect date checked …"
    // line so a user who walks away after running the manual
    // refresh can still see which bank errored without having to
    // re-click the button. Distinct from `last_sync_error` (which
    // tracks /transactions/sync failures) so a healthy sync does
    // not erase the consent-refresh failure and vice versa.
    consentExpirationLastRefreshError: text(
      "consent_expiration_last_refresh_error",
    ),
    consentExpirationLastRefreshErrorCode: text(
      "consent_expiration_last_refresh_error_code",
    ),
    // (#274) The value of `consent_expiration_at` at the moment the
    // user clicked dismiss on the dashboard "bank consent expiring
    // soon" banner. The frontend suppresses the alert for an item
    // only while its current cutoff matches this stored value, so a
    // re-consent (which rolls the cutoff forward) or a brand-new item
    // entering the window naturally re-surfaces the banner without
    // needing a separate "clear dismissal" mutation. Null until the
    // user dismisses for the first time.
    consentWarningDismissedForCutoff: timestamp(
      "consent_warning_dismissed_for_cutoff",
      { withTimezone: true },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    itemUq: uniqueIndex("plaid_items_item_uq").on(t.itemId),
    userIdx: index("plaid_items_user_idx").on(t.userId),
  }),
);

// (#262) Tracks which (plaid_item, consent cutoff) pairs we have
// already emailed/pushed an "about to disconnect" reminder for so the
// daily sweep does not spam the same user every morning while an item
// sits inside the alert window. Keyed by (plaidItemId, cutoffSentFor):
//
//   * Same cutoff → already notified, skip.
//   * Different cutoff → fresh reminder is allowed. In practice a
//     successful re-consent rolls Plaid's cutoff months out (well past
//     the alert window), so the next sweep will not even consider the
//     item — silence falls out for free without us having to look up
//     reconnect events explicitly.
//
// `recipient` and `channel` are recorded for support/debugging so we
// can answer "what did we tell this user, and where did we send it?"
// without re-running the sweep. Cascade delete on the parent item so
// removing a Plaid link cleans up its history.
export const plaidConsentRemindersSentTable = pgTable(
  "plaid_consent_reminders_sent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    plaidItemId: uuid("plaid_item_id")
      .notNull()
      .references((): AnyPgColumn => plaidItemsTable.id, {
        onDelete: "cascade",
      }),
    cutoffSentFor: timestamp("cutoff_sent_for", {
      withTimezone: true,
    }).notNull(),
    channel: text("channel").notNull(),
    recipient: text("recipient"),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    itemCutoffUq: uniqueIndex(
      "plaid_consent_reminders_sent_item_cutoff_uq",
    ).on(t.plaidItemId, t.cutoffSentFor),
    userIdx: index("plaid_consent_reminders_sent_user_idx").on(t.userId),
  }),
);

// (#279) Append-only audit log of every Plaid sync attempt — one row
// per (item, kind) outcome. Surfaces the full recent-history (e.g.
// "this bank failed 4 of the last 10 syncs") in Settings → Linked
// banks so users can spot a flaky bank link before they only see the
// latest `lastSyncError` snapshot. Pruned by a daily cron so the
// table stays bounded.
//
// `kind` is one of:
//   * "transactions" — /transactions/sync (called from syncPlaidItem)
//   * "balance"      — /accounts/balance/get (bank-snapshot refresh)
//   * "liabilities"  — /liabilities/get + /accounts/get fallback
export const plaidSyncAttemptsTable = pgTable(
  "plaid_sync_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    plaidItemId: uuid("plaid_item_id")
      .notNull()
      .references((): AnyPgColumn => plaidItemsTable.id, {
        onDelete: "cascade",
      }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    kind: text("kind").notNull(),
    success: boolean("success").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    // (#357) Enriched per-attempt failure metadata so Settings → Recent
    // activity (and any future surface) can render exactly the same
    // structured Plaid failure the live sync toast renders, without a
    // second round-trip to Plaid. All optional — populated only on
    // failure rows that came from extractPlaidError().
    plaidDisplayMessage: text("plaid_display_message"),
    requestId: text("request_id"),
    httpStatus: integer("http_status"),
    // Categorical bucket: reauth | rate_limit | institution_down |
    // transient | unknown. Lets the UI decide when to surface a
    // Reconnect CTA on a historical row without re-deriving from the
    // raw error_code each render. Named `errorKind` (col
    // `error_kind`) so it doesn't collide with the existing `kind`
    // column which records the Plaid product call.
    errorKind: text("error_kind"),
  },
  (t) => ({
    itemTimeIdx: index("plaid_sync_attempts_item_time_idx").on(
      t.plaidItemId,
      t.attemptedAt,
    ),
    userIdx: index("plaid_sync_attempts_user_idx").on(t.userId),
  }),
);

export const plaidAccountsTable = pgTable(
  "plaid_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    itemId: uuid("item_id").notNull(),
    accountId: text("account_id").notNull(),
    name: text("name"),
    officialName: text("official_name"),
    mask: text("mask"),
    type: text("type"),
    subtype: text("subtype"),
    liabilityKind: text("liability_kind"),
    liabilityBalance: numeric("liability_balance", { precision: 12, scale: 2 }),
    liabilityApr: numeric("liability_apr", { precision: 6, scale: 4 }),
    liabilityMinPayment: numeric("liability_min_payment", { precision: 12, scale: 2 }),
    // (#44) Day-of-month derived from /liabilities/get's
    // next_payment_due_date / last_statement_issue_date so that
    // GET /plaid/liability-accounts can pre-fill the suggestedDebt
    // payload without an extra Plaid round-trip on each render.
    liabilityDueDay: integer("liability_due_day"),
    liabilityStatementDay: integer("liability_statement_day"),
    liabilityLastFetchedAt: timestamp("liability_last_fetched_at", { withTimezone: true }),
    // (#361) First-sync dedupe gate. `importCutoffDate` is the inclusive
    // upper bound on dates Plaid is allowed to *insert* during the very
    // first /transactions/sync against this account: rows whose `date` is
    // on/before this cutoff are skipped (assumed to overlap manual /
    // imported history the user already has). Rows within ±7 days of the
    // cutoff first try to merge with an unattached manual row at the same
    // amount/date — successful merges adopt `plaidTransactionId` /
    // `plaidAccountId` instead of inserting a duplicate. Auto-detected
    // at link time from the user's existing manual rows; user-overridable
    // via Settings while `firstSyncCompletedAt` is still null.
    importCutoffDate: date("import_cutoff_date"),
    // (#361) Stamped at the end of the first successful /transactions/sync
    // for this account. Until set, the cutoff gate above is active. After
    // it is set, the gate is permanently disabled (subsequent cursor-based
    // syncs behave exactly as today).
    firstSyncCompletedAt: timestamp("first_sync_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    accountUq: uniqueIndex("plaid_accounts_account_uq").on(t.accountId),
    userIdx: index("plaid_accounts_user_idx").on(t.userId),
  }),
);

export const mappingRulesTable = pgTable(
  "mapping_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    pattern: text("pattern").notNull(),
    matchType: text("match_type").notNull().default("contains"),
    categoryId: uuid("category_id"),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("mapping_rules_user_idx").on(t.userId),
  }),
);

export const monthlySnapshotsTable = pgTable(
  "monthly_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    monthStart: date("month_start").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userMonthUq: uniqueIndex("monthly_snapshots_user_month_uq").on(t.userId, t.monthStart),
  }),
);

export const settingsTable = pgTable("settings", {
  userId: text("user_id").primaryKey(),
  weeklyAllowanceAmount: numeric("weekly_allowance_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  monthlyAllowanceAmount: numeric("monthly_allowance_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  unplannedAllowanceAmount: numeric("unplanned_allowance_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  primaryAccount: text("primary_account"),
  preferences: jsonb("preferences"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const importBatchesTable = pgTable("import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  filename: text("filename"),
  summary: jsonb("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const forecastResolutionsTable = pgTable(
  "forecast_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    recurringItemId: uuid("recurring_item_id"),
    occurrenceDate: date("occurrence_date"),
    status: text("status").notNull(),
    matchedTxnId: uuid("matched_txn_id"),
    rescheduledTo: date("rescheduled_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("forecast_resolutions_user_idx").on(t.userId),
  }),
);

export const forecastClosedMonthsTable = pgTable(
  "forecast_closed_months",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    monthKey: text("month_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userMonthUq: uniqueIndex("forecast_closed_months_uq").on(t.userId, t.monthKey),
  }),
);

export const forecastSettingsTable = pgTable("forecast_settings", {
  userId: text("user_id").primaryKey(),
  daysAhead: integer("days_ahead").notNull().default(90),
  startingBalance: numeric("starting_balance", { precision: 12, scale: 2 }).notNull().default("0"),
  cashBuffer: numeric("cash_buffer", { precision: 12, scale: 2 }).notNull().default("500"),
  bankSnapshotBalance: numeric("bank_snapshot_balance", { precision: 12, scale: 2 }),
  bankSnapshotAt: timestamp("bank_snapshot_at", { withTimezone: true }),
  bankSnapshotSource: text("bank_snapshot_source"),
  bankSnapshotAccountId: uuid("bank_snapshot_account_id"),
  bankSnapshotName: text("bank_snapshot_name"),
  bankSnapshotMask: text("bank_snapshot_mask"),
  monthSnapshots: jsonb("month_snapshots").$type<
    Record<
      string,
      {
        balance: string;
        at: string;
        gap?: string;
        forecastEnd?: string;
        bankEnd?: string;
        pending?: number;
        reconciled?: boolean;
        closedAt?: string;
      }
    >
  >(),
  // Per-account current-balance snapshots, keyed by `plaid_accounts.id`.
  // The legacy `bankSnapshot*` columns above remain the "primary" snapshot
  // (drives Forecast page balance math + cash-signal). This map lets the
  // Chase page anchor Starting/Ending balance for non-primary checking
  // accounts the user picks via the multi-account picker (#296).
  accountSnapshots: jsonb("account_snapshots").$type<
    Record<
      string,
      {
        balance: string;
        at: string;
        source: "manual" | "plaid";
        name: string | null;
        mask: string | null;
      }
    >
  >(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const dashboardBudgetsTable = pgTable(
  "dashboard_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    bucket: text("bucket").notNull(),
    periodKey: text("period_key").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uq: uniqueIndex("dashboard_budgets_uq").on(t.userId, t.bucket, t.periodKey),
  }),
);

export const insertDebtSchema = createInsertSchema(debtsTable).omit({
  id: true, userId: true, createdAt: true, updatedAt: true,
});
export const insertCategorySchema = createInsertSchema(budgetCategoriesTable).omit({
  id: true, userId: true, createdAt: true,
});
export const insertBudgetMonthSchema = createInsertSchema(budgetMonthsTable).omit({
  id: true, userId: true, createdAt: true,
});
export const insertBudgetLineSchema = createInsertSchema(budgetLinesTable).omit({
  id: true, userId: true, createdAt: true,
});
export const insertRecurringSchema = createInsertSchema(recurringItemsTable).omit({
  id: true, userId: true, createdAt: true,
});
export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({
  id: true, userId: true, createdAt: true,
});
export const insertMappingRuleSchema = createInsertSchema(mappingRulesTable).omit({
  id: true, userId: true, createdAt: true,
});

export type Debt = typeof debtsTable.$inferSelect;
export type Category = typeof budgetCategoriesTable.$inferSelect;
export type BudgetMonth = typeof budgetMonthsTable.$inferSelect;
export type BudgetLine = typeof budgetLinesTable.$inferSelect;
export type RecurringItem = typeof recurringItemsTable.$inferSelect;
export type Transaction = typeof transactionsTable.$inferSelect;
export type MappingRule = typeof mappingRulesTable.$inferSelect;
export type Settings = typeof settingsTable.$inferSelect;
export type ImportBatch = typeof importBatchesTable.$inferSelect;
export type ForecastResolution = typeof forecastResolutionsTable.$inferSelect;
export type ForecastClosedMonth = typeof forecastClosedMonthsTable.$inferSelect;
export type ForecastSettings = typeof forecastSettingsTable.$inferSelect;
export type DashboardBudget = typeof dashboardBudgetsTable.$inferSelect;
