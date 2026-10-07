export declare const schemaMigrationsTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "schema_migrations";
    schema: undefined;
    columns: {
        name: import("drizzle-orm/pg-core").PgColumn<{
            name: "name";
            tableName: "schema_migrations";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        checksum: import("drizzle-orm/pg-core").PgColumn<{
            name: "checksum";
            tableName: "schema_migrations";
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
        appliedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "applied_at";
            tableName: "schema_migrations";
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
//# sourceMappingURL=migrations.d.ts.map