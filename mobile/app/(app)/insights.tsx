import { ScrollView, StyleSheet } from 'react-native';
import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import DailyHoursVisualization from '../../src/components/insights/DailyHoursVisualization';
import { Colors, Spacing } from '../../src/theme';
import type { ResistanceBlock, StreakResult } from '../../src/types/resistanceBlocks';

// TODO: Replace mock data with useResistanceBlocks() hook when API integration is wired
const MOCK_BLOCKS: ResistanceBlock[] = [
  {
    id: 'mock-1',
    user_id: 'mock-user',
    started_at: new Date(new Date().setHours(8, 0, 0, 0)).toISOString(),
    ended_at: new Date(new Date().setHours(8, 18, 0, 0)).toISOString(),
    duration_minutes: 18,
    urge_occurred: false,
    session_date: new Date().toISOString().slice(0, 10),
  },
  {
    id: 'mock-2',
    user_id: 'mock-user',
    started_at: new Date(new Date().setHours(10, 0, 0, 0)).toISOString(),
    ended_at: new Date(new Date().setHours(10, 9, 0, 0)).toISOString(),
    duration_minutes: 9,
    urge_occurred: true,
    session_date: new Date().toISOString().slice(0, 10),
  },
];

const MOCK_STREAK: StreakResult = {
  currentStreakBlocks: 4,
  longestStreakBlocks: 7,
  currentStreakMinutes: 12,
  latestMilestone: '3-Hour Block Achieved!',
};

export default function InsightsScreen() {
  const currentHour = new Date().getHours();

  return (
    <ScreenWithEntity title="Insights">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <DailyHoursVisualization
          blocks={MOCK_BLOCKS}
          streakResult={MOCK_STREAK}
          currentHour={currentHour}
        />
      </ScrollView>
    </ScreenWithEntity>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: Spacing.md,
    gap: Spacing.md,
  },
});
