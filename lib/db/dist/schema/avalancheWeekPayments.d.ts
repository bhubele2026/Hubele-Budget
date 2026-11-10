export declare const avalancheWeekPaymentsTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "avalanche_week_payments";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "avalanche_week_payments";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        householdId: import("drizzle-orm/pg-core").PgColumn<{
            name: "household_id";
            tableName: "avalanche_week_payments";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        weekDate: import("drizzle-orm/pg-core").PgColumn<{
            name: "week_date";
            tableName: "avalanche_week_payments";
            dataType: "string";
            columnType: "PgDateString";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        total: import("drizzle-orm/pg-core").PgColumn<{
            name: "total";
            tableName: "avalanche_week_payments";
            dataType: "string";
            columnType: "PgNumeric";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        resolutionId: import("drizzle-orm/pg-core").PgColumn<{
            name: "resolution_id";
            tableName: "avalanche_week_payments";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        replaced: import("drizzle-orm/pg-core").PgColumn<{
            name: "replaced";
            tableName: "avalanche_week_payments";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        debts: import("drizzle-orm/pg-core").PgColumn<{
            name: "debts";
            tableName: "avalanche_week_payments";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdBy: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_by";
            tableName: "avalanche_week_payments";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "avalanche_week_payments";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        undoneAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "undone_at";
            tableName: "avalanche_week_payments";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        undoneBy: import("drizzle-orm/pg-core").PgColumn<{
            name: "undone_by";
            tableName: "avalanche_week_payments";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
/** One debt a "We paid it" paid, as `avalanche_week_payments.debts` keeps it. */
export interface AvalancheWeekPaymentDebt {
    debtId: string;
    name: string;
    /** What the week paid this debt (the plan's figure). */
    amount: number;
    /** The bank carries this debt's balance (`plaid_account_id`): no balance write, no claim. */
    linked: boolean;
    /** The stored balance before the payment (numeric text, as the column reads). */
    balanceBefore: string;
    statusBefore: string;
    /** After the payment; null for a linked debt (nothing was written). */
    balanceAfter: string | null;
    statusAfter: string | null;
    /** `last_balance_update` before (ISO), restored by the undo. */
    lastBalanceUpdateBefore: string | null;
    /** The balance-history day the payment wrote, and that day's row before it (null: there was none). */
    snapshotDay: string | null;
    snapshotBefore: string | null;
    /** The claim transaction the payment wrote; null for a linked debt. */
    claimTxnId: string | null;
    paidOff: boolean;
}
export type AvalancheWeekPayment = typeof avalancheWeekPaymentsTable.$inferSelect;
//# sourceMappingURL=avalancheWeekPayments.d.ts.map