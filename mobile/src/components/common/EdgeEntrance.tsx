import { useEffect, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import type { Direction } from '../../lib/navDirections';

// Mirrors HubHomeScreen's swipe-exit animation on the way in: each hub
// destination sits on a fixed edge relative to home (see navDirections.ts),
// so on mount it slides in from that edge no matter how the screen was
// reached (drag, BBNavOverlay tap, or a direct voice<->chat switch). Native
// stack animation is disabled for these routes so this is the only motion.
const ENTRANCE_SPRING = { damping: 20, stiffness: 200 };

interface EdgeEntranceProps {
  // The edge this screen lives on relative to the hub, e.g. 'down' for Voice
  // (below home) means it enters by sliding up from the bottom edge.
  edge: Direction;
  children: ReactNode;
}

export default function EdgeEntrance({ edge, children }: EdgeEntranceProps) {
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();

  const translateX = useSharedValue(edge === 'left' ? -SCREEN_W : edge === 'right' ? SCREEN_W : 0);
  const translateY = useSharedValue(edge === 'up' ? -SCREEN_H : edge === 'down' ? SCREEN_H : 0);

  // Runs once on mount — this is an entrance animation, not a responder to
  // dimension changes, so it intentionally ignores translateX/translateY.
  useEffect(() => {
    translateX.value = withSpring(0, ENTRANCE_SPRING);
    translateY.value = withSpring(0, ENTRANCE_SPRING);
  }, []);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  return <Animated.View style={[styles.fill, style]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
