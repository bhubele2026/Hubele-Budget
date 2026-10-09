/**
 * (F8) Ported from the frozen h2 app (`artifacts/h2/src/data/aiStream.ts`) with
 * its tests; never imported from it. Classic adds one result, `aborted`: the
 * person pressed Stop (or left the page), which is neither an error nor a drop
 * to poll for.
 *
 * ⭐ THE ONE HAND-WRITTEN CALL: `POST /api/ai/chat` answers in server-sent
 * events, which the generated react-query client cannot read (the route is
 * tagged `ai-stream`). Everything else Ask does goes through generated hooks.
 *
 * - Frames are `event: <type>` + `data: <AiChatEvent JSON>`; `: ping` lines are
 *   comments. Every frame is checked here; an invalid one is ignored, never
 *   thrown. (`aiStream.test.ts` holds `isAiEvent` to the generated zod
 *   `AiChatResponse`, so the two cannot drift.)
 * - `token` text is shown as it arrives; `done.text` REPLACES it (the server's
 *   checked copy is the answer).
 * - A dropped stream (the reader throws, or ends with neither `done` nor
 *   `error`) is not an error: the caller polls `GET /ai/conversations/:id`
 *   until the stored answer exists (`pollForAnswer`).
 * - Nothing here works out a figure.
 */

export interface AiEvent {
  type: "token" | "tool" | "done" | "error";
  text?: string;
  name?: string;
  status?: "running" | "done" | "error";
  runId?: string;
  messageId?: string;
  grounded?: boolean;
  demo?: boolean;
  code?: string;
  message?: string;
  retryable?: boolean;
}

const TYPES = new Set(["token", "tool", "done", "error"]);
const STATUSES = new Set(["running", "done", "error"]);
const STRINGS = ["text", "name", "runId", "messageId", "code", "message"] as const;
const BOOLS = ["grounded", "demo", "retryable"] as const;

/** The same shape the generated `AiChatResponse` accepts. */
export function isAiEvent(v: unknown): v is AiEvent {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== "string" || !TYPES.has(o.type)) return false;
  if (o.status !== undefined && (typeof o.status !== "string" || !STATUSES.has(o.status))) return false;
  for (const k of STRINGS) if (o[k] !== undefined && typeof o[k] !== "string") return false;
  for (const k of BOOLS) if (o[k] !== undefined && typeof o[k] !== "boolean") return false;
  return true;
}

/** One SSE block (the text between blank lines) as an event, or null. */
export function parseFrame(block: string): AiEvent | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(data.join("\n"));
    return isAiEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every valid event in a byte stream, in order. A frame split across chunks is held until it is whole. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AiEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
        const event = parseFrame(block);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const last = parseFrame(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

export interface DoneEvent {
  text: string;
  runId: string | null;
  messageId: string | null;
  grounded: boolean;
  demo: boolean;
}

export type StreamResult =
  | { kind: "done"; done: DoneEvent }
  | { kind: "error"; code: string; message: string; retryable: boolean }
  | { kind: "dropped" }
  | { kind: "aborted" };

/** What a refused request says, in the server's own words where it sends them. */
const HTTP_WORDS: Record<number, string> = {
  400: "That question could not be sent. Try shorter words.",
  404: "That conversation is gone. Start a new one.",
  409: "H2 is still answering the last question.",
  429: "Ask is busy. Try again in a minute.",
};

export interface StreamOptions {
  conversationId: string;
  text: string;
  userAskedToChange: boolean;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onTool?: (name: string, status: "running" | "done" | "error") => void;
  fetchImpl?: typeof fetch;
}

/** Ask one question and follow the answer. Never throws: a drop is a result, and so is Stop. */
export async function streamAnswer(opts: StreamOptions): Promise<StreamResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const stopped = () => opts.signal?.aborted === true;
  if (stopped()) return { kind: "aborted" };
  let res: Response;
  try {
    res = await doFetch("/api/ai/chat", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        conversationId: opts.conversationId,
        text: opts.text,
        userAskedToChange: opts.userAskedToChange,
      }),
      signal: opts.signal,
    });
  } catch {
    return stopped() ? { kind: "aborted" } : { kind: "dropped" };
  }
  if (!res.ok || !res.body) {
    if (res.status === 401) return { kind: "error", code: "signed_out", message: "Sign in again to ask.", retryable: false };
    const message = HTTP_WORDS[res.status] ?? "Something went wrong. Try again.";
    return { kind: "error", code: `http_${res.status}`, message, retryable: res.status === 429 || res.status >= 500 };
  }
  try {
    for await (const e of readEvents(res.body)) {
      if (e.type === "token" && e.text) opts.onToken?.(e.text);
      else if (e.type === "tool" && e.name) opts.onTool?.(e.name, e.status ?? "running");
      else if (e.type === "done") {
        return {
          kind: "done",
          done: {
            text: e.text ?? "",
            runId: e.runId ?? null,
            messageId: e.messageId ?? null,
            grounded: e.grounded !== false,
            demo: e.demo === true,
          },
        };
      } else if (e.type === "error") {
        return {
          kind: "error",
          code: e.code ?? "api_error",
          message: e.message ?? "Something went wrong.",
          retryable: e.retryable === true,
        };
      }
    }
  } catch {
    return stopped() ? { kind: "aborted" } : { kind: "dropped" };
  }
  return stopped() ? { kind: "aborted" } : { kind: "dropped" };
}

export interface PollOptions {
  /** How many assistant messages the thread already had when the question was sent. */
  assistantBefore: number;
  getDetail: () => Promise<{ messages: ReadonlyArray<{ role: string }> }>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  tries?: number;
}

/** After a drop: read the thread until the answer is stored. True once it is, false if it never appears. */
export async function pollForAnswer(opts: PollOptions): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = opts.tries ?? 30;
  for (let i = 0; i < tries; i++) {
    await sleep(opts.intervalMs ?? 2000);
    try {
      const d = await opts.getDetail();
      const last = d.messages[d.messages.length - 1];
      const assistants = d.messages.filter((m) => m.role === "assistant").length;
      if (last?.role === "assistant" && assistants > opts.assistantBefore) return true;
    } catch {
      // keep polling: a blip is not an answer either way
    }
  }
  return false;
}
