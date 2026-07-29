import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuthStore } from '../../src/stores/authStore';
import { fetchDayEvents, type BBEvent } from '../../src/services/eventService';
import { Colors, Radii } from '../../src/theme';

// The day calendar: one local day, hour by hour, every logged moment placed
// in its hour block with its activity label (gym, work, drive, park — whatever
// context rode in on the log). Pattern recognition by eye: cigarette hours run
// coral, ridden-out hours run green, and the clusters jump out of the empty
// stretches. A separate screen reached by navigation — the session screen's
// structure stays untouched (launch-gate rule).

interface KindMeta {
  icon: string;
  name: string;
  color: string;
}

const KIND: Record<string, KindMeta> = {
  cigarette: { icon: '🚬', name: 'Cigarette', color: Colors.coral },
  urge_gave_in: { icon: '🚬', name: 'Gave in', color: Colors.coral },
  urge_resisted: { icon: '💪', name: 'Rode it out', color: Colors.success },
  urge: { icon: '🌊', name: 'Urge', color: Colors.warning },
  decision: { icon: '🙂', name: 'Decision', color: Colors.stateIdle },
  milestone: { icon: '🏁', name: 'Milestone', color: Colors.success },
};

const FALLBACK_KIND: KindMeta = { icon: '·', name: 'Moment', color: Colors.textSecondary };

function kindOf(e: BBEvent): KindMeta {
  return KIND[e.event_type] ?? FALLBACK_KIND;
}

/** The activity context that rode in on the log — trigger first (that's where
    "driving", "after the gym" lands), then a milestone label, then notes. */
function activityLabel(e: BBEvent): string | null {
  const md = e.metadata ?? {};
  const raw = md.trigger ?? md.label ?? md.notes;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  return text.length > 34 ? `${text.slice(0, 33)}…` : text;
}

function localDateStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dateForOffset(daysBack: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // noon anchor — day arithmetic is DST-safe
  d.setDate(d.getDate() - daysBack);
  return d;
}

function fmtHour(h: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
}

