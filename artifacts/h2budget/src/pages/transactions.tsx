import { useMemo, useState } from "react";
import { useListTransactions, useCreateTransaction, useUpdateTransaction, useDeleteTransaction, useListCategories, getListTransactionsQueryKey, getGetForecastQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Edit2, Trash2, Send, Inbox } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Transaction } from "@workspace/api-client-react";

const formSchema = z.object({
  occurredOn: z.string().min(1, "Date is required"),
  description: z.string().min(1, "Description is required"),
  amount: z.string().min(1, "Amount is required"),
  kind: z.enum(["expense", "income"]).default("expense"),
  forecastFlag: z.boolean().default(false),
  weeklyAllowance: z.boolean().default(false),
  monthlyAllowance: z.boolean().default(false),
  unplannedAllowance: z.boolean().default(false),
  reimbursable: z.boolean().default(false),
  reimbursed: z.boolean().default(false),
});

type FormValues = z.infer<typeof formSchema>;

function normalizeAmount(raw: string, kind: "expense" | "income"): string {
  const num = Math.abs(parseFloat(raw));
  if (Number.isNaN(num)) return raw;
  return (kind === "income" ? num : -num).toFixed(2);
}

export default function TransactionsPage() {
  const { data: transactions, isLoading } = useListTransactions();
  const { data: categories } = useListCategories();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const createTx = useCreateTransaction();
  const updateTx = useUpdateTransaction();
  const deleteTx = useDeleteTransaction();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      occurredOn: new Date().toISOString().split('T')[0],
      description: "",
      amount: "",
      kind: "expense",
      forecastFlag: false,
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      reimbursable: false,
      reimbursed: false,
    },
  });

  const handleOpenNew = () => {
    setEditingTx(null);
    form.reset({
      occurredOn: new Date().toISOString().split('T')[0],
      description: "",
      amount: "",
      kind: "expense",
      forecastFlag: false,
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      reimbursable: false,
      reimbursed: false,
    });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (tx: Transaction) => {
    setEditingTx(tx);
    const numeric = parseFloat(tx.amount);
    form.reset({
      occurredOn: tx.occurredOn.split('T')[0],
      description: tx.description,
      amount: Math.abs(numeric).toFixed(2),
      kind: numeric >= 0 ? "income" : "expense",
      forecastFlag: tx.forecastFlag,
      weeklyAllowance: tx.weeklyAllowance,
      monthlyAllowance: tx.monthlyAllowance,
      unplannedAllowance: tx.unplannedAllowance,
      reimbursable: tx.reimbursable,
      reimbursed: tx.reimbursed,
    });
    setIsDialogOpen(true);
  };

  const onSubmit = (values: FormValues) => {
    const { kind, ...rest } = values;
    const payload = { ...rest, amount: normalizeAmount(values.amount, kind) };
    if (editingTx) {
      updateTx.mutate({ id: editingTx.id, data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          setIsDialogOpen(false);
          toast({ title: "Transaction updated" });
        }
      });
    } else {
      createTx.mutate({ data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          setIsDialogOpen(false);
          toast({ title: "Transaction created" });
        }
      });
    }
  };

  const handleToggleForecast = (tx: Transaction) => {
    const next = !tx.forecastFlag;
    updateTx.mutate(
      { id: tx.id, data: { forecastFlag: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
          toast({ title: next ? "Sent to Forecast" : "Removed from Forecast" });
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    if (confirm("Delete this transaction?")) {
      deleteTx.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          toast({ title: "Transaction deleted" });
        }
      });
    }
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Transactions</h1>
          <p className="text-muted-foreground mt-1">Every dollar, accounted for.</p>
        </div>
        <Button onClick={handleOpenNew}><Plus className="w-4 h-4 mr-2" /> Add Transaction</Button>
      </div>

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

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="forecastFlag" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Forecast</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="reimbursable" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Reimbursable</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="reimbursed" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Reimbursed</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="weeklyAllowance" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Weekly Allow</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="monthlyAllowance" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Monthly Allow</FormLabel></FormItem>
                )} />
                <FormField control={form.control} name="unplannedAllowance" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0"><FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl><FormLabel>Unplanned Allow</FormLabel></FormItem>
                )} />
              </div>

              <div className="flex justify-end pt-4">
                <Button type="submit" disabled={createTx.isPending || updateTx.isPending}>Save</Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {transactions?.map((tx) => (
              <div key={tx.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-muted/50 transition-colors">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-foreground">{tx.description}</span>
                    <span className="text-sm text-muted-foreground">{formatDate(tx.occurredOn)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {tx.categoryId && categoryById.get(tx.categoryId) && (
                      <Badge variant="outline" className="text-xs border-violet-200 text-violet-700 bg-violet-50">
                        {categoryById.get(tx.categoryId)}
                      </Badge>
                    )}
                    {!tx.categoryId && (
                      <Badge variant="outline" className="text-xs border-muted text-muted-foreground">Uncategorized</Badge>
                    )}
                    {tx.forecastFlag && (
                      <Badge variant="outline" className="text-xs border-emerald-200 text-emerald-700 bg-emerald-50">
                        <Inbox className="w-3 h-3 mr-1" /> In forecast
                      </Badge>
                    )}
                    {tx.weeklyAllowance && <Badge variant="outline" className="text-xs border-blue-200 text-blue-700 bg-blue-50">Weekly</Badge>}
                    {tx.monthlyAllowance && <Badge variant="outline" className="text-xs border-indigo-200 text-indigo-700 bg-indigo-50">Monthly</Badge>}
                    {tx.unplannedAllowance && <Badge variant="outline" className="text-xs border-amber-200 text-amber-700 bg-amber-50">Unplanned</Badge>}
                    {tx.reimbursable && <Badge variant="outline" className="text-xs border-orange-200 text-orange-700 bg-orange-50">Reimbursable</Badge>}
                    {tx.reimbursed && <Badge variant="outline" className="text-xs border-green-200 text-green-700 bg-green-50">Reimbursed</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-medium text-foreground whitespace-nowrap">{formatCurrency(tx.amount)}</span>
                  <div className="flex gap-2 items-center">
                    <Button
                      variant={tx.forecastFlag ? "outline" : "secondary"}
                      size="sm"
                      onClick={() => handleToggleForecast(tx)}
                      disabled={updateTx.isPending}
                      title={tx.forecastFlag ? "Remove from Forecast" : "Send to Forecast"}
                    >
                      <Send className="w-3.5 h-3.5 mr-1.5" />
                      {tx.forecastFlag ? "Remove from Forecast" : "Send to Forecast"}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(tx)}><Edit2 className="w-4 h-4 text-muted-foreground" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(tx.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                  </div>
                </div>
              </div>
            ))}
            {transactions?.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">No transactions found.</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
