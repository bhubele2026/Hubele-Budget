import { useSignIn, useSSO } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import * as AuthSession from "expo-auth-session";
import { Link, useRouter, type Href } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const { startSSOFlow } = useSSO();
  const router = useRouter();
  const colors = useColors();

  const [emailAddress, setEmailAddress] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [oauthLoading, setOauthLoading] = React.useState(false);
  const [oauthError, setOauthError] = React.useState<string | null>(null);

  useEffect(() => {
    WebBrowser.warmUpAsync();
    return () => {
      WebBrowser.coolDownAsync();
    };
  }, []);

  const goHome = () => router.replace("/(home)/(tabs)" as Href);

  const handleSubmit = async () => {
    const { error } = await signIn.password({
      identifier: emailAddress.trim(),
      password,
    });
    if (error) return;
    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: () => goHome(),
      });
    }
  };

  const handleGoogle = async () => {
    setOauthError(null);
    setOauthLoading(true);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: "oauth_google",
        redirectUrl: AuthSession.makeRedirectUri({ scheme: "mobile" }),
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId, navigate: async () => goHome() });
      }
    } catch (err) {
      setOauthError(
        err instanceof Error ? err.message : "Google sign-in failed",
      );
    } finally {
      setOauthLoading(false);
    }
  };

  const busy = fetchStatus === "fetching";
  const disabled = !emailAddress || !password || busy;

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.background }]}
      edges={["top", "bottom"]}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brand}>
            <View
              style={[
                styles.logoBox,
                { backgroundColor: colors.primary },
              ]}
            >
              <Text style={styles.logoMark}>H₂</Text>
            </View>
            <Text style={[styles.title, { color: colors.foreground }]}>
              Welcome back
            </Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              Sign in to your H2 Family Budget
            </Text>
          </View>

          <Text style={[styles.label, { color: colors.foreground }]}>
            Email address
          </Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: colors.card,
                color: colors.foreground,
                borderColor: colors.border,
              },
            ]}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            placeholder="you@example.com"
            placeholderTextColor={colors.mutedForeground}
            value={emailAddress}
            onChangeText={setEmailAddress}
          />
          {errors?.fields?.identifier && (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {errors.fields.identifier.message}
            </Text>
          )}

          <Text
            style={[styles.label, { color: colors.foreground, marginTop: 12 }]}
          >
            Password
          </Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: colors.card,
                color: colors.foreground,
                borderColor: colors.border,
              },
            ]}
            secureTextEntry
            autoComplete="current-password"
            placeholder="••••••••"
            placeholderTextColor={colors.mutedForeground}
            value={password}
            onChangeText={setPassword}
          />
          {errors?.fields?.password && (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {errors.fields.password.message}
            </Text>
          )}
          {errors?.raw && errors.raw.length > 0 && (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {(errors.raw[0] as { message?: string })?.message ?? "Sign in failed"}
            </Text>
          )}

          <Pressable
            onPress={handleSubmit}
            disabled={disabled}
            style={({ pressed }) => [
              styles.primaryButton,
              {
                backgroundColor: colors.primary,
                opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
              },
            ]}
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text
                style={[
                  styles.primaryButtonText,
                  { color: colors.primaryForeground },
                ]}
              >
                Sign in
              </Text>
            )}
          </Pressable>

          <View style={styles.dividerRow}>
            <View
              style={[styles.dividerLine, { backgroundColor: colors.border }]}
            />
            <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>
              or
            </Text>
            <View
              style={[styles.dividerLine, { backgroundColor: colors.border }]}
            />
          </View>

          <Pressable
            onPress={handleGoogle}
            disabled={oauthLoading}
            style={({ pressed }) => [
              styles.secondaryButton,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                opacity: oauthLoading ? 0.6 : pressed ? 0.85 : 1,
              },
            ]}
          >
            {oauthLoading ? (
              <ActivityIndicator color={colors.foreground} />
            ) : (
              <>
                <Feather name="chrome" size={20} color={colors.foreground} />
                <Text
                  style={[
                    styles.secondaryButtonText,
                    { color: colors.foreground },
                  ]}
                >
                  Continue with Google
                </Text>
              </>
            )}
          </Pressable>
          {oauthError && (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {oauthError}
            </Text>
          )}

          <View style={styles.footerRow}>
            <Text style={{ color: colors.mutedForeground }}>
              Don't have an account?{" "}
            </Text>
            <Link href="/(auth)/sign-up" replace>
              <Text style={{ color: colors.primary, fontWeight: "600" }}>
                Sign up
              </Text>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: {
    padding: 24,
    paddingTop: 12,
    flexGrow: 1,
    justifyContent: "center",
  },
  brand: {
    alignItems: "center",
    marginBottom: 32,
  },
  logoBox: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  logoMark: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 24,
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    marginBottom: 6,
  },
  subtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 15,
  },
  label: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
  },
  error: {
    marginTop: 6,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  primaryButton: {
    marginTop: 20,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 18,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
  },
  secondaryButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 24,
  },
});
