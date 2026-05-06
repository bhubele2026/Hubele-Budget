import { useCallback } from "react";
import { Alert, Linking } from "react-native";
import * as Haptics from "expo-haptics";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  useSyncPlaidTransactions,
} from "@workspace/api-client-react";

/**
 * (#358) Mobile mirror of artifacts/h2budget/src/hooks/use-plaid-sync.tsx.
 *
 * Surfaces the structured Plaid error fields wired up in #357
 * (institution name, plain-English reason, kind, requestId, etc.) as a
 * native Alert that names the failing bank — never the bare axios
 * "Request failed with status code 400" string. Re-auth failures get a
 * Reconnect button that deep-links to the web app's Settings page (the
 * mobile app does not host Plaid Link / update mode itself).
 */
export type SyncErrorDetail = {
  itemId: string | null;
  plaidItemRowId: string | null;
  institutionName: string | null;
  message: string;
  code: string | null;
  displayMessage: string | null;
  requestId: string | null;
  httpStatus: number | null;
  kind:
    | "reauth"
    | "rate_limit"
    | "institution_down"
    | "transient"
    | "unknown"
    | null;
};

export type SyncTotals = {
  added: number;
  modified: number;
  removed: number;
  errors: string[];
  errorDetails: SyncErrorDetail[];
  stillPreparing: boolean;
};

const ZERO: SyncTotals = {
  added: 0,
  modified: 0,
  removed: 0,
  errors: [],
  errorDetails: [],
  stillPreparing: false,
};

const STILL_PREPARING_MESSAGE =
  "Your bank is still preparing the initial batch — try again in a minute.";

export function formatPlaidErrorForDisplay(msg: string): string {
  if (!msg) return msg;
  return msg.startsWith("Plaid:") ? msg : `Plaid: ${msg}`;
}

/**
 * (#358) Compose the user-facing line for a Plaid error: prefer
 * "<Institution>: <displayMessage>" (Plaid's officially recommended
 * user-facing string) and fall back to the raw error_message. Never
 * returns the bare axios "Request failed with status code 400".
 */
export function formatSyncErrorDetail(d: SyncErrorDetail): string {
  const reason =
    (d.displayMessage && d.displayMessage.trim()) ||
    (d.message && d.message.trim()) ||
    "Sync failed";
  const bank = d.institutionName?.trim();
  if (bank) return `${bank}: ${reason}`;
  return formatPlaidErrorForDisplay(reason);
}

/**
 * (#358) Where the Reconnect CTA should send mobile users. The mobile
 * app does not host Plaid Link's update flow, so we deep-link to the
 * web app's Settings page (per-item Reconnect buttons live there).
 */
function buildReconnectUrl(): string | null {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) return null;
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  return `${base.replace(/\/+$/, "")}/settings`;
}

export type RunSyncOptions = {
  itemId?: string;
  silent?: boolean;
};

export function usePlaidSync() {
  const sync = useSyncPlaidTransactions();
  const qc = useQueryClient();

  const runSync = useCallback(
    (opts: RunSyncOptions = {}): Promise<SyncTotals> => {
      const { itemId, silent } = opts;
      return new Promise<SyncTotals>((resolve) => {
        sync.mutate(
          { data: itemId ? { itemId } : {} },
          {
            onSuccess: (res) => {
              const items = res.items ?? [];
              const totals = items.reduce<SyncTotals>(
                (acc, r) => {
                  acc.added += r.added ?? 0;
                  acc.modified += r.modified ?? 0;
                  acc.removed += r.removed ?? 0;
                  if (r.error) {
                    acc.errors.push(r.error);
                    acc.errorDetails.push({
                      itemId: r.itemId ?? null,
                      plaidItemRowId: r.plaidItemRowId ?? null,
                      institutionName: r.institutionName ?? null,
                      message: r.plaidErrorMessage ?? r.error,
                      code: r.plaidErrorCode ?? null,
                      displayMessage: r.plaidDisplayMessage ?? null,
                      requestId: r.requestId ?? null,
                      httpStatus: r.httpStatus ?? null,
                      kind:
                        (r.kind as SyncErrorDetail["kind"]) ?? null,
                    });
                  }
                  if (r.stillPreparing) acc.stillPreparing = true;
                  return acc;
                },
                {
                  added: 0,
                  modified: 0,
                  removed: 0,
                  errors: [],
                  errorDetails: [],
                  stillPreparing: false,
                },
              );

              qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
              if (totals.added + totals.modified + totals.removed > 0) {
                qc.invalidateQueries({
                  queryKey: getListTransactionsQueryKey(),
                });
              }

              if (!silent) {
                if (totals.errorDetails.length > 0) {
                  // (#358) Compose "<Institution>: <reason>" lines so the
                  // alert names exactly which bank is broken — never the
                  // raw axios message. When at least one error is a
                  // re-auth, attach a Reconnect button that opens the web
                  // Settings page (where the per-item Reconnect buttons
                  // live).
                  const description = totals.errorDetails
                    .map(formatSyncErrorDetail)
                    .join("\n\n");
                  const reauthDetail = totals.errorDetails.find(
                    (d) => d.kind === "reauth",
                  );
                  const reconnectUrl = reauthDetail
                    ? buildReconnectUrl()
                    : null;
                  Haptics.notificationAsync(
                    Haptics.NotificationFeedbackType.Error,
                  ).catch(() => {});
                  if (reconnectUrl) {
                    Alert.alert("Sync had errors", description, [
                      { text: "Dismiss", style: "cancel" },
                      {
                        text: "Reconnect",
                        onPress: () => {
                          Linking.openURL(reconnectUrl).catch(() => {});
                        },
                      },
                    ]);
                  } else {
                    Alert.alert("Sync had errors", description);
                  }
                } else if (totals.stillPreparing) {
                  // Plaid told us PRODUCT_NOT_READY — the bank hasn't
                  // finished staging the historical batch yet. Neutral
                  // alert, no error haptic.
                  Alert.alert("Still preparing", STILL_PREPARING_MESSAGE);
                }
              }
              resolve(totals);
            },
            onError: (err) => {
              // (#358) Network / 5xx from our own API. Show a generic,
              // non-scary message rather than axios internals — the user
              // can't act on "Network Error" beyond retrying.
              const rawMsg = err instanceof Error ? err.message : String(err);
              if (!silent) {
                Haptics.notificationAsync(
                  Haptics.NotificationFeedbackType.Error,
                ).catch(() => {});
                Alert.alert(
                  "Sync failed",
                  "Sync couldn't reach the server. Try again in a moment.",
                );
              }
              resolve({ ...ZERO, errors: [rawMsg] });
            },
          },
        );
      });
    },
    [sync, qc],
  );

  return { runSync, isPending: sync.isPending };
}
