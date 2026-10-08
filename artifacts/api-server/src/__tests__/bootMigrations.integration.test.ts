// PR-0 · Boot order (src/boot.ts): pending migrations run BEFORE the server
// listens, and a failing migration means it never listens and exits 1 (the
// deploy fails, the old build keeps serving). `exit` is injected so nothing
// really exits here.
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pool } from "@workspace/db";
import { runMigrations } from "@workspace/db/migrate";
import { migrateOnBootEnabled, startServer, type StartServerOptions } from "../boot";
import { findMigrationsDir } from "../lib/migrationsDir";

function harness(migrate: StartServerOptions["migrate"], migrateOnBoot = true) {
  const events: string[] = [];
  const exits: number[] = [];
  const errors: unknown[] = [];
  const opts: StartServerOptions = {
    migrateOnBoot,
    migrate: async () => {
      events.push("migrate:start");
      const r = await migrate();
      events.push("migrate:done");
      return r;
    },
    listen: () => events.push("listen"),
    exit: (code) => exits.push(code),
    log: { info: () => {}, error: (_m, err) => errors.push(err) },
  };
  return { opts, events, exits, errors };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

describe("startServer", () => {
  it("migrates first, then listens", async () => {
    const h = harness(async () => ({ applied: ["0001_x.sql"], skipped: 0 }));
    expect(await startServer(h.opts)).toBe(true);
    expect(h.events).toEqual(["migrate:start", "migrate:done", "listen"]);
    expect(h.exits).toEqual([]);
  });

  it("does not listen while a migration is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async () => {
      await gate;
      return { applied: [], skipped: 2 };
    });
    const started = startServer(h.opts);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).toEqual(["migrate:start"]);
    release();
    await started;
    expect(h.events).toEqual(["migrate:start", "migrate:done", "listen"]);
  });

  it("a failing migration never listens and exits 1", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    expect(await startServer(h.opts)).toBe(false);
    expect(h.events).toEqual(["migrate:start"]);
    expect(h.exits).toEqual([1]);
    expect(String(h.errors[0])).toContain("boom");
  });

  it("MIGRATE_ON_BOOT=false skips the runner and listens", async () => {
    const h = harness(async () => ({ applied: [], skipped: 0 }), false);
    expect(await startServer(h.opts)).toBe(true);
    expect(h.events).toEqual(["listen"]);
  });

  it("only the literal string \"false\" turns boot migrations off", () => {
    expect(migrateOnBootEnabled({})).toBe(true);
    expect(migrateOnBootEnabled({ MIGRATE_ON_BOOT: "true" })).toBe(true);
    expect(migrateOnBootEnabled({ MIGRATE_ON_BOOT: "0" })).toBe(true);
    expect(migrateOnBootEnabled({ MIGRATE_ON_BOOT: "false" })).toBe(false);
  });
});

describe("startServer with the real runner", () => {
  it("finds lib/db/migrations from this file", async () => {
    const dir = findMigrationsDir(import.meta.url);
    expect(await readdir(dir)).toContain("0002_category_locked_by_user.sql");
  });

  it("a real failing migration file keeps the server from listening", async () => {
    const schema = `pr0_boot_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    // (PR-D) INCLUDING INDEXES copies the primary key: 0060 adds foreign keys
    // that point at transactions(id), which need one.
    await pool.query(`CREATE TABLE ${schema}.transactions (LIKE public.transactions INCLUDING DEFAULTS INCLUDING INDEXES)`);
    for (const col of ["category_locked_by_user", "payment_state", "confirmed_by_txn_id"]) {
      await pool.query(`ALTER TABLE ${schema}.transactions DROP COLUMN ${col}`);
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr0-boot-"));
    cleanup.push(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await rm(dir, { recursive: true, force: true });
    });
    const real = findMigrationsDir(import.meta.url);
    for (const n of (await readdir(real)).filter((f) => f.endsWith(".sql"))) {
      await copyFile(path.join(real, n), path.join(dir, n));
    }
    await writeFile(path.join(dir, "9990_broken.sql"), "SELECT * FROM pr0_no_such_table;");
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema},public`);

    const h = harness(() => runMigrations({ databaseUrl: url.toString(), dir }));
    expect(await startServer(h.opts)).toBe(false);
    expect(h.events).toEqual(["migrate:start"]);
    expect(h.exits).toEqual([1]);
    expect(String(h.errors[0])).toMatch(/9990_broken\.sql failed and was rolled back/);
    // The files before it did apply, each in its own transaction.
    // Expected = every real migration that sorts before the broken file, so a
    // new package's SQL file never breaks this test.
    const expected = (await readdir(real))
      .filter((f) => f.endsWith(".sql") && f < "9990_broken.sql")
      .sort();
    expect(expected.length).toBeGreaterThanOrEqual(2);
    const { rows } = await pool.query(`SELECT name FROM ${schema}.schema_migrations ORDER BY name`);
    expect(rows.map((r: { name: string }) => r.name)).toEqual(expected);
  });
});
