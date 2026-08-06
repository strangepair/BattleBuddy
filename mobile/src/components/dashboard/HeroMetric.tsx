import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';
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
  /** All known cigarette logs (realtime-merged today + history), any order. */
  logs: SmokingLog[];
  loading: boolean;
}

/**
 * HeroMetric renders the "Last cigarette" hero card: the absolute timestamp
 * of the most recent log entry and a live elapsed-time counter that ticks
 * every minute.
 *
 * Purely presentational: the dashboard owns the (single) fetch and realtime
 * merge and passes the combined log list down. Mounted as the calendar
 * FlatList's ListHeaderComponent so it rides the same scroll as the timeline
 * — never as a fixed sibling above a second scroll region.
 */
export default function HeroMetric({ logs, loading }: HeroMetricProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const latest = logs.reduce<string | null>((best, log) => {
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
    marginBottom: Spacing.sm,
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
