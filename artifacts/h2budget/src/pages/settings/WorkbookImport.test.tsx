import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImportHistoryItem, ImportPreview, ImportRestorePreview, ImportStateSummary } from "@workspace/api-client-react/features";

/**
 * ⭐ (W) SETTINGS › DATA › WORKBOOK IMPORT — preview, confirm, history, restore.
 * Rendered on the server's answers, every call mocked at the client boundary:
 * the upload only previews; the import runs only from "Replace" and carries the
 * preview's confirmation; a file with problems lists them all and offers no
 * confirm; a stale preview is previewed again; History shows Restore on the
 * one import that can be restored; Restore says what it puts back and removes
 * first, and a blocked one says why with the count. Synthetic numbers only.
 */
type Fn = Mock<(...args: unknown[]) => unknown>;
const m = vi.hoisted(() => ({
  preview: null as unknown as Fn,
  importer: null as unknown as Fn,
  restore: null as unknown as Fn,
  check: null as unknown as Fn,
  history: { items: [] as unknown[] },
}));
vi.mock("@workspace/api-client-react/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react/features")>();
  return {
    ...actual,
    usePreviewWorkbookImport: () => ({ mutate: m.preview, isPending: false }),
    useImportWorkbook: () => ({ mutate: m.importer, isPending: false }),
    useRestoreImportSnapshot: () => ({ mutate: m.restore, isPending: false }),
    useListImportHistory: () => ({ data: m.history, isLoading: false, isError: false }),
    getImportRestorePreview: (...args: unknown[]) => m.check(...args),
  };
});
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/settings", vi.fn()] as const }));

import { WorkbookImport } from "./WorkbookImport";

const STATE = (over: Partial<ImportStateSummary> = {}): ImportStateSummary => ({
  transactions: 340,
  bankTransactions: 220,
  bankFrom: "2026-07-01",
  bankTo: "2026-10-16",
  categories: 10,
  budgetLines: 10,
  debts: 2,
  rules: 5,
  recurring: 4,
  monthlySnapshots: 0,
  decisions: 3,
  splits: 0,
  ...over,
});
const PREVIEW: ImportPreview = {
  fileName: "synthetic.xlsx",
  confirmToken: "confirm-abc",
  adds: { transactions: 120, from: "2026-09-01", to: "2026-10-15", categories: 12, budgetLines: 12, debts: 3, rules: 8, recurring: 5, monthlySnapshots: 2 },
  replaces: STATE(),
  rulesKept: 1,
};
const item = (over: Partial<ImportHistoryItem>): ImportHistoryItem => ({
  batchId: "b-1",
  fileName: "synthetic.xlsx",
  importedAt: "2026-10-16T17:12:00.000Z",
  counts: { transactions: 120 },
  replaced: STATE(),
  snapshotId: "00000000-0000-4000-8000-000000000001",
  restoredAt: null,
  restore: "available",
  ...over,
});
const CHECK = (over: Partial<ImportRestorePreview> = {}): ImportRestorePreview => ({
  snapshotId: "00000000-0000-4000-8000-000000000001",
  batchId: "b-1",
  fileName: "synthetic.xlsx",
  importedAt: "2026-10-16T17:12:00.000Z",
  restoredAt: null,
  status: "ready",
  blockedBy: null,
  reason: null,
  putsBack: STATE(),
  removes: STATE({ transactions: 120, bankTransactions: 0, bankFrom: null, bankTo: null, categories: 12, rules: 8, debts: 3 }),
  changes: null,
  ...over,
});

