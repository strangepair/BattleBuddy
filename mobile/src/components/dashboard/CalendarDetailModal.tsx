import { Modal, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors, Radii, Spacing, Typography } from '../../theme';

interface CalendarDetailModalProps {
  visible: boolean;
  onDismiss: () => void;
  title: string;
  description: string;
}

export default function CalendarDetailModal({ visible, onDismiss, title, description }: CalendarDetailModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onDismiss}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.description}>{description}</Text>
          <TouchableOpacity style={styles.closeBtn} onPress={onDismiss}>
            <Text style={styles.closeBtnText}>Dismiss</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.lg,
    width: '80%',
    maxWidth: 360,
    gap: Spacing.sm,
  },
  title: {
    ...Typography.screenTitle,
    marginBottom: Spacing.xs,
  },
  description: {
    ...Typography.body,
    color: Colors.textSecondary,
  },
  closeBtn: {
    marginTop: Spacing.sm,
    alignSelf: 'flex-end',
  },
  closeBtnText: {
    ...Typography.label,
    color: Colors.stateIdle,
  },
});
