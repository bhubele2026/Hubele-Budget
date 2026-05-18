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

// (#623) HOUSEHOLD DATA MODEL
//
// A household is the unit of data sharing. The owner (defined by
// OWNER_EMAIL on first sign-in) creates the single household; invited
// family members join it via `householdMembersTable`. Every user-scoped
// table carries a `household_id uuid` FK so reads and writes are scoped
// to the household, not to an individual user. The legacy `user_id`
// column on those tables is preserved as the *actor* (who created the
// row) for audit / display purposes — it is no longer used to filter
// reads.
//
// Resolution at request time happens in `requireAuth`:
//   * `req.actualUserId` — signed-in Clerk user id (the actor).
//   * `req.userId`       — alias of `req.actualUserId` (kept for back-
//                          compat in legacy call sites that record an
//                          actor on insert).
//   * `req.householdId`  — data scope, looked up via
//                          `household_members.user_id = actualUserId`.
//
// Member removal is durable: deleting a `household_members` row +
// revoking pending Clerk invitations is sufficient to permanently
// revoke access; there is no historical-invitation heuristic.

export const householdsTable = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The Clerk userId of the household owner. Unique because the app
  // is single-household-per-owner (owner_email model). Used by
  // requireAuth to bootstrap the owner's household on first sign-in.
  ownerUserId: text("owner_user_id").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const householdMembersTable = pgTable(
  "household_members",
  {
    // The signed-in Clerk userId of this member. PK because each user
    // belongs to at most one household.
    userId: text("user_id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => householdsTable.id, { onDelete: "cascade" }),
    // The email used in the original Clerk invitation. Stored so a
    // re-invite/lookup can match historical state without a Clerk
    // round-trip. Null for the owner (self-bootstrap).
    invitedEmail: text("invited_email"),
    // 'owner' or 'member'. Owner is bootstrapped from OWNER_EMAIL;
    // members are inserted on first sign-in after accepting an invite.
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    householdIdx: index("household_members_household_idx").on(t.householdId),
  }),
);

export const profilesTable = pgTable("profiles", {
  id: text("id").primaryKey(),
  email: text("email"),
  displayName: text("display_name"),
  // (#623) Legacy column from the previous middleware-remap approach.
  // Retained nullable so existing data is not lost; not read by the
  // current household-scoped queries (those use `household_members`).
  householdOwnerId: text("household_owner_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const debtsTable = pgTable(
  "debts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Audit / actor: the signed-in user who created the row. Reads
    // are scoped by `household_id`, not this column.
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
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
    householdIdx: index("debts_household_idx").on(t.householdId),
    plaidAcctIdx: index("debts_plaid_account_idx").on(t.plaidAccountId),
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
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    debtId: uuid("debt_id")
      .notNull()
      .references(() => debtsTable.id, { onDelete: "cascade" }),
    recordedOn: date("recorded_on").notNull(),
    balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Original per-user uniqueness preserved (it's a strict-superset
    // of the household uniqueness when one household = one owner).
    userDebtDayUnique: uniqueIndex("debt_balance_history_user_debt_day_uq").on(
      t.userId,
      t.debtId,
      t.recordedOn,
    ),
    userDebtIdx: index("debt_balance_history_user_debt_idx").on(t.userId, t.debtId),
    householdDebtDayUq: uniqueIndex(
      "debt_balance_history_household_debt_day_uq",
    ).on(t.householdId, t.debtId, t.recordedOn),
  }),
);

export const avalancheSettingsTable = pgTable("avalanche_settings", {
  // userId remains PK for backward compatibility with the existing
  // single-row-per-user data; one row per household owner is exactly
  // one row per household.
  userId: text("user_id").primaryKey(),
  householdId: uuid("household_id").references(
    () => householdsTable.id,
    { onDelete: "cascade" },
  ),
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
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("expense"),
    groupName: text("group_name").notNull().default("Other"),
    sourceKind: text("source_kind").notNull().default("manual"),
    sortOrder: integer("sort_order").notNull().default(0),
    debtId: uuid("debt_id").references(() => debtsTable.id, { onDelete: "cascade" }),
    excludeFromBudget: boolean("exclude_from_budget").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userNameUnique: uniqueIndex("budget_categories_user_name_uq").on(t.userId, t.name),
    userDebtUnique: uniqueIndex("budget_categories_user_debt_uq").on(t.userId, t.debtId),
    householdNameUq: uniqueIndex("budget_categories_household_name_uq").on(
      t.householdId,
      t.name,
    ),
    householdDebtUq: uniqueIndex("budget_categories_household_debt_uq").on(
      t.householdId,
      t.debtId,
    ),
  }),
);

