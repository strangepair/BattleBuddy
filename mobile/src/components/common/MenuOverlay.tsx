import type { ComponentProps } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing } from '../../theme';
import { useUIStore } from '../../stores/uiStore';
import { FeatureFlags } from '../../config';

interface MenuItem {
  key: string;
  label: string;
  icon: ComponentProps<typeof Ionicons>['name'];
}

const ITEMS: MenuItem[] = [
  { key: 'history',     label: 'History',     icon: 'time-outline' },
  { key: 'insights',    label: 'Insights',    icon: 'sparkles-outline' },
  { key: 'analytics',   label: 'Analytics',   icon: 'pulse-outline' },
  { key: 'goals',       label: 'Goals',       icon: 'flag-outline' },
  { key: 'routines',    label: 'Routines',    icon: 'repeat-outline' },
  { key: 'preferences', label: 'Preferences', icon: 'settings-outline' },
];

// The build-pipeline dashboard. Gated the same way as the "Build pipeline
// (Dev)" row in preferences.tsx: on the build-time availability flag (which
// defaults on), never on the developerMode toggle — the dashboard is a
// read-only view of recorded build requests, so reaching it must not depend
// on the conversation being in dev mode.
const DEV_ITEM: MenuItem = { key: 'dev', label: 'Build Pipeline', icon: 'cube-outline' };

interface MenuOverlayProps {
  onNavigate: (key: string) => void;
}

export default function MenuOverlay({ onNavigate }: MenuOverlayProps) {
  const menuOpen = useUIStore((s) => s.menuOpen);
  const closeMenu = useUIStore((s) => s.closeMenu);
  const items = FeatureFlags.developerModeAvailable ? [...ITEMS, DEV_ITEM] : ITEMS;

  return (
    <Modal
      visible={menuOpen}
      transparent
      animationType="fade"
      onRequestClose={closeMenu}
    >
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={closeMenu} />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>BattleBuddy</Text>
            <TouchableOpacity onPress={closeMenu} hitSlop={12}>
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.items}>
            {items.map(({ key, label, icon }) => (
              <TouchableOpacity
                key={key}
                style={styles.item}
                onPress={() => onNavigate(key)}
                activeOpacity={0.7}
              >
                <Ionicons name={icon} size={20} color={Colors.textSecondary} style={styles.itemIcon} />
                <Text style={styles.itemLabel}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.footerText}>Your companion for building new habits</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: '78%',
    backgroundColor: Colors.surface,
    paddingTop: 60,
    paddingHorizontal: Spacing.lg,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.coral,
  },
  items: {
    gap: Spacing.xs,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    borderRadius: 14,
    gap: Spacing.md,
  },
  itemIcon: {
    width: 28,
    textAlign: 'center',
  },
  itemLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  footerText: {
    position: 'absolute',
    bottom: 40,
    left: Spacing.lg,
    right: Spacing.lg,
    fontSize: 13,
    color: Colors.textTertiary,
    textAlign: 'center',
  },
});
