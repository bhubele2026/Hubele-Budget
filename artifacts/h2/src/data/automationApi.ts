import { useMutation, useQuery } from "@tanstack/react-query";
import {
  customFetch,
  type CategorizationSettings,
  type CategorizationSettingsInput,
  type MappingRule,
  type MappingRuleInput,
} from "@workspace/api-client-react";

/**
 * ⭐ THE AUTOMATION SCREEN'S FIVE CALLS, written out by hand on purpose.
 *
 * The generated hooks are the right tool everywhere else. Here they are not:
 * the generated module lives in the entry chunk, and every export a lazy screen
 * imports from it is kept there (≈ 2 KB for these five). The open path is at
 * its 400 KB cap, so these ride in the lazy chunks instead. They call the SAME
 * routes through the SAME `customFetch`, with the SAME query keys; a test holds
 * the keys and URLs equal to the generated ones.
 */
export const settingsKey = () => ["/api/categorization/settings"] as const;
export const mappingRulesKey = () => ["/api/mapping-rules"] as const;

export function useCategorizationSettings(options: { staleTime: number; gcTime: number }) {
  return useQuery({
    queryKey: settingsKey(),
    queryFn: ({ signal }) => customFetch<CategorizationSettings>("/api/categorization/settings", { method: "GET", signal }),
    ...options,
  });
}

export function useSaveCategorizationSettings() {
  return useMutation({
    mutationFn: (body: CategorizationSettingsInput) =>
      customFetch<CategorizationSettings>("/api/categorization/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  });
}

export function useMappingRules() {
  return useQuery({
    queryKey: mappingRulesKey(),
    queryFn: ({ signal }) => customFetch<MappingRule[]>("/api/mapping-rules", { method: "GET", signal }),
    staleTime: 60_000,
  });
}

export function useChangeMappingRule() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: MappingRuleInput }) =>
      customFetch<MappingRule>(`/api/mapping-rules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
  });
}

export function useRemoveMappingRule() {
  return useMutation({
    mutationFn: ({ id }: { id: string }) => customFetch<void>(`/api/mapping-rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  });
}