export const budgetMonthsTable = pgTable(
  "budget_months",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    monthStart: date("month_start").notNull(),
    note: text("note"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userMonthUnique: uniqueIndex("budget_months_user_month_uq").on(t.userId, t.monthStart),
    householdMonthUq: uniqueIndex("budget_months_household_month_uq").on(
      t.householdId,
      t.monthStart,
    ),
  }),
);

export const budgetLinesTable = pgTable(
  "budget_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
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
    householdIdx: index("budget_lines_household_idx").on(t.householdId, t.monthStart),
    householdMonthCatUq: uniqueIndex("budget_lines_household_month_cat_uq").on(
      t.householdId,
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
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
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
    householdIdx: index("recurring_items_household_idx").on(t.householdId),
  }),
);

export const transactionsTable = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
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
    isTransferUserOverridden: boolean("is_transfer_user_overridden")
      .notNull()
      .default(false),
    isExternalCardPayment: boolean("is_external_card_payment")
      .notNull()
      .default(false),
    importBatchId: uuid("import_batch_id"),
    notes: text("notes"),
    source: text("source").notNull().default("manual"),
    member: text("member"),
    owedBy: text("owed_by"),
    plaidTransactionId: text("plaid_transaction_id"),
    plaidAccountId: text("plaid_account_id"),
    // (#636) Plaid `personal_finance_category.primary` / `.detailed`
    // persisted on every insert/refresh from Plaid sync so the startup
    // card-payment sweep (and any future audits) can catch rows whose
    // description is too bland to match the heuristic patterns (e.g.
    // "ACH WEB PAYMENT 12345") but whose PFC clearly identifies them
    // as a card payment / transfer (LOAN_PAYMENTS, TRANSFER_IN/OUT).
    // Nullable: rows that did not originate from Plaid (manual / xlsx)
    // and rows pre-dating this column carry NULL until the live
    // classifier next refreshes them.
    pfcPrimary: text("pfc_primary"),
    pfcDetailed: text("pfc_detailed"),
    // (#728) First-class boolean for Plaid pending/posted state. Replaces
    // the legacy `notes='[pending]'` string marker the Plaid sync used to
    // write — that marker collided with user-typed notes and forced the
    // UI to do string sniffing to surface a Pending section. The column
    // is backfilled from the old marker by
    // `scripts/backfill_transactions_pending.sql` and the marker stripped
    // from notes in the same pass. Plaid sync now writes the boolean and
    // flips it back to false on the pending→posted modified path.
    pending: boolean("pending").notNull().default(false),
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
    householdIdx: index("transactions_household_idx").on(t.householdId, t.occurredOn),
    householdSourceIdx: index("transactions_household_source_idx").on(
      t.householdId,
      t.source,
    ),
    householdDebtIdx: index("transactions_household_debt_idx").on(t.householdId, t.debtId),
    // (#728) Covers the "Pending" register query — list every pending
    // row for an account, newest first — without touching the main
    // table. Composite (plaid_account_id, pending) lets the planner
    // narrow to a single account before applying the boolean filter.
    pendingIdx: index("transactions_pending_idx").on(t.plaidAccountId, t.pending),
  }),
);

