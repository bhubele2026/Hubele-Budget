import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { Transaction } from "@workspace/api-client-react";
import { TransactionEditDialog } from "./TransactionEditDialog";

/** (F4) The Chase edit dialog offers "Split by category…" for an existing charge only. */
const TX = { id: "t1", description: "CORNER MARKET", amount: "-18.40", occurredOn: "2026-10-07", categoryId: "c1" } as unknown as Transaction;
function Harness({ editing, onSplit }: { editing: Transaction | null; onSplit?: (t: Transaction) => void }) {
  const form = useForm({ defaultValues: { occurredOn: "2026-10-07", description: "", categoryId: null, kind: "expense", amount: "", reimbursable: false, reimbursed: false, weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false, isTransfer: false } as never });
  const [open, setOpen] = React.useState(true);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <span data-testid="open">{String(open)}</span>
      <TransactionEditDialog
        isDialogOpen={open}
        setIsDialogOpen={setOpen}
        editingTx={editing}
        setEditingTx={() => {}}
        form={form as never}
        onSubmit={() => {}}
        categories={[]}
        categoryManuallyPickedRef={{ current: false }}
        editingMatchedRule={null}
        dialogAutoMatchedRule={null}
        mappingRules={[]}
        clearTransferOverride={{} as never}
        createTx={{ isPending: false } as never}
        updateTx={{ isPending: false } as never}
        onSplit={onSplit}
      />
    </QueryClientProvider>
  );
}
afterEach(cleanup);

describe("Chase edit dialog — Split by category", () => {
  it("an existing charge offers it; pressing closes the edit dialog and hands the charge over", () => {
    const onSplit = vi.fn();
    render(<Harness editing={TX} onSplit={onSplit} />);
    fireEvent.click(screen.getByTestId("button-split-by-category"));
    expect(onSplit).toHaveBeenCalledWith(TX);
    expect(screen.getByTestId("open").textContent).toBe("false");
  });
  it("a new transaction has nothing to split", () => {
    render(<Harness editing={null} onSplit={vi.fn()} />);
    expect(screen.queryByTestId("button-split-by-category")).toBeNull();
  });
});
