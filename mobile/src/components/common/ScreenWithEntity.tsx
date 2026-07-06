import type { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import EntityBackground from '../home/EntityBackground';
import ScreenHeader from './ScreenHeader';
import { Colors } from '../../theme';

interface ScreenWithEntityProps {
  children: ReactNode;
  title?: string;
  headerRight?: ReactNode;
  onBack?: () => void;
  /** Ambient entity target color — defaults to the idle blue used by every
   *  secondary screen so the swarm reads as the same organism, just resting. */
  entityColor?: string;
  /** Low by design — ambient presence behind cards/text, never competing
   *  with legibility. */
  entityEnergy?: number;
  /** Anchor the swarm above the content (like a faint aurora) instead of
   *  screen-center, which is where the list/cards live. */
  entityCenterYRatio?: number;
}

// Shared near-black + ambient-entity + SafeArea wrapper for the secondary
// screens (history, insights, analytics, goals, profile) — the "one organism"
// backdrop the hub and voice screens already have, dimmed way down so it
// never competes with foreground content.
export default function ScreenWithEntity({
  children,
  title,
  headerRight,
  onBack,
  entityColor = Colors.stateIdle,
  entityEnergy = 0.05,
  entityCenterYRatio = -0.15,
}: ScreenWithEntityProps) {
  const { width, height } = useWindowDimensions();

  return (
    <View style={styles.root}>
      <EntityBackground
        targetColor={entityColor}
        energy={entityEnergy}
        center={{ x: width / 2, y: height * entityCenterYRatio }}
      />
      <SafeAreaView style={styles.safeArea}>
        {title && <ScreenHeader title={title} right={headerRight} onBack={onBack} />}
        {children}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  safeArea: {
    flex: 1,
  },
});
