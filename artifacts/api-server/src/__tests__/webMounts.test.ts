import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mountWebApps } from "../webMounts";

/**
 * ⭐ TWO WEB APPS ON ONE ORIGIN: H2 at `/`, the classic app at `/classic`.
 *
 * Built against throwaway dist folders (no database, no real build): each URL
 * must get the right app's `index.html` or the right asset, with the right
 * cache header, and `/api` must never be answered with HTML.
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
  const res = await fetch(`${base}${url}`);
  return { status: res.status, body: await res.text(), cache: res.headers.get("cache-control") };
}

function boot(dirs: { webDistDir: string; classicDistDir: string }): Promise<void> {
  const app = express();
  // Stand-in for the API router: an unknown /api path answers JSON 404.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  mountWebApps(app, dirs);
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

describe("mountWebApps — both builds present", () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "web-mounts-"));
    makeDist(path.join(root, "h2"), "H2-INDEX", "index-h2abc.js");
    makeDist(path.join(root, "classic"), "CLASSIC-INDEX", "index-clxyz.js");
    await boot({ webDistDir: path.join(root, "h2"), classicDistDir: path.join(root, "classic") });
  });
  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["/", "/design", "/plaid-oauth", "/sign-in/factor-one", "/classicfoo"])(
    "%s → H2's index.html, never cached",
    async (url) => {
      const r = await get(url);
      expect(r.status).toBe(200);
      expect(r.body).toContain("H2-INDEX");
      expect(r.cache).toBe("no-cache");
    },
  );

  it.each(["/classic/", "/classic/home", "/classic/review", "/classic/sign-in/factor-one"])(
    "%s → the classic index.html, never cached",
    async (url) => {
      const r = await get(url);
      expect(r.status).toBe(200);
      expect(r.body).toContain("CLASSIC-INDEX");
      expect(r.cache).toBe("no-cache");
    },
  );

  it("/classic without a slash redirects to /classic/ (express.static's directory redirect)", async () => {
    const res = await fetch(`${base}/classic`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/classic/");
  });

  it("each app's hashed assets are served from its own build and cached for a year", async () => {
    const h2 = await get("/assets/index-h2abc.js");
    expect(h2.body).toContain("H2-INDEX");
    expect(h2.cache).toBe("public, max-age=31536000");
    const classic = await get("/classic/assets/index-clxyz.js");
    expect(classic.body).toContain("CLASSIC-INDEX");
    expect(classic.cache).toBe("public, max-age=31536000");
  });

  it("a classic asset is not reachable at the root, nor an H2 asset under /classic", async () => {
    expect((await get("/assets/index-clxyz.js")).body).toContain("H2-INDEX"); // SPA fallback, not the file
    expect((await get("/classic/assets/index-h2abc.js")).body).toContain("CLASSIC-INDEX");
  });

  it("/api is never answered with an HTML shell", async () => {
    const r = await get("/api/no-such-route");
    expect(r.status).toBe(404);
    expect(r.body).toContain('"error"');
    expect(r.body).not.toContain("INDEX");
  });
});

describe("mountWebApps — no classic build", () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "web-mounts-"));
    makeDist(path.join(root, "h2"), "H2-INDEX", "index-h2abc.js");
    await boot({ webDistDir: path.join(root, "h2"), classicDistDir: path.join(root, "missing") });
  });
  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("/classic/* falls through to H2, which shows its not-found screen in its shell", async () => {
    const r = await get("/classic/home");
    expect(r.status).toBe(200);
    expect(r.body).toContain("H2-INDEX");
  });
});
