/** Arbitrary, fixed key for the runner's session-level advisory lock. */
export declare const MIGRATION_LOCK_KEY = 7212;
export type RunMigrationsOptions = {
    databaseUrl: string;
    /** Directory holding the `NNNN_*.sql` files. */
    dir: string;
    log?: (msg: string) => void;
    /**
     * `lock_timeout` for each file's transaction. An `ALTER TABLE` queued
     * behind the live server's queries would otherwise block every later query
     * on that table while it waits; failing fast cancels the deploy instead.
     */
    lockTimeoutMs?: number;
};
export type RunMigrationsResult = {
    applied: string[];
    skipped: number;
};
export declare function checksumOf(sql: string): string;
export declare function runMigrations(opts: RunMigrationsOptions): Promise<RunMigrationsResult>;
//# sourceMappingURL=migrate.d.ts.map