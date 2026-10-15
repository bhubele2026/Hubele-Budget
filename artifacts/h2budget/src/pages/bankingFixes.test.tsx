import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * (Q5) The correction workflow on Banking › Proposed fixes: Preview (a dry run:
 * rows and totals before → after), Apply (asks once), a toast with Undo, and the
 * "Applied fixes" history with its own Undo. Endpoints are mocked; every figure
 * is a string the server would send. Synthetic fixtures only.
 */
const h = vi.hoisted(() => ({
  owner: true as boolean,
  proposals: undefined as unknown,
  applied: { items: [] as unknown[] } as { items: unknown[] },
  dry: vi.fn(),
  apply: vi.fn(),
  undo: vi.fn(),
  toastWith: vi.fn(),
  toast: vi.fn(),
  /** What the applied-list hook was asked: the member's server answer is 403 */
  appliedIsError: false,
  appliedAsked: 0,
}));

vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react")>()),
  useListPlaidItems: () => ({
    data: [{ id: "i1", itemId: "pi-1", institutionName: "Chase", institutionSlug: "chase", lastSyncedAt: null, lastSyncError: null, lastSyncErrorCode: null,
      accounts: [{ id: "acct-chk", accountId: "ext-chk", name: "Total Checking", mask: "4321", type: "depository", subtype: "checking" }] }],
    isError: false,
  }),
  useGetMe: () => ({ data: { isOwner: h.owner }, isError: false }),
}));
vi.mock("@workspace/api-client-react/features", async (orig) => {
  const React = await import("react");
  return {
    ...(await orig<typeof import("@workspace/api-client-react/features")>()),
    getGetReviewProposalsQueryKey: () => ["/api/review/proposals"],
    getListAppliedReviewProposalsQueryKey: () => ["/api/review/proposals/applied"],
    useGetReviewProposals: () => ({ data: h.proposals, isError: false, refetch: vi.fn() }),
    useListAppliedReviewProposals: (opts?: { query?: { enabled?: boolean } }) => {
      if (opts?.query?.enabled === false) return { data: undefined, isError: false };
      h.appliedAsked += 1;
      return h.appliedIsError ? { data: undefined, isError: true } : { data: h.applied, isError: false };
    },
    undoAppliedReviewProposal: (id: string) => h.undo(id),
    useApplyReviewProposal: () => {
      const [pending, setPending] = React.useState(false);
      return {
        isPending: pending,
        mutateAsync: async (vars: { key: string; data: unknown; params?: { dryRun?: string } }) => {
          setPending(true);
          try {
            return await (vars.params?.dryRun ? h.dry(vars) : h.apply(vars));
          } finally {
            setPending(false);
          }
        },
        mutate: (vars: { key: string; data: unknown; params?: { dryRun?: string } }, cbs?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
          setPending(true);
          const run = vars.params?.dryRun ? h.dry(vars) : h.apply(vars);
          void Promise.resolve(run).then(
            (r) => { setPending(false); cbs?.onSuccess?.(r); },
            (e) => { setPending(false); cbs?.onError?.(e); },
          );
        },
      };
    },
  };
});
vi.mock("@/components/ui/action-toast", () => ({ toastWithActions: (o: unknown) => h.toastWith(o) }));
vi.mock("@/hooks/use-toast", async (orig) => ({ ...(await orig<Record<string, unknown>>()), toast: (o: unknown) => h.toast(o) }));

import { ProposedFixes } from "./banking/ProposedFixes";

const rowOf = (i: number) => ({
  id: `r${i}`, date: `2026-10-0${i}`, displayName: "Peartree Savings", description: "PEARTREE", amount: "-20.00", pending: false, source: "plaid:chase",
  account: { id: "a", institution: "Chase", name: "Total Checking", mask: "4321", externalId: "ext-chk" },
  category: { id: "c-din", name: "Dining" }, occurrence: null,
});
const proposal = (o: Record<string, unknown> = {}) => ({
  key: "transfer:1", proposalHash: "hash-1", kind: "transfer", rowCount: 2, truncated: false, total: "40.00",
  rows: [rowOf(1), rowOf(2)],
  evidence: [{ field: "pfc_primary", value: "TRANSFER_OUT" }],
  action: { code: "file_as_transfer", target: { kind: "category", id: "c-tr", label: "Transfer", categoryId: "c-tr", categoryName: "Transfer" } },
  applyWith: ["categories_change"],
  ...o,
});
const state = (o: Record<string, unknown> = {}) => ({ categoryId: "c-din", categoryLockedByUser: false, categoryProvisional: false, isTransfer: false, isTransferUserOverridden: false, weeklyAllowance: true, monthlyAllowance: false, unplannedAllowance: false, ...o });
const period = (known: string, unresolved: string, actual: string) => ({ start: "2026-10-11", end: "2026-10-17", plan: "300.00", actual, known, unresolved, remaining: "20.24", over: null });
const buckets = (n: number) => Object.fromEntries(["amountDifference", "timingDifference", "confirmedUnplanned", "uncertain", "unmatched"].map((k) => [k, { count: k === "unmatched" ? n : 0, moneyIn: "0.00", moneyOut: k === "unmatched" ? String(n * 20) + ".00" : "0.00", net: "0.00" }]));
const preview = (o: Record<string, unknown> = {}) => ({
  dryRun: true,
  proposal: { key: "transfer:1", kind: "transfer", proposalHash: "hash-1", action: "file_as_transfer", label: "File as a transfer" },
  rows: [1, 2].map((i) => ({ ...rowOf(i), before: state(), after: state({ categoryId: "c-tr", isTransfer: true, weeklyAllowance: false }), resolution: null, resolutionSkipped: null })),
  replaces: [],
  learnsMemory: true,
  figures: {
    week: { before: period("279.76", "40.00", "319.76"), after: period("279.76", "0.00", "279.76") },
    month: { before: period("900.00", "40.00", "940.00"), after: period("900.00", "0.00", "900.00") },
    budgetMonths: [],
    banking: [{
      account: { id: "acct-chk", institution: "Chase", name: "Total Checking", mask: "4321" }, from: "2026-10-01", to: "2026-10-14",
      before: { buckets: buckets(2), asPlanned: { count: 0, net: "0.00" }, unresolvedInRange: 2 },
      after: { buckets: buckets(0), asPlanned: { count: 0, net: "0.00" }, unresolvedInRange: 0 },
    }],
  },
  limitations: [],
  ...o,
});
const appliedRecord = { dryRun: false, applicationId: "app-1", appliedAt: "2026-10-14T17:00:00Z", proposal: preview().proposal, rows: preview().rows, replaced: [], learnedMemory: true };
const refusal = (code: string, error: string) => Object.assign(new Error(error), { status: 409, data: { code, error } });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries");
  const view = render(<QueryClientProvider client={qc}><ProposedFixes defaultOpen /></QueryClientProvider>);
  return { qc, spy, view };
}
const open = async (id: "br-fix-preview" | "br-fix-apply") => {
  fireEvent.click(screen.getByTestId(id));
  return screen.findByTestId("fix-dialog");
};

beforeEach(() => {
  h.owner = true;
  h.proposals = { window: { from: "a", to: "b", days: 120 }, count: 1, truncated: false, items: [proposal()] };
  h.applied = { items: [] };
  h.dry.mockReset().mockResolvedValue(preview());
  h.apply.mockReset().mockResolvedValue(appliedRecord);
  h.undo.mockReset().mockResolvedValue({});
  h.toastWith.mockReset();
  h.toast.mockReset();
  h.appliedIsError = false;
  h.appliedAsked = 0;
});
afterEach(() => cleanup());

describe("Preview", () => {
  it("is a dry run: rows with what changes, the totals before → after, and nothing written", async () => {
    mount();
    const dlg = await open("br-fix-preview");
    await within(dlg).findByTestId("fix-rows");
    expect(h.dry).toHaveBeenCalledTimes(1);
    expect(h.dry.mock.calls[0]![0]).toEqual({ key: "transfer:1", data: { rowIds: ["r1", "r2"], proposalHash: "hash-1" }, params: { dryRun: "1" } });
    expect(h.apply).not.toHaveBeenCalled();
    // each row opens its record
    const link = within(dlg).getAllByTestId("fix-row-link")[0]!;
    const u = new URL(link.getAttribute("href")!, "http://x");
    expect(u.pathname).toBe("/transactions");
    expect(u.searchParams.get("account")).toBe("acct-chk");
    expect(u.searchParams.get("tx")).toBe("r1");
    // what changes on the row, in words
    const change = within(within(dlg).getAllByTestId("fix-row")[0]!).getByTestId("fix-row-change").textContent!;
    expect(change).toContain("Filed under Transfer (was Dining)");
    expect(change).toContain("Counted as a transfer");
    expect(change).toContain("Leaves the weekly plan");
    // totals that move, with the glossary's names; the ones that do not are not listed
    const lines = within(dlg).getAllByTestId("fix-change").map((e) => e.textContent!);
    expect(lines).toContain("This week · Unconfirmed$40.00 → $0.00");
    expect(lines).toContain("This week · Cautious total (includes unconfirmed)$319.76 → $279.76");
    expect(lines.join("|")).not.toContain("Counts toward plan");
    // The dry run reads this fix's own dates; the line says them, so 2 here is not read against the page's count.
    expect(lines).toContain("Banking · Chase Total Checking ••4321 · Oct 1 – Oct 14 · Not on the plan2 rows → 0 rows");
    expect(lines).toContain("Banking · Chase Total Checking ••4321 · Oct 1 – Oct 14 · To review2 → 0");
    expect(within(dlg).getByTestId("fix-learns")).toBeTruthy();
    expect(within(dlg).queryByTestId("fix-limits")).toBeNull();
  });

  it("Apply stays off until the dry run has loaded", async () => {
    let release: (v: unknown) => void = () => {};
    h.dry.mockReturnValue(new Promise((r) => (release = r)));
    mount();
    const dlg = await open("br-fix-preview");
    expect(within(dlg).getByTestId("fix-loading")).toBeTruthy();
    expect((within(dlg).getByTestId("fix-apply") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release(preview()));
    await within(dlg).findByTestId("fix-rows");
    expect((within(dlg).getByTestId("fix-apply") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when no total changes, and names the plain limitation the server still has", async () => {
    h.dry.mockResolvedValue(preview({ figures: { ...preview().figures, week: { before: period("279.76", "0.00", "279.76"), after: period("279.76", "0.00", "279.76") }, month: { before: period("900.00", "0.00", "900.00"), after: period("900.00", "0.00", "900.00") }, banking: [] }, limitations: ["listed_rows_only"] }));
    mount();
    const dlg = await open("br-fix-preview");
    expect((await within(dlg).findByTestId("fix-no-change")).textContent).toBe("No total changes.");
    expect(within(dlg).getByTestId("fix-limits").textContent).toBe("Only the rows listed are changed.");
  });

  it("a failed preview says so and cannot be applied", async () => {
    h.dry.mockRejectedValue(refusal("proposal_changed", "This fix changed. Reload the list."));
    mount();
    const dlg = await open("br-fix-preview");
    expect((await within(dlg).findByTestId("fix-failed")).textContent).toBe("This fix changed. Reload the list.");
    expect((within(dlg).getByTestId("fix-apply") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Apply", () => {
  it("asks once, writes with the same rows and hash, closes, marks everything stale, and offers Undo", async () => {
    const { spy } = mount();
    const dlg = await open("br-fix-apply");
    expect(within(dlg).getByText(/Apply this fix\?/)).toBeTruthy();
    const go = within(dlg).getByTestId("fix-confirm-go") as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false)); // the preview is in
    expect(h.apply).not.toHaveBeenCalled();
    fireEvent.click(go);
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0]![0]).toEqual({ key: "transfer:1", data: { rowIds: ["r1", "r2"], proposalHash: "hash-1" } });
    await waitFor(() => expect(screen.queryByTestId("fix-dialog")).toBeNull());
    expect(spy).toHaveBeenCalledWith();
    expect(h.toastWith).toHaveBeenCalledTimes(1);
    const t = h.toastWith.mock.calls[0]![0] as { title: string; description: string; actions: Array<{ label: string; onClick: () => void }> };
    expect(t.title).toBe("Applied · File as a transfer");
    expect(t.description).toBe("2 rows changed.");
    expect(t.actions[0]!.label).toBe("Undo");
    t.actions[0]!.onClick();
    await waitFor(() => expect(h.undo).toHaveBeenCalledWith("app-1"));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ title: "Undone · File as a transfer" }));
  });

  it("from the Preview dialog too: Apply… then Yes, apply", async () => {
    mount();
    const dlg = await open("br-fix-preview");
    await within(dlg).findByTestId("fix-rows");
    fireEvent.click(within(dlg).getByTestId("fix-apply"));
    expect(within(dlg).getByText(/Apply this fix\?/)).toBeTruthy();
    expect(h.apply).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByTestId("fix-confirm-go"));
    await waitFor(() => expect(h.apply).toHaveBeenCalledTimes(1));
  });

  it("a refused apply shows the server's line, applies nothing, and offers no Undo", async () => {
    h.apply.mockRejectedValue(refusal("proposal_changed", "A row changed since you looked. Preview it again."));
    mount();
    const dlg = await open("br-fix-apply");
    const go = within(dlg).getByTestId("fix-confirm-go") as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    expect((await within(dlg).findByTestId("fix-refused")).textContent).toBe("A row changed since you looked. Preview it again.");
    expect(h.toastWith).not.toHaveBeenCalled();
    expect(screen.getByTestId("fix-dialog")).toBeTruthy();
    expect(within(dlg).queryByTestId("fix-confirm-go")).toBeNull();
  });

  it("a double tap is one write", async () => {
    let release: (v: unknown) => void = () => {};
    h.apply.mockReturnValue(new Promise((r) => (release = r)));
    mount();
    const dlg = await open("br-fix-apply");
    const go = within(dlg).getByTestId("fix-confirm-go") as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    fireEvent.click(go);
    expect(h.apply).toHaveBeenCalledTimes(1);
    await act(async () => release(appliedRecord));
  });

  it("cancel writes nothing, and focus goes back to the button that opened the dialog", async () => {
    mount();
    const opener = screen.getByTestId("br-fix-apply");
    const dlg = await open("br-fix-apply");
    fireEvent.click(within(dlg).getByTestId("fix-cancel"));
    await waitFor(() => expect(screen.queryByTestId("fix-dialog")).toBeNull());
    expect(h.apply).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("Escape also hands focus back to the Preview button", async () => {
    mount();
    const opener = screen.getByTestId("br-fix-preview");
    const dlg = await open("br-fix-preview");
    await within(dlg).findByTestId("fix-rows");
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("fix-dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("while it applies the dialog cannot be closed (Escape, Cancel, X), so the result is never lost: the Undo toast appears and takes focus", async () => {
    let release: (v: unknown) => void = () => {};
    h.apply.mockReturnValue(new Promise((r) => (release = r)));
    // The toast viewport (mocked here) renders the Undo; focus must reach it for a keyboard user.
    const undoBtn = document.createElement("button");
    undoBtn.setAttribute("data-testid", "fix-toast-undo");
    document.body.appendChild(undoBtn);
    mount();
    const dlg = await open("br-fix-apply");
    const go = within(dlg).getByTestId("fix-confirm-go") as HTMLButtonElement;
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(go.textContent).toBe("Applying…"));
    expect((within(dlg).getByTestId("fix-cancel") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dlg, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("fix-dialog")).toBeTruthy();
    await act(async () => release(appliedRecord));
    await waitFor(() => expect(h.toastWith).toHaveBeenCalledTimes(1));
    expect((h.toastWith.mock.calls[0]![0] as { duration: number }).duration).toBeGreaterThanOrEqual(10_000);
    await waitFor(() => expect(document.activeElement).toBe(undoBtn), { timeout: 2000 });
    undoBtn.remove();
  });
});

describe("Applied fixes (history with Undo)", () => {
  const item = (o: Record<string, unknown>) => ({ id: "a1", proposalKey: "transfer:1", kind: "transfer", label: "File as a transfer", rowCount: 2, filedCount: 2, matchedCount: 0, appliedAt: "2026-10-14T15:00:00Z", undoneAt: null, undoable: true, ...o });

  it("lists the last fixes; the owner can Undo one; an undone one says so and has no button", async () => {
    h.applied = { items: [item({}), item({ id: "a2", label: "Confirm it pays HELOC", undoneAt: "2026-10-14T16:00:00Z" }), item({ id: "a3", undoable: false })] };
    mount();
    const rows = screen.getAllByTestId("br-applied-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("File as a transfer · 2 rows");
    expect(within(rows[1]!).getByTestId("br-applied-undone").textContent).toBe("Undone");
    expect(screen.queryByTestId("br-applied-undo-a2")).toBeNull();
    expect(screen.queryByTestId("br-applied-undo-a3")).toBeNull();
    // each Undo has a name of its own
    expect(screen.getByTestId("br-applied-undo-a1").getAttribute("aria-label")).toBe("Undo: File as a transfer, 2 rows, Oct 14, 10:00 AM");
    fireEvent.click(screen.getByTestId("br-applied-undo-a1"));
    await waitFor(() => expect(h.undo).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ title: "Undone · File as a transfer" }));
  });

  it("an undo the server refuses (a row changed since) says why and changes nothing", async () => {
    h.applied = { items: [item({})] };
    h.undo.mockRejectedValue(refusal("changed_since", "A row was filed by hand since. Nothing was undone."));
    mount();
    fireEvent.click(screen.getByTestId("br-applied-undo-a1"));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ title: "Not undone", description: "A row was filed by hand since. Nothing was undone.", variant: "destructive" }));
  });

  it("a member gets no error: the list is the owner's (the server answers a member 403), so it is never asked", () => {
    h.owner = false;
    h.appliedIsError = true; // what asking would give a member
    mount();
    expect(h.appliedAsked).toBe(0);
    expect(screen.queryByTestId("br-applied-error")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("br-fixes-member").textContent).toBe("The household owner applies fixes.");
  });
});
