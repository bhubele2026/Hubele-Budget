import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
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

app.use(cors({ credentials: true, origin: true }));
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

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

// Terminal error handler. Express 5 forwards rejected async-handler promises
// here automatically, so no route can hang on an unhandled rejection. We log
// the full error via the request-scoped pino logger and return a sanitized
// JSON body — never a stack trace or internal message to the client. (Phase 1.)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const log = req.log ?? logger;
  log.error({ err }, "Unhandled error in request");
  if (res.headersSent) return;
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : typeof (err as { statusCode?: unknown })?.statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: status >= 400 && status < 500 ? "Bad request" : "Internal server error",
  });
});

export default app;
