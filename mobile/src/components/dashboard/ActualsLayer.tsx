import { View, Text, StyleSheet } from 'react-native';
import { Colors } from '../../theme';
import type { SmokingLog } from '../../hooks/useSmokingLogs';

interface ActualsLayerProps {
  /** Today's cigarette log entries that fall within this hour row. */
  logs: SmokingLog[];
  /** Whether these are ghost markers from a previous day. */
  ghost?: boolean;
}

/**
 * ActualsLayer renders coloured dot markers for cigarette log events
 * within a single hour row. Ghost markers (previous days) appear faded.
 * When `activityLabel` or `location` is present on a log entry, it is
 * rendered beside the time, e.g. "6:47 AM · car".
 */
export default function ActualsLayer({ logs, ghost = false }: ActualsLayerProps) {
  if (logs.length === 0) return null;

  return (
    <View style={styles.row}>
      {logs.map((log) => {
        const d = new Date(log.occurred_at);
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const suffix = log.activityLabel || log.location || null;
        const label = suffix ? `${time} · ${suffix}` : time;
        return (
          <View key={log.id} style={[styles.dot, ghost && styles.dotGhost]}>
            <Text style={[styles.label, ghost && styles.labelGhost]}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  dot: {
    backgroundColor: Colors.coral,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  dotGhost: {
    backgroundColor: 'rgba(232,98,74,0.22)',
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  labelGhost: {
    color: Colors.textTertiary,
  },
});
