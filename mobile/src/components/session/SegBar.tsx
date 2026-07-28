import { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import {
  useSettingsStore,
  TEXT_SCALE_MIN,
  TEXT_SCALE_MAX,
} from '../../stores/settingsStore';
import { Colors } from '../../theme';

export type SessionView = 'home' | 'chat' | 'content';

const SEGMENTS: { key: SessionView; label: string }[] = [
  { key: 'home', label: 'Mission' },
  { key: 'chat', label: 'Comms' },
  { key: 'content', label: 'Content' },
];

interface SegBarProps {
  view: SessionView;
  onChange: (view: SessionView) => void;
}

// The view tabs plus the Aa text-size slider, one row — the web head's
// seg-bar. Tabs sit on the thumb side (handedness), the slider opposite.
export default function SegBar({ view, onChange }: SegBarProps) {
  const hand = useSettingsStore((s) => s.hand);

  const tabs = (
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
  );

  return (
    <View style={styles.bar}>
      {hand === 'right' ? (
        <>
          <TextScaleSlider />
          <View style={styles.spacer} />
          {tabs}
        </>
      ) : (
        <>
          {tabs}
          <View style={styles.spacer} />
          <TextScaleSlider />
        </>
      )}
    </View>
  );
}

function TextScaleSlider() {
  const textScale = useSettingsStore((s) => s.textScale);
  const setTextScale = useSettingsStore((s) => s.setTextScale);
  const [trackWidth, setTrackWidth] = useState(0);

  const onLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

  const setFromX = useCallback(
    (x: number) => {
      if (!trackWidth) return;
      const t = Math.min(1, Math.max(0, x / trackWidth));
      setTextScale(TEXT_SCALE_MIN + t * (TEXT_SCALE_MAX - TEXT_SCALE_MIN));
    },
    [trackWidth, setTextScale],
  );

  const pan = Gesture.Pan()
    .onBegin((e) => {
      'worklet';
      runOnJS(setFromX)(e.x);
    })
    .onUpdate((e) => {
      'worklet';
      runOnJS(setFromX)(e.x);
    });

  const t = (textScale - TEXT_SCALE_MIN) / (TEXT_SCALE_MAX - TEXT_SCALE_MIN);

  return (
    <View style={styles.aaRow} accessibilityLabel="Text size">
      <Text style={styles.aaSmall}>A</Text>
      <GestureDetector gesture={pan}>
        <View style={styles.aaTrack} onLayout={onLayout} collapsable={false}>
          <View style={styles.aaLine} />
          <View style={[styles.aaFill, { width: `${t * 100}%` }]} />
          <View style={[styles.aaThumb, { left: `${t * 100}%` }]} />
        </View>
      </GestureDetector>
      <Text style={styles.aaLarge}>A</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 8,
  },
  spacer: {
    flex: 1,
  },
  seg: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 999,
    padding: 3,
    gap: 2,
  },
  segBtn: {
    paddingHorizontal: 12,
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
  aaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aaSmall: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  aaLarge: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  aaTrack: {
    width: 72,
    height: 26,
    justifyContent: 'center',
  },
  aaLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 3,
    borderRadius: 2,
    backgroundColor: Colors.surfaceLight,
  },
  aaFill: {
    position: 'absolute',
    left: 0,
    height: 3,
    borderRadius: 2,
    backgroundColor: Colors.coral,
  },
  aaThumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    backgroundColor: Colors.coral,
  },
});
