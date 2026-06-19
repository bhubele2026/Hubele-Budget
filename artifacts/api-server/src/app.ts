import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { logAprilChaseSeedBootStatus } from "./lib/aprilChaseSeed";

// (#711) Announce on boot whether the April-2026 Chase placeholder
// seeder is armed for this process. Skipping production runs is the
// default; an explicit env flag or household allowlist is required to
// re-enable it. See `aprilChaseSeed.ts` for the full gate rules.
logAprilChaseSeedBootStatus();

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// CORS: origin:true reflects the request's Origin header back, which is
// INTENTIONAL here. This API is fronted by the same deployment as the SPA
// and is only ever called from the app's own origin (plus the Clerk proxy);
// credentials:true requires a concrete origin (the spec forbids "*" with
// credentials), so reflecting the caller's origin is the supported pattern
// for a first-party app. Do NOT tighten this to a hard-coded host without
// also updating the Replit/preview/custom-domain origins, or the SPA breaks.
app.use(cors({ credentials: true, origin: true }));

// Security headers. helmet only SETS response headers — it never parses or
// blocks the request body, so it is safe to register before the raw-body
// capture and JSON parsers below. contentSecurityPolicy is DISABLED on
// purpose: the SPA is served from the same origin and helmet's default CSP
// (default-src 'self') would block inline styles/scripts and the Clerk
// widget, breaking the app. crossOriginEmbedderPolicy is left off so
// third-party embeds (Plaid Link, Clerk) keep working.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// Plaid webhooks are JWT-signed and the JWT carries a SHA-256 of the raw
// request body, so we MUST capture the unparsed bytes for that one route
// before express.json() turns the body into a JS object. `type: () => true`
// makes the raw parser fire regardless of what Content-Type Plaid sends.
app.use(
  "/api/plaid/webhook",
  express.raw({ type: () => true, limit: "1mb" }),
);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Basic abuse limiter for the JSON API. Registered AFTER the body parsers
// (so raw-body capture and JSON parsing are untouched) and scoped to /api
// so it never throttles the SPA's static assets or the Clerk proxy. The
// Plaid webhook is EXEMPTED — Plaid retries aggressively and a 429 there
// would drop legitimate bank updates; that route is already authenticated
// by its signed JWT. Limits are deliberately generous (a logged-in app
// session makes many XHRs); this exists to blunt scripted abuse, not to
// rate-shape normal use. Window/cap are env-tunable for ops.
const rateWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const rateMax = Number(process.env.RATE_LIMIT_MAX) || 600;
app.use(
  "/api",
  rateLimit({
    windowMs: rateWindowMs,
    max: rateMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/plaid/webhook" || req.path === "/health",
  }),
);

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
