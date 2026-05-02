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
} from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("debts_user_idx").on(t.userId),
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
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userNameUnique: uniqueIndex("budget_categories_user_name_uq").on(t.userId, t.name),
  }),
);

export const budgetMonthsTable = pgTable(
  "budget_months",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    monthStart: date("month_start").notNull(),
    note: text("note"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("budget_lines_user_idx").on(t.userId, t.monthStart),
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
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    account: text("account"),
    categoryId: uuid("category_id"),
    forecastFlag: boolean("forecast_flag").notNull().default(false),
    weeklyAllowance: boolean("weekly_allowance").notNull().default(false),
    monthlyAllowance: boolean("monthly_allowance").notNull().default(false),
    unplannedAllowance: boolean("unplanned_allowance").notNull().default(false),
    reimbursable: boolean("reimbursable").notNull().default(false),
    reimbursed: boolean("reimbursed").notNull().default(false),
    importBatchId: uuid("import_batch_id"),
    notes: text("notes"),
    source: text("source").notNull().default("manual"),
    member: text("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("transactions_user_idx").on(t.userId, t.occurredOn),
    sourceIdx: index("transactions_user_source_idx").on(t.userId, t.source),
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