function fmtMinute(iso: string): string {
  const d = new Date(iso);
  return `:${String(d.getMinutes()).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayTitle(offset: number, d: Date): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Yesterday';
  return WEEKDAYS[d.getDay()];
}

export default function DayCalendarScreen() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // 0 = today; +1 per day back. No future days — the map only covers lived time.
  const [offset, setOffset] = useState(0);
  const [events, setEvents] = useState<BBEvent[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const date = useMemo(() => dateForOffset(offset), [offset]);
  const dateStr = localDateStr(date);

  const load = useCallback(async () => {
    setEvents(await fetchDayEvents(userId, dateStr));
  }, [userId, dateStr]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const step = useCallback((delta: number) => {
    Haptics.selectionAsync().catch(() => {});
    setOffset((o) => Math.max(0, o + delta));
  }, []);

  // Hour blocks: events grouped by local hour, oldest first within the hour.
  const hours = useMemo(() => {
    const byHour: BBEvent[][] = Array.from({ length: 24 }, () => []);
    for (const e of events) {
      const d = new Date(e.occurred_at);
      if (Number.isNaN(d.getTime())) continue;
      byHour[d.getHours()].push(e);
    }
    for (const block of byHour) {
      block.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
    }
    return byHour;
  }, [events]);

  const cigCount = events.filter((e) => e.event_type === 'cigarette').length;
  const rodeCount = events.filter((e) => e.event_type === 'urge_resisted').length;
  const nowHour = new Date().getHours();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>YOUR DAY</Text>
        <View style={styles.headerBtn} />
      </View>

      {/* day picker — arrows walk one day at a time */}
      <View style={styles.dayNav}>
        <TouchableOpacity
          style={styles.dayBtn}
          onPress={() => step(1)}
          activeOpacity={0.7}
          accessibilityLabel="Previous day"
        >
          <Ionicons name="chevron-back" size={18} color={Colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.dayLabelWrap}>
          <Text style={styles.dayLabel}>{dayTitle(offset, date)}</Text>
          <Text style={styles.daySub}>
            {MONTHS[date.getMonth()]} {date.getDate()}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.dayBtn, offset === 0 && styles.dayBtnDisabled]}
          onPress={() => step(-1)}
          disabled={offset === 0}
          activeOpacity={0.7}
          accessibilityLabel="Next day"
        >
          <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* the day's tally */}
      <View style={styles.tally}>
        <TallyItem value={String(cigCount)} label="cigarettes" color={Colors.coral} />
        <TallyItem value={String(rodeCount)} label="ridden out" color={Colors.success} />
        <TallyItem value={String(events.length)} label="moments logged" color={Colors.textPrimary} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.textSecondary} />
        }
      >
        {events.length === 0 && (
          <Text style={styles.empty}>
            Nothing logged {offset === 0 ? 'yet today' : 'this day'} — the hours fill in as you log
            moments with a word of context.
          </Text>
        )}
        {hours.map((block, h) => (
          <HourRow
            key={h}
            hour={h}
            events={block}
            isNow={offset === 0 && h === nowHour}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function TallyItem({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <View style={styles.tallyItem}>
      <Text style={[styles.tallyValue, { color }]}>{value}</Text>
      <Text style={styles.tallyLabel}>{label}</Text>
    </View>
  );
}

/** One hour of the day. Empty hours stay thin and dim so the logged clusters
    stand out; the block tints toward its heaviest event kind. */
function HourRow({ hour, events, isNow }: { hour: number; events: BBEvent[]; isNow: boolean }) {
  const hasCig = events.some((e) => e.event_type === 'cigarette' || e.event_type === 'urge_gave_in');
  const hasRode = events.some((e) => e.event_type === 'urge_resisted');
  const blockStyle = [
    styles.hourBlock,
    events.length === 0 && styles.hourBlockEmpty,
    events.length > 0 && hasCig && styles.hourBlockCig,
    events.length > 0 && !hasCig && hasRode && styles.hourBlockRode,
    events.length > 0 && !hasCig && !hasRode && styles.hourBlockOther,
    isNow && styles.hourBlockNow,
  ];
  return (
    <View style={styles.hourRow}>
      <Text style={[styles.hourLabel, isNow && styles.hourLabelNow]}>{fmtHour(hour)}</Text>
      <View style={blockStyle}>
        {events.map((e) => {
          const kind = kindOf(e);
          const activity = activityLabel(e);
          return (
            <View key={e.id} style={styles.eventLine}>
              <Text style={styles.eventIcon}>{kind.icon}</Text>
              <Text style={styles.eventText} numberOfLines={1}>
                <Text style={[styles.eventKind, { color: kind.color }]}>{kind.name}</Text>
                {activity ? <Text style={styles.eventActivity}> · {activity}</Text> : null}
              </Text>
              <Text style={styles.eventMinute}>{fmtMinute(e.occurred_at)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 12,
    letterSpacing: 2.4,
    fontWeight: '800',
    color: Colors.textPrimary,
  },
  dayNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingBottom: 8,
  },
  dayBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayBtnDisabled: {
    opacity: 0.35,
  },
  dayLabelWrap: {
    alignItems: 'center',
    minWidth: 120,
  },
  dayLabel: {
    fontSize: 17,
    fontWeight: '800',
    color: Colors.textPrimary,
  },
  daySub: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  tally: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    paddingVertical: 8,
    marginHorizontal: 14,
    backgroundColor: 'rgba(35,35,38,0.92)',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radii.md,
  },
  tallyItem: {
    alignItems: 'center',
  },
  tallyValue: {
    fontSize: 20,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  tallyLabel: {
    fontSize: 9.5,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 14,
    paddingBottom: 28,
  },
  empty: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 17,
    textAlign: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  hourRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 3,
  },
  hourLabel: {
    width: 44,
    fontSize: 10,
    fontWeight: '700',
    color: Colors.textTertiary,
    textAlign: 'right',
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  hourLabelNow: {
    color: Colors.stateIdle,
  },
  hourBlock: {
    flex: 1,
    borderRadius: 9,
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    gap: 4,
  },
  hourBlockEmpty: {
    borderColor: 'rgba(58,58,60,0.45)',
    backgroundColor: 'transparent',
    paddingVertical: 5,
    minHeight: 14,
  },
  hourBlockCig: {
    borderColor: 'rgba(232,98,74,0.45)',
    backgroundColor: 'rgba(232,98,74,0.10)',
  },
  hourBlockRode: {
    borderColor: 'rgba(52,199,89,0.40)',
    backgroundColor: 'rgba(52,199,89,0.08)',
  },
  hourBlockOther: {
    borderColor: Colors.surfaceBorder,
    backgroundColor: 'rgba(35,35,38,0.92)',
  },
  hourBlockNow: {
    borderColor: 'rgba(91,159,255,0.6)',
  },
  eventLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  eventIcon: {
    fontSize: 13,
  },
  eventText: {
    flex: 1,
    fontSize: 12,
  },
  eventKind: {
    fontWeight: '700',
  },
  eventActivity: {
    color: Colors.textSecondary,
    fontWeight: '400',
  },
  eventMinute: {
    fontSize: 10.5,
    color: Colors.textTertiary,
    fontVariant: ['tabular-nums'],
  },
});
