import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  // (AI-0) Model inputs/outputs and phone traffic never reach the logs.
  // Log AI events under `ai.*` and SMS events under `sms.*` so these apply.
  "ai.description",
  "ai.text",
  "ai.body",
  "ai.messages",
  "ai.phone",
  "sms.to",
  "sms.body",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: LOG_REDACT_PATHS,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
