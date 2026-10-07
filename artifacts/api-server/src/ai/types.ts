// (AI-0) The shapes every AI call returns. A model call never throws into a
// caller: it resolves to an AiResult, and the failure says what happened and
// whether trying again later could help.

export const AI_FAILURE_KINDS = [
  "disabled",
  "budget_exceeded",
  "rate_limited",
  "timeout",
  "connection",
  "api_error",
  "parse_failed",
  "validation_failed",
  "refusal",
  "max_tokens",
] as const;
export type AiFailureKind = (typeof AI_FAILURE_KINDS)[number];

export interface AiFailureInfo {
  kind: AiFailureKind;
  /** True when the same call may succeed later (a transient condition). */
  retryable: boolean;
  message: string;
  requestId?: string;
}

/** Thrown inside the AI layer (assertBudget); runStructured turns it into an AiResult. */
export class AiFailure extends Error implements AiFailureInfo {
  readonly kind: AiFailureKind;
  readonly retryable: boolean;
  readonly requestId?: string;
  constructor(info: AiFailureInfo) {
    super(info.message);
    this.name = "AiFailure";
    this.kind = info.kind;
    this.retryable = info.retryable;
    if (info.requestId) this.requestId = info.requestId;
  }
  toInfo(): AiFailureInfo {
    return {
      kind: this.kind,
      retryable: this.retryable,
      message: this.message,
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface AiUsageSummary extends TokenUsage {
  /** Sum over every attempt; null when any attempt's model had no price. */
  costUsd: number | null;
  latencyMs: number;
  attempts: number;
  model: string;
  provider: "anthropic" | "fake";
}

export type AiResult<T> =
  | {
      ok: true;
      value: T;
      usage: AiUsageSummary;
      /** True when the fake provider answered — a UI labels the output "Demo". */
      demo: boolean;
    }
  | { ok: false; failure: AiFailureInfo; usage?: AiUsageSummary };
