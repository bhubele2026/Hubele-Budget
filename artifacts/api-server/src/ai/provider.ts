import type Anthropic from "@anthropic-ai/sdk";
import type * as z from "zod/v4";
import type { AiTask, AiEffort } from "./config";
import type { TokenUsage } from "./types";

// (AI-0) The seam between runStructured and whoever answers: the Anthropic
// API, or the deterministic fake used by tests and demo mode.

export type AiProviderName = "anthropic" | "fake";

export interface StructuredCall {
  task: AiTask;
  model: string;
  effort: AiEffort;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  /** Stable system text; sent as one block with cache_control. */
  system: string;
  messages: Anthropic.MessageParam[];
  /** zod/v4 schema — turned into the request's JSON schema. */
  schema: z.ZodType;
}

export interface StructuredResponse {
  /** The JSON the model returned, decoded but NOT yet schema-checked; null when it did not decode. */
  parsed: unknown | null;
  parseError: string | null;
  stopReason: string | null;
  /** The model that actually answered (priced from this). */
  model: string;
  usage: TokenUsage;
  requestId: string | null;
  demo: boolean;
}

export interface AiProvider {
  readonly name: AiProviderName;
  callStructured(call: StructuredCall): Promise<StructuredResponse>;
}
