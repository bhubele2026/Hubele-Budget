// PERF HARNESS ONLY — the entry of the local perf server bundle (`build-server.mjs`): the real server
// (`artifacts/api-server/src/index.ts`, unchanged) with Clerk swapped for `stubs/clerk-express.ts`.
// Two guards before anything else loads: the database must be a local one whose name ends in `_perf`, and every
// listen binds 127.0.0.1 (the stub signs anyone in).
import http from "node:http";

const url = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  const u = new URL(url);
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) throw new Error("not local");
  dbName = u.pathname.replace(/^\//, "");
} catch {
  dbName = "";
}
if (!/_perf$/.test(dbName)) {
  console.error("perf server: DATABASE_URL must be a local database whose name ends in _perf");
  process.exit(2);
}
if (process.env.NODE_ENV === "production") {
  console.error("perf server: refuses NODE_ENV=production");
  process.exit(2);
}

const listen = http.Server.prototype.listen as (...a: unknown[]) => http.Server;
http.Server.prototype.listen = function (this: http.Server, ...args: unknown[]) {
  if (typeof args[0] === "number" && (args.length === 1 || typeof args[1] === "function")) {
    args.splice(1, 0, "127.0.0.1");
  }
  return listen.apply(this, args);
} as typeof http.Server.prototype.listen;

await import("../../artifacts/api-server/src/index");
