import type { ComponentProps } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing } from '../../theme';

interface EmptyStateProps {
  icon: ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
}

// Shared empty-state block — replaces the emoji + bold title + tertiary
// subtitle pattern that was hand-rolled separately in history/insights/
// analytics/content-feed. One Ionicon, muted, instead of a platform emoji.
export default function EmptyState({ icon, title, body }: EmptyStateProps) {
  return (
    <View style={styles.center}>
      <Ionicons name={icon} size={40} color={Colors.textSecondary} style={styles.icon} />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.sm,
  },
  icon: { marginBottom: Spacing.sm },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  body: { fontSize: 14, color: Colors.textTertiary, textAlign: 'center', lineHeight: 20 },
});
