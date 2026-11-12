import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clerkJSScriptUrl, clerkUIScriptUrl, publishableKeyFromHost } from "@clerk/react/internal";
import { clerkOrigin, clerkPreconnectHtml, frontendApiOf } from "./clerkOrigin";

/**
 * (perf phase 2) The preconnect in index.html names the host Clerk will really load from: it is worked out the way
 * App.tsx hands Clerk its key (`publishableKeyFromHost(location.hostname, VITE_CLERK_PUBLISHABLE_KEY)`), and it is
 * checked against the very URLs Clerk loads its two scripts from (`clerkJSScriptUrl`, `clerkUIScriptUrl`).
 */
const scriptOrigins = (publishableKey: string, proxyUrl?: string) => [
  new URL(clerkJSScriptUrl({ publishableKey, proxyUrl })).origin,
  new URL(clerkUIScriptUrl({ publishableKey, proxyUrl })).origin,
];
const key = (host: string, kind: "test" | "live") => `pk_${kind}_${btoa(`${host}$`)}`;

describe("clerkOrigin", () => {
  it("a development key: the frontend API inside it, as Clerk parses it", () => {
    const k = key("happy-otter-12.clerk.accounts.dev", "test");
    expect(publishableKeyFromHost("h2budget.example", k)).toBe(k); // App keeps a dev key as it is
    const o = clerkOrigin(k, undefined);
    const [js, ui] = scriptOrigins(publishableKeyFromHost("h2budget.example", k));
    expect(o).toEqual({ kind: "fixed", origin: js });
    expect(ui).toBe(js);
    expect(frontendApiOf(k)).toBe("happy-otter-12.clerk.accounts.dev");
  });

  it("a production key: Clerk uses clerk.<the page's host>, so the page works it out", () => {
    const k = key("clerk.other.example", "live");
    expect(clerkOrigin(k, undefined)).toEqual({ kind: "from-host" });
    for (const host of ["h2budget.onrender.com", "H2.Example.COM"]) {
      const [expected, ui] = scriptOrigins(publishableKeyFromHost(host, k));
      expect(ui).toBe(expected);
      // Run the inline script against a stand-in document and location.
      const links: Array<{ rel: string; href: string; crossOrigin?: string }> = [];
      const html = clerkPreconnectHtml({ kind: "from-host" });
      const body = /<script id="clerk-preconnect">([\s\S]*)<\/script>/.exec(html)![1]!;
      const doc = { head: { appendChild: (l: (typeof links)[number]) => links.push(l) }, createElement: () => ({}) };
      new Function("document", "location", body)(doc, { hostname: host });
      expect(links.map((l) => l.href)).toEqual([expected, expected, expected]);
      expect(links.map((l) => l.rel)).toEqual(["preconnect", "preconnect", "dns-prefetch"]);
      expect(links[0]!.crossOrigin).toBe("anonymous"); // clerk-js and its UI script load with crossorigin
      expect(links[1]!.crossOrigin).toBeUndefined(); // the API calls carry credentials
    }
  });

  it("an absolute proxy: its origin; a relative one: this origin, nothing to open", () => {
    const k = key("x.clerk.accounts.dev", "test");
    expect(clerkOrigin(k, "https://h2.example/__clerk")).toEqual({ kind: "fixed", origin: scriptOrigins(k, "https://h2.example/__clerk")[0] });
    expect(clerkOrigin(key("x.clerk.accounts.dev", "test"), "/__clerk")).toEqual({ kind: "none" });
  });

  it("no key, or a stand-in that is not a real key (the perf rig, the theme guard): nothing", () => {
    expect(clerkOrigin(undefined, undefined)).toEqual({ kind: "none" });
    expect(clerkOrigin("pk_test_perf", undefined)).toEqual({ kind: "none" });
    expect(clerkPreconnectHtml({ kind: "none" })).toBe("");
  });

  it("fixed: an anonymous and a credentialed preconnect, and a DNS hint", () => {
    const html = clerkPreconnectHtml({ kind: "fixed", origin: "https://x.clerk.accounts.dev" });
    expect(html).toBe(
      '<link rel="preconnect" href="https://x.clerk.accounts.dev" crossorigin />' +
        '<link rel="preconnect" href="https://x.clerk.accounts.dev" />' +
        '<link rel="dns-prefetch" href="https://x.clerk.accounts.dev" />',
    );
  });

  it("vite.config.ts injects it (the plugin is wired)", () => {
    const cfg = readFileSync(resolve(import.meta.dirname, "../../vite.config.ts"), "utf8");
    expect(cfg).toMatch(/plugins: \[[^\]]*clerkPreconnect\(\)/);
  });
});
