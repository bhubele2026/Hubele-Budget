import { useEffect, useRef } from "react";
import { Animated, type ViewStyle } from "react-native";
import { colors } from "@/lib/theme";

/** A matte shimmer placeholder — premium loading, no spinners. */
export function Skeleton({ style }: { style?: ViewStyle }) {
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 720,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 720,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[
        {
          height: 16,
          borderRadius: 12,
          backgroundColor: colors.card,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}
