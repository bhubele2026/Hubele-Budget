import { Tabs, Redirect } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { Feather } from "@expo/vector-icons";
import { colors } from "@/lib/theme";

export default function TabsLayout() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && !isSignedIn) return <Redirect href="/sign-in" />;

  return (
    <Tabs
      initialRouteName="home"
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          height: 86,
          paddingTop: 8,
          paddingBottom: 24,
        },
        tabBarActiveTintColor: colors.navy,
        tabBarInactiveTintColor: colors.faint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => (
            <Feather name="home" size={20} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: "Allowances",
          tabBarIcon: ({ color }) => (
            <Feather name="pie-chart" size={20} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: "Categorize",
          tabBarIcon: ({ color }) => (
            <Feather name="check-square" size={20} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
