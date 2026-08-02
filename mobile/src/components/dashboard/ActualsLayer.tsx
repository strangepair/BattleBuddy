import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors, Radii } from '../../theme';
import type { SmokingLog } from '../../hooks/useSmokingLogs';

const MINUTE_HEIGHT = 2;
export const MIN_BLOCK_HEIGHT = 48;
const BLOCK_WIDTH_FRACTION = 0.85;
const OVERLAP_OFFSET_FRACTION = 0.12;

function minuteOffset(hour: number, minute: number): number {
  return (hour * 60 + minute) * MINUTE_HEIGHT;
}

interface ActualsLayerProps {
  /** Cigarette log entries to render as time-blocks. */
  logs: SmokingLog[];
  /** Whether these are ghost markers from a previous day. */
  ghost?: boolean;
  /** Left offset (px) reserved for the hour-label column. */
  timelineLeft: number;
  /** Index used to horizontally stagger ghost layers (0–2). */
  ghostIndex?: number;
  /** Called when a non-ghost block is tapped. */
  onPressLog?: (log: SmokingLog) => void;
}

function logDurationPx(log: SmokingLog): number {
  const durationMin =
    typeof log.metadata?.duration_minutes === 'number'
      ? (log.metadata.duration_minutes as number)
      : typeof log.metadata?.end_time === 'string'
      ? (() => {
          const end = new Date(log.metadata.end_time as string);
          const start = new Date(log.occurred_at);
          return Math.max(0, (end.getTime() - start.getTime()) / 60000);
        })()
      : 0;
  return durationMin > 0 ? Math.max(MIN_BLOCK_HEIGHT, durationMin * MINUTE_HEIGHT) : MIN_BLOCK_HEIGHT;
}

/**
 * ActualsLayer renders each SmokingLog entry as an absolutely-positioned
 * time-block within the parent timeline. Block height corresponds to the
 * item's duration; items without a duration render as a minimal point marker.
 * Ghost layers (previous days) are staggered horizontally so they remain
 * visible behind today's blocks.
 */
export default function ActualsLayer({ logs, ghost = false, timelineLeft, ghostIndex = 0, onPressLog }: ActualsLayerProps) {
  if (logs.length === 0) return null;

  const staggerFrac = ghost ? OVERLAP_OFFSET_FRACTION * (ghostIndex + 1) : 0;
  const leftPct = `${Math.round(staggerFrac * 100)}%` as `${number}%`;
  const widthPct = `${Math.round(BLOCK_WIDTH_FRACTION * 100)}%` as `${number}%`;

  return (
    <>
      {logs.map((log) => {
        const d = new Date(log.occurred_at);
        const top = minuteOffset(d.getHours(), d.getMinutes());
        const height = logDurationPx(log);
        const isPoint = height === MIN_BLOCK_HEIGHT;

        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const suffix = log.activityLabel || log.location || null;
        const label = suffix ? `${time} · ${suffix}` : time;

        const blockStyle = [
          styles.block,
          ghost ? styles.blockGhost : styles.blockActual,
          isPoint && styles.blockPoint,
          {
            top,
            left: timelineLeft,
            right: 0,
            height,
          },
        ];

        const inner = (
          <View style={[styles.inner, { left: leftPct, width: widthPct }]}>
            {!ghost && (
              <Text style={styles.label} numberOfLines={1} ellipsizeMode="tail">
                {label}
              </Text>
            )}
          </View>
        );

        return ghost || !onPressLog ? (
          <View key={log.id} style={blockStyle}>{inner}</View>
        ) : (
          <TouchableOpacity
            key={log.id}
            style={blockStyle}
            onPress={() => onPressLog(log)}
            activeOpacity={0.7}
          >
            {inner}
          </TouchableOpacity>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  block: {
    position: 'absolute',
    overflow: 'hidden',
  },
  blockActual: {},
  blockGhost: {
    opacity: 0.35,
  },
  blockPoint: {},
  inner: {
    position: 'absolute',
    top: 0,
    height: '100%',
    backgroundColor: Colors.coral,
    borderRadius: Radii.sm,
    paddingHorizontal: 5,
    justifyContent: 'center',
    minHeight: MIN_BLOCK_HEIGHT,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
});
