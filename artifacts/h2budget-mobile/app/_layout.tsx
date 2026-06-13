import { ClerkProvider, ClerkLoaded } from "@clerk/clerk-expo";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { tokenCache } from "@/lib/tokenCache";

const publishableKey =
  (Constants.expoConfig?.extra?.clerkPublishableKey as string) ?? "";

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
