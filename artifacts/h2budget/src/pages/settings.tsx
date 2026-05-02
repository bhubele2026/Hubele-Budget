import { useState, useEffect } from "react";
import { useGetSettings, useUpdateSettings, useImportWorkbook, getGetSettingsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, Download } from "lucide-react";

const settingsSchema = z.object({
  weeklyAllowanceAmount: z.string().min(1),
  monthlyAllowanceAmount: z.string().min(1),
  unplannedAllowanceAmount: z.string().min(1),
  primaryAccount: z.string().optional().nullable(),
});

type SettingsFormValues = z.infer<typeof settingsSchema>;

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetSettings();
  const updateSettings = useUpdateSettings();
  const importWorkbook = useImportWorkbook();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      weeklyAllowanceAmount: "0",
      monthlyAllowanceAmount: "0",
      unplannedAllowanceAmount: "0",
      primaryAccount: "",
    }
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        weeklyAllowanceAmount: settings.weeklyAllowanceAmount,
        monthlyAllowanceAmount: settings.monthlyAllowanceAmount,
        unplannedAllowanceAmount: settings.unplannedAllowanceAmount,
        primaryAccount: settings.primaryAccount || "",
      });
    }
  }, [settings, form]);

  const onSubmit = (values: SettingsFormValues) => {
    updateSettings.mutate({ data: values }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: "Settings updated successfully" });
      }
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    toast({ title: "Importing workbook..." });
    importWorkbook.mutate({ data: { file } }, {
      onSuccess: (res) => {
        toast({ title: "Import complete", description: `Processed ${res.counts.transactions || 0} transactions.` });
        e.target.value = ''; // reset input
      },
      onError: (err) => {
        toast({ title: "Import failed", description: String(err), variant: "destructive" });
        e.target.value = '';
      }
    });
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">Configure allowances and import historical data.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Allowance Budgets</CardTitle>
          <CardDescription>Set the target amounts for discretionary allowances.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="weeklyAllowanceAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Weekly Allowance ($)</FormLabel>
                  <FormControl><Input type="number" step="1" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="monthlyAllowanceAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Monthly Allowance ($)</FormLabel>
                  <FormControl><Input type="number" step="1" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="unplannedAllowanceAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Unplanned Allowance ($)</FormLabel>
                  <FormControl><Input type="number" step="1" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="pt-4">
                <Button type="submit" disabled={updateSettings.isPending}>Save Settings</Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spreadsheet Import</CardTitle>
          <CardDescription>Migrate your legacy Hubele Family Budget Excel file.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <a href={`${import.meta.env.BASE_URL}sample/Hubele_Family_Budget_v36.xlsx`} download className="text-primary font-medium hover:underline flex items-center gap-2 mb-4">
              <Download className="w-4 h-4" /> Download Sample Workbook
            </a>
            <p className="text-sm text-muted-foreground mb-2">Upload a populated workbook to bootstrap your ledger. We'll extract transactions, debts, recurring bills, and configuration.</p>
          </div>
          
          <div className="flex items-center gap-4">
            <Button variant="outline" className="relative cursor-pointer" disabled={importWorkbook.isPending}>
              <UploadCloud className="w-4 h-4 mr-2" />
              {importWorkbook.isPending ? "Importing..." : "Upload .xlsx File"}
              <input 
                type="file" 
                accept=".xlsx" 
                className="absolute inset-0 opacity-0 cursor-pointer" 
                onChange={handleFileUpload}
                disabled={importWorkbook.isPending}
              />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
