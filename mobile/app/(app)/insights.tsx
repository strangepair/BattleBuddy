import { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import EmptyState from '../../src/components/common/EmptyState';
import { useAuthStore } from '../../src/stores/authStore';
import { fetchSessionStats, type SessionReportRow } from '../../src/services/sessionStats';
import { Colors, Spacing, Radii } from '../../src/theme';

export default function InsightsScreen() {
  const [reports, setReports] = useState<SessionReportRow[] | null>(null);
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    let cancelled = false;
    fetchSessionStats(userId ?? null)
      .then((stats) => { if (!cancelled) setReports(stats.reports); })
      .catch(() => { if (!cancelled) setReports([]); });
    return () => { cancelled = true; };
  }, [userId]);

  return (
    <ScreenWithEntity title="Session Insights">
      {reports === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      ) : reports.length === 0 ? (
        <EmptyState
          icon="sparkles-outline"
          title="Insights are coming"
          body="After each session, Buddy reflects on the conversation and captures what it learned about you. Those reflections will appear here."
        />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {reports.map((report, i) => (
            <ReportCard key={i} report={report} />
          ))}
        </ScrollView>
      )}
    </ScreenWithEntity>
  );
}

function ReportCard({ report }: { report: SessionReportRow }) {
  const date = new Date(report.createdAt);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const outcomeColors: Record<string, string> = {
    resisted: Colors.success,
    submitted: Colors.warning,
    gave_in: Colors.warning,
    unsure: Colors.textSecondary,
  };

  const kf = report.preferences?.key_facts_learned;
  const tm = report.preferences?.trackable_metrics;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardDate}>{dateStr} {timeStr}</Text>
        {report.outcome && (
          <Text style={[styles.cardOutcome, { color: outcomeColors[report.outcome] || Colors.textSecondary }]}>
            {report.outcome.replace('_', ' ')}
          </Text>
        )}
      </View>

      <Text style={styles.cardSummary}>{report.summary}</Text>

      {report.emotionalArc?.start && report.emotionalArc?.end && (
        <View style={styles.arcRow}>
          <Text style={styles.arcLabel}>Emotional arc:</Text>
          <Text style={styles.arcValue}>{report.emotionalArc.start} → {report.emotionalArc.end}</Text>
        </View>
      )}

      {report.triggerType && (
        <View style={styles.arcRow}>
          <Text style={styles.arcLabel}>Trigger:</Text>
          <Text style={styles.arcValue}>
            {report.triggerType}
            {report.triggerIntensity ? ` (${report.triggerIntensity}/5)` : ''}
          </Text>
        </View>
      )}

      {report.whatHelped.length > 0 && (
        <View style={styles.tagSection}>
          <Text style={styles.tagLabel}>What helped</Text>
          <View style={styles.tags}>
            {report.whatHelped.map((h, j) => (
              <Text key={j} style={styles.tagGreen}>{h}</Text>
            ))}
          </View>
        </View>
      )}

      {report.whatDidntHelp.length > 0 && (
        <View style={styles.tagSection}>
          <Text style={styles.tagLabel}>What didn't land</Text>
          <View style={styles.tags}>
            {report.whatDidntHelp.map((h, j) => (
              <Text key={j} style={styles.tagRed}>{h}</Text>
            ))}
          </View>
        </View>
      )}

      {kf?.name && (
        <Text style={styles.factText}>Learned name: {kf.name}</Text>
      )}

      {tm?.cigarettes_today != null && (
        <Text style={styles.factText}>Reported: {tm.cigarettes_today} cigarettes that day</Text>
      )}

      {report.nextSessionHint && (
        <View style={styles.hintBox}>
          <Text style={styles.hintLabel}>Next session</Text>
          <Text style={styles.hintText}>{report.nextSessionHint}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: Spacing.md, gap: Spacing.md, paddingBottom: Spacing.xxl },
  card: {
    backgroundColor: Colors.surface, borderRadius: Radii.md, padding: Spacing.md, gap: Spacing.sm,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardDate: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  cardOutcome: { fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
  cardSummary: { fontSize: 15, color: Colors.textPrimary, lineHeight: 22 },
  arcRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  arcLabel: { fontSize: 12, color: Colors.textTertiary, fontWeight: '600' },
  arcValue: { fontSize: 12, color: Colors.textSecondary },
  tagSection: { gap: 4 },
  tagLabel: { fontSize: 11, color: Colors.textTertiary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tagGreen: {
    fontSize: 12, color: Colors.success, backgroundColor: 'rgba(52, 199, 89, 0.1)',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden',
  },
  tagRed: {
    fontSize: 12, color: Colors.warning, backgroundColor: 'rgba(255, 159, 10, 0.1)',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden',
  },
  factText: { fontSize: 12, color: Colors.textSecondary, fontStyle: 'italic' },
  hintBox: {
    backgroundColor: Colors.background, borderRadius: Radii.sm, padding: Spacing.sm,
    borderLeftWidth: 3, borderLeftColor: Colors.coral, gap: 2,
  },
  hintLabel: { fontSize: 10, fontWeight: '700', color: Colors.coral, textTransform: 'uppercase', letterSpacing: 0.5 },
  hintText: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
});
