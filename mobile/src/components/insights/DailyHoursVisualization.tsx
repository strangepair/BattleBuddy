import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing } from '../../theme';
import type { ResistanceBlock, StreakResult } from '../../types/resistanceBlocks';
import BlockCell from './BlockCell';
import MilestoneBadge from './MilestoneBadge';

const HOURS = 24;
const SLOTS_PER_HOUR = 20;
const TOTAL_CELLS = HOURS * SLOTS_PER_HOUR;
const SLOT_MINUTES = 3;
const SLOTS_PER_THREE_HOURS = SLOTS_PER_HOUR * 3;
const ROW_LABEL_WIDTH = 36;

type CellStatus = 'future' | 'clean' | 'urge' | 'usage';

interface DailyHoursVisualizationProps {
  blocks: ResistanceBlock[];
  streakResult: StreakResult;
  currentHour: number;
}

function buildCellStatuses(blocks: ResistanceBlock[], currentHour: number): CellStatus[] {
  const statuses: CellStatus[] = new Array(TOTAL_CELLS).fill('future');

  for (let i = 0; i < TOTAL_CELLS; i++) {
    const slotStartMinute = i * SLOT_MINUTES;
    const slotHour = Math.floor(slotStartMinute / 60);
    const slotMinute = slotStartMinute % 60;

    if (slotHour > currentHour || (slotHour === currentHour)) {
      statuses[i] = 'future';
    } else {
      statuses[i] = 'clean';
    }

    for (const block of blocks) {
      const start = new Date(block.started_at);
      const blockHour = start.getHours();
      const blockMinute = start.getMinutes();
      const blockStartSlot = blockHour * SLOTS_PER_HOUR + Math.floor(blockMinute / SLOT_MINUTES);

      const durationMinutes = block.duration_minutes ?? SLOT_MINUTES;
      const durationSlots = Math.max(1, Math.ceil(durationMinutes / SLOT_MINUTES));
      const blockEndSlot = blockStartSlot + durationSlots;

      if (i >= blockStartSlot && i < blockEndSlot) {
        if (!block.ended_at) {
          statuses[i] = 'clean';
        } else if (block.urge_occurred) {
          statuses[i] = 'urge';
        } else {
          statuses[i] = 'clean';
        }
      }
    }
  }

  return statuses;
}

function hourLabel(hour: number): string {
  if (hour === 0) return '12a';
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return '12p';
  return `${hour - 12}p`;
}

export default function DailyHoursVisualization({
  blocks,
  streakResult,
  currentHour,
}: DailyHoursVisualizationProps) {
  const statuses = buildCellStatuses(blocks, currentHour);

  return (
    <View style={styles.container}>
      <View style={styles.statsHeader}>
        <Text style={styles.statText}>
          {'Current Streak: '}
          <Text style={styles.statValue}>{streakResult.currentStreakBlocks}</Text>
          {' blocks ('}
          <Text style={styles.statValue}>{streakResult.currentStreakMinutes}</Text>
          {' min)'}
        </Text>
        <Text style={styles.statText}>
          {'Best: '}
          <Text style={styles.statValue}>{streakResult.longestStreakBlocks}</Text>
          {' blocks'}
        </Text>
      </View>

      <MilestoneBadge milestone={streakResult.latestMilestone} />

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator>
        {Array.from({ length: HOURS }, (_, hour) => {
          const isThreeHourRow = hour % 3 === 0 && hour !== 0;
          return (
            <View key={hour}>
              {isThreeHourRow && <View style={styles.threeHourSeparator} />}
              <View style={styles.hourRow}>
                <Text style={[styles.hourLabel, { width: ROW_LABEL_WIDTH }]}>
                  {hourLabel(hour)}
                </Text>
                <View style={styles.cells}>
                  {Array.from({ length: SLOTS_PER_HOUR }, (_, slot) => {
                    const cellIndex = hour * SLOTS_PER_HOUR + slot;
                    const globalSlot = hour * SLOTS_PER_HOUR + slot;
                    const isThreeHourBoundary = globalSlot % SLOTS_PER_THREE_HOURS === 0 && globalSlot !== 0;
                    return (
                      <BlockCell
                        key={slot}
                        status={statuses[cellIndex]}
                        isThreeHourBoundary={isThreeHourBoundary}
                      />
                    );
                  })}
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
  },
  statsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  statText: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  statValue: {
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  scroll: {
    maxHeight: 320,
  },
  hourRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 1,
  },
  hourLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textTertiary,
    textAlign: 'right',
    paddingRight: 4,
  },
  cells: {
    flexDirection: 'row',
    flex: 1,
  },
  threeHourSeparator: {
    height: 2,
    backgroundColor: Colors.surfaceBorder,
    marginVertical: 2,
    marginLeft: ROW_LABEL_WIDTH,
  },
});
