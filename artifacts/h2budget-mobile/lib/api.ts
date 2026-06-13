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
    getCategories: () => req<Category[]>("/categories"),
    getTransactions: (from: string, to: string) =>
      req<Txn[]>(`/transactions?from=${from}&to=${to}&limit=5000`),
    setCategory: (id: string, categoryId: string | null) =>
      req<Txn>(`/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId }),
      }),
  };
}

export type Api = ReturnType<typeof createApi>;
