import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Linking,
} from 'react-native';
import { Colors, Spacing, Radii } from '../../theme';
import type { DevRequest } from '../../services/devService';

interface Props {
  request: DevRequest | null;
  onDismiss: () => void;
}

const TARGET_LABEL: Record<string, string> = {
  backend: 'Backend',
  agent: 'Agent',
  ui: 'UI',
  prompt: 'Prompt',
};

export function PRDetailView({ request, onDismiss }: Props) {
  if (!request) return null;

  return (
    <Modal
      visible={!!request}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onDismiss}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle} numberOfLines={1}>Change Detail</Text>
          <TouchableOpacity onPress={onDismiss} hitSlop={12} style={styles.closeBtn}>
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.titleRow}>
            <View style={styles.targetPill}>
              <Text style={styles.targetText}>{TARGET_LABEL[request.target] ?? request.target}</Text>
            </View>
            <Text style={styles.sourceText}>
              {request.source === 'directive' ? 'from directive' : 'from conversation'}
            </Text>
          </View>

          <Text style={styles.title}>{request.title}</Text>

          {request.description ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>DESCRIPTION</Text>
              <Text style={styles.body}>{request.description}</Text>
            </View>
          ) : null}

          {request.pr_url ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>PULL REQUEST</Text>
              <TouchableOpacity onPress={() => Linking.openURL(request.pr_url!)} activeOpacity={0.7}>
                <Text style={styles.prLink}>
                  View PR{request.pr_number ? ` #${request.pr_number}` : ''} ›
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {request.error ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>ERROR</Text>
              <Text style={styles.errorText}>{request.error}</Text>
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>CREATED</Text>
            <Text style={styles.metaText}>
              {new Date(request.created_at).toLocaleString()}
            </Text>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  headerTitle: { fontSize: 17, fontWeight: '600', color: Colors.textPrimary, flex: 1 },
  closeBtn: { paddingLeft: Spacing.md },
  closeText: { fontSize: 16, fontWeight: '600', color: Colors.coral },
  scroll: { padding: Spacing.md, gap: Spacing.lg },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  targetPill: {
    backgroundColor: Colors.surface,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  targetText: { fontSize: 11, fontWeight: '600', color: Colors.textSecondary },
  sourceText: { fontSize: 12, color: Colors.textTertiary },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary, lineHeight: 24 },
  section: { gap: Spacing.xs },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textTertiary,
    letterSpacing: 0.8,
  },
  body: { fontSize: 15, color: Colors.textSecondary, lineHeight: 22 },
  prLink: { fontSize: 15, fontWeight: '600', color: Colors.coral },
  errorText: { fontSize: 14, color: Colors.error, lineHeight: 20 },
  metaText: { fontSize: 14, color: Colors.textSecondary },
});
