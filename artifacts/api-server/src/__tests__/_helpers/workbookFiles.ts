import * as XLSX from "xlsx";

// (Task 7, V) Test-only: a household workbook built in memory, in the layout
// `lib/workbookImporter.ts` reads, so a suite can upload a real file through
// `POST /api/import/workbook`. Synthetic names and amounts only.
//
// Layout (0-based rows; the importer skips the header rows):
//   Debt Tracker      rows 4+  [_, name, type, apr, balance, minPayment]
//   Monthly Budget    rows 5+  [num, category, planned, _, _, _, note]
//   Recurring Items   rows 5+  [_, name, kind, amount, frequency, dayOfMonth, anchorDate, active]
//   Mapping           rows 4+  [pattern, targetCategory]
//   Payments          rows 5+  [_, date, description, type, targetCategory, amount, _, notes]
//   Monthly Tracking  row 4 = [_, _, "Sep 2026", …], rows 5+ [_, metric, value per month] (optional)

export interface WbDebt { name: string; type?: string; apr: unknown; balance: unknown; min: unknown }
export interface WbBudget { name: string; planned: unknown; note?: string | null }
export interface WbRecurring {
  name: string;
  kind?: string;
  amount: unknown;
  frequency?: string;
  day?: number | null;
  anchor?: unknown;
  active?: string;
}
export interface WbRule { pattern: string; target: string | null }
export interface WbPayment {
  date: unknown;
  description: string;
  type?: string;
  target?: string | null;
  amount: unknown;
  notes?: string | null;
}
export interface WbTracking { months: string[]; metrics: Array<{ name: string; values: unknown[] }> }

export interface WorkbookSpec {
  debts?: WbDebt[];
  budget?: WbBudget[];
  recurring?: WbRecurring[];
  rules?: WbRule[];
  payments?: WbPayment[];
  tracking?: WbTracking;
  /** Required sheets to leave out (a malformed workbook). */
  omit?: string[];
  /** Sheets the importer does not read (they must be ignored). */
  extraSheets?: Record<string, unknown[][]>;
}

const pad = (n: number, label: string): unknown[][] => Array.from({ length: n }, () => [label]);

export function buildWorkbook(spec: WorkbookSpec): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const omit = new Set(spec.omit ?? []);
  const add = (name: string, rows: unknown[][]) => {
    if (!omit.has(name)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  };
  add("Debt Tracker", [
    ...pad(4, "DEBTS"),
    ...(spec.debts ?? []).map((d) => [null, d.name, d.type ?? "Card", d.apr, d.balance, d.min]),
  ]);
  add("Monthly Budget", [
    ...pad(5, "BUDGET"),
    ...(spec.budget ?? []).map((b, i) => [i + 1, b.name, b.planned, null, null, null, b.note ?? null]),
  ]);
  add("Recurring Items", [
    ...pad(5, "RECURRING"),
    ...(spec.recurring ?? []).map((r) => [
      null,
      r.name,
      r.kind ?? "Expense",
      r.amount,
      r.frequency ?? "monthly",
      r.day ?? null,
      r.anchor ?? null,
      r.active ?? "Yes",
    ]),
  ]);
  add("Mapping", [...pad(4, "MAPPING"), ...(spec.rules ?? []).map((r) => [r.pattern, r.target])]);
  add("Payments", [
    ...pad(5, "PAYMENTS"),
    ...(spec.payments ?? []).map((p) => [
      null,
      p.date,
      p.description,
      p.type ?? "Expense",
      p.target ?? null,
      p.amount,
      null,
      p.notes ?? null,
    ]),
  ]);
  if (spec.tracking) {
    add("Monthly Tracking", [
      ...pad(4, "TRACKING"),
      [null, null, ...spec.tracking.months],
      ...spec.tracking.metrics.map((m) => [null, m.name, ...m.values]),
    ]);
  }
  for (const [name, rows] of Object.entries(spec.extraSheets ?? {})) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return wb;
}

export type BookType = "xlsx" | "xlsm" | "xls" | "ods" | "csv";

/** The workbook as the bytes a browser would upload. */
export function workbookFile(spec: WorkbookSpec, bookType: BookType = "xlsx"): Buffer {
  return XLSX.write(buildWorkbook(spec), { type: "buffer", bookType }) as Buffer;
}
