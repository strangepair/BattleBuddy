import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import GaugeHero from './GaugeHero';
import type { SessionPhase } from './SessionHeader';
import ArcChart from '../journey/ArcChart';
import HoursHeatmap from '../journey/HoursHeatmap';
import IndependenceTrend from '../journey/IndependenceTrend';
import InsightCards from '../journey/InsightCards';
import WhatWorksList from '../journey/WhatWorksList';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore, type Hand } from '../../stores/settingsStore';
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
import { fetchRecentEvents, type BBEvent } from '../../services/eventService';
import { Colors, Spacing, Radii } from '../../theme';

export type QuickLogKind = 'resisted' | 'cigarette' | 'decision' | 'urge';

export interface TalkAboutTopic {
  title: string;
  detail: string;
  userText: string;
}

interface HomeDashboardProps {
  phase: SessionPhase;
  /** When resistance began (ms) — drives the live wave timer. */
  resistanceSince: number | null;
  /** True while Mission is the visible tab — gates the refresh cycle. */
  active: boolean;
  onTalk: (topic: TalkAboutTopic) => void;
  onQuickLog: (kind: QuickLogKind) => void;
  /** Resistance command — straight into the Rule of Three. */
  onRuleOfThree: () => void;
}

interface HudData {
  lastCigaretteAt: number | null;
  dayN: number;
  todayCount: number;
  weekReps: number;
  totalMoments: number;
  /** Next likely hour (0-23) from the logged pattern, or null while learning. */
  watchedHour: number | null;
}

const URGE_LIKE = ['urge', 'urge_resisted', 'urge_gave_in', 'cigarette'];

function computeHud(events: BBEvent[]): HudData {
  const now = new Date();
  const dayKey = now.toDateString();
  const weekAgo = now.getTime() - 7 * 86400e3;

  let lastCig: number | null = null;
  let earliest = now.getTime();
  let todayCount = 0;
  let weekReps = 0;
  const hourCounts = new Array(24).fill(0);

  for (const e of events) {
    const t = new Date(e.occurred_at);
    const ms = t.getTime();
    if (ms < earliest) earliest = ms;
    if (e.event_type === 'cigarette') {
      if (lastCig == null || ms > lastCig) lastCig = ms;
      if (t.toDateString() === dayKey) todayCount++;
    }
    if (e.event_type === 'urge_resisted' && ms >= weekAgo) weekReps++;
    if (URGE_LIKE.includes(e.event_type)) hourCounts[t.getHours()]++;
  }

  // Watched window: the next hour of the day (from now forward, wrapping)
  // with the strongest logged pattern. Needs a handful of moments before
  // it's worth asserting — before that, BB is honest that it's learning.
  let watchedHour: number | null = null;
  if (events.length >= 5) {
    const nowH = now.getHours();
    let bestH = -1;
    let bestC = 0;
    for (let off = 1; off <= 24; off++) {
      const h = (nowH + off) % 24;
      if (hourCounts[h] > bestC) {
        bestC = hourCounts[h];
        bestH = h;
      }
    }
    if (bestC >= 2) watchedHour = bestH;
  }

  return {
    lastCigaretteAt: lastCig,
    dayN: Math.max(1, Math.floor((now.getTime() - earliest) / 86400e3) + 1),
    todayCount,
    weekReps,
    totalMoments: events.length,
    watchedHour,
  };
}

function fmtHour(h: number): string {
  const ampm = h >= 12 ? 'p' : 'a';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `~${hr}${ampm}`;
}

