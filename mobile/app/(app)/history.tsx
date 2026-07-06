import { useState, useEffect, useCallback } from 'react';
import { View, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import SessionCard from '../../src/components/history/SessionCard';
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import EmptyState from '../../src/components/common/EmptyState';
import { useAuthStore } from '../../src/stores/authStore';
import { fetchSessionStats, type SessionEventRow } from '../../src/services/sessionStats';
import { Colors, Spacing } from '../../src/theme';

export default function HistoryScreen() {
  const [sessions, setSessions] = useState<SessionEventRow[] | null>(null);
  const userId = useAuthStore((s) => s.user?.id);

  const loadEvents = useCallback(async () => {
    const stats = await fetchSessionStats(userId ?? null);
    setSessions(stats.sessions);
  }, [userId]);

  useEffect(() => {
    loadEvents().catch(() => setSessions([]));
  }, [loadEvents]);

  return (
    <ScreenWithEntity title="History">
      {sessions === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.coral} />
        </View>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon="time-outline"
          title="Your story starts here"
          body="Every session you have with Buddy — urges faced, outcomes, what worked — will build up right here."
        />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <SessionCard
              startedAt={item.occurredAt}
              mode={item.mode}
              outcome={item.outcome}
              helped={item.helped}
              intensityStart={item.intensityStart}
              intensityEnd={item.intensityEnd}
              onPress={() => {}}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </ScreenWithEntity>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  separator: {
    height: Spacing.sm,
  },
});
