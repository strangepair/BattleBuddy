import { useEffect, useState, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import ArcChart from '../journey/ArcChart';
import HoursHeatmap from '../journey/HoursHeatmap';
import IndependenceTrend from '../journey/IndependenceTrend';
import InsightCards from '../journey/InsightCards';
import WhatWorksList from '../journey/WhatWorksList';
import { useAuthStore } from '../../stores/authStore';
import {
  fetchJourney,
  fetchInsights,
  fetchStatsAll,
  arcFromStatsAll,
  heatmapFromStatsAll,
  formatGapMs,
  type JourneyData,
  type Insight,
  type StatsAllResponse,
} from '../../services/statsService';
import { fetchRecentEvents } from '../../services/eventService';
import { Colors, Spacing, Radii } from '../../theme';

export type QuickLogKind = 'resisted' | 'cigarette' | 'decision' | 'urge';

/** "Talk about this" — carries what the user was looking at back into the
    conversation as a reply-quote (title + one-line summary). */
export interface TalkAboutTopic {
  title: string;
  detail: string;
  userText: string;
}

interface HomeDashboardProps {
  onTalk: (topic: TalkAboutTopic) => void;
  onQuickLog: (kind: QuickLogKind) => void;
}

interface Snapshot {
  today: number | null;
  wakingGap: string | null;
  weekReps: number | null;
}

export default function HomeDashboard({ onTalk, onQuickLog }: HomeDashboardProps) {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [journey, setJourney] = useState<JourneyData | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [live, setLive] = useState<StatsAllResponse | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({ today: null, wakingGap: null, weekReps: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [j, ins, all, events] = await Promise.all([
        fetchJourney(userId),
        fetchInsights(userId),
        fetchStatsAll(userId),
        fetchRecentEvents(userId),
      ]);
      if (cancelled) return;
      setJourney(j);
      setInsights(ins);
      setLive(all);

      // "Where you stand" tiles — same math as the web head's refreshStats.
      const now = new Date();
      const dayKey = now.toDateString();
      const weekAgo = now.getTime() - 7 * 86400e3;
      let today = 0;
      let reps = 0;
      for (const e of events) {
        const t = new Date(e.occurred_at);
        if (e.event_type === 'cigarette' && t.toDateString() === dayKey) today++;
        if (e.event_type === 'urge_resisted' && t.getTime() >= weekAgo) reps++;
      }
      setSnapshot({
        today: events.length ? today : null,
        wakingGap: all ? formatGapMs(all.records.current_waking_gap_ms) : null,
        weekReps: events.length ? reps : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const arc = live ? arcFromStatsAll(live) : journey?.arc;
  const heatmap = live ? heatmapFromStatsAll(live) : journey?.heatmap;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <JCard
        title="Quick log"
        sub="One tap. It lands in the conversation as a receipt — no forms."
      >
        <View style={styles.qlRow}>
          <QLButton label="💪 Resisted" tint={Colors.success} onPress={() => onQuickLog('resisted')} />
          <QLButton label="😐 Gave in" onPress={() => onQuickLog('cigarette')} />
          <QLButton label="🙂 Decision" tint={Colors.stateIdle} onPress={() => onQuickLog('decision')} />
          <QLButton label="🌊 Urge — help" tint={Colors.coral} onPress={() => onQuickLog('urge')} />
        </View>
      </JCard>

      <JCard title="Where you stand" sub="Right now, against your own baseline — nobody else's">
        <View style={styles.snapRow}>
          <SnapTile label="Today" value={snapshot.today != null ? String(snapshot.today) : '—'} detail="cigarettes" />
          <SnapTile label="Waking gap" value={snapshot.wakingGap ?? '—'} detail="awake & counting" good />
          <SnapTile label="This week" value={snapshot.weekReps != null ? String(snapshot.weekReps) : '—'} detail="urges ridden out" good />
        </View>
      </JCard>

      {arc && (
        <JCard title="The arc" sub={`Daily count vs your ${arc.baseline}/day baseline — 30 days`}>
          <ArcChart arc={arc} />
          <CtaRow>
            <Cta
              label="Talk about this"
              primary
              onPress={() =>
                onTalk({
                  title: 'The arc',
                  detail: `Daily count vs ${arc.baseline}/day baseline — 30 days`,
                  userText: "Let's talk about this.",
                })
              }
            />
          </CtaRow>
        </JCard>
      )}

      {heatmap && (
        <JCard title="Your hours" sub="Urges by time of day — what Buddy watches for you">
          <HoursHeatmap data={heatmap} />
          <CtaRow>
            <Cta
              label="Talk about this"
              primary
              onPress={() =>
                onTalk({
                  title: 'Your hours',
                  detail: 'Urges by time of day and day of week',
                  userText: "Let's talk about this.",
                })
              }
            />
          </CtaRow>
        </JCard>
      )}

      {journey && (
        <JCard title="What works for you" sub="Techniques ranked by your own outcomes, not theory">
          <WhatWorksList items={journey.whatWorks} />
          <CtaRow>
            <Cta
              label="Practice one now"
              primary
              onPress={() =>
                onTalk({
                  title: 'What works for you',
                  detail: journey.whatWorks
                    .slice(0, 3)
                    .map((w) => `${w.name} ${w.succeeded}/${w.total}`)
                    .join(' · '),
                  userText: "Let's run one now.",
                })
              }
            />
            <Cta
              label="Why these work"
              onPress={() =>
                onTalk({
                  title: 'What works for you',
                  detail: 'Techniques ranked by outcomes',
                  userText: 'Why do these work for me?',
                })
              }
            />
          </CtaRow>
        </JCard>
      )}

      {live && (
        <JCard
          title="Records & milestones"
          sub="These only grow. Waking hours only — sleep isn't a struggle, so it never pads a record."
        >
          <View style={styles.records}>
            <RecordRow name="Longest waking gap" value={formatGapMs(live.records.longest_waking_gap_ms)} />
            <RecordRow name="Most urges ridden out, one week" value={String(live.records.best_week_resists)} />
            <RecordRow name="Current waking gap" value={formatGapMs(live.records.current_waking_gap_ms)} />
          </View>
          <CtaRow>
            <Cta
              label="Talk about this"
              primary
              onPress={() =>
                onTalk({
                  title: 'Records & milestones',
                  detail: `Longest waking gap ${formatGapMs(live.records.longest_waking_gap_ms)}`,
                  userText: "Let's talk about this.",
                })
              }
            />
          </CtaRow>
        </JCard>
      )}

      <JCard title="Insights & recommendations" sub="Written by Buddy from your data — tap to go deeper">
        <InsightCards
          insights={insights}
          onTalk={(insight) =>
            onTalk({
              title: 'Insight',
              detail: insight.text,
              userText: "Let's talk about this.",
            })
          }
        />
      </JCard>

      {journey && (
        <JCard
          title="Independence trend"
          sub="You catching it yourself vs Buddy reaching out — the goal is needing this less"
        >
          <IndependenceTrend weeks={journey.independence} />
          <CtaRow>
            <Cta
              label="Talk about this"
              primary
              onPress={() =>
                onTalk({
                  title: 'Independence trend',
                  detail: 'Self-initiated vs prompted sessions by week',
                  userText: "Let's talk about this.",
                })
              }
            />
          </CtaRow>
        </JCard>
      )}
    </ScrollView>
  );
}

function JCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {sub ? <Text style={styles.cardSub}>{sub}</Text> : null}
      {children}
    </View>
  );
}

function QLButton({ label, tint, onPress }: { label: string; tint?: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.qlBtn, tint ? { borderColor: tint } : null]}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      activeOpacity={0.8}
    >
      <Text style={styles.qlLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function SnapTile({ label, value, detail, good }: { label: string; value: string; detail: string; good?: boolean }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, good && styles.tileValueGood]}>{value}</Text>
      <Text style={styles.tileDetail}>{detail}</Text>
    </View>
  );
}

