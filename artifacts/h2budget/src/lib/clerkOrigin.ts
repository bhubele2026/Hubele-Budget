/**
 * (perf phase 2) WHERE CLERK'S SCRIPT AND API LIVE, so `index.html` can open the
 * connection before the app has even downloaded (`clerkPreconnect()` in
 * vite.config.ts). Every open without the auth hint waits for clerk-js (and its
 * UI script) from that host, then a round trip to it: a preconnect takes the DNS,
 * TCP and TLS out of that wait.
 *
 * It mirrors how App.tsx hands Clerk its key, exactly (`clerkOrigin.test.ts` checks
 * it against Clerk's own `publishableKeyFromHost` / `parsePublishableKey`):
 *   - an absolute `VITE_CLERK_PROXY_URL` → that origin (a relative one is this origin: nothing to do);
 *   - a DEVELOPMENT key (`pk_test_…`) → the frontend API host encoded in it, fixed at build time;
 *   - a PRODUCTION key → `publishableKeyFromHost` ignores it and uses `clerk.<the page's host>`,
 *     so the origin is worked out in the page, from `location.hostname`.
 * A publishable key is public (it ships in the bundle); nothing secret is read.
 */
export type ClerkOrigin =
  | { kind: "fixed"; origin: string }
  | { kind: "from-host" }
  | { kind: "none" };

const HOST = /^[a-z0-9.-]+(?::\d+)?$/i;

function decodeBase64(s: string): string | null {
  try {
    return atob(s); // a browser and Node (≥ 16) both have it
  } catch {
    return null;
  }
}

/** The frontend API host a publishable key names, or null when it is not a well-formed key. */
export function frontendApiOf(key: string): string | null {
  const m = /^pk_(test|live)_(.+)$/.exec(key);
  if (!m) return null;
  const decoded = decodeBase64(m[2]!);
  if (!decoded || !decoded.endsWith("$")) return null;
  const host = decoded.slice(0, -1);
  return HOST.test(host) ? host : null;
}

export function clerkOrigin(publishableKey: string | undefined, proxyUrl: string | undefined): ClerkOrigin {
  if (proxyUrl) {
    if (!/^https?:\/\//i.test(proxyUrl)) return { kind: "none" }; // relative: this origin
    try {
      return { kind: "fixed", origin: new URL(proxyUrl).origin };
    } catch {
      return { kind: "none" };
    }
  }
  if (!publishableKey) return { kind: "none" };
  if (publishableKey.startsWith("pk_test_")) {
    const host = frontendApiOf(publishableKey);
    return host ? { kind: "fixed", origin: `https://${host}` } : { kind: "none" };
  }
  return { kind: "from-host" };
}

/** The `<head>` markup for `o`: preconnects (anonymous for the scripts, credentialed for the API) and a DNS hint. */
export function clerkPreconnectHtml(o: ClerkOrigin): string {
  if (o.kind === "none") return "";
  if (o.kind === "fixed") {
    const h = o.origin.replace(/"/g, "");
    return (
      `<link rel="preconnect" href="${h}" crossorigin />` +
      `<link rel="preconnect" href="${h}" />` +
      `<link rel="dns-prefetch" href="${h}" />`
    );
  }
  // Production: `clerk.` + the page's host, as `publishableKeyFromHost` builds it.
  return (
    `<script id="clerk-preconnect">(function(){try{var o="https://clerk."+location.hostname.toLowerCase(),h=document.head;` +
    `[["preconnect",1],["preconnect",0],["dns-prefetch",0]].forEach(function(r){var l=document.createElement("link");` +
    `l.rel=r[0];l.href=o;if(r[1])l.crossOrigin="anonymous";h.appendChild(l);});}catch(e){}})();</script>`
  );
}
