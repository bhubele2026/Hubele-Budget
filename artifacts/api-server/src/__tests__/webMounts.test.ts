import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mountWebApp, resolveWebDistDir } from "../webMounts";

/**
 * ⭐ ONE WEB APP AT `/` (the switch). The app that was previewed under
 * `/classic` is served at the root; `/classic/*` redirects there.
 *
 * Built against a throwaway dist folder (no database, no real build): each URL
 * must get the app's `index.html` or the right asset with the right cache
 * header, `/classic` must 301 with the query kept, Plaid's redirect URI must be
 * answered in place, and `/api` must never be answered with HTML.
 */

let root: string;
let server: Server;
let base: string;

function makeDist(dir: string, marker: string, asset: string): void {
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>${marker}</title>`);
  writeFileSync(path.join(dir, "assets", asset), `/* ${marker} */`);
}

async function get(url: string) {
  const res = await fetch(`${base}${url}`, { redirect: "manual" });
  return {
    status: res.status,
    body: await res.text(),
    cache: res.headers.get("cache-control"),
    location: res.headers.get("location"),
    type: res.headers.get("content-type"),
  };
}

function boot(distDir: string): Promise<void> {
  const app = express();
  // Stand-in for the API router: an unknown /api path answers JSON 404.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  mountWebApp(app, { distDir });
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

describe("mountWebApp — the app's build is present", () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "web-mount-"));
    makeDist(path.join(root, "app"), "APP-INDEX", "index-abc123.js");
    await boot(path.join(root, "app"));
  });
  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["/", "/home", "/review", "/settings?tab=automation", "/sign-in/factor-one", "/today", "/classicfoo", "/apiary"])(
    "%s → the app's index.html, never cached",
    async (url) => {
      const r = await get(url);
      expect(r.status).toBe(200);
      expect(r.body).toContain("APP-INDEX");
      expect(r.cache).toBe("no-cache");
    },
  );

  it("Plaid's redirect URI (/plaid-oauth) is answered in place with the shell — no redirect, so oauth_state_id round-trips", async () => {
    const r = await get("/plaid-oauth?oauth_state_id=abc-123");
    expect(r.status).toBe(200);
    expect(r.location).toBeNull();
    expect(r.body).toContain("APP-INDEX");
  });

  it.each([
    ["/classic", "/"],
    ["/classic/", "/"],
    ["/classic/home", "/home"],
    ["/classic/review/categories", "/review/categories"],
    ["/classic/settings?tab=automation", "/settings?tab=automation"],
    ["/classic/transactions?month=2026-10&tx=t1", "/transactions?month=2026-10&tx=t1"],
    ["/classic/plaid-oauth?oauth_state_id=abc", "/plaid-oauth?oauth_state_id=abc"],
    ["/classic/?d=2026-10-09", "/?d=2026-10-09"],
  ])("%s → 301 to %s (the query kept)", async (from, to) => {
    const r = await get(from);
    expect(r.status).toBe(301);
    expect(r.location).toBe(to);
  });

  it("the /classic redirect never becomes protocol-relative (no open redirect)", async () => {
    expect((await get("/classic//evil.example/x")).location).toBe("/evil.example/x");
    expect((await get("/classic///evil.example")).location).toBe("/evil.example");
  });

  it("hashed assets are served and cached for a year; a missing one is a plain 404, not the shell", async () => {
    const hit = await get("/assets/index-abc123.js");
    expect(hit.status).toBe(200);
    expect(hit.body).toContain("APP-INDEX");
    expect(hit.cache).toBe("public, max-age=31536000");
    const miss = await get("/assets/index-old999.js");
    expect(miss.status).toBe(404);
    expect(miss.body).not.toContain("APP-INDEX");
    expect(miss.type).toMatch(/^text\/plain/);
  });

  it("an old /classic asset URL redirects to the root, where a stale hash 404s", async () => {
    const r = await get("/classic/assets/index-old999.js");
    expect(r.status).toBe(301);
    expect(r.location).toBe("/assets/index-old999.js");
    expect((await get("/assets/index-old999.js")).status).toBe(404);
  });

  it.each(["/api/no-such-route", "/api"])("%s is never answered with an HTML shell", async (url) => {
    const r = await get(url);
    expect(r.status).toBe(404);
    expect(r.body).toContain('"error"');
    expect(r.body).not.toContain("INDEX");
  });
});

describe("mountWebApp — no build (local dev, the API tests)", () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "web-mount-"));
    await boot(path.join(root, "missing"));
  });
  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves nothing at the root, but /classic still redirects", async () => {
    expect((await get("/home")).status).toBe(404);
    const r = await get("/classic/home?x=1");
    expect(r.status).toBe(301);
    expect(r.location).toBe("/home?x=1");
  });
});

describe("resolveWebDistDir", () => {
  it("uses WEB_DIST_DIR when it holds a build, else the default — a stale value never blanks the app", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "web-dist-"));
    try {
      makeDist(path.join(dir, "built"), "X", "a.js");
      const warnings: string[] = [];
      expect(resolveWebDistDir(undefined, "/default")).toBe("/default");
      expect(resolveWebDistDir("  ", "/default")).toBe("/default");
      expect(resolveWebDistDir(path.join(dir, "built"), "/default")).toBe(path.join(dir, "built"));
      expect(resolveWebDistDir(path.join(dir, "gone"), "/default", (m) => warnings.push(m))).toBe("/default");
      expect(warnings).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
