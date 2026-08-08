import { View, StyleSheet } from 'react-native';
import type { SessionPhase } from './SessionHeader';
import { Colors } from '../../theme';
import MissionDashboardScreen from '../../screens/MissionDashboardScreen';

export type QuickLogKind = 'resisted' | 'cigarette' | 'decision' | 'urge';

export interface TalkAboutTopic {
  title: string;
  detail: string;
  userText: string;
}

interface HomeDashboardProps {
  phase: SessionPhase;
  resistanceSince: number | null;
  active: boolean;
  onTalk: (topic: TalkAboutTopic) => void;
  onQuickLog: (kind: QuickLogKind) => void;
  onRuleOfThree: () => void;
}

export default function HomeDashboard({
  phase: _phase,
}: HomeDashboardProps) {
  return (
    <View style={styles.root}>
      <MissionDashboardScreen />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
});
