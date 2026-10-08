// (AI-2) What a tool hands back to the model: JSON text, at most 2,000
// characters and 25 rows. When a result is too big the longest list loses
// rows (then the largest field is left out) and says so: `truncated: true`
// and, for a field, `omitted: [...]`. Nothing is silently cut.

export const RESULT_CHAR_CAP = 2000;
export const RESULT_ROW_CAP = 25;

export function capRows<T>(rows: readonly T[], max = RESULT_ROW_CAP): T[] {
  return rows.slice(0, Math.min(max, RESULT_ROW_CAP));
}

const len = (v: unknown): number => JSON.stringify(v).length;

export function toResult(obj: Record<string, unknown>): string {
  let s = JSON.stringify(obj);
  if (s.length <= RESULT_CHAR_CAP) return s;
  const out: Record<string, unknown> = { ...obj, truncated: true };
  for (let guard = 0; guard < 400; guard++) {
    s = JSON.stringify(out);
    if (s.length <= RESULT_CHAR_CAP) return s;
    // The longest list gives up its last row.
    let listKey: string | null = null;
    let listLen = 0;
    for (const [k, v] of Object.entries(out)) {
      if (Array.isArray(v) && v.length > 0 && len(v) > listLen) {
        listKey = k;
        listLen = len(v);
      }
    }
    if (listKey) {
      (out[listKey] as unknown[]) = (out[listKey] as unknown[]).slice(0, -1);
      continue;
    }
    // No list left: leave out the largest field.
    let bigKey: string | null = null;
    let bigLen = 0;
    for (const [k, v] of Object.entries(out)) {
      if (k === "truncated" || k === "omitted") continue;
      if (len(v) > bigLen) {
        bigKey = k;
        bigLen = len(v);
      }
    }
    if (!bigKey) break;
    delete out[bigKey];
    out.omitted = [...((out.omitted as string[] | undefined) ?? []), bigKey];
  }
  return JSON.stringify({ error: "result_too_large" });
}

export const notFound = (): string => JSON.stringify({ error: "not_found" });
export const failure = (error: string): string => JSON.stringify({ error });
