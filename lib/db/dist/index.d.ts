import pg from "pg";
import * as schema from "./schema";
/** The pool's connection cap. */
export declare const POOL_MAX = 8;
/**
 * (P2) How long a query waits for a free connection before it fails. pg's
 * default is to wait forever: a request queued behind a stuck one hung with
 * no error and no log. 10 s is far above any page's slowest read.
 */
export declare const POOL_CONNECTION_TIMEOUT_MS = 10000;
export declare const pool: import("pg").Pool;
export declare const db: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: import("pg").Pool;
};
/** (P2) What `watchPoolWaiting` reports. */
export interface PoolPressure {
    /** Queries waiting for a connection. */
    waiting: number;
    /** Connections open (busy + idle). */
    total: number;
    idle: number;
    max: number;
}
/**
 * ⭐ (P2) A cheap signal that the pool is the bottleneck: each time a connection
 * is handed out while other queries still wait for one, `report` is called —
 * at most once per `everyMs`. Nothing is measured when nobody waits. Returns a
 * function that stops watching.
 */
export declare function watchPoolWaiting(report: (pressure: PoolPressure) => void, everyMs?: number, target?: Pick<pg.Pool, "on" | "off" | "waitingCount" | "totalCount" | "idleCount">): () => void;
export * from "./schema";
export * from "./mappingRuleUpsert";
//# sourceMappingURL=index.d.ts.map