import { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import ArcChart from '../../src/components/journey/ArcChart';
import HoursHeatmap from '../../src/components/journey/HoursHeatmap';
import WhatWorksList from '../../src/components/journey/WhatWorksList';
import IndependenceTrend from '../../src/components/journey/IndependenceTrend';
import InsightCards from '../../src/components/journey/InsightCards';
import { useAuthStore } from '../../src/stores/authStore';
import { fetchJourney, fetchInsights, type JourneyData, type Insight } from '../../src/services/statsService';
import { Colors, Spacing } from '../../src/theme';

// BB's memory made visible — recognition and meaning, never a clinical
// readout (doc 08 §5). Replaces the old three-number analytics screen.
export default function JourneyScreen() {
  const userId = useAuthStore((s) => s.user?.id);
  const [journey, setJourney] = useState<JourneyData | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchJourney(userId ?? null), fetchInsights(userId ?? null)])
      .then(([j, i]) => {
        if (cancelled) return;
        setJourney(j);
        setInsights(i);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);

  return (
    <ScreenWithEntity title="Journey">
      {!journey ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.sectionTitle}>The Arc</Text>
          <Text style={styles.sectionSub}>Is it working? One glance.</Text>
          <ArcChart arc={journey.arc} />

          <Text style={styles.sectionTitle}>Your Hours</Text>
          <Text style={styles.sectionSub}>This is what BB watches for you.</Text>
          <HoursHeatmap data={journey.heatmap} />

          <Text style={styles.sectionTitle}>What Works for You</Text>
          <WhatWorksList items={journey.whatWorks} />

          <Text style={styles.sectionTitle}>Independence Trend</Text>
          <Text style={styles.sectionSub}>More and more, you&apos;re catching it yourself.</Text>
          <IndependenceTrend weeks={journey.independence} />

          {insights.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Insights</Text>
              <InsightCards insights={insights} />
            </>
          )}
        </ScrollView>
      )}
    </ScreenWithEntity>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: {
    padding: Spacing.md,
    gap: Spacing.md,
    paddingBottom: Spacing.xxl,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
  },
  sectionSub: {
    fontSize: 14,
    color: Colors.textTertiary,
    marginTop: -8,
  },
});
