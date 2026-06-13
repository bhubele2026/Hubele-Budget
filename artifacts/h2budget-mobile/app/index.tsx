import { Redirect } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { View, ActivityIndicator } from "react-native";
import { colors } from "@/lib/theme";

export default function Index() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.navy} />
      </View>
    );
  }
  return <Redirect href={isSignedIn ? "/(tabs)" : "/sign-in"} />;
}
