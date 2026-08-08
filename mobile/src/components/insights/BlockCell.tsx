import { Pressable, StyleSheet } from 'react-native';

type BlockStatus = 'future' | 'clean' | 'urge' | 'usage';

const STATUS_COLORS: Record<BlockStatus, string> = {
  future: '#E5E7EB',
  clean: '#22C55E',
  urge: '#F59E0B',
  usage: '#EF4444',
};

interface BlockCellProps {
  status: BlockStatus;
  isThreeHourBoundary: boolean;
}

export default function BlockCell({ status, isThreeHourBoundary }: BlockCellProps) {
  return (
    <Pressable
      style={[
        styles.cell,
        { backgroundColor: STATUS_COLORS[status] },
        isThreeHourBoundary && styles.boundary,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  cell: {
    width: 8,
    height: 8,
    marginRight: 1,
    marginBottom: 1,
  },
  boundary: {
    borderLeftWidth: 2,
    borderLeftColor: '#111827',
  },
});
