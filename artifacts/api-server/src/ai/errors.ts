import Anthropic from "@anthropic-ai/sdk";
import { AiFailure, type AiFailureInfo } from "./types";

// (AI-0) SDK error → AiFailure kind. Most specific class first; never match
// on message text. The SDK has already retried 408/409/429/5xx/connection
// errors `maxRetries` times before any of these reach us.

export function classifyError(err: unknown): AiFailureInfo {
  if (err instanceof AiFailure) return err.toInfo();
  const requestId =
    err instanceof Anthropic.APIError && err.requestID ? { requestId: err.requestID } : {};
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limited", retryable: true, message: msg, ...requestId };
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { kind: "timeout", retryable: true, message: msg, ...requestId };
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return { kind: "api_error", retryable: false, message: msg, ...requestId };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: "connection", retryable: true, message: msg, ...requestId };
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { kind: "api_error", retryable: false, message: msg, ...requestId };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { kind: "api_error", retryable: false, message: msg, ...requestId };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    // 408 / 409 / 5xx (incl. 529 overloaded) are worth a later retry; other 4xx are not.
    const retryable = status === 408 || status === 409 || status >= 500;
    return { kind: "api_error", retryable, message: msg, ...requestId };
  }
  return { kind: "api_error", retryable: false, message: msg };
}
