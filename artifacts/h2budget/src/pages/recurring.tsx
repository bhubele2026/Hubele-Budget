import { useState } from "react";
import { useListRecurringItems, useCreateRecurringItem, useUpdateRecurringItem, useDeleteRecurringItem, getListRecurringItemsQueryKey, useListDebts } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Edit2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { RecurringItem } from "@workspace/api-client-react";

const NO_DEBT = "__none__";

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  kind: z.string().min(1, "Kind is required"),
  amount: z.string().min(1, "Amount is required"),
  frequency: z.string().min(1, "Frequency is required"),
  active: z.string().min(1, "Status is required"),
  debtId: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export default function RecurringPage() {
  const { data: items, isLoading } = useListRecurringItems();
  const { data: debts } = useListDebts();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createItem = useCreateRecurringItem();
  const updateItem = useUpdateRecurringItem();
  const deleteItem = useDeleteRecurringItem();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<RecurringItem | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      kind: "bill",
      amount: "",
      frequency: "monthly",
      active: "true",
      debtId: NO_DEBT,
    },
  });

  const handleOpenNew = () => {
    setEditingItem(null);
    form.reset({
      name: "",
      kind: "bill",
      amount: "",
      frequency: "monthly",
      active: "true",
      debtId: NO_DEBT,
    });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (item: RecurringItem) => {
    setEditingItem(item);
    form.reset({
      name: item.name,
      kind: item.kind,
      amount: item.amount,
      frequency: item.frequency,
      active: item.active,
      debtId: item.debtId ?? NO_DEBT,
    });
    setIsDialogOpen(true);
  };

  const onSubmit = (values: FormValues) => {
    const payload = {
      ...values,
      debtId: values.debtId && values.debtId !== NO_DEBT ? values.debtId : null,
    };
    if (editingItem) {
      updateItem.mutate({ id: editingItem.id, data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRecurringItemsQueryKey() });
          setIsDialogOpen(false);
          toast({ title: "Item updated" });
        }
      });
    } else {
      createItem.mutate({ data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRecurringItemsQueryKey() });
          setIsDialogOpen(false);
          toast({ title: "Item created" });
        }
      });
    }
  };

  const handleDelete = (id: string) => {
    if (confirm("Delete this recurring item?")) {
      deleteItem.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRecurringItemsQueryKey() });
          toast({ title: "Item deleted" });
        }
      });
    }
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  const groupedItems = items?.reduce((acc, item) => {
    if (!acc[item.kind]) acc[item.kind] = [];
    acc[item.kind].push(item);
    return acc;
  }, {} as Record<string, RecurringItem[]>) || {};

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Recurring Items</h1>
          <p className="text-muted-foreground mt-1">Bills, income, and subscriptions.</p>
        </div>
        <Button onClick={handleOpenNew}><Plus className="w-4 h-4 mr-2" /> Add Item</Button>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Item" : "New Recurring Item"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Netflix" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="kind" render={({ field }) => (
                  <FormItem><FormLabel>Type</FormLabel><Select onValueChange={field.onChange} defaultValue={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl><SelectContent><SelectItem value="bill">Bill</SelectItem><SelectItem value="income">Income</SelectItem><SelectItem value="subscription">Subscription</SelectItem></SelectContent></Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="frequency" render={({ field }) => (
                  <FormItem><FormLabel>Frequency</FormLabel><Select onValueChange={field.onChange} defaultValue={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl><SelectContent><SelectItem value="weekly">Weekly</SelectItem><SelectItem value="biweekly">Bi-weekly</SelectItem><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="yearly">Yearly</SelectItem></SelectContent></Select><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="amount" render={({ field }) => (
                <FormItem><FormLabel>Amount</FormLabel><FormControl><Input type="number" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="active" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel><Select onValueChange={field.onChange} defaultValue={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl><SelectContent><SelectItem value="true">Active</SelectItem><SelectItem value="false">Inactive</SelectItem></SelectContent></Select><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="debtId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Linked debt</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || NO_DEBT}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="select-linked-debt">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NO_DEBT}>None</SelectItem>
                      {(debts ?? [])
                        .filter((d) => (d.status ?? "active") === "active")
                        .map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              <div className="flex justify-end pt-4">
                <Button type="submit" disabled={createItem.isPending || updateItem.isPending}>Save</Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Object.entries(groupedItems).map(([kind, kindItems]) => (
          <Card key={kind}>
            <CardHeader>
              <CardTitle className="capitalize">{kind}s</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {kindItems.map((item) => {
                  const linkedDebt = item.debtId ? debts?.find((d) => d.id === item.debtId) : null;
                  return (
                  <div key={item.id} className="p-4 flex items-center justify-between hover:bg-muted/50">
                    <div>
                      <p className="font-medium text-foreground">{item.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {item.frequency} • {item.active === "true" ? "Active" : "Inactive"}
                        {linkedDebt ? <span className="ml-1 normal-case">• Linked to {linkedDebt.name}</span> : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="font-medium">{formatCurrency(item.amount)}</span>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleOpenEdit(item)}><Edit2 className="w-3.5 h-3.5 text-muted-foreground" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(item.id)}><Trash2 className="w-3.5 h-3.5 text-destructive" /></Button>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        ))}
        {Object.keys(groupedItems).length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground border border-dashed rounded-lg">
            No recurring items tracked yet.
          </div>
        )}
      </div>
    </div>
  );
}
