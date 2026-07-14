import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Colors } from '../../theme';

export type SessionView = 'home' | 'chat' | 'content';

const SEGMENTS: { key: SessionView; label: string }[] = [
  { key: 'home', label: 'Home' },
  { key: 'chat', label: 'Conversation' },
  { key: 'content', label: 'Content' },
];

interface SegBarProps {
  view: SessionView;
  onChange: (view: SessionView) => void;
}

export default function SegBar({ view, onChange }: SegBarProps) {
  return (
    <View style={styles.bar}>
      <View style={styles.seg}>
        {SEGMENTS.map(({ key, label }) => {
          const on = view === key;
          return (
            <TouchableOpacity
              key={key}
              style={[styles.segBtn, on && styles.segBtnOn]}
              onPress={() => {
                if (!on) {
                  Haptics.selectionAsync().catch(() => {});
                  onChange(key);
                }
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.segLabel, on && styles.segLabelOn]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    // Tabs sit on the thumb side; the left gap is reserved for Phase 5's
    // Aa text-size slider, matching the web head's seg-bar row.
    justifyContent: 'flex-end',
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  seg: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 999,
    padding: 3,
    gap: 2,
  },
  segBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
  },
  segBtnOn: {
    backgroundColor: Colors.surfaceLight,
  },
  segLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  segLabelOn: {
    color: Colors.textPrimary,
  },
});
