import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSessionStore } from '../../stores/sessionStore';
import { Colors, Spacing, Radii } from '../../theme';
import type { Insight } from '../../services/statsService';

interface InsightCardsProps {
  insights: Insight[];
}

// BB-voiced observations, shared between the Journey screen's Section 5 and
// the standalone insights.tsx — one source of truth so both surfaces agree
// (doc 08 §5: "BB talks about what the dashboard shows and vice versa").
export default function InsightCards({ insights }: InsightCardsProps) {
  const setTriggerContext = useSessionStore((s) => s.setTriggerContext);

  const handleTalk = (insight: Insight) => {
    setTriggerContext({
      trigger: insight.triggerContext,
      intensity: 0,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    router.push('/session-chat');
  };

  return (
    <View style={styles.list}>
      {insights.map((insight) => (
        <View key={insight.id} style={styles.card}>
          <Text style={styles.text}>{insight.text}</Text>
          <TouchableOpacity style={styles.button} onPress={() => handleTalk(insight)} activeOpacity={0.8}>
            <Text style={styles.buttonText}>Talk about this →</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: Spacing.sm,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
    gap: 12,
  },
  text: {
    fontSize: 16,
    lineHeight: 23,
    color: Colors.textPrimary,
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(232,98,74,0.12)',
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: Radii.full,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.coral,
  },
});
