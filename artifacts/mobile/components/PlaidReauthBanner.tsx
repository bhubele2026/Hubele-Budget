import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  useListPlaidItems,
  type PlaidItemDetail,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import {
  derivePlaidReauthBannerProps,
  formatPlaidErrorForDisplay,
} from "@/lib/plaidReauth";

/**
 * (#387) Mobile mirror of artifacts/h2budget/src/components/plaid-reauth-banner.tsx.
 *
 * Persistently surfaces any Plaid item that needs re-authentication —
 * previously the mobile app only shouted about this on a sync attempt
 * (the Alert from usePlaidSync). With #320 the web banner also shows the
 * "Couldn't verify disconnect date: …" subline when
 * `consentExpirationLastRefreshError` is set; this banner does the same
 * so a mobile-only user can tell when the dated 'will disconnect on …'
 * copy may be reading off a stale cutoff.
 *
 * The mobile app does not host Plaid Link's update flow, so the
 * Reconnect button deep-links to the web app's Settings page (where the
 * per-item Reconnect buttons live) — same fallback as usePlaidSync's
 * Alert "Reconnect" action.
 */

function buildReconnectUrl(): string | null {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) return null;
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  return `${base.replace(/\/+$/, "")}/settings`;
}

export function PlaidReauthBannerView({
  items,
}: {
  items: PlaidItemDetail[] | null | undefined;
}) {
  const colors = useColors();
  const props = useMemo(() => derivePlaidReauthBannerProps(items), [items]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // Reset dismissal whenever the set of affected items changes — a newly
  // failing institution should re-show the banner even if the user
  // dismissed an earlier one.
  useEffect(() => {
    if (dismissedKey && dismissedKey !== props.dismissKey) {
      setDismissedKey(null);
    }
  }, [props.dismissKey, dismissedKey]);

  if (!props.show) return null;
  if (dismissedKey === props.dismissKey) return null;

  const onReconnect = () => {
    const url = buildReconnectUrl();
    if (!url) {
      Alert.alert(
        "Open the web app",
        "Open H2 Budget on the web and use Settings → Reconnect.",
      );
      return;
    }
    Linking.openURL(url).catch(() => {
      Alert.alert("Couldn't open Settings", "Please open the web app manually.");
    });
  };

  return (
    <View
      testID="banner-plaid-reauth"
      accessibilityRole="alert"
      style={[
        styles.container,
        { borderColor: "#f59e0b", backgroundColor: "#fffbeb" },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          testID="text-plaid-reauth-headline"
          style={[styles.headline, { color: "#78350f" }]}
        >
          {props.headline}
        </Text>
        <Text
          testID="text-plaid-reauth-subline"
          style={[styles.subline, { color: "#78350f" }]}
        >
          {props.subline}
        </Text>
        {props.consentRefreshError && props.worstId && (
          <Text
            testID={`text-plaid-reauth-consent-refresh-error-${props.worstId}`}
            style={[styles.consentLine, { color: "#78350f" }]}
          >
            Couldn't verify disconnect date:{" "}
            {formatPlaidErrorForDisplay(props.consentRefreshError)}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        <Pressable
          testID="button-plaid-reauth-reconnect"
          onPress={onReconnect}
          style={[
            styles.reconnectBtn,
            { backgroundColor: colors.primary },
          ]}
          accessibilityRole="button"
        >
          <Text
            style={[
              styles.reconnectBtnText,
              { color: colors.primaryForeground },
            ]}
          >
            Reconnect
          </Text>
        </Pressable>
        <Pressable
          testID="button-plaid-reauth-dismiss"
          onPress={() => setDismissedKey(props.dismissKey)}
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          style={styles.dismissBtn}
        >
          <Text style={[styles.dismissBtnText, { color: "#78350f" }]}>×</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function PlaidReauthBanner() {
  const { data: items } = useListPlaidItems();
  return <PlaidReauthBannerView items={items} />;
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  headline: {
    fontSize: 15,
    fontWeight: "600",
  },
  subline: {
    fontSize: 13,
    marginTop: 2,
    opacity: 0.9,
  },
  consentLine: {
    fontSize: 12,
    marginTop: 4,
    opacity: 0.9,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  reconnectBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  reconnectBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  dismissBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  dismissBtnText: {
    fontSize: 22,
    lineHeight: 22,
    fontWeight: "500",
  },
});