export const plaidItemsTable = pgTable(
  "plaid_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    itemId: text("item_id").notNull(),
    accessToken: text("access_token").notNull(),
    institutionId: text("institution_id"),
    institutionName: text("institution_name"),
    institutionSlug: text("institution_slug").notNull().default("bank"),
    cursor: text("cursor"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    lastSyncErrorCode: text("last_sync_error_code"),
    stillPreparingSince: timestamp("still_preparing_since", { withTimezone: true }),
    // (#720) Stamped when /transactions/refresh returns INVALID_PRODUCT
    // (Plaid Dashboard doesn't have the transactions_refresh add-on
    // enabled for this item's institution). When set <7 days ago we
    // skip the refresh call entirely on subsequent syncs to stop the
    // log spam and shave 100–300ms off each user-triggered sync click.
    // Re-attempted once weekly in case the user later enables the add-
    // on on the Plaid Dashboard.
    refreshProductDisabledAt: timestamp("refresh_product_disabled_at", {
      withTimezone: true,
    }),
    // (#728) Circuit-breaker stamp for Plaid's TRANSACTIONS_LIMIT
    // (HTTP 429) on /transactions/refresh. When set in the future,
    // the sync hot path short-circuits the refresh call entirely so
    // we don't burn the per-item quota on a doomed retry. Stamped
    // `now() + 1h` on each TRANSACTIONS_LIMIT response and cleared
    // on the next successful refresh (self-heal).
    refreshRateLimitedUntil: timestamp("refresh_rate_limited_until", {
      withTimezone: true,
    }),
    consentExpirationAt: timestamp("consent_expiration_at", { withTimezone: true }),
    consentExpirationLastRefreshedAt: timestamp(
      "consent_expiration_last_refreshed_at",
      { withTimezone: true },
    ),
    consentExpirationLastRefreshError: text(
      "consent_expiration_last_refresh_error",
    ),
    consentExpirationLastRefreshErrorCode: text(
      "consent_expiration_last_refresh_error_code",
    ),
    consentWarningDismissedForCutoff: timestamp(
      "consent_warning_dismissed_for_cutoff",
      { withTimezone: true },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    itemUq: uniqueIndex("plaid_items_item_uq").on(t.itemId),
    userIdx: index("plaid_items_user_idx").on(t.userId),
    householdIdx: index("plaid_items_household_idx").on(t.householdId),
  }),
);

export const plaidConsentRemindersSentTable = pgTable(
  "plaid_consent_reminders_sent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
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

export const plaidMalformedTokenAlertsSentTable = pgTable(
  "plaid_malformed_token_alerts_sent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    flagged: integer("flagged").notNull(),
    scanned: integer("scanned").notNull(),
    threshold: integer("threshold").notNull(),
    digest: text("digest").notNull(),
    flaggedItemRowIds: jsonb("flagged_item_row_ids").notNull(),
    channel: text("channel").notNull(),
    recipient: text("recipient"),
  },
  (t) => ({
    sentAtIdx: index("plaid_malformed_token_alerts_sent_sent_at_idx").on(
      t.sentAt,
    ),
  }),
);

export const plaidSyncAttemptsTable = pgTable(
  "plaid_sync_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
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
    plaidDisplayMessage: text("plaid_display_message"),
    requestId: text("request_id"),
    httpStatus: integer("http_status"),
    errorKind: text("error_kind"),
  },
  (t) => ({
    itemTimeIdx: index("plaid_sync_attempts_item_time_idx").on(
      t.plaidItemId,
      t.attemptedAt,
    ),
    userIdx: index("plaid_sync_attempts_user_idx").on(t.userId),
    householdIdx: index("plaid_sync_attempts_household_idx").on(t.householdId),
  }),
);

export const plaidAccountsTable = pgTable(
  "plaid_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
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
    liabilityDueDay: integer("liability_due_day"),
    liabilityStatementDay: integer("liability_statement_day"),
    liabilityLastFetchedAt: timestamp("liability_last_fetched_at", { withTimezone: true }),
    importCutoffDate: date("import_cutoff_date"),
    firstSyncCompletedAt: timestamp("first_sync_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    accountUq: uniqueIndex("plaid_accounts_account_uq").on(t.accountId),
    userIdx: index("plaid_accounts_user_idx").on(t.userId),
    householdIdx: index("plaid_accounts_household_idx").on(t.householdId),
  }),
);

export const mappingRulesTable = pgTable(
  "mapping_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    pattern: text("pattern").notNull(),
    matchType: text("match_type").notNull().default("contains"),
    categoryId: uuid("category_id"),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("mapping_rules_user_idx").on(t.userId),
    householdIdx: index("mapping_rules_household_idx").on(t.householdId),
  }),
);

