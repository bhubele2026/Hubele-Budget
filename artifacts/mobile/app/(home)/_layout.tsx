import { useAuth, useClerk } from "@clerk/expo";
import { useQueryClient } from "@tanstack/react-query";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { Redirect, Stack } from "expo-router";
import React, { useEffect, useRef } from "react";

export default function HomeLayout() {
  const { isSignedIn, getToken } = useAuth();
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // The generated API client attaches `Authorization: Bearer <token>`
    // for every request that doesn't already set the header.
    setAuthTokenGetter(() => getToken());
    return () => {
      setAuthTokenGetter(null);
    };
  }, [getToken]);

  useEffect(() => {
    // When the signed-in user changes (sign-out, swap), clear the cache so
    // the next mount of the app sees fresh data instead of the previous
    // user's responses.
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="transaction/[id]"
        options={{
          presentation: "modal",
          headerShown: true,
          title: "Transaction",
        }}
      />
    </Stack>
  );
}
