/** The morning text's words, pure (the preview component is lazy). */

const URL_RE = /https?:\/\/\S+/g;
/** The recap ends with a link by design; the page shows the sentences only,
 *  and keeps the date the link carried as a quiet "for <date>". */
export function cleanRecap(text: string, facts?: Record<string, unknown>): { body: string; forDate: string | null } {
  const link = text.match(URL_RE)?.[0] ?? "";
  const fromLink = /[?&]d=(\d{4}-\d{2}-\d{2})/.exec(link)?.[1] ?? null;
  const fromFacts = [facts?.forDate, facts?.date].find((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) as string | undefined;
  return { body: text.replace(URL_RE, "").replace(/[ \t]+\n/g, "\n").trim(), forDate: fromFacts?.slice(0, 10) ?? fromLink };
}

/** Who wrote the words: code from the household's numbers (AI off), or a model draft. */
export function recapSourceWords(model: { demo?: boolean } | null | undefined): string {
  if (!model) return "Written from your numbers · AI is off";
  return model.demo ? "Demo draft" : "Model draft, figures from your numbers";
}

