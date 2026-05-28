// (#802 — Phase E) One-way bridge from anywhere in the app to the
// floating <AdvisorChat /> singleton.
//
// The chat is mounted once at the page-shell level; pages that want
// to "open the chat with a starter question + context" dispatch a
// window event via openAdvisorChatWithContext, and the chat listens
// (via subscribeOpenWithContext) to open itself and pre-fill the
// composer. Using a window CustomEvent rather than a shared store
// keeps the chat component fully self-contained — debrief.tsx
// imports zero chat internals.

export interface AdvisorChatContext {
  // Week being asked about — used to scope the starter prompt.
  weekStart: string;
  // Optional pre-baked starter (e.g. "Why did Groceries run over?").
  // If omitted, the chat composer is just opened empty.
  prompt?: string;
  // Optional context block the chat will prepend to the FIRST user
  // message it sends, so the model sees concrete facts about the
  // week without needing a dedicated tool. Plain text; keep short.
  contextBlock?: string;
}

const EVENT_NAME = "advisor:open-with-context";

export function openAdvisorChatWithContext(ctx: AdvisorChatContext): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AdvisorChatContext>(EVENT_NAME, { detail: ctx }),
  );
}

/** Returns an unsubscribe function. Intended to be called from a useEffect. */
export function subscribeOpenWithContext(
  handler: (ctx: AdvisorChatContext) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const ce = e as CustomEvent<AdvisorChatContext>;
    if (ce.detail) handler(ce.detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
