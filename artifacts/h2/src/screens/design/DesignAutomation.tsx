import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  getListCategoriesQueryKey,
  type Category,
  type CategorizationSettings,
  type MeResponse,
} from "@workspace/api-client-react";
import { settingsKey } from "@/data/automationApi";
import { Note } from "@/kit/Note";
import Automation from "@/screens/household/Automation";

/**
 * ⭐ /design/automation — AUTOMATION ON MADE-UP DATA, for judging the screen
 * without signing in. Public, lazy, no network: the query cache holds invented
 * answers under the real keys and every query is switched off. The model is in
 * "suggest" mode with 18 of 30 judged. Pressing a switch or Undo fails (there is
 * no server), which is fine for a sample.
 */
const CATEGORIES = [
  { id: "c1", name: "Groceries", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 1 },
  { id: "c2", name: "Dining out", kind: "expense", groupName: "Food", sourceKind: "manual", sortOrder: 2 },
  { id: "c3", name: "Fuel", kind: "expense", groupName: "Transport", sourceKind: "manual", sortOrder: 1 },
  { id: "c4", name: "Pharmacy", kind: "expense", groupName: "Health", sourceKind: "manual", sortOrder: 1 },
] as Category[];

const d = (
  id: string,
  on: string,
  description: string,
  amount: string,
  categoryId: string | null,
  categoryName: string | null,
  source: string,
  band: string,
  resolution: string | null,
  resolvedBy: string | null,
  undoable: boolean,
) => ({ id, transactionId: `t-${id}`, description, amount, occurredOn: on, source, band, categoryId, categoryName, resolution, resolvedBy, decidedAt: `${on}T12:00:00Z`, undoable });

export const SAMPLE_SETTINGS = {
  autoCategorize: true,
  modelAutoCategorize: false,
  ai: { configured: true, enabled: true },
  engine: { rules: 4, learned: 11, memories: 10, recurring: 7 },
  model: {
    mode: "suggest",
    eligible: false,
    judged: 18,
    requirements: [
      { key: "ai", label: "AI is turned on for this app.", met: true, current: 1, target: 1 },
      { key: "owner_switch", label: "The owner lets sure answers file on their own.", met: false, current: 0, target: 1 },
      { key: "judged", label: "At least 30 suggestions judged.", met: false, current: 18, target: 30 },
      { key: "accuracy", label: "9 in 10 right among the last 50 judged.", met: false, current: 16, target: 18 },
    ],
    accuracy: { last50: { right: 16, judged: 18 }, last20: { right: 16, judged: 18 } },
  },
  recent: [
    d("a1", "2026-10-07", "Corner Market", "-18.40", "c1", "Groceries", "rule", "auto", null, null, true),
    d("a2", "2026-10-07", "Coffee Cart", "-6.25", "c2", "Dining out", "model", "provisional", null, null, true),
    d("a3", "2026-10-06", "Gas Station", "-41.10", "c3", "Fuel", "memory", "auto", null, null, true),
    d("a4", "2026-10-06", "Streaming Service", "-15.99", null, null, "recurring", "queue", null, null, false),
    d("a5", "2026-10-05", "Pharmacy", "-12.99", "c4", "Pharmacy", "model", "provisional", "accepted", "user", false),
    d("a6", "2026-10-04", "Pizza Place", "-27.80", "c2", "Dining out", "model", "provisional", "accepted", "silent", false),
    d("a7", "2026-10-03", "Hardware Depot", "-64.20", "c1", "Groceries", "model", "queue", "corrected", "user", false),
    d("a8", "2026-10-02", "Gas Station", "-38.00", "c3", "Fuel", "inherited", "auto", null, null, true),
  ],
  reviewCount: 3,
} as unknown as CategorizationSettings;

function sampleClient(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, refetchOnMount: false } } });
  qc.setQueryData(settingsKey(), SAMPLE_SETTINGS);
  qc.setQueryData(getGetMeQueryKey(), { isOwner: true } as unknown as MeResponse);
  qc.setQueryData(getListCategoriesQueryKey(), CATEGORIES);
  return qc;
}

const client = sampleClient();

export default function DesignAutomation() {
  return (
    <QueryClientProvider client={client}>
      <div className="flex flex-col gap-6" data-testid="page-design-automation">
        <Note kind="empty" data-testid="sample-note">
          Sample — every figure on this page is made up.
        </Note>
        <Automation />
      </div>
    </QueryClientProvider>
  );
}
