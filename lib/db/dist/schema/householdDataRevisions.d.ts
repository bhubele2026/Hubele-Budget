export declare const householdDataRevisionsTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "household_data_revisions";
    schema: undefined;
    columns: {
        householdId: import("drizzle-orm/pg-core").PgColumn<{
            name: "household_id";
            tableName: "household_data_revisions";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        rev: import("drizzle-orm/pg-core").PgColumn<{
            name: "rev";
            tableName: "household_data_revisions";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
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
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "household_data_revisions";
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
    };
    dialect: "pg";
}>;
export type HouseholdDataRevision = typeof householdDataRevisionsTable.$inferSelect;
//# sourceMappingURL=householdDataRevisions.d.ts.map