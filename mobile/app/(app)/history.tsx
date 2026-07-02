import { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { TouchableOpacity } from 'react-native';
import SessionCard from '../../src/components/history/SessionCard';
import { ApiConfig } from '../../src/config';
import { useAuthStore } from '../../src/stores/authStore';
import { Colors, Spacing } from '../../src/theme';

interface SessionEvent {
  id: string;
  started_at: string;
  mode: string;
  outcome: string | null;
  helped: boolean | null;
  intensity_start: number | null;
  intensity_end: number | null;
}

export default function HistoryScreen() {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const loadEvents = async () => {
    setLoading(true);
    try {
      if (!userId) {
        setLoading(false);
        return;
      }

      // Sessions live in the server-side event log (bb_events) — the app's
      // local ids can't read the RLS-guarded Supabase tables directly.
      const res = await fetch(
        `${ApiConfig.CHAT_URL}/events?userId=${encodeURIComponent(userId)}&eventTypes=session&limit=50`,
      );

      if (res.ok) {
        const data = await res.json();
        const rows: SessionEvent[] = (data.events || []).map((e: any) => ({
          id: e.id,
          started_at: e.occurred_at,
          mode: e.metadata?.mode ?? 'text',
          outcome: e.metadata?.outcome ?? null,
          helped: e.metadata?.helped ?? null,
          intensity_start: e.metadata?.intensity_start ?? null,
          intensity_end: e.metadata?.intensity_end ?? null,
        }));
        setEvents(rows);
      }
    } catch {
      // Offline or not configured
    } finally {
      setLoading(false);
    }
  };

  const handleSessionPress = useCallback((_eventId: string) => {
    // TODO Phase 6b: navigate to transcript view
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={12}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>History</Text>
        <View style={styles.spacer} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      ) : events.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyTitle}>No sessions yet</Text>
          <Text style={styles.emptySubtitle}>
            Your past sessions will appear here — urge events, outcomes, and what worked.
          </Text>
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <SessionCard
              startedAt={item.started_at}
              mode={item.mode}
              outcome={item.outcome}
              helped={item.helped}
              intensityStart={item.intensity_start}
              intensityEnd={item.intensity_end}
              onPress={() => handleSessionPress(item.id)}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  backButton: {
    paddingVertical: Spacing.xs,
    paddingRight: Spacing.sm,
    minWidth: 60,
  },
  backText: {
    color: Colors.coral,
    fontSize: 16,
    fontWeight: '600',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  spacer: { minWidth: 60 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.sm,
  },
  emptyIcon: { fontSize: 40, marginBottom: Spacing.sm },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  emptySubtitle: { fontSize: 14, color: Colors.textTertiary, textAlign: 'center', lineHeight: 20 },
  list: {
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  separator: {
    height: Spacing.sm,
  },
});
