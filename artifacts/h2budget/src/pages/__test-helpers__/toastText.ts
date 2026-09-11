import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * (PR14 review NIT) The Chase review toasts carry their counts in mono spans, so
 * a title is a React node, not a string. Tests read what a person reads: the
 * node's text.
 */
export function nodeText(node: unknown): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  return renderToStaticMarkup(createElement(Fragment, null, node as ReactNode))
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

type ToastArg = { title?: unknown; description?: unknown; variant?: string; action?: unknown };

/** Every call of a mocked `toast`, as text. */
export function toastTexts(toast: { mock: { calls: unknown[][] } }) {
  return toast.mock.calls.map(([arg]) => {
    const a = (arg ?? {}) as ToastArg;
    return {
      title: nodeText(a.title),
      description: nodeText(a.description),
      variant: a.variant,
      action: a.action,
    };
  });
}
