import { View, Text, StyleSheet } from 'react-native';
import Svg, { Line, Polyline, Circle, Text as SvgText } from 'react-native-svg';
import { Colors, Spacing } from '../../theme';
import type { JourneyArc } from '../../services/statsService';

interface ArcChartProps {
  arc: JourneyArc;
  height?: number;
}

const VIEW_W = 320;
const PAD_X = 10;
const CHART_TOP = 24;

// Daily cigarette count vs. personal baseline, tapering over time. Slip
// days render as a warning-colored dot in context of the trend — a dip in
// a line that's still falling, never a separate shameful marker (doc 08 §4/§5).
export default function ArcChart({ arc, height = 140 }: ArcChartProps) {
  const { baseline, points } = arc;
  if (points.length === 0) return null;

  const maxVal = Math.max(baseline, ...points.map((p) => p.count));
  const chartBottom = height - 6;
  const usableW = VIEW_W - PAD_X * 2;

  const yFor = (count: number) => chartBottom - (count / maxVal) * (chartBottom - CHART_TOP);
  const xFor = (i: number) => (points.length === 1 ? PAD_X : PAD_X + (i / (points.length - 1)) * usableW);

  const linePoints = points.map((p, i) => `${xFor(i)},${yFor(p.count)}`).join(' ');
  const baselineY = yFor(baseline);
  const lastPoint = points[points.length - 1];

  return (
    <View style={styles.card}>
      <Svg viewBox={`0 0 ${VIEW_W} ${height}`} width="100%" height={height}>
        <Line
          x1={PAD_X} y1={baselineY} x2={VIEW_W - PAD_X} y2={baselineY}
          stroke={Colors.textTertiary} strokeWidth={1.5} strokeDasharray="4 4"
        />
        <SvgText x={PAD_X} y={Math.max(baselineY - 6, 12)} fill={Colors.textTertiary} fontSize={11}>
          baseline {baseline}/day
        </SvgText>
        <Polyline points={linePoints} fill="none" stroke={Colors.coral} strokeWidth={2.5} />
        {points.map((p, i) =>
          p.isSlip ? (
            <Circle key={p.date} cx={xFor(i)} cy={yFor(p.count)} r={4} fill={Colors.warning} />
          ) : null,
        )}
        {points.map((p, i) =>
          p.isSlip ? (
            <SvgText key={`${p.date}-label`} x={xFor(i) - 10} y={yFor(p.count) - 8} fill={Colors.warning} fontSize={10} fontWeight="700">
              slip
            </SvgText>
          ) : null,
        )}
        <Circle cx={xFor(points.length - 1)} cy={yFor(lastPoint.count)} r={4} fill={Colors.coral} />
      </Svg>

      <View style={styles.legend}>
        <LegendItem color={Colors.textTertiary} label="baseline" />
        <LegendItem color={Colors.coral} label="your count" />
        <LegendItem color={Colors.warning} label="slip day" />
      </View>
    </View>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
  },
  legend: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 12.5,
    color: Colors.textTertiary,
  },
});