let qc: QueryClient;
const mount = () => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkbookImport />
    </QueryClientProvider>,
  );
};
const FILE = new File(["synthetic"], "synthetic.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const pick = (file: File = FILE) => fireEvent.change(screen.getByLabelText("Upload workbook"), { target: { files: [file] } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T18:00:00Z"));
  m.preview = vi.fn((_v: unknown, o: { onSuccess?: (p: ImportPreview) => void }) => o.onSuccess?.(PREVIEW)) as unknown as Fn;
  m.importer = vi.fn() as unknown as Fn;
  m.restore = vi.fn() as unknown as Fn;
  m.check = vi.fn() as unknown as Fn;
  m.history = { items: [] };
  toastMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("(W) the upload previews first; nothing is imported without Replace", () => {
  it("names what it adds and what it replaces, bank rows and their days included", () => {
    mount();
    pick();
    expect(m.preview).toHaveBeenCalledWith({ data: { file: FILE } }, expect.anything());
    const box = screen.getByTestId("import-preview");
    expect(within(box).getByTestId("import-question").textContent).toBe("Replace 340 transactions, including 220 bank rows?");
    expect(within(box).getByTestId("import-adds").textContent).toBe("120 transactions, Sep 1 – Oct 15 · 12 categories · 8 rules · 3 debts");
    expect(within(box).getByTestId("import-replaces").textContent).toBe("340 transactions (220 bank rows, Jul 1 – Oct 16) · 10 categories · 5 rules · 2 debts");
    expect(box.textContent).toContain("1 of your rules");
    expect(box.textContent).toContain("H2 keeps a copy first. History can restore it.");
    expect(within(box).getByTestId("button-confirm-import").textContent).toBe("Replace");
    expect(m.importer).not.toHaveBeenCalled();
    // The question takes focus: a keyboard user answers it next.
    expect(document.activeElement).toBe(within(box).getByTestId("import-question"));
  });

  it("Replace sends the same file with the preview's confirmation; the line says Restore is in History", async () => {
    m.importer = vi.fn((_v: unknown, o: { onSuccess?: (r: unknown) => void }) =>
      o.onSuccess?.({ batchId: "b-2", counts: { transactions: 120, mapping_rules_preserved: 1, transactions_preserved: 0 }, ruleAttributions: [], snapshotId: "s-2" }),
    ) as unknown as Fn;
    mount();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    pick();
    fireEvent.click(screen.getByTestId("button-confirm-import"));
    expect(m.importer).toHaveBeenCalledWith({ data: { file: FILE, confirm: "confirm-abc" } }, expect.anything());
    expect(screen.getByTestId("import-result").textContent).toBe("Imported 120 rows · Restore available in History");
    expect(screen.queryByTestId("import-preview")).toBeNull();
    // Every screen reads the rows just replaced: all of it refetches.
    expect(invalidate).toHaveBeenCalledWith();
    const toast = toastMock.mock.calls.at(-1)![0] as { title: string; description: string };
    expect(toast).toMatchObject({ title: "Import complete", description: "Imported 120 rows · Restore available in History. Kept 1 rule and 0 category edits." });
  });

  it("Cancel imports nothing", () => {
    mount();
    pick();
    fireEvent.click(screen.getByTestId("button-cancel-import"));
    expect(screen.queryByTestId("import-preview")).toBeNull();
    expect(m.importer).not.toHaveBeenCalled();
  });

  it("with nothing to replace it asks to import, and the button says Import", () => {
    const empty = STATE({ transactions: 0, bankTransactions: 0, bankFrom: null, bankTo: null, categories: 0, budgetLines: 0, debts: 0, rules: 0, recurring: 0, decisions: 0 });
    m.preview = vi.fn((_v: unknown, o: { onSuccess?: (p: ImportPreview) => void }) => o.onSuccess?.({ ...PREVIEW, replaces: empty, rulesKept: 0 })) as unknown as Fn;
    mount();
    pick();
    expect(screen.getByTestId("import-question").textContent).toBe("Import 120 transactions?");
    expect(screen.getByTestId("import-replaces").textContent).toBe("0 transactions · 0 categories · 0 rules · 0 debts");
    expect(screen.getByTestId("button-confirm-import").textContent).toBe("Import");
  });

  it("a file with problems lists every one, in the server's words, and offers no confirm", () => {
    m.preview = vi.fn((_v: unknown, o: { onError?: (e: unknown) => void }) =>
      o.onError?.({
        status: 400,
        data: {
          error: 'Payments row 16: the amount "twelve" is not a number.',
          errors: ['Payments row 16: the amount "twelve" is not a number.', 'Recurring Items row 8: the day "soon" is not a day of the month.'],
        },
      }),
    ) as unknown as Fn;
    mount();
    pick();
    const box = screen.getByTestId("import-errors");
    expect(box.textContent).toContain("This file can't be imported:");
    expect(within(box).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      'Payments row 16: the amount "twelve" is not a number.',
      'Recurring Items row 8: the day "soon" is not a day of the month.',
    ]);
    expect(box.textContent).toContain("Fix the file and upload it again.");
    expect(screen.queryByTestId("button-confirm-import")).toBeNull();
  });

  it("a stale preview (409: a sync since) is previewed again with a note; nothing imported", () => {
    m.importer = vi.fn((_v: unknown, o: { onError?: (e: unknown) => void }) => o.onError?.({ status: 409, data: { code: "preview_stale" } })) as unknown as Fn;
    mount();
    pick();
    fireEvent.click(screen.getByTestId("button-confirm-import"));
    expect(m.preview).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("import-preview-notice").textContent).toBe("Your data changed since the preview. Check the new numbers.");
    expect(screen.queryByTestId("import-result")).toBeNull();
  });

  it("an import that failed says nothing was changed (never the raw HTTP error)", () => {
    m.importer = vi.fn((_v: unknown, o: { onError?: (e: unknown) => void }) => o.onError?.({ status: 500, data: { error: "The import could not be saved, so nothing was changed." } })) as unknown as Fn;
    mount();
    pick();
    fireEvent.click(screen.getByTestId("button-confirm-import"));
    expect(screen.getByTestId("import-failed").textContent).toBe("The import could not be saved, so nothing was changed.");
  });
});

