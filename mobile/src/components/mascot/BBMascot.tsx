import { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  withTiming,
  withRepeat,
  withSequence,
  withDelay,
  interpolateColor,
  Easing,
} from 'react-native-reanimated';
import Svg, { Circle, Ellipse, Defs, RadialGradient, Stop } from 'react-native-svg';
import { Colors } from '../../theme';
import { useMascotAnimation, type MascotState } from './useMascotAnimation';

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// 3 colors: blue (idle/waiting), green (hearing user), blue (BB talking)
const STATE_COLORS = [
  Colors.stateIdle,         // 0 = blue
  Colors.stateUserSpeaking, // 1 = green
  Colors.stateListening,    // 2 = blue (BB speaking)
];

const STATE_INDEX: Record<MascotState, number> = {
  idle: 0, listening: 0, user_speaking: 1, speaking: 2,
  thinking: 2, celebrating: 1, empathy: 0,
};

interface BBMascotProps {
  state?: MascotState;
  size?: number;
  showRing?: boolean;
  audioLevel?: number;
}

export default function BBMascot({ state = 'idle', size = 200, showRing = true, audioLevel = 0 }: BBMascotProps) {
  const {
    breathingStyle,
    ringStyle,
  } = useMascotAnimation(state);

  const stateIndex = useSharedValue(STATE_INDEX[state]);

  useEffect(() => {
    stateIndex.value = withTiming(STATE_INDEX[state], { duration: 400 });
  }, [state, stateIndex]);

  // Blob layer animations — each layer rotates/morphs at different speeds
  const blob1Rotate = useSharedValue(0);
  const blob2Rotate = useSharedValue(0);
  const blob3Rotate = useSharedValue(0);
  const blob4Rotate = useSharedValue(0);

  const audioScale = useSharedValue(1);

  useEffect(() => {
    const ease = Easing.inOut(Easing.ease);
    // Very slow, never-aligning rotations — co-prime durations prevent sync jitter
    blob1Rotate.value = withRepeat(withTiming(360, { duration: 37000, easing: Easing.linear }), -1);
    blob2Rotate.value = withRepeat(withTiming(-360, { duration: 43000, easing: Easing.linear }), -1);
    blob3Rotate.value = withRepeat(withTiming(360, { duration: 53000, easing: Easing.linear }), -1);
    blob4Rotate.value = withRepeat(
      withSequence(
        withTiming(8, { duration: 7000, easing: ease }),
        withTiming(-8, { duration: 7000, easing: ease }),
      ),
      -1,
    );
  }, [blob1Rotate, blob2Rotate, blob3Rotate, blob4Rotate]);

  // Audio-reactive scaling
  useEffect(() => {
    const target = 1 + audioLevel * 0.3;
    audioScale.value = withTiming(target, { duration: 100 });
  }, [audioLevel, audioScale]);

  const blob1Style = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${blob1Rotate.value}deg` },
      { scale: audioScale.value },
    ],
  }));

  const blob2Style = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${blob2Rotate.value}deg` },
      { scale: 0.85 + (audioScale.value - 1) * 0.5 },
    ],
  }));

  const blob3Style = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${blob3Rotate.value}deg` },
      { scale: 0.7 + (audioScale.value - 1) * 0.8 },
    ],
  }));

  const blob4Style = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${blob4Rotate.value}deg` },
      { scaleX: audioScale.value * 1.1 },
      { scaleY: audioScale.value * 0.9 },
    ],
  }));

  // Color-animated blobs
  const blobColorProps = useAnimatedProps(() => ({
    fill: interpolateColor(
      stateIndex.value,
      [0, 1, 2],
      STATE_COLORS.map(c => c),
    ),
  }));

  const glowColorProps = useAnimatedProps(() => ({
    fill: interpolateColor(
      stateIndex.value,
      [0, 1, 2],
      STATE_COLORS.map(c => c),
    ),
    opacity: 0.15,
  }));

  const coreColorProps = useAnimatedProps(() => ({
    fill: interpolateColor(
      stateIndex.value,
      [0, 1, 2],
      STATE_COLORS.map(c => c),
    ),
    opacity: 0.9,
  }));

  const ringDiameter = size * 0.92;
  const blobSize = size * 0.8;
  const halfBlob = blobSize / 2;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      {/* Pulse ring */}
      {showRing && (
        <Animated.View
          style={[
            styles.ring,
            {
              width: ringDiameter,
              height: ringDiameter,
              borderRadius: ringDiameter / 2,
            },
            ringStyle,
          ]}
        />
      )}

      {/* Breathing wrapper */}
      <Animated.View style={[styles.blobContainer, { width: blobSize, height: blobSize }, breathingStyle]}>

        {/* Layer 1: outer glow blob — slowest rotation */}
        <Animated.View style={[styles.blobLayer, blob1Style]}>
          <Svg width={blobSize} height={blobSize} viewBox="0 0 200 200">
            <AnimatedEllipse cx={100} cy={100} rx={90} ry={75} animatedProps={glowColorProps} />
          </Svg>
        </Animated.View>

        {/* Layer 2: mid blob — counter-rotating */}
        <Animated.View style={[styles.blobLayer, blob2Style]}>
          <Svg width={blobSize} height={blobSize} viewBox="0 0 200 200">
            <AnimatedEllipse cx={100} cy={100} rx={70} ry={80} animatedProps={blobColorProps} opacity={0.3} />
          </Svg>
        </Animated.View>

        {/* Layer 3: inner blob — faster, more audio-reactive */}
        <Animated.View style={[styles.blobLayer, blob3Style]}>
          <Svg width={blobSize} height={blobSize} viewBox="0 0 200 200">
            <AnimatedEllipse cx={100} cy={100} rx={55} ry={65} animatedProps={blobColorProps} opacity={0.5} />
          </Svg>
        </Animated.View>

        {/* Layer 4: organic wobble blob */}
        <Animated.View style={[styles.blobLayer, blob4Style]}>
          <Svg width={blobSize} height={blobSize} viewBox="0 0 200 200">
            <AnimatedEllipse cx={100} cy={100} rx={60} ry={50} animatedProps={blobColorProps} opacity={0.25} />
          </Svg>
        </Animated.View>

        {/* Core: bright center */}
        <View style={styles.blobLayer}>
          <Svg width={blobSize} height={blobSize} viewBox="0 0 200 200">
            <AnimatedCircle cx={100} cy={100} r={35} animatedProps={coreColorProps} />
            <Circle cx={100} cy={100} r={18} fill="#FFFFFF" opacity={0.15} />
            <Circle cx={90} cy={92} r={6} fill="#FFFFFF" opacity={0.25} />
          </Svg>
        </View>

      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    borderWidth: 2.5,
    borderColor: Colors.stateIdle,
  },
  blobContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  blobLayer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
