import { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Linking,
  Alert,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuthStore } from '../../stores/authStore';
import {
  listRequests,
  submitDirective,
  type DevRequest,
  type DevRequestStatus,
} from '../../services/devService';
import { Colors, Spacing, Radii } from '../../theme';

const STATUS_META: Record<
  DevRequestStatus,
  { label: string; color: string; bucket: 'active' | 'done' | 'queued' | 'attention' }
> = {
  pending: { label: 'Pending development', color: Colors.textTertiary, bucket: 'queued' },
  building: { label: 'Under development', color: Colors.coral, bucket: 'active' },
  in_review: { label: 'Under development', color: Colors.coral, bucket: 'active' },
  merging: { label: 'Under development', color: Colors.coral, bucket: 'active' },
  deploying: { label: 'Deploying', color: Colors.coral, bucket: 'active' },
  deployed: { label: 'Deployed', color: Colors.success, bucket: 'done' },
  failed: { label: 'Failed', color: Colors.error, bucket: 'attention' },
  needs_attention: { label: 'Needs attention', color: Colors.error, bucket: 'attention' },
};

const TARGET_LABEL: Record<string, string> = {
  backend: 'Backend',
  agent: 'Agent',
  ui: 'UI',
  prompt: 'Prompt',
};

export default function DevPane() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [requests, setRequests] = useState<DevRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [directive, setDirective] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const list = await listRequests(userId);
    setRequests(list);
    setLoading(false);
  }, [userId]);

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

  const onSubmit = useCallback(async () => {
    const text = directive.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      await submitDirective({ userId, text });
      setDirective('');
      await load();
    } catch {
      Alert.alert('Could not submit', 'The build pipeline did not accept that directive. Try again.');
    } finally {
      setSubmitting(false);
    }
  }, [directive, submitting, userId, load]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.coral} />}
    >
      <Text style={styles.blurb}>
        Developer mode is recording your conversations and turning them into changes
        that build and deploy automatically. Type a directive below to request one directly.
      </Text>

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder="e.g. Make the greeting warmer and shorter"
          placeholderTextColor={Colors.textTertiary}
          value={directive}
          onChangeText={setDirective}
          multiline
          editable={!submitting}
        />
        <TouchableOpacity
          style={[styles.submitBtn, (!directive.trim() || submitting) && styles.submitBtnDisabled]}
          onPress={onSubmit}
          disabled={!directive.trim() || submitting}
          activeOpacity={0.8}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.submitText}>Send to pipeline</Text>
          )}
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionHeader}>CHANGES</Text>

      {loading ? (
        <ActivityIndicator color={Colors.coral} style={{ marginTop: Spacing.xl }} />
      ) : requests.length === 0 ? (
        <Text style={styles.empty}>
          No build requests yet. Turn on Developer mode, have a conversation about a change,
          or send a directive above.
        </Text>
      ) : (
        requests.map((r) => {
          const meta = STATUS_META[r.status] ?? STATUS_META.pending;
          return (
            <View key={r.id} style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.cardTitle} numberOfLines={2}>{r.title}</Text>
                <View style={[styles.badge, { borderColor: meta.color }]}>
                  <Text style={[styles.badgeText, { color: meta.color }]}>{meta.label}</Text>
                </View>
              </View>
              <View style={styles.cardMeta}>
                <View style={styles.targetPill}>
                  <Text style={styles.targetText}>{TARGET_LABEL[r.target] ?? r.target}</Text>
                </View>
                <Text style={styles.sourceText}>
                  {r.source === 'directive' ? 'from directive' : 'from conversation'}
                </Text>
              </View>
              {r.error ? <Text style={styles.errorText}>{r.error}</Text> : null}
              {r.pr_url ? (
                <TouchableOpacity onPress={() => Linking.openURL(r.pr_url!)} activeOpacity={0.7}>
                  <Text style={styles.prLink}>
                    View PR{r.pr_number ? ` #${r.pr_number}` : ''} ›
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingHorizontal: Spacing.md, paddingTop: Spacing.lg, paddingBottom: Spacing.xxl },
  blurb: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18, marginBottom: Spacing.md },
  composer: { marginBottom: Spacing.xl },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.md,
    color: Colors.textPrimary,
    fontSize: 15,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  submitBtn: {
    backgroundColor: Colors.coral,
    borderRadius: Radii.md,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textTertiary,
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  empty: { fontSize: 14, color: Colors.textTertiary, lineHeight: 20, marginTop: Spacing.sm },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    gap: Spacing.sm,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: Colors.textPrimary, lineHeight: 20 },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  targetPill: {
    backgroundColor: Colors.background,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  targetText: { fontSize: 11, fontWeight: '600', color: Colors.textSecondary },
  sourceText: { fontSize: 12, color: Colors.textTertiary },
  errorText: { fontSize: 12, color: Colors.error, lineHeight: 16 },
  prLink: { fontSize: 13, fontWeight: '600', color: Colors.coral },
});
