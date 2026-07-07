import { useState, useEffect } from 'react';
import { View, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import EmptyState from '../../src/components/common/EmptyState';
import InsightCards from '../../src/components/journey/InsightCards';
import { useAuthStore } from '../../src/stores/authStore';
import { fetchInsights, type Insight } from '../../src/services/statsService';
import { Colors, Spacing } from '../../src/theme';

export default function InsightsScreen() {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    let cancelled = false;
    fetchInsights(userId ?? null)
      .then((data) => { if (!cancelled) setInsights(data); })
      .catch(() => { if (!cancelled) setInsights([]); });
    return () => { cancelled = true; };
  }, [userId]);

  return (
    <ScreenWithEntity title="Insights">
      {insights === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      ) : insights.length === 0 ? (
        <EmptyState
          icon="sparkles-outline"
          title="Insights are coming"
          body="After enough sessions, Buddy starts noticing patterns worth naming — those observations will show up here, in BB's own voice."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <InsightCards insights={insights} />
        </ScrollView>
      )}
    </ScreenWithEntity>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: Spacing.md, paddingBottom: Spacing.xxl },
});
