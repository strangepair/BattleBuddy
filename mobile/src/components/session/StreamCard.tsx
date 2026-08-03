import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import BreathingCard from './BreathingCard';
import HoursHeatmap from '../journey/HoursHeatmap';
import { useAuthStore } from '../../stores/authStore';
import {
  fetchStatsAll,
  heatmapFromStatsAll,
  formatGapMs,
  type HeatmapData,
  type StatsAllResponse,
} from '../../services/statsService';
import type { StreamCardData } from '../../stores/sessionStore';
import { Colors, Radii } from '../../theme';

// Renders the agent-presented inline cards of the One Conversation stream.
// Bubbles say things; cards DO things — breathe, watch, look at the map.

interface StreamCardProps {
  card: StreamCardData;
  onBreathingDone: (from: number, to: number) => void;
}

export default function StreamCard({ card, onBreathingDone }: StreamCardProps) {
  switch (card.type) {
    case 'breathing':
      return <BreathingCard onDone={onBreathingDone} />;
    case 'quote':
      return <QuoteCard quote={card.quote} cite={card.cite} />;
    case 'video':
      return <InlineVideoCard title={card.title} url={card.url} durationSeconds={card.durationSeconds} />;
    case 'heatmap':
      return <HeatmapCard />;
    case 'records':
      return <RecordsCard />;
    default:
      return null;
  }
}

function CardShell({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      {children}
    </View>
  );
}

function QuoteCard({ quote, cite }: { quote: string; cite: string }) {
  return (
    <CardShell title="Something to hold" sub="Matched to this moment">
      <Text style={styles.quote}>“{quote}”</Text>
      <Text style={styles.cite}>{cite}</Text>
    </CardShell>
  );
}

function InlineVideoCard({
  title,
  url,
  durationSeconds,
}: {
  title: string;
  url: string;
  durationSeconds?: number;
}) {
  const player = useVideoPlayer(url, (p) => {
    p.loop = false;
    p.muted = false;
  });

  const dur = durationSeconds
    ? ` · ${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')}`
    : '';

  return (
    <CardShell title={title} sub={`From your library${dur} — the kind that's worked for you`}>
      <VideoView player={player} style={styles.video} contentFit="cover" nativeControls />
    </CardShell>
  );
}

function HeatmapCard() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [data, setData] = useState<HeatmapData | null | 'empty'>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const live = await fetchStatsAll(userId);
      if (cancelled) return;
      if (live) {
        setData(heatmapFromStatsAll(live));
      } else {
        setData('empty');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <CardShell title="Your hours" sub="Urges by time of day — what Buddy watches for you">
      {data === null ? (
        <Text style={styles.loading}>loading…</Text>
      ) : data === 'empty' ? (
        <Text style={styles.loading}>Not enough data yet</Text>
      ) : (
        <HoursHeatmap data={data} />
      )}
    </CardShell>
  );
}

function RecordsCard() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [live, setLive] = useState<StatsAllResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStatsAll(userId).then((d) => {
      if (!cancelled) setLive(d);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <CardShell
      title="Records & milestones"
      sub="These only grow. Waking hours only — sleep isn't a struggle."
    >
      {live ? (
        <View style={styles.records}>
          <View style={styles.recordRow}>
            <Text style={styles.recordName}>Longest waking gap</Text>
            <Text style={styles.recordValue}>{formatGapMs(live.records.longest_waking_gap_ms)}</Text>
          </View>
          <View style={styles.recordRow}>
            <Text style={styles.recordName}>Most urges ridden out, one week</Text>
            <Text style={styles.recordValue}>{String(live.records.best_week_resists)}</Text>
          </View>
          <View style={styles.recordRow}>
            <Text style={styles.recordName}>Current waking gap</Text>
            <Text style={styles.recordValue}>{formatGapMs(live.records.current_waking_gap_ms)}</Text>
          </View>
        </View>
      ) : (
        <Text style={styles.loading}>loading…</Text>
      )}
    </CardShell>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(35,35,38,0.96)',
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: 16,
    marginBottom: 8,
    gap: 8,
    alignSelf: 'stretch',
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  sub: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  quote: {
    fontSize: 17,
    lineHeight: 25,
    fontStyle: 'italic',
    color: Colors.textPrimary,
    borderLeftWidth: 3,
    borderLeftColor: Colors.coral,
    paddingLeft: 12,
  },
  cite: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: Radii.sm,
    backgroundColor: Colors.background,
  },
  records: {
    gap: 8,
  },
  recordRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radii.sm,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  recordName: {
    fontSize: 13,
    color: Colors.textSecondary,
    flexShrink: 1,
  },
  recordValue: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  loading: {
    fontSize: 13,
    color: Colors.textTertiary,
    fontStyle: 'italic',
  },
});
