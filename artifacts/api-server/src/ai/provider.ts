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

/** (AI-2) A tool the model may call. `run` returns the text the model reads. */
export interface AgentTool {
  name: string;
  description: string;
  /** zod/v4 object schema; `.strict()` so the model cannot pass extra keys. */
  inputSchema: z.ZodType;
  run(input: any): Promise<string>;
}

export interface ToolLoopCall {
  task: AiTask;
  model: string;
  effort: AiEffort;
  maxTokens: number;
  maxIterations: number;
  system: string;
  /** Plain text turns (user / assistant) — tool turns are never replayed. */
  messages: Anthropic.MessageParam[];
  tools: AgentTool[];
  /** Aborts the loop (wall clock, client gone). */
  signal?: AbortSignal;
  /** Text as it is written (streamed deltas, or whole chunks from the fake). */
  onText?: (delta: string) => void;
}

export interface ToolLoopTurn {
  model: string;
  usage: TokenUsage;
  requestId: string | null;
  stopReason: string | null;
}

export interface ToolLoopResponse {
  /** The text blocks of the final assistant message. */
  text: string;
  /** The final message's stop reason (`end_turn`, `refusal`, `max_tokens`, or `tool_use` when the iteration cap cut it). */
  stopReason: string | null;
  /** One entry per API request, in order (each becomes an ai_usage row). */
  turns: ToolLoopTurn[];
  demo: boolean;
}

export interface AiProvider {
  readonly name: AiProviderName;
  callStructured(call: StructuredCall): Promise<StructuredResponse>;
  /** (AI-2) The tool loop: model <-> tools until a final answer, a refusal or the cap. */
  runTools(call: ToolLoopCall): Promise<ToolLoopResponse>;
}
