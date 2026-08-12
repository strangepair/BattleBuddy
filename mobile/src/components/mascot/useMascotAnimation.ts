import { useEffect } from 'react';
import {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  withTiming,
  withRepeat,
  withSequence,
  withSpring,
  interpolateColor,
  cancelAnimation,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { Colors } from '../../theme';

export type MascotState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'speaking'
  | 'thinking'
  | 'celebrating'
  | 'empathy';

// 3 colors: blue (idle/waiting), green (hearing user), blue (BB talking)
const STATE_COLORS = [
  Colors.stateIdle,         // 0 = blue
  Colors.stateUserSpeaking, // 1 = green
  Colors.stateListening,    // 2 = blue (BB speaking)
] as const;

const STATE_INDEX: Record<MascotState, number> = {
  idle: 0,        // blue — waiting
  listening: 0,   // blue — waiting for user
  user_speaking: 1, // green — hearing user
  speaking: 2,    // blue — BB talking
  thinking: 2,    // blue — BB processing (still "talking")
  celebrating: 1, // green
  empathy: 0,     // blue
};

const ease = Easing.inOut(Easing.ease);

export interface MascotAnimationResult {
  breathingStyle: ReturnType<typeof useAnimatedStyle>;
  ringStyle: ReturnType<typeof useAnimatedStyle>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eyeAnimatedProps: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  glowAnimatedProps: any;
  glowOpacity: SharedValue<number>;
}

export function useMascotAnimation(state: MascotState): MascotAnimationResult {
  const stateIndex = useSharedValue(STATE_INDEX[state]);
  const breatheY = useSharedValue(0);
  const ringScale = useSharedValue(1);
  const ringOpacity = useSharedValue(0);
  const glowOpacity = useSharedValue(0.15);

  // Smooth color transition
  useEffect(() => {
    stateIndex.value = withTiming(STATE_INDEX[state], { duration: 400 });
  }, [state, stateIndex]);

  // Breathing / floating
  useEffect(() => {
    cancelAnimation(breatheY);

    switch (state) {
      case 'idle':
        // Gentle float on home screen
        breatheY.value = withRepeat(
          withSequence(
            withTiming(-4, { duration: 1500, easing: ease }),
            withTiming(4, { duration: 1500, easing: ease }),
          ),
          -1,
        );
        break;

      case 'listening':
        // Completely still — waiting for the user
        breatheY.value = withTiming(0, { duration: 300 });
        break;

      case 'thinking':
        // Subtle side-to-side sway — "processing"
        breatheY.value = withRepeat(
          withSequence(
            withTiming(-2, { duration: 600, easing: ease }),
            withTiming(2, { duration: 600, easing: ease }),
          ),
          -1,
        );
        break;

      case 'user_speaking':
        // Responsive pulse — reacts to user voice
        breatheY.value = withRepeat(
          withSequence(
            withTiming(-2, { duration: 500, easing: ease }),
            withTiming(2, { duration: 500, easing: ease }),
          ),
          -1,
        );
        break;

      case 'speaking':
        // Energetic — BB is talking
        breatheY.value = withRepeat(
          withSequence(
            withTiming(-3, { duration: 400, easing: ease }),
            withTiming(3, { duration: 400, easing: ease }),
          ),
          -1,
        );
        break;

      case 'celebrating':
        breatheY.value = withSequence(
          withSpring(-6, { damping: 3, stiffness: 180 }),
          withSpring(0, { damping: 5, stiffness: 120 }),
          withSpring(-4, { damping: 4, stiffness: 160 }),
          withSpring(0, { damping: 6, stiffness: 100 }),
        );
        break;

      case 'empathy':
        // Very slow, gentle
        breatheY.value = withRepeat(
          withSequence(
            withTiming(-3, { duration: 2000, easing: ease }),
            withTiming(3, { duration: 2000, easing: ease }),
          ),
          -1,
        );
        break;
    }
  }, [state, breatheY]);

  // Ring pulse
  useEffect(() => {
    cancelAnimation(ringScale);
    cancelAnimation(ringOpacity);

    switch (state) {
      case 'listening':
        // No ring — still
        ringScale.value = withTiming(1, { duration: 300 });
        ringOpacity.value = withTiming(0, { duration: 300 });
        break;

      case 'thinking':
        // Slow gentle pulse — "processing"
        ringScale.value = withRepeat(
          withTiming(1.08, { duration: 1000, easing: ease }),
          -1,
          true,
        );
        ringOpacity.value = withRepeat(
          withSequence(
            withTiming(0.3, { duration: 1000, easing: ease }),
            withTiming(0.1, { duration: 1000, easing: ease }),
          ),
          -1,
        );
        break;

      case 'user_speaking':
        ringScale.value = withRepeat(
          withTiming(1.16, { duration: 500, easing: ease }),
          -1,
          true,
        );
        ringOpacity.value = withRepeat(
          withSequence(
            withTiming(0.55, { duration: 500, easing: ease }),
            withTiming(0.2, { duration: 500, easing: ease }),
          ),
          -1,
        );
        break;

      case 'speaking':
        ringScale.value = withRepeat(
          withTiming(1.22, { duration: 400, easing: ease }),
          -1,
          true,
        );
        ringOpacity.value = withRepeat(
          withSequence(
            withTiming(0.65, { duration: 400, easing: ease }),
            withTiming(0.25, { duration: 400, easing: ease }),
          ),
          -1,
        );
        break;

      case 'idle':
        ringScale.value = withRepeat(
          withTiming(1.06, { duration: 1500, easing: ease }),
          -1,
          true,
        );
        ringOpacity.value = withRepeat(
          withSequence(
            withTiming(0.25, { duration: 1500, easing: ease }),
            withTiming(0.1, { duration: 1500, easing: ease }),
          ),
          -1,
        );
        break;

      case 'celebrating':
        ringScale.value = withRepeat(
          withTiming(1.3, { duration: 300, easing: ease }),
          -1,
          true,
        );
        ringOpacity.value = withTiming(0.75, { duration: 200 });
        break;

      case 'empathy':
        ringScale.value = withRepeat(
          withTiming(1.04, { duration: 2000, easing: ease }),
          -1,
          true,
        );
        ringOpacity.value = withTiming(0.2, { duration: 500 });
        break;
    }
  }, [state, ringScale, ringOpacity]);

  // Eye glow pulse
  useEffect(() => {
    cancelAnimation(glowOpacity);

    switch (state) {
      case 'listening':
        // Dim and still
        glowOpacity.value = withTiming(0.15, { duration: 300 });
        break;

      case 'thinking':
        // Rhythmic pulse — "I'm working on it"
        glowOpacity.value = withRepeat(
          withSequence(
            withTiming(0.5, { duration: 600, easing: ease }),
            withTiming(0.1, { duration: 600, easing: ease }),
          ),
          -1,
        );
        break;

      case 'user_speaking':
        glowOpacity.value = withRepeat(
          withSequence(
            withTiming(0.45, { duration: 500, easing: ease }),
            withTiming(0.15, { duration: 500, easing: ease }),
          ),
          -1,
        );
        break;

      case 'speaking':
      case 'celebrating':
        glowOpacity.value = withRepeat(
          withSequence(
            withTiming(0.6, { duration: 400, easing: ease }),
            withTiming(0.18, { duration: 400, easing: ease }),
          ),
          -1,
        );
        break;

      default:
        // idle, empathy
        glowOpacity.value = withRepeat(
          withSequence(
            withTiming(0.35, { duration: 1500, easing: ease }),
            withTiming(0.1, { duration: 1500, easing: ease }),
          ),
          -1,
        );
        break;
    }
  }, [state, glowOpacity]);

  // --- Animated outputs ---

  const breathingStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: breatheY.value }],
  }));

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale.value }],
    opacity: ringOpacity.value,
    borderColor: interpolateColor(
      stateIndex.value,
      [0, 1, 2],
      [...STATE_COLORS],
    ),
  }));

  const eyeAnimatedProps = useAnimatedProps(() => ({
    fill: interpolateColor(
      stateIndex.value,
      [0, 1, 2],
      [...STATE_COLORS],
    ),
  }));

  const glowAnimatedProps = useAnimatedProps(() => ({
    fill: interpolateColor(
      stateIndex.value,
      [0, 1, 2],
      [...STATE_COLORS],
    ),
    opacity: glowOpacity.value,
  }));

  return {
    breathingStyle,
    ringStyle,
    eyeAnimatedProps,
    glowAnimatedProps,
    glowOpacity,
  };
}
