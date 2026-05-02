import { useListDebts } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export default function DebtsPage() {
  const { data: debts, isLoading } = useListDebts();

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  // Sort by APR descending (avalanche)
  const sortedDebts = [...(debts || [])].sort((a, b) => parseFloat(b.apr) - parseFloat(a.apr));

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Debt Avalanche</h1>
          <p className="text-muted-foreground mt-1">Sorted by APR to minimize interest paid.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedDebts.map((debt, index) => (
          <Card key={debt.id} className={index === 0 ? "border-primary" : ""}>
            <CardHeader className="pb-2">
              <div className="flex justify-between items-start">
                <CardTitle className="text-lg">{debt.name}</CardTitle>
                {index === 0 && <span className="bg-primary text-primary-foreground text-xs px-2 py-1 rounded">Target</span>}
              </div>
              <p className="text-xs text-muted-foreground">{debt.type || "General"}</p>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 mt-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Balance</span>
                  <span className="text-sm font-medium">{formatCurrency(debt.balance)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">APR</span>
                  <span className="text-sm font-medium">{debt.apr}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Min Payment</span>
                  <span className="text-sm font-medium">{formatCurrency(debt.minPayment)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {sortedDebts.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No debts recorded. You're debt free!
        </div>
      )}
    </div>
  );
}
