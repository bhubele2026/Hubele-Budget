import { Tabs, Redirect } from "expo-router";
import { useAuth } from "@clerk/clerk-expo";
import { Text } from "react-native";
import { colors } from "@/lib/theme";

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: focused ? "700" : "500", color: focused ? colors.navy : colors.faint }}>
      {label}
    </Text>
  );
}

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
          height: 84,
          paddingTop: 8,
        },
        tabBarShowLabel: false,
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon label="Home" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon label="Allowances" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon label="Categorize" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