// The Mission HUD: Time-Since-Last as the hero everywhere, phase-aware
// tiles and support cards, and the deep map below the fold. Observation
// asks only for honest logging; resistance leads with the wave.
export default function HomeDashboard({
  phase,
  resistanceSince,
  active,
  onTalk,
  onQuickLog,
  onRuleOfThree,
}: HomeDashboardProps) {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [journey, setJourney] = useState<JourneyData | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [live, setLive] = useState<StatsAllResponse | null>(null);
  const [hud, setHud] = useState<HudData | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [waveNow, setWaveNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const [j, ins, all, events] = await Promise.all([
      fetchJourney(userId),
      fetchInsights(userId),
      fetchStatsAll(userId),
      fetchRecentEvents(userId),
    ]);
    setJourney(j);
    setInsights(ins);
    setLive(all);
    setHud(computeHud(events));
  }, [userId]);

  // Refresh when Mission becomes the visible tab, then keep the numbers
  // honest once a minute while it stays visible.
  useEffect(() => {
    if (!active) return;
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [active, refresh]);

  // Wave timer ticks while resisting.
  useEffect(() => {
    if (phase !== 'resistance') return;
    const t = setInterval(() => setWaveNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [phase]);

  const resistance = phase === 'resistance';
  const arc = live ? arcFromStatsAll(live) : journey?.arc;
  const heatmap = live ? heatmapFromStatsAll(live) : journey?.heatmap;
  const waveMin =
    resistanceSince != null ? Math.max(1, Math.round((waveNow - resistanceSince) / 60000)) : null;
  const mapPct = hud ? Math.min(99, hud.totalMoments * 3) : 0;

  const quickLog = (kind: QuickLogKind) => {
    setLogOpen(false);
    onQuickLog(kind);
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <GaugeHero
        phase={phase}
        lastCigaretteAt={hud?.lastCigaretteAt ?? null}
        bestGapMs={live?.records.longest_waking_gap_ms ?? null}
      />

      {/* status tiles — the read-out flips with the phase */}
      {!resistance ? (
        <View style={styles.tiles}>
          <Tile label="Today" value={hud ? String(hud.todayCount) : '—'} detail="moments logged" />
          <Tile label="The map" value={`${mapPct}%`} tone="amber" detail={hud ? `${hud.totalMoments} moments in — filling` : 'filling in'} />
          <Tile
            label="Ridden out"
            value={hud ? String(hud.weekReps) : '—'}
            tone="green"
            detail={hud && hud.weekReps === 0 ? "first one's coming" : 'this week — yours'}
          />
        </View>
      ) : (
        <View style={styles.tiles}>
          <Tile
            label="Holding"
            value={hud?.lastCigaretteAt ? formatGapMs(Date.now() - hud.lastCigaretteAt) : '—'}
            tone="coral"
            detail={
              live && live.records.longest_waking_gap_ms > 0
                ? `best ${formatGapMs(live.records.longest_waking_gap_ms)}`
                : 'the record only grows'
            }
          />
          <Tile label="This wave" value={waveMin ? `${waveMin} min` : '—'} tone="amber" detail="most break by 15" />
          <Tile
            label="Ridden out"
            value={hud ? String(hud.weekReps) : '—'}
            tone="green"
            detail="this week — yours"
          />
        </View>
      )}

      {/* the day calendar — where the moments cluster, hour by hour */}
      <TouchableOpacity
        style={styles.dayLink}
        activeOpacity={0.85}
        onPress={() => {
          Haptics.selectionAsync().catch(() => {});
          router.push('/day-calendar');
        }}
        accessibilityLabel="Open your day, hour by hour"
      >
        <Text style={styles.watchIcon}>📅</Text>
        <View style={styles.watchBody}>
          <Text style={styles.dayLinkTitle}>Your day, hour by hour</Text>
          <Text style={styles.dayLinkSub}>
            Every logged moment on today's clock — see where they cluster.
          </Text>
        </View>
        <Text style={styles.dayLinkArrow}>→</Text>
      </TouchableOpacity>

      {/* watched window (observation) / the wave (resistance) */}
      {!resistance ? (
        <TouchableOpacity
          style={styles.watch}
          activeOpacity={0.85}
          onPress={() =>
            onTalk({
              title: 'Watched window',
              detail:
                hud?.watchedHour != null
                  ? `Next likely moment around ${fmtHour(hud.watchedHour)} based on my logged pattern`
                  : 'The app is still learning my pattern',
              userText: "Let's talk about this.",
            })
          }
        >
          <Text style={styles.watchIcon}>⏱</Text>
          <View style={styles.watchBody}>
            {hud?.watchedHour != null ? (
              <Text style={styles.watchText}>
                <Text style={styles.watchStrong}>Watched window:</Text> from your logs, the next
                likely one is <Text style={styles.watchStrong}>{fmtHour(hud.watchedHour)}</Text>.
                Buddy will be paying attention with you.
              </Text>
            ) : (
              <Text style={styles.watchText}>
                <Text style={styles.watchStrong}>Watched window:</Text> still learning your
                pattern — log a few moments and Buddy will find it with you.
              </Text>
            )}
            <Text style={styles.watchTalk}>Talk about this →</Text>
          </View>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.wave} activeOpacity={0.85} onPress={onRuleOfThree}>
          <Text style={styles.watchIcon}>🌊</Text>
          <View style={styles.watchBody}>
            <Text style={styles.watchText}>
              This wave has been rising{' '}
              <Text style={styles.waveStrong}>{waveMin ?? 1} min</Text> — most break inside 15.
              You don't beat it, you outlast it.
            </Text>
            <Text style={styles.waveTalk}>Ride it with me →</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* mission orders / right now */}
      {!resistance ? (
        <JCard title={`Mission orders — day ${hud?.dayN ?? 1}`}>
          <Text style={styles.orders}>
            Just observe. Log every one, honestly, with a word of context — where you were, what
            came right before. That's the whole mission today. No quitting required yet.
          </Text>
          <View style={styles.mapline}>
            <View style={styles.mapbar}>
              <View style={[styles.mapfill, { width: `${mapPct}%` }]} />
            </View>
            <Text style={styles.maplabel}>
              the map is filling in{hud ? ` · ${hud.totalMoments} moments` : ''}
            </Text>
          </View>
        </JCard>
      ) : (
        <JCard title="Right now">
          <Text style={styles.orders}>
            Feet on the floor. One thing in the room you can hear. The wave is already cresting —
            and your record for riding them out only ever grows.
          </Text>
        </JCard>
      )}

      {/* commands */}
      <View style={styles.cmdRow}>
        <TouchableOpacity
          style={styles.cmd}
          activeOpacity={0.8}
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            setLogOpen((o) => !o);
          }}
        >
          <Text style={styles.cmdLabel}>📝 LOG A MOMENT</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.cmd, styles.cmdUrgent]}
          activeOpacity={0.8}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            if (resistance) onRuleOfThree();
            else onQuickLog('urge');
          }}
        >
          <Text style={[styles.cmdLabel, styles.cmdUrgentLabel]}>
            {resistance ? '🫁 RULE OF THREE' : '🌊 URGE — HELP'}
          </Text>
        </TouchableOpacity>
      </View>
      {logOpen && (
        <View style={styles.qlRow}>
          <QLButton label="🚬 Had one" onPress={() => quickLog('cigarette')} />
          <QLButton label="💪 Rode it out" tint={Colors.success} onPress={() => quickLog('resisted')} />
          <QLButton label="🙂 Decision" tint={Colors.stateIdle} onPress={() => quickLog('decision')} />
        </View>
      )}

      {/* ── the deep map — below the fold ────────────────────────────────── */}
      <Text style={styles.deepHeader}>THE DEEP MAP</Text>

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

      <JCard
        title="Settings"
        sub="Which hand do you use? Buddy and the primary controls move to your thumb side."
      >
        <HandToggle />
        <Text style={styles.settingsNote}>
          Applies everywhere: Buddy's presence, mic and send, and the view tabs.
        </Text>
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

