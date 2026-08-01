import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';
import { useSmokingLogs } from '../../hooks/useSmokingLogs';
import type { SmokingLog } from '../../hooks/useSmokingLogs';

function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} m ago`;
  return `${hours} h ${minutes} m ago`;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface HeroMetricProps {
  realtimeLogs?: SmokingLog[];
}

/**
 * HeroMetric renders the "Last cigarette" hero card.
 * Displays the absolute timestamp of the most recent log entry and a
 * live-updating elapsed-time counter that ticks every minute.
 *
 * Accepts an optional `realtimeLogs` prop (realtime-merged today-logs from
 * the parent dashboard). When provided these are included in the latest-entry
 * calculation so the gap updates immediately after a new cigarette is logged
 * via voice or a direct UI action, without waiting for a full re-fetch.
 */
export default function HeroMetric({ realtimeLogs }: HeroMetricProps = {}) {
  const { todayLogs, historyLogs, loading } = useSmokingLogs();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const effectiveTodayLogs = realtimeLogs ?? todayLogs;
  const allLogs = [...effectiveTodayLogs, ...historyLogs];
  const latest = allLogs.reduce<string | null>((best, log) => {
    if (!best) return log.occurred_at;
    return log.occurred_at > best ? log.occurred_at : best;
  }, null);

  const elapsed = latest ? now - new Date(latest).getTime() : null;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>LAST CIGARETTE</Text>
      {loading ? (
        <Text style={styles.placeholder}>—</Text>
      ) : latest ? (
        <>
          <Text style={styles.elapsed}>{elapsed != null ? formatElapsed(elapsed) : '—'}</Text>
          <Text style={styles.absolute}>{formatAbsolute(latest)}</Text>
        </>
      ) : (
        <Text style={styles.placeholder}>No logs yet</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(35,35,38,0.92)',
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: Colors.coral,
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
    gap: 6,
  },
  label: {
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: '800',
    color: Colors.textTertiary,
  },
  elapsed: {
    fontSize: 42,
    fontWeight: '800',
    color: Colors.coral,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  absolute: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  placeholder: {
    fontSize: 42,
    fontWeight: '800',
    color: Colors.textTertiary,
  },
});
