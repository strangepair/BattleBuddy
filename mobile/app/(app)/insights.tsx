import ScreenWithEntity from '../../src/components/common/ScreenWithEntity';
import EmptyState from '../../src/components/common/EmptyState';
import { useResistanceBlocks } from '../../src/hooks/useResistanceBlocks';

export default function InsightsScreen() {
  const { blocks, streakResult, isLoading } = useResistanceBlocks();

  void blocks;
  void streakResult;
  void isLoading;

  return (
    <ScreenWithEntity title="Insights">
      <EmptyState
        icon="sparkles-outline"
        title="Insights are coming"
        body="After enough sessions, Buddy starts noticing patterns worth naming — those observations will show up here, in BB's own voice."
      />
    </ScreenWithEntity>
  );
}
