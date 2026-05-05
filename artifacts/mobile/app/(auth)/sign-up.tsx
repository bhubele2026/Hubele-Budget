import { useSignUp, useSSO } from "@clerk/expo";
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

export default function SignUpScreen() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const { startSSOFlow } = useSSO();
  const router = useRouter();
  const colors = useColors();

  const [emailAddress, setEmailAddress] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
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
    const { error } = await signUp.password({
      emailAddress: emailAddress.trim(),
      password,
    });
    if (error) return;
    await signUp.verifications.sendEmailCode();
  };

  const handleVerify = async () => {
    await signUp.verifications.verifyEmailCode({ code });
    if (signUp.status === "complete") {
      await signUp.finalize({ navigate: () => goHome() });
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
        err instanceof Error ? err.message : "Google sign-up failed",
      );
    } finally {
      setOauthLoading(false);
    }
  };

  const busy = fetchStatus === "fetching";
  const needsVerification =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields?.includes?.("email_address") &&
    signUp.missingFields?.length === 0;

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
              style={[styles.logoBox, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.logoMark}>H₂</Text>
            </View>
            <Text style={[styles.title, { color: colors.foreground }]}>
              {needsVerification ? "Verify your email" : "Create your account"}
            </Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              {needsVerification
                ? "Enter the 6-digit code we sent you"
                : "Track every dollar, together"}
            </Text>
          </View>

          {needsVerification ? (
            <>
              <Text style={[styles.label, { color: colors.foreground }]}>
                Verification code
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.card,
                    color: colors.foreground,
                    borderColor: colors.border,
                    letterSpacing: 6,
                    textAlign: "center",
                    fontSize: 22,
                  },
                ]}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                placeholder="123456"
                placeholderTextColor={colors.mutedForeground}
              />
              {errors?.fields?.code && (
                <Text style={[styles.error, { color: colors.destructive }]}>
                  {errors.fields.code.message}
                </Text>
              )}
              <Pressable
                onPress={handleVerify}
                disabled={busy || code.length < 4}
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    backgroundColor: colors.primary,
                    opacity: busy || code.length < 4 ? 0.5 : pressed ? 0.85 : 1,
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
                    Verify & continue
                  </Text>
                )}
              </Pressable>
              <Pressable
                onPress={() => signUp.verifications.sendEmailCode()}
                style={{ marginTop: 14, alignItems: "center" }}
              >
                <Text style={{ color: colors.primary, fontWeight: "600" }}>
                  Resend code
                </Text>
              </Pressable>
            </>
          ) : (
            <>
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
              {errors?.fields?.emailAddress && (
                <Text style={[styles.error, { color: colors.destructive }]}>
                  {errors.fields.emailAddress.message}
                </Text>
              )}

              <Text
                style={[
                  styles.label,
                  { color: colors.foreground, marginTop: 12 },
                ]}
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
                autoComplete="new-password"
                placeholder="At least 8 characters"
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
                  {(errors.raw[0] as { message?: string })?.message ?? "Sign up failed"}
                </Text>
              )}

              <Pressable
                onPress={handleSubmit}
                disabled={!emailAddress || !password || busy}
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    backgroundColor: colors.primary,
                    opacity:
                      !emailAddress || !password || busy
                        ? 0.5
                        : pressed
                          ? 0.85
                          : 1,
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
                    Create account
                  </Text>
                )}
              </Pressable>

              <View style={styles.dividerRow}>
                <View
                  style={[
                    styles.dividerLine,
                    { backgroundColor: colors.border },
                  ]}
                />
                <Text
                  style={[styles.dividerText, { color: colors.mutedForeground }]}
                >
                  or
                </Text>
                <View
                  style={[
                    styles.dividerLine,
                    { backgroundColor: colors.border },
                  ]}
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
                  Already have an account?{" "}
                </Text>
                <Link href="/(auth)/sign-in" replace>
                  <Text style={{ color: colors.primary, fontWeight: "600" }}>
                    Sign in
                  </Text>
                </Link>
              </View>

              {/* Required for sign-up flows; Clerk's bot protection. */}
              <View nativeID="clerk-captcha" />
            </>
          )}
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
  brand: { alignItems: "center", marginBottom: 32 },
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
    textAlign: "center",
  },
  subtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    textAlign: "center",
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
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
  },
  secondaryButtonText: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  footerRow: { flexDirection: "row", justifyContent: "center", marginTop: 24 },
});