function RecordRow({ name, value }: { name: string; value: string }) {
  return (
    <View style={styles.recordRow}>
      <Text style={styles.recordName}>{name}</Text>
      <Text style={styles.recordValue}>{value}</Text>
    </View>
  );
}

function CtaRow({ children }: { children: ReactNode }) {
  return <View style={styles.ctaRow}>{children}</View>;
}

function Cta({ label, primary, onPress }: { label: string; primary?: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.cta, primary && styles.ctaPrimary]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Text style={[styles.ctaLabel, primary && styles.ctaLabelPrimary]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    padding: 14,
    gap: 12,
    paddingBottom: 24,
  },
  card: {
    backgroundColor: 'rgba(35,35,38,0.92)',
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  cardSub: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
    marginBottom: 2,
  },
  qlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  qlBtn: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  qlLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  snapRow: {
    flexDirection: 'row',
    gap: 8,
  },
  tile: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radii.sm,
    padding: 10,
    gap: 2,
  },
  tileLabel: {
    fontSize: 10,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tileValue: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.textPrimary,
  },
  tileValueGood: {
    color: Colors.success,
  },
  tileDetail: {
    fontSize: 10,
    color: Colors.textSecondary,
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
  ctaRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  cta: {
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 16,
    backgroundColor: Colors.surface,
  },
  ctaPrimary: {
    backgroundColor: 'rgba(232,98,74,0.12)',
  },
  ctaLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  ctaLabelPrimary: {
    color: Colors.coral,
  },
});
