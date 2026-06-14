import { ClerkProvider, ClerkLoaded } from "@clerk/clerk-expo";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { tokenCache } from "@/lib/tokenCache";

// Clerk publishable key. Prefer the standard Expo public env var (set it once
// in a `.env` at the mobile app root: EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
// — the SAME pk_ key the web app uses), falling back to app.json `extra`.
const publishableKey =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  (Constants.expoConfig?.extra?.clerkPublishableKey as string) ||
  "";

export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <ClerkLoaded>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <Slot />
        </SafeAreaProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
