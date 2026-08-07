import { useCallback, useMemo } from 'react';
import {
  SectionList,
  View,
  Text,
  ActivityIndicator,
  Button,
  StyleSheet,
} from 'react-native';
import { Colors, Spacing, Radii } from '../theme';
import { useSessionHistory } from '../hooks/useSessionHistory';
import type { Session } from '../api/sessions';

interface SectionData {
  title: string;
  data: Session[];
}

function fmtDayHeader(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return 'Today';
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function fmtTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sessionDateKey(session: Session): string {
  return session.created_at.slice(0, 10);
}

function groupByDay(sessions: Session[]): SectionData[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = sessionDateKey(s);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, data]) => ({ title: fmtDayHeader(date), data }));
}

function SessionRow({ session }: { session: Session }) {
  const time = fmtTime(session.created_at);
  const label = session.summary ?? 'Session';
  return (
    <View style={styles.row}>
      <View style={styles.dot} />
      <Text style={styles.rowTime}>{time}</Text>
      <Text style={styles.rowLabel} numberOfLines={1} ellipsizeMode="tail">
        {label}
      </Text>
    </View>
  );
}

export default function MissionTimelineScreen() {
  const { sessions, loading, error, hasMore, loadMore, retry } =
    useSessionHistory();

  const sections: SectionData[] = useMemo(
    () => groupByDay(sessions),
    [sessions],
  );

  const renderItem = useCallback(
    ({ item }: { item: Session }) => <SessionRow session={item} />,
    [],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionData }) => (
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionHeaderText}>{section.title}</Text>
      </View>
    ),
    [],
  );

  const keyExtractor = useCallback((item: Session) => item.id, []);

  const ListFooter = useCallback(() => {
    if (loading) {
      return (
        <View style={styles.footer}>
          <ActivityIndicator size="small" color={Colors.textTertiary} />
        </View>
      );
    }
    if (error) {
      return (
        <View style={styles.footer}>
          <Button title="Retry" onPress={retry} color={Colors.stateIdle} />
        </View>
      );
    }
    if (!hasMore) {
      return (
        <View style={styles.footer}>
          <Text style={styles.footerText}>{"You've reached the beginning"}</Text>
        </View>
      );
    }
    return null;
  }, [loading, error, hasMore, retry]);

  if (loading && sessions.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={Colors.textTertiary} />
      </View>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      renderSectionHeader={renderSectionHeader}
      onEndReached={loadMore}
      onEndReachedThreshold={0.2}
      ListFooterComponent={ListFooter}
      style={styles.list}
      contentContainerStyle={styles.content}
      stickySectionHeadersEnabled={false}
      initialNumToRender={20}
      maxToRenderPerBatch={20}
      windowSize={10}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
  },
  sectionHeader: {
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
    backgroundColor: Colors.background,
  },
  sectionHeaderText: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1.1,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: Radii.full,
    backgroundColor: Colors.coral,
    flexShrink: 0,
  },
  rowTime: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
    width: 56,
    flexShrink: 0,
  },
  rowLabel: {
    fontSize: 16,
    color: Colors.textPrimary,
    flex: 1,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  footerText: {
    fontSize: 16,
    color: Colors.textTertiary,
  },
});
