// The harness's whole API: a Vite dev-server middleware that answers every
// `/api/*` request from the invented household in `fixture.mjs` (+ the page
// fixtures gathered in `routes.mjs`). Nothing is proxied, nothing touches a
// database. An endpoint not listed is logged (`[fc-api] UNHANDLED …`) and
// answered with a safe empty value, so a new one shows up in the dev-server
// output instead of breaking the page.
//
// Test hooks (all per request, by header, so a browser context can choose them
// with `extraHTTPHeaders`):
//   x-scenario: under|over|…           the home page's scenario (home.mjs)
//   x-guard-appearance: auto|light|dark|time|none
//                                      sets `guardState.appearance` first (`none` → null)
//   x-guard-fail-put: 1                PUT /api/me/ui-preferences answers 500
//   x-guard-me-delay: <ms>             GET /api/me waits that long
import * as fx from "./fixture.mjs";
import * as home from "./home.mjs";
import { GET_EXACT, GET_PATTERNS, QUIET_EMPTY, WRITES } from "./routes.mjs";

/**
 * What a test can read or set from outside. `appearance` non-null → GET /api/me
 * carries it. `mePatch` is merged over GET /api/me. `puts` is every raw body
 * PUT to /api/me/ui-preferences, in order.
 */
export const guardState = { appearance: null, mePatch: {}, puts: [] };
/** The stored ui-preferences object (PUTs merge into it; GET answers it). */
const uiPrefs = {};
const APPEARANCES = new Set(["auto", "light", "dark", "time"]);

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

const num = (v) => (v == null || v === "" ? undefined : Number(v));

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.setEncoding?.("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(raw));
  });
const parse = (raw) => {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

function meBody() {
  const me = { ...fx.me, ...guardState.mePatch };
  if (guardState.appearance != null) me.appearance = guardState.appearance;
  return me;
}

/** GET routes: pathname → (query) => body. The page fixtures (routes.mjs) are merged over these. */
const GET = {
  "/api/forecast": (q) => fx.forecastBundle({ days: num(q.get("days")) ?? 90 }),
  "/api/forecast/cash-signal": (q) =>
    fx.cashSignal({ horizonDays: num(q.get("horizonDays")) ?? 90, fromDate: q.get("fromDate") || undefined }),
  "/api/forecast/avalanche-schedule": () => fx.avalancheSchedule(),
  "/api/forecast/settings": () => fx.forecastSettings,
  "/api/forecast/review-count": () => ({ count: fx.spine().reviewCount }),
  "/api/spine": () => home.spine(),
  "/api/money/position": () => home.moneyPosition(),
  "/api/settings": () => home.settings,
  "/api/avalanche/weekly": () => home.avalancheWeekly(),
  "/api/recap/preview": () => home.recapPreview,
  "/api/me": () => meBody(),
  "/api/me/ui-preferences": () => uiPrefs,
  "/api/budget/categories": () => fx.categories,
  "/api/recurring-items": () => fx.recurringItems,
  "/api/avalanche/settings": () => fx.avalancheSettings,
  "/api/avalanche/extra": () => fx.avalancheExtra,
  "/api/version": () => ({ version: "dev", buildId: "dev" }),
  // The page fixtures win where both name a path.
  ...GET_EXACT,
};

export function fixtureApi({ log = true } = {}) {
  const seen = new Set();
  return {
    name: "fc-fixture-api",
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
    configureServer(server) {
      server.middlewares.use(handle);
    },
  };
  function handle(req, res, next) {
    if (!req.url || !req.url.startsWith("/api/")) return next();
    const url = new URL(req.url, "http://fixture.local");
    const path = url.pathname.replace(/\/+$/, "");
    const method = (req.method ?? "GET").toUpperCase();
    home.state.scenario = String(req.headers["x-scenario"] ?? "under");
    const wanted = req.headers["x-guard-appearance"];
    if (wanted != null) {
      const w = String(wanted);
      if (w === "none") guardState.appearance = null;
      else if (APPEARANCES.has(w)) guardState.appearance = w;
    }
    const fail = (e) => {
      console.error(`[fc-api] ERROR ${method} ${path}:`, e);
      if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
    };
    try {
      if (method === "GET") {
        const note = () => {
          if (log && !seen.has(path)) {
            seen.add(path);
            console.log(`[fc-api] ${method} ${path}${url.search}`);
          }
        };
        if (path === "/api/me") {
          const wait = Number(req.headers["x-guard-me-delay"] ?? 0);
          note();
          if (wait > 0) {
            setTimeout(() => {
              try {
                json(res, 200, meBody());
              } catch (e) {
                fail(e);
              }
            }, wait);
            return;
          }
          return json(res, 200, meBody());
        }
        if (GET[path]) {
          note();
          return json(res, 200, GET[path](url.searchParams));
        }
        for (const [re, fn] of GET_PATTERNS) {
          const m = re.exec(path);
          if (!m) continue;
          note();
          const body = fn(m, url.searchParams);
          if (body === undefined) return json(res, 404, { error: "not_found" });
          return json(res, 200, body);
        }
        if (path in QUIET_EMPTY) return json(res, 200, QUIET_EMPTY[path]);
        if (log) console.warn(`[fc-api] UNHANDLED GET ${path}${url.search} → {}`);
        return json(res, 200, {});
      }
      // Writes: nothing is stored (except the ui-preferences), every one answers harmlessly.
      readBody(req)
        .then((raw) => {
          if (method === "PUT" && path === "/api/me/ui-preferences") {
            guardState.puts.push(raw);
            if (String(req.headers["x-guard-fail-put"] ?? "") === "1") return json(res, 500, { error: "guard_fail_put" });
            const body = parse(raw);
            Object.assign(uiPrefs, body);
            if ("appearance" in body) guardState.appearance = body.appearance ?? null;
            return json(res, 200, uiPrefs);
          }
          const body = parse(raw);
          const key = `${method} ${path}`;
          if (WRITES.exact[key]) return json(res, 200, WRITES.exact[key](body, url.searchParams));
          for (const [m0, re, fn] of WRITES.patterns) {
            if (m0 !== method) continue;
            const m = re.exec(path);
            if (m) return json(res, 200, fn(m, body, url.searchParams));
          }
          if (log) console.warn(`[fc-api] write ${method} ${path} → { ok: true }`);
          return json(res, 200, { ok: true });
        })
        .catch(fail);
    } catch (e) {
      fail(e);
    }
  }
}