function Tile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'green' | 'amber' | 'coral';
}) {
  const color =
    tone === 'green' ? Colors.success : tone === 'amber' ? Colors.warning : tone === 'coral' ? Colors.coral : Colors.textPrimary;
  return (
    <View style={styles.tile}>
      <Text style={styles.tileK}>{label.toUpperCase()}</Text>
      <Text style={[styles.tileV, { color }]}>{value}</Text>
      <Text style={styles.tileD}>{detail}</Text>
    </View>
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

function HandToggle() {
  const hand = useSettingsStore((s) => s.hand);
  const setHand = useSettingsStore((s) => s.setHand);
  const options: { key: Hand; label: string }[] = [
    { key: 'left', label: 'Left hand' },
    { key: 'right', label: 'Right hand' },
  ];
  return (
    <View style={styles.handRow} accessibilityRole="radiogroup">
      {options.map(({ key, label }) => {
        const on = hand === key;
        return (
          <TouchableOpacity
            key={key}
            style={[styles.handBtn, on && styles.handBtnOn]}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setHand(key);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.handLabel, on && styles.handLabelOn]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    padding: 14,
    gap: 11,
    paddingBottom: 24,
  },
  tiles: {
    flexDirection: 'row',
    gap: 9,
  },
  tile: {
    flex: 1,
    backgroundColor: 'rgba(35,35,38,0.92)',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: 13,
    paddingVertical: 10,
    paddingHorizontal: 11,
  },
  tileK: {
    fontSize: 8.5,
    letterSpacing: 0.9,
    color: Colors.textTertiary,
    fontWeight: '700',
  },
  tileV: {
    fontSize: 19,
    fontWeight: '800',
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  tileD: {
    fontSize: 9,
    color: Colors.textSecondary,
    marginTop: 2,
    lineHeight: 12,
  },
  dayLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(35,35,38,0.92)',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: 13,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  dayLinkTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  dayLinkSub: {
    fontSize: 10.5,
    color: Colors.textSecondary,
    marginTop: 2,
    lineHeight: 14,
  },
  dayLinkArrow: {
    fontSize: 16,
    color: Colors.stateIdle,
    fontWeight: '700',
  },
  watch: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: 'rgba(255,159,10,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,159,10,0.35)',
    borderRadius: 13,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  wave: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: 'rgba(232,98,74,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(232,98,74,0.45)',
    borderRadius: 13,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  watchIcon: {
    fontSize: 16,
    marginTop: 1,
  },
  watchBody: {
    flex: 1,
  },
  watchText: {
    fontSize: 12,
    lineHeight: 17,
    color: Colors.textPrimary,
  },
  watchStrong: {
    color: Colors.warning,
    fontWeight: '700',
  },
  waveStrong: {
    color: Colors.coral,
    fontWeight: '700',
    fontFamily: 'Menlo',
  },
  watchTalk: {
    fontSize: 10.5,
    color: Colors.coral,
    fontWeight: '700',
    marginTop: 5,
  },
  waveTalk: {
    fontSize: 10.5,
    color: Colors.coral,
    fontWeight: '700',
    marginTop: 5,
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
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  cardSub: {
    fontSize: 11,
    color: Colors.textSecondary,
    lineHeight: 15,
    marginBottom: 2,
  },
  orders: {
    fontSize: 11.5,
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  mapline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 4,
  },
  mapbar: {
    flex: 1,
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.surfaceLight,
    overflow: 'hidden',
  },
  mapfill: {
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.stateIdle,
  },
  maplabel: {
    fontSize: 10.5,
    color: Colors.stateIdle,
    fontWeight: '700',
  },
  cmdRow: {
    flexDirection: 'row',
    gap: 9,
  },
  cmd: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 13,
    paddingVertical: 13,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  cmdUrgent: {
    backgroundColor: 'rgba(232,98,74,0.15)',
    borderColor: 'rgba(232,98,74,0.6)',
  },
  cmdLabel: {
    fontSize: 12.5,
    fontWeight: '800',
    letterSpacing: 0.4,
    color: Colors.textPrimary,
  },
  cmdUrgentLabel: {
    color: Colors.coral,
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
  deepHeader: {
    fontSize: 10,
    letterSpacing: 2,
    color: Colors.textTertiary,
    fontWeight: '800',
    marginTop: 10,
    marginBottom: -2,
    textAlign: 'center',
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
  handRow: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: 999,
    padding: 3,
    alignSelf: 'flex-start',
    gap: 2,
  },
  handBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  handBtnOn: {
    backgroundColor: Colors.surfaceLight,
  },
  handLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  handLabelOn: {
    color: Colors.textPrimary,
  },
  settingsNote: {
    fontSize: 11,
    color: Colors.textTertiary,
    lineHeight: 15,
  },
});
