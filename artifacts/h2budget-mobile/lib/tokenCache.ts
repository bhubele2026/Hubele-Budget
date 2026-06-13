import * as SecureStore from "expo-secure-store";
import type { TokenCache } from "@clerk/clerk-expo/dist/cache";

// Persist Clerk's session token in the device keychain so the user stays
// signed in between launches.
export const tokenCache: TokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // ignore
    }
  },
};
