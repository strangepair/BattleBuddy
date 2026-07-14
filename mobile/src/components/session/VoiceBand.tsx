import { View, Text, StyleSheet } from 'react-native';
import type { MascotState } from '../mascot';
import { Colors } from '../../theme';

// The slim strip above the dock while audio is on — the web head's
// .voice-band: VOICE tag, a small level meter, and a one-line caption.

const BAR_COUNT = 5;
// Static per-bar multipliers give the meter a natural silhouette.
const BAR_SHAPE = [0.5, 0.8, 1, 0.7, 0.45];

interface VoiceBandProps {
  audioLevel: number;
  mascotState: MascotState;
  muted: boolean;
}

function caption(mascotState: MascotState, muted: boolean): string {
  if (muted) return "muted — Buddy can't hear you";
  switch (mascotState) {
    case 'user_speaking':
      return 'hearing you…';
    case 'speaking':
      return 'Buddy is talking…';
    case 'thinking':
      return 'thinking…';
    default:
      return 'listening…';
  }
}

export default function VoiceBand({ audioLevel, mascotState, muted }: VoiceBandProps) {
  const active = Math.min(1, audioLevel * 1.6);
  return (
    <View style={styles.band}>
      <Text style={styles.tag}>VOICE</Text>
      <View style={styles.meter}>
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                height: 4 + 12 * BAR_SHAPE[i] * (0.35 + 0.65 * active),
                backgroundColor: muted ? Colors.textTertiary : Colors.stateIdle,
              },
            ]}
          />
        ))}
      </View>
      <Text style={styles.caption} numberOfLines={1}>
        {caption(mascotState, muted)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.surfaceBorder,
    backgroundColor: 'rgba(91,159,255,0.06)',
  },
  tag: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: Colors.stateIdle,
  },
  meter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    height: 18,
  },
  bar: {
    width: 3.5,
    borderRadius: 2,
  },
  caption: {
    flex: 1,
    fontSize: 13,
    fontStyle: 'italic',
    color: Colors.textSecondary,
  },
});
