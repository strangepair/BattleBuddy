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
import { useSettingsStore } from '../../stores/settingsStore';
import { Colors } from '../../theme';

export type SessionPhase = 'observation' | 'resistance';

// Presence colors per the One Conversation spec (MOBILE-PORT §3):
// blue = neutral/listening, orange = hearing the user, coral = responding.
const STATE_COLOR: Record<MascotState, string> = {
  idle: Colors.stateIdle,
  listening: Colors.stateIdle,
  user_speaking: Colors.stateListening,
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

export default function SessionHeader({ mascotState, phase: _phase }: SessionHeaderProps) {
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

  const hand = useSettingsStore((s) => s.hand);
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  const clock = (
    <View style={[styles.clock, hand === 'left' && styles.clockLeftHand]}>
      <Text style={styles.time}>{time}</Text>
      <Text style={styles.day}>{day}</Text>
    </View>
  );
  const buddy = (
    <View style={[styles.meta, hand === 'left' && styles.metaLeftHand]}>
      <Text style={styles.name}>Buddy</Text>
      <Text style={styles.state}>{STATE_LABEL[mascotState]}</Text>
    </View>
  );
  const orb = (
    <View style={styles.orbWrap}>
      <Animated.View style={[styles.orbRing, ringStyle, { borderColor: orbColor }]} />
      <View style={[styles.orb, { backgroundColor: orbColor }]} />
    </View>
  );

  // Buddy's presence lives on the thumb side; clock on the other.
  return hand === 'right' ? (
    <View style={styles.row}>
      {clock}
      <View style={styles.spacer} />
      {buddy}
      {orb}
    </View>
  ) : (
    <View style={styles.row}>
      {orb}
      {buddy}
      <View style={styles.spacer} />
      {clock}
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
  metaLeftHand: {
    alignItems: 'flex-start',
  },
  clockLeftHand: {
    alignItems: 'flex-end',
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
