import { type MutableRefObject } from "react";
import { type UseFormReturn } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateTransaction,
  useUpdateTransaction,
  useClearTransferOverride,
  getListTransactionsQueryKey,
  type Transaction,
  type MappingRule,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { NewTransactionCategoryPicker } from "./NewTransactionCategoryPicker";
import { type FormValues } from "./transactionsShared";

/**
 * (Phase 6 decomposition) The Add/Edit transaction dialog, extracted
 * verbatim from TransactionsPage. Props-only: the page owns the form
 * instance, the editing target, and the submit handler; this component
 * just renders the Radix dialog body. Radix's DialogContent traps and
 * restores focus, and DialogTitle gives the dialog its accessible name.
 */
export function TransactionEditDialog({
  isDialogOpen,
  setIsDialogOpen,
  editingTx,
  setEditingTx,
  form,
  onSubmit,
  categories,
  categoryManuallyPickedRef,
  editingMatchedRule,
  dialogAutoMatchedRule,
  mappingRules,
  clearTransferOverride,
  createTx,
  updateTx,
}: {
  isDialogOpen: boolean;
  setIsDialogOpen: (open: boolean) => void;
  editingTx: Transaction | null;
  setEditingTx: React.Dispatch<React.SetStateAction<Transaction | null>>;
  form: UseFormReturn<FormValues>;
  onSubmit: (values: FormValues) => void;
  categories: { id: string; name: string }[] | undefined;
  categoryManuallyPickedRef: MutableRefObject<boolean>;
  editingMatchedRule: MappingRule | null;
  dialogAutoMatchedRule: MappingRule | null;
  mappingRules: readonly MappingRule[] | undefined;
  clearTransferOverride: ReturnType<typeof useClearTransferOverride>;
  createTx: ReturnType<typeof useCreateTransaction>;
  updateTx: ReturnType<typeof useUpdateTransaction>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return (
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{editingTx ? "Edit Transaction" : "New Transaction"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="occurredOn" render={({ field }) => (
                <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Input placeholder="Trader Joe's" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField
                control={form.control}
                name="categoryId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <NewTransactionCategoryPicker
                        value={field.value ?? null}
                        onChange={(next) => {
                          categoryManuallyPickedRef.current = true;
                          field.onChange(next);
                        }}
                        categories={categories ?? []}
                        autoMatchedRule={
                          editingTx ? editingMatchedRule : dialogAutoMatchedRule
                        }
                        mappingRules={mappingRules}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-3 gap-3">
                <FormField control={form.control} name="kind" render={({ field }) => (
                  <FormItem className="col-span-1"><FormLabel>Kind</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="expense">Expense</SelectItem>
                        <SelectItem value="income">Income</SelectItem>
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Amount</FormLabel><FormControl><Input type="number" step="0.01" min="0" placeholder="42.50" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              {(() => {
                // (#607) When the picked category is the system-managed
                // Transfer row, hide Weekly/Monthly/Unplanned/Transfer
                // toggles — the server flips isTransfer=true and clears
                // all three allowance flags on save, so showing them
                // would be misleading. The Transfer toggle is also
                // implied true in that case and would just be a no-op.
                const watchedCategoryId = form.watch("categoryId");
                const transferCat = (categories ?? []).find(
                  (c) => c.name === "Transfer",
                );
                const isPickedTransfer =
                  !!transferCat && watchedCategoryId === transferCat.id;
                return (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="reimbursable" render={({ field }) => (
                      <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Reimbursable</FormLabel></FormItem>
                    )} />
                    <FormField control={form.control} name="reimbursed" render={({ field }) => (
                      <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Reimbursed</FormLabel></FormItem>
                    )} />
                    {!isPickedTransfer && (
                      <>
                        <FormField control={form.control} name="weeklyAllowance" render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Weekly Allow</FormLabel></FormItem>
                        )} />
                        <FormField control={form.control} name="monthlyAllowance" render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Monthly Allow</FormLabel></FormItem>
                        )} />
                        <FormField control={form.control} name="unplannedAllowance" render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Unplanned Allow</FormLabel></FormItem>
                        )} />
                        <FormField control={form.control} name="isTransfer" render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0">
                            <FormControl>
                              <Checkbox
                                checked={field.value}
                                onCheckedChange={field.onChange}
                                data-testid="checkbox-is-transfer"
                              />
                            </FormControl>
                            <FormLabel>Transfer</FormLabel>
                          </FormItem>
                        )} />
                      </>
                    )}
                  </div>
                );
              })()}
              {editingTx?.isTransferUserOverridden && (
                <div
                  className="flex items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
                  data-testid="transfer-override-hint"
                >
                  <div>
                    <div className="font-medium text-slate-700">
                      Transfer status manually set
                    </div>
                    <div className="mt-0.5 text-slate-500">
                      Future bank syncs won't re-flag this row from the description
                      heuristic. Reset to let auto-detection take over again.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    data-testid="button-reset-transfer-override"
                    disabled={clearTransferOverride.isPending}
                    onClick={() => {
                      const id = editingTx.id;
                      clearTransferOverride.mutate(
                        { id },
                        {
                          onSuccess: () => {
                            queryClient.invalidateQueries({
                              queryKey: getListTransactionsQueryKey(),
                            });
                            setEditingTx((prev) =>
                              prev && prev.id === id
                                ? { ...prev, isTransferUserOverridden: false }
                                : prev,
                            );
                            toast({ title: "Reset to auto" });
                          },
                        },
                      );
                    }}
                  >
                    Reset to auto
                  </Button>
                </div>
              )}
              <div className="flex justify-end pt-4">
                <Button type="submit" disabled={createTx.isPending || updateTx.isPending}>Save</Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
  );
}