export const monthlySnapshotsTable = pgTable(
  "monthly_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    monthStart: date("month_start").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userMonthUq: uniqueIndex("monthly_snapshots_user_month_uq").on(t.userId, t.monthStart),
    householdMonthUq: uniqueIndex("monthly_snapshots_household_month_uq").on(
      t.householdId,
      t.monthStart,
    ),
  }),
);

export const settingsTable = pgTable("settings", {
  userId: text("user_id").primaryKey(),
  householdId: uuid("household_id").references(
    () => householdsTable.id,
    { onDelete: "cascade" },
  ),
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
  householdId: uuid("household_id").references(
    () => householdsTable.id,
    { onDelete: "cascade" },
  ),
  filename: text("filename"),
  summary: jsonb("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const forecastResolutionsTable = pgTable(
  "forecast_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    recurringItemId: text("recurring_item_id"),
    occurrenceDate: date("occurrence_date"),
    status: text("status").notNull(),
    matchedTxnId: uuid("matched_txn_id"),
    rescheduledTo: date("rescheduled_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("forecast_resolutions_user_idx").on(t.userId),
    householdIdx: index("forecast_resolutions_household_idx").on(t.householdId),
  }),
);

export const forecastClosedMonthsTable = pgTable(
  "forecast_closed_months",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    monthKey: text("month_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userMonthUq: uniqueIndex("forecast_closed_months_uq").on(t.userId, t.monthKey),
    householdMonthUq: uniqueIndex("forecast_closed_months_household_uq").on(
      t.householdId,
      t.monthKey,
    ),
  }),
);

export const forecastSettingsTable = pgTable("forecast_settings", {
  userId: text("user_id").primaryKey(),
  householdId: uuid("household_id").references(
    () => householdsTable.id,
    { onDelete: "cascade" },
  ),
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
  autoDedupeRanAt: timestamp("auto_dedupe_ran_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const dashboardBudgetsTable = pgTable(
  "dashboard_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id").references(
      () => householdsTable.id,
      { onDelete: "cascade" },
    ),
    bucket: text("bucket").notNull(),
    periodKey: text("period_key").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uq: uniqueIndex("dashboard_budgets_uq").on(t.userId, t.bucket, t.periodKey),
    householdUq: uniqueIndex("dashboard_budgets_household_uq").on(
      t.householdId,
      t.bucket,
      t.periodKey,
    ),
  }),
);

export const insertDebtSchema = createInsertSchema(debtsTable).omit({
  id: true, userId: true, householdId: true, createdAt: true, updatedAt: true,
});
export const insertCategorySchema = createInsertSchema(budgetCategoriesTable).omit({
  id: true, userId: true, householdId: true, createdAt: true,
});
export const insertBudgetMonthSchema = createInsertSchema(budgetMonthsTable).omit({
  id: true, userId: true, householdId: true, createdAt: true,
});
export const insertBudgetLineSchema = createInsertSchema(budgetLinesTable).omit({
  id: true, userId: true, householdId: true, createdAt: true,
});
export const insertRecurringSchema = createInsertSchema(recurringItemsTable).omit({
  id: true, userId: true, householdId: true, createdAt: true,
});
export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({
  id: true, userId: true, householdId: true, createdAt: true,
});
export const insertMappingRuleSchema = createInsertSchema(mappingRulesTable).omit({
  id: true, userId: true, householdId: true, createdAt: true,
});

export type Household = typeof householdsTable.$inferSelect;
export type HouseholdMember = typeof householdMembersTable.$inferSelect;
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

// (#629) "Close Out Week" — one row per (household, weekStart) marking the
// Sun–Sat week as paid off. Existence of a row means closed; we keep it as
// a row (rather than a boolean column) so we can audit closedAt/closedBy
// without growing the dashboard_budgets table.
export const weeklySettlementsTable = pgTable(
  "weekly_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    householdId: uuid("household_id")
      .references(() => householdsTable.id, { onDelete: "cascade" })
      .notNull(),
    weekStart: text("week_start").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }).defaultNow().notNull(),
    closedBy: text("closed_by").notNull(),
  },
  (t) => ({
    householdWeekUq: uniqueIndex("weekly_settlements_household_week_uq").on(
      t.householdId,
      t.weekStart,
    ),
  }),
);
export type WeeklySettlement = typeof weeklySettlementsTable.$inferSelect;
