import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSignIn, useAuth } from "@clerk/clerk-expo";
import { Redirect } from "expo-router";
import { colors, radius } from "@/lib/theme";

export default function SignIn() {
  const { isSignedIn } = useAuth();
  const { signIn, setActive, isLoaded } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isSignedIn) return <Redirect href="/(tabs)" />;

  const onSubmit = async () => {
    if (!isLoaded) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email, password });
      if (attempt.status === "complete") {
        await setActive({ session: attempt.createdSessionId });
      } else {
        setError("Additional verification required — finish sign-in on the web first.");
      }
    } catch (e: any) {
      setError(e?.errors?.[0]?.message ?? (e instanceof Error ? e.message : "Sign-in failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.wrap}
      >
        <View style={styles.logo}>
          <Text style={styles.logoText}>H2</Text>
        </View>
        <Text style={styles.title}>H2 Budget</Text>
        <Text style={styles.subtitle}>
          Where your money has nowhere to hide.
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.faint}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.button, busy && { opacity: 0.6 }]}
          onPress={onSubmit}
          disabled={busy}
        >
          <Text style={styles.buttonText}>{busy ? "Signing in…" : "Sign in"}</Text>
        </Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  wrap: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.navy,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 4,
  },
  logoText: { color: colors.navy, fontSize: 22, fontWeight: "800" },
  title: { fontSize: 26, fontWeight: "700", color: colors.text, textAlign: "center" },
  subtitle: { fontSize: 14, color: colors.muted, textAlign: "center", marginBottom: 12 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.text,
  },
  error: { color: colors.negative, fontSize: 13 },
  button: {
    backgroundColor: colors.navy,
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 4,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