describe("(W) History and Restore", () => {
  it("lists the imports; only the one that can be restored has Restore, the others say why", () => {
    m.history = {
      items: [
        item({ batchId: "b-3", restore: "available" }),
        item({ batchId: "b-2", restore: "later_import", fileName: "older.xlsx" }),
        item({ batchId: "b-1", restore: "restored", restoredAt: "2026-10-16T18:30:00.000Z", fileName: "first.xlsx", counts: { transactions: 7 } }),
        item({ batchId: "b-0", restore: "too_old", counts: null, snapshotId: "00000000-0000-4000-8000-000000000009", fileName: null }),
      ],
    };
    mount();
    const rows = screen.getAllByTestId("import-history-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Oct 16, 12:12 PM · synthetic.xlsx · 120 rowsRestore",
      "Oct 16, 12:12 PM · older.xlsx · 120 rowsRestore the newer import first",
      "Oct 16, 12:12 PM · first.xlsx · 7 rowsRestored Oct 16, 1:30 PM",
      "Oct 16, 12:12 PM · WorkbookToo old to restore",
    ]);
    expect(screen.getAllByTestId("button-restore-import")).toHaveLength(1);
  });

  it("no imports yet says so", () => {
    mount();
    expect(screen.getByTestId("import-history-empty").textContent).toBe("No imports yet.");
  });

  it("Restore first says what it puts back and removes; confirm restores and says so", async () => {
    m.history = { items: [item({})] };
    m.check = vi.fn(async () => CHECK()) as unknown as Fn;
    m.restore = vi.fn((_v: unknown, o: { onSuccess?: () => void }) => o.onSuccess?.()) as unknown as Fn;
    mount();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    fireEvent.click(screen.getByTestId("button-restore-import"));
    expect(m.check).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    const box = await screen.findByTestId("restore-preview");
    expect(box.textContent).toContain("Restore your data from before this import?");
    expect(within(box).getByTestId("restore-puts-back").textContent).toBe("340 transactions (220 bank rows, Jul 1 – Oct 16) · 10 categories · 5 rules · 2 debts");
    expect(within(box).getByTestId("restore-removes").textContent).toBe("120 transactions · 12 categories · 8 rules · 3 debts");
    expect(m.restore).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByTestId("button-confirm-restore"));
    expect(m.restore).toHaveBeenCalledWith({ snapshotId: "00000000-0000-4000-8000-000000000001" }, expect.anything());
    expect(screen.getByTestId("restore-result").textContent).toBe("Restored · 340 transactions back");
    expect(screen.queryByTestId("restore-preview")).toBeNull();
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("a blocked restore says why, with the count, and offers no Restore", async () => {
    m.history = { items: [item({})] };
    const reason = "Blocked: 2 changes since this import would be lost (1 new bank row, 1 edited row).";
    m.check = vi.fn(async () => CHECK({ status: "blocked", blockedBy: "changed_since", reason })) as unknown as Fn;
    mount();
    fireEvent.click(screen.getByTestId("button-restore-import"));
    const box = await screen.findByTestId("restore-preview");
    expect(within(box).getByTestId("restore-blocked").textContent).toBe(reason);
    expect(within(box).queryByTestId("button-confirm-restore")).toBeNull();
    expect(within(box).getByTestId("button-cancel-restore").textContent).toBe("Close");
  });

  it("a restore the server refuses keeps the explanation and shows its reason", async () => {
    m.history = { items: [item({})] };
    m.check = vi.fn(async () => CHECK()) as unknown as Fn;
    m.restore = vi.fn((_v: unknown, o: { onError?: (e: unknown) => void }) => o.onError?.({ status: 409, data: { error: "This import was already restored." } })) as unknown as Fn;
    mount();
    fireEvent.click(screen.getByTestId("button-restore-import"));
    const box = await screen.findByTestId("restore-preview");
    fireEvent.click(within(box).getByTestId("button-confirm-restore"));
    await waitFor(() => expect(screen.getByTestId("restore-error").textContent).toBe("This import was already restored."));
    expect(screen.queryByTestId("restore-result")).toBeNull();
  });

  it("a restore check that fails says nothing was changed", async () => {
    m.history = { items: [item({})] };
    m.check = vi.fn(async () => {
      throw { status: 500, data: null };
    }) as unknown as Fn;
    mount();
    fireEvent.click(screen.getByTestId("button-restore-import"));
    expect((await screen.findByTestId("restore-failed")).textContent).toBe("The restore check could not be made. Nothing was changed.");
  });
});
