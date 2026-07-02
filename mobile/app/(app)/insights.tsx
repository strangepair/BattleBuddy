import { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { ApiConfig } from '../../src/config';
import { useAuthStore } from '../../src/stores/authStore';
import { Colors, Spacing, Radii } from '../../src/theme';

interface SessionReport {
  created_at: string;
  summary: string;
  trigger_type: string | null;
  trigger_intensity: number | null;
  outcome: string | null;
  emotional_arc: { start?: string; end?: string };
  what_helped: string[];
  what_didnt_help: string[];
  next_session_hint: string | null;
  preferences: Record<string, any>;
}

export default function InsightsScreen() {
  const [reports, setReports] = useState<SessionReport[]>([]);
  const [loading, setLoading] = useState(true);
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    loadReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const loadReports = async () => {
    setLoading(true);
    try {
      if (!userId) {
        setLoading(false);
        return;
      }
      // Session reports are stored in the server-side event log (bb_events,
      // event_type 'session_report') — the old session_reports table required
      // an auth uuid the app doesn't have, so it never received a row.
      const res = await fetch(
        `${ApiConfig.CHAT_URL}/events?userId=${encodeURIComponent(userId)}&eventTypes=session_report&limit=20`,
      );
      if (res.ok) {
        const data = await res.json();
        const rows: SessionReport[] = (data.events || []).map((e: any) => {
          const r = e.metadata?.report || {};
          return {
            created_at: e.occurred_at,
            summary: r.summary || 'Session completed.',
            trigger_type: r.trigger_type ?? null,
            trigger_intensity: r.trigger_intensity ?? null,
            outcome: e.metadata?.outcome ?? r.outcome ?? null,
            emotional_arc: r.emotional_arc || {},
            what_helped: r.what_helped || [],
            what_didnt_help: r.what_didnt_help || [],
            next_session_hint: r.next_session_hint ?? null,
            preferences: {
              ...(r.preferences || {}),
              key_facts_learned: r.key_facts_learned ?? r.preferences?.key_facts_learned ?? null,
              trackable_metrics: r.trackable_metrics ?? r.preferences?.trackable_metrics ?? null,
            },
          };
        });
        setReports(rows);
      }
    } catch {}
    setLoading(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={12}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Session Insights</Text>
        <View style={styles.spacer} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      ) : reports.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🧠</Text>
          <Text style={styles.emptyTitle}>No insights yet</Text>
          <Text style={styles.emptySubtitle}>
            After each session, BB analyzes the conversation and captures what was learned. Those insights will appear here.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {reports.map((report, i) => (
            <ReportCard key={i} report={report} />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ReportCard({ report }: { report: SessionReport }) {
  const date = new Date(report.created_at);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const outcomeColors: Record<string, string> = {
    resisted: Colors.success,
    submitted: Colors.warning,
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
            {report.outcome}
          </Text>
        )}
      </View>

      <Text style={styles.cardSummary}>{report.summary}</Text>

      {report.emotional_arc?.start && report.emotional_arc?.end && (
        <View style={styles.arcRow}>
          <Text style={styles.arcLabel}>Emotional arc:</Text>
          <Text style={styles.arcValue}>{report.emotional_arc.start} → {report.emotional_arc.end}</Text>
        </View>
      )}

      {report.trigger_type && (
        <View style={styles.arcRow}>
          <Text style={styles.arcLabel}>Trigger:</Text>
          <Text style={styles.arcValue}>
            {report.trigger_type}
            {report.trigger_intensity ? ` (${report.trigger_intensity}/5)` : ''}
          </Text>
        </View>
      )}

      {report.what_helped?.length > 0 && (
        <View style={styles.tagSection}>
          <Text style={styles.tagLabel}>What helped</Text>
          <View style={styles.tags}>
            {report.what_helped.map((h, j) => (
              <Text key={j} style={styles.tagGreen}>{h}</Text>
            ))}
          </View>
        </View>
      )}

      {report.what_didnt_help?.length > 0 && (
        <View style={styles.tagSection}>
          <Text style={styles.tagLabel}>What didn't land</Text>
          <View style={styles.tags}>
            {report.what_didnt_help.map((h, j) => (
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

      {report.next_session_hint && (
        <View style={styles.hintBox}>
          <Text style={styles.hintLabel}>Next session</Text>
          <Text style={styles.hintText}>{report.next_session_hint}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.surfaceBorder,
  },
  backButton: { paddingVertical: Spacing.xs, paddingRight: Spacing.sm, minWidth: 60 },
  backText: { color: Colors.coral, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  spacer: { minWidth: 60 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl, gap: Spacing.sm },
  emptyIcon: { fontSize: 40, marginBottom: Spacing.sm },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  emptySubtitle: { fontSize: 14, color: Colors.textTertiary, textAlign: 'center', lineHeight: 20 },
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
