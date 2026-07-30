import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { SessionPhase } from './SessionHeader';
import { Colors, Spacing } from '../../theme';
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
  phase,
  onQuickLog,
  onRuleOfThree,
}: HomeDashboardProps) {
  const resistance = phase === 'resistance';

  return (
    <View style={styles.root}>
      <MissionDashboardScreen />
      <View style={styles.cmdRow}>
        <TouchableOpacity
          style={styles.cmd}
          activeOpacity={0.8}
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            onQuickLog('urge');
          }}
        >
          <Text style={styles.cmdLabel}>📝 LOG A MOMENT</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.cmd, styles.cmdUrgent]}
          activeOpacity={0.8}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            if (resistance) onRuleOfThree();
            else onQuickLog('urge');
          }}
        >
          <Text style={[styles.cmdLabel, styles.cmdUrgentLabel]}>
            {resistance ? '🫁 RULE OF THREE' : '🌊 URGE — HELP'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  cmdRow: {
    flexDirection: 'row',
    gap: 9,
    padding: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.surfaceBorder,
    backgroundColor: Colors.background,
  },
  cmd: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 13,
    paddingVertical: 13,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  cmdUrgent: {
    backgroundColor: 'rgba(232,98,74,0.15)',
    borderColor: 'rgba(232,98,74,0.6)',
  },
  cmdLabel: {
    fontSize: 12.5,
    fontWeight: '800',
    letterSpacing: 0.4,
    color: Colors.textPrimary,
  },
  cmdUrgentLabel: {
    color: Colors.coral,
  },
});
