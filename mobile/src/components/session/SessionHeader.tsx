import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type { MascotState } from '../mascot';
import { Colors } from '../../theme';

export type SessionPhase = 'observation' | 'resistance';

// Same state → color convention as the hub entity and the voice screen:
// blue = idle/listening, green = hearing the user, coral = Buddy talking/thinking.
const STATE_COLOR: Record<MascotState, string> = {
  idle: Colors.stateIdle,
  listening: Colors.stateIdle,
  user_speaking: Colors.stateUserSpeaking,
  speaking: Colors.coral,
  thinking: Colors.coral,
  celebrating: Colors.stateUserSpeaking,
  empathy: Colors.stateIdle,
};

const STATE_LABEL: Record<MascotState, string> = {
  idle: 'here',
  listening: 'listening',
  user_speaking: 'hearing you',
  speaking: 'talking',
  thinking: 'thinking…',
  celebrating: 'celebrating',
  empathy: 'with you',
};

interface SessionHeaderProps {
  mascotState: MascotState;
  phase: SessionPhase;
}

export default function SessionHeader({ mascotState, phase }: SessionHeaderProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const ringScale = useSharedValue(1);
  const ringOpacity = useSharedValue(0.5);
  useEffect(() => {
    ringScale.value = withRepeat(
      withSequence(withTiming(1, { duration: 0 }), withTiming(1.8, { duration: 2600, easing: Easing.out(Easing.ease) })),
      -1,
    );
    ringOpacity.value = withRepeat(
      withSequence(withTiming(0.5, { duration: 0 }), withTiming(0, { duration: 2600, easing: Easing.out(Easing.ease) })),
      -1,
    );
  }, [ringScale, ringOpacity]);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: ringOpacity.value,
    transform: [{ scale: ringScale.value }],
  }));

  const orbColor = STATE_COLOR[mascotState];
  const resistance = phase === 'resistance';

  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  // Right-hand layout per the web head's default: clock on the far left,
  // Buddy's presence on the thumb side. Phase 5's handedness setting flips it.
  return (
    <View style={styles.row}>
      <View style={styles.clock}>
        <Text style={styles.time}>{time}</Text>
        <Text style={styles.day}>{day}</Text>
      </View>
      <View style={[styles.chip, resistance ? styles.chipResistance : styles.chipObservation]}>
        <View style={[styles.chipDot, { backgroundColor: resistance ? Colors.coral : Colors.stateIdle }]} />
        <Text style={[styles.chipLabel, { color: resistance ? Colors.coral : Colors.stateIdle }]}>
          {resistance ? 'RESISTANCE' : 'OBSERVATION'}
        </Text>
      </View>
      <View style={styles.spacer} />
      <View style={styles.meta}>
        <Text style={styles.name}>Buddy</Text>
        <Text style={styles.state}>{STATE_LABEL[mascotState]}</Text>
      </View>
      <View style={styles.orbWrap}>
        <Animated.View style={[styles.orbRing, ringStyle, { borderColor: orbColor }]} />
        <View style={[styles.orb, { backgroundColor: orbColor }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  orbWrap: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbRing: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
  },
  orb: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  spacer: {
    flex: 1,
  },
  meta: {
    alignItems: 'flex-end',
    gap: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  state: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipObservation: {
    borderColor: 'rgba(91,159,255,0.45)',
    backgroundColor: 'rgba(91,159,255,0.10)',
  },
  chipResistance: {
    borderColor: 'rgba(232,98,74,0.55)',
    backgroundColor: 'rgba(232,98,74,0.12)',
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  chipLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  clock: {
    alignItems: 'flex-start',
    gap: 1,
  },
  time: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  day: {
    fontSize: 10,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
