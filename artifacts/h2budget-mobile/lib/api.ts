import Constants from "expo-constants";

const BASE_URL: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string) ??
  "https://hubele-budget.replit.app";

export type Settings = {
  weeklyAllowanceAmount: string;
  monthlyAllowanceAmount: string;
  unplannedAllowanceAmount: string;
};

export type Txn = {
  id: string;
  occurredOn: string;
  description: string;
  displayName?: string | null;
  amount: string;
  categoryId: string | null;
  weeklyAllowance: boolean;
  monthlyAllowance: boolean;
  unplannedAllowance: boolean;
  reimbursable: boolean;
  isTransfer: boolean;
  source: string;
};

export type Category = { id: string; name: string };

export type Dashboard = {
  totalDebt: string;
  monthlyIncome: string;
  monthlySpend: string;
  netCashflow: string;
  paidThisMonth: string;
  paidLifetime: string;
  topCategories: { categoryName: string; total: string }[];
};

export type Nudge = {
  enabled: boolean;
  severity?: "info" | "warn" | "alert";
  message?: string;
};

// Mirror of GET /api/debts (only the fields the mobile glance reads). The
// server returns many more Plaid-status fields; we keep the contract loose.
export type Debt = {
  id: string;
  name: string;
  apr: string;
  balance: string;
  minPayment: string;
  status: string;
};

// Mirror of GET /api/avalanche/settings.
export type AvalancheSettings = {
  strategy: "avalanche" | "snowball";
  extraSource: string;
  extraBudgetCategoryId: string | null;
  manualExtra: string;
  budgetMode: string;
};

// Mirror of GET /api/amex/anchor.
export type AmexAnchor = {
  amexEndingBalance: number | null;
  asOf: string;
  source: "plaid" | "debt" | "anchor" | "computed" | "missing";
};

/**
 * Thin API client against the existing H2 Budget backend. Every call carries
 * the Clerk session token (Bearer) so `requireAuth` on the server accepts it.
 */
export function createApi(getToken: () => Promise<string | null>) {
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await getToken();
    const res = await fetch(`${BASE_URL}/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    getSettings: () => req<Settings>("/settings"),
    getDashboard: () => req<Dashboard>("/dashboard"),
    getNudge: () => req<Nudge>("/advisor/nudge"),
    getCategories: () => req<Category[]>("/categories"),
    getTransactions: (from: string, to: string) =>
      req<Txn[]>(`/transactions?from=${from}&to=${to}&limit=5000`),
    setCategory: (id: string, categoryId: string | null) =>
      req<Txn>(`/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId }),
      }),
    getDebts: () => req<Debt[]>("/debts"),
    getAvalancheSettings: () =>
      req<AvalancheSettings>("/avalanche/settings"),
    getAmexAnchor: () => req<AmexAnchor>("/amex/anchor"),
  };
}

export type Api = ReturnType<typeof createApi>;
