import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';

interface Props {
  releaseLabel: string;
  releasedAt: string;
  children: React.ReactNode;
}

export function ReleaseGroup({ releaseLabel, releasedAt, children }: Props) {
  const dateStr = formatDate(releasedAt);

  return (
    <View style={styles.group}>
      <View style={styles.header}>
        <Text style={styles.label}>{releaseLabel}</Text>
        <Text style={styles.date}>{dateStr}</Text>
      </View>
      <View style={styles.items}>{children}</View>
    </View>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

const styles = StyleSheet.create({
  group: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
    paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  date: {
    fontSize: 12,
    color: Colors.textTertiary,
  },
  items: {
    gap: 0,
  },
});
