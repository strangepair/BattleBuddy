import type { ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, Typography } from '../../theme';

interface ScreenHeaderProps {
  title: string;
  /** Renders a right-side slot (e.g. an action button) in place of the spacer. */
  right?: ReactNode;
  onBack?: () => void;
}

// Shared header for the secondary/drawer screens — replaces the four
// copy-pasted "← Back / title / spacer" blocks (history, insights,
// analytics, goals) with one component wired to Typography.screenTitle.
export default function ScreenHeader({ title, right, onBack }: ScreenHeaderProps) {
  const handleBack = onBack ?? (() => router.back());

  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={handleBack} style={styles.backButton} hitSlop={12}>
        <Ionicons name="chevron-back" size={22} color={Colors.coral} />
      </TouchableOpacity>
      <Text style={styles.title} numberOfLines={1}>{title}</Text>
      <View style={styles.rightSlot}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    minWidth: 44,
    paddingVertical: Spacing.xs,
    alignItems: 'flex-start',
  },
  title: {
    ...Typography.screenTitle,
    flex: 1,
    textAlign: 'center',
  },
  rightSlot: {
    minWidth: 44,
    alignItems: 'flex-end',
  },
});
