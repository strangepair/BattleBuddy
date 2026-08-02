/*
 * AUDIT SUMMARY — routines.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE   checkInEnabled   – notificationStore (Zustand, persisted locally)
 * LIVE   checkInTime1     – notificationStore (Zustand, persisted locally)
 * LIVE   checkInTime2     – notificationStore (Zustand, persisted locally)
 * LIVE   streakEnabled    – notificationStore (Zustand, persisted locally)
 * LIVE   reEngageEnabled  – notificationStore (Zustand, persisted locally)
 * LIVE   quietStart       – notificationStore (Zustand, persisted locally)
 * LIVE   quietEnd         – notificationStore (Zustand, persisted locally)
 * ─────────────────────────────────────────────────────────────────────────────
 * No stale or hardcoded stats found on this screen.
 * All displayed values are user-controlled toggles/times written to and read
 * from notificationStore; no backend data is rendered here.
 */
import { useState, useCallback } from 'react';
import {
  View,
  Text,
  Switch,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import DateTimePicker, {
  DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Colors, Spacing, Radii } from '../../src/theme';
import HamburgerMenu from '../../src/components/common/HamburgerMenu';
import { useNotificationStore } from '../../src/stores/notificationStore';

type TimeField = 'checkInTime1' | 'checkInTime2' | 'quietStart' | 'quietEnd';

function timeToDate(timeStr: string): Date {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function dateToTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatTime(timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${display}:${String(m).padStart(2, '0')} ${suffix}`;
}

export default function RoutinesScreen() {
  // AUDIT: live – all values from notificationStore (Zustand, persisted locally)
  const store = useNotificationStore();

  const [editingField, setEditingField] = useState<TimeField | null>(null);

  const handleTimeChange = useCallback(
    (_: DateTimePickerEvent, date?: Date) => {
      if (Platform.OS === 'android') setEditingField(null);
      if (!date || !editingField) return;
      store.setPreference(editingField, dateToTime(date));
    },
    [editingField, store],
  );

  const confirmTimePicker = useCallback(() => {
    setEditingField(null);
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={12}
        >
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Routines</Text>
        <HamburgerMenu />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {/* ── Check-ins ─────────────────────────── */}
        <Text style={styles.sectionHeader}>SCHEDULED CHECK-INS</Text>
        <Text style={styles.sectionCaption}>
          Your buddy will reach out at these times to see how you're doing.
        </Text>

        <ToggleRow
          label="Check-in nudges"
          value={store.checkInEnabled} // AUDIT: live – notificationStore
          onChange={(v) => store.setPreference('checkInEnabled', v)}
        />

        {store.checkInEnabled && (
          <>
            <TimeRow
              label="First check-in"
              time={store.checkInTime1} // AUDIT: live – notificationStore
              onPress={() => setEditingField('checkInTime1')}
            />
            <TimeRow
              label="Second check-in"
              time={store.checkInTime2} // AUDIT: live – notificationStore
              onPress={() => setEditingField('checkInTime2')}
            />
          </>
        )}

        {/* ── Celebrations ──────────────────────── */}
        <Text style={[styles.sectionHeader, styles.sectionGap]}>
          CELEBRATIONS
        </Text>
        <Text style={styles.sectionCaption}>
          Get a nudge when you hit a streak milestone.
        </Text>

        <ToggleRow
          label="Streak celebrations"
          value={store.streakEnabled} // AUDIT: live – notificationStore
          onChange={(v) => store.setPreference('streakEnabled', v)}
        />

        {/* ── Re-engagement ─────────────────────── */}
        <Text style={[styles.sectionHeader, styles.sectionGap]}>
          GENTLE REMINDERS
        </Text>
        <Text style={styles.sectionCaption}>
          A quiet nudge if your buddy hasn't heard from you in a while. Never nagging.
        </Text>

        <ToggleRow
          label="Re-engagement"
          value={store.reEngageEnabled} // AUDIT: live – notificationStore
          onChange={(v) => store.setPreference('reEngageEnabled', v)}
        />

        {/* ── Quiet hours ───────────────────────── */}
        <Text style={[styles.sectionHeader, styles.sectionGap]}>
          QUIET HOURS
        </Text>
        <Text style={styles.sectionCaption}>
          No notifications during these hours. Sleep comes first.
        </Text>

        <TimeRow
          label="Quiet from"
          time={store.quietStart} // AUDIT: live – notificationStore
          onPress={() => setEditingField('quietStart')}
        />
        <TimeRow
          label="Until"
          time={store.quietEnd} // AUDIT: live – notificationStore
          onPress={() => setEditingField('quietEnd')}
        />
      </ScrollView>

      {/* ── Time picker (iOS inline, Android dialog) ── */}
      {editingField && (
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerContainer}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>
                Set time
              </Text>
              <TouchableOpacity onPress={confirmTimePicker}>
                <Text style={styles.pickerDone}>Done</Text>
              </TouchableOpacity>
            </View>
            <DateTimePicker
              value={timeToDate(store[editingField])}
              mode="time"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={handleTimeChange}
              themeVariant="dark"
              minuteInterval={15}
            />
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────────

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: Colors.surfaceLight, true: Colors.coral }}
        thumbColor={Colors.textPrimary}
      />
    </View>
  );
}

function TimeRow({
  label,
  time,
  onPress,
}: {
  label: string;
  time: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.timeBadge}>
        <Text style={styles.timeText}>{formatTime(time)}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  backButton: {
    paddingVertical: Spacing.xs,
    paddingRight: Spacing.sm,
    minWidth: 60,
  },
  backText: {
    color: Colors.coral,
    fontSize: 16,
    fontWeight: '600',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  spacer: {
    minWidth: 60,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xxl,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textTertiary,
    letterSpacing: 0.5,
    marginBottom: Spacing.xs,
  },
  sectionGap: {
    marginTop: Spacing.xl,
  },
  sectionCaption: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
    marginBottom: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    borderRadius: Radii.sm,
    marginBottom: Spacing.sm,
  },
  rowLabel: {
    fontSize: 16,
    color: Colors.textPrimary,
    fontWeight: '500',
  },
  timeBadge: {
    backgroundColor: Colors.surfaceLight,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radii.sm,
  },
  timeText: {
    fontSize: 15,
    color: Colors.coral,
    fontWeight: '600',
  },
  pickerOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingTop: Spacing.lg,
  },
  pickerContainer: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radii.lg,
    borderTopRightRadius: Radii.lg,
    paddingBottom: Spacing.xxl,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  pickerDone: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.coral,
  },
});
