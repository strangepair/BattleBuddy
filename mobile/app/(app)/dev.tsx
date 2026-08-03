import { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Swipeable from 'react-native-gesture-handler/Swipeable';
import { router, useFocusEffect } from 'expo-router';
import { useAuthStore } from '../../src/stores/authStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import {
  listRequests,
  submitDirective,
  archiveRequest,
  resubmitRequest,
  fetchWorkItems,
  fetchReleases,
  fetchDigest,
  type DevRequest,
  type DevRequestStatus,
  type WorkItem,
  type Release,
} from '../../src/services/devService';
import { Colors, Spacing, Radii } from '../../src/theme';
import { PRDetailView } from '../../src/components/dev/PRDetailView';
import { AiDigest } from '../../src/components/pipeline/AiDigest';
import { WorkItemCard } from '../../src/components/pipeline/WorkItemCard';
import { ReleaseGroup } from '../../src/components/pipeline/ReleaseGroup';
import { ExceptionCard } from '../../src/components/pipeline/ExceptionCard';

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
  duplicate: { label: 'Already tracked', color: Colors.textTertiary, bucket: 'done' },
};

const TARGET_LABEL: Record<string, string> = {
  backend: 'Backend',
  agent: 'Agent',
  ui: 'UI',
  prompt: 'Prompt',
};

const RESUBMITTABLE_STATUSES: DevRequestStatus[] = ['failed', 'needs_attention'];

interface ExceptionItem {
  id: string;
  title: string;
  body: string;
  defaultAction: string;
  deadlineIso: string;
}

function parseException(wi: WorkItem): ExceptionItem | null {
  if (!wi.exception) return null;
  let parsed: Record<string, string> = {};
  try {
    parsed = typeof wi.exception === 'string' ? JSON.parse(wi.exception) : wi.exception;
  } catch {
    return {
      id: wi.id,
      title: wi.title,
      body: typeof wi.exception === 'string' ? wi.exception : '',
      defaultAction: 'Proceed with best available information',
      deadlineIso: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    };
  }
  return {
    id: wi.id,
    title: parsed.title ?? wi.title,
    body: parsed.body ?? '',
    defaultAction: parsed.defaultAction ?? 'Proceed with best available information',
    deadlineIso: parsed.deadlineIso ?? new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  };
}

export default function DevScreen() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const developerMode = useSettingsStore((s) => s.developerMode);

  const [requests, setRequests] = useState<DevRequest[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [digest, setDigest] = useState<string>('');

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<DevRequest | null>(null);
  const [directive, setDirective] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [resubmitting, setResubmitting] = useState<string | null>(null);
  const swipeableRefs = useRef<Record<string, Swipeable | null>>({});

  const load = useCallback(async () => {
    const [list, wis, rels, dg] = await Promise.all([
      listRequests(userId),
      fetchWorkItems(),
      fetchReleases(),
      fetchDigest(),
    ]);
    setRequests(list);
    setWorkItems(wis);
    setReleases(rels);
    setDigest(dg);
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
      const result = await submitDirective({ userId, text });
      setDirective('');
      await load();
      if (result.duplicate && result.attachedTo) {
        Alert.alert(
          'Already tracked',
          `That looks like the same issue as "${result.attachedTo.title}". Attached as evidence — no new build was started.`,
        );
      }
    } catch (err) {
      Alert.alert('Could not submit', 'The build pipeline did not accept that directive. Try again.');
    } finally {
      setSubmitting(false);
    }
  }, [directive, submitting, userId, load]);

  const onResubmit = useCallback(async (id: string) => {
    if (resubmitting) return;
    setResubmitting(id);
    const result = await resubmitRequest(id);
    setResubmitting(null);
    if (!result.ok) {
      Alert.alert('Could not resubmit', result.error ?? 'The pipeline refused that request.');
      return;
    }
    const submittedAt = new Date().toISOString();
    setRequests((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...(result.item ?? r), status: result.item?.status ?? 'pending', updated_at: submittedAt }
          : r,
      ),
    );
    setWorkItems((prev) =>
      prev.map((wi) => {
        const linked = requests.find((r) => r.id === id);
        if (!linked) return wi;
        const isLinked = wi.title === linked.title || wi.subsystem === linked.target;
        if (!isLinked) return wi;
        return {
          ...wi,
          stage: result.plan === 'rerun_deploy' ? 'deploying' : 'building',
          latest_event: { kind: result.plan === 'rerun_deploy' ? 'deploy_started' : 'build_started', created_at: submittedAt },
          updated_at: submittedAt,
        };
      }),
    );
    await load();
    Alert.alert(
      'Resubmitted',
      result.plan === 'rerun_deploy'
        ? 'The code was already merged, so the deploy is being re-run.'
        : 'A fresh build has been dispatched from current main.',
    );
  }, [resubmitting, requests, load]);

  const onArchive = useCallback(async (id: string) => {
    swipeableRefs.current[id]?.close();
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, archived: true } : r));
    const ok = await archiveRequest(id);
    if (!ok) {
      setRequests((prev) => prev.map((r) => r.id === id ? { ...r, archived: false } : r));
      Alert.alert('Archive failed', 'Could not archive this request. Please try again.');
    }
  }, []);

  const exceptions: ExceptionItem[] = workItems
    .map(parseException)
    .filter((e): e is ExceptionItem => e !== null);

  const workItemsByReleaseId: Record<string, WorkItem[]> = {};
  const unreleasedItems: WorkItem[] = [];
  for (const wi of workItems) {
    const change = releases
      .flatMap((r) => r.changes.map((c) => ({ releaseId: r.id, workItemId: c.work_item_id })))
      .find((c) => c.workItemId === wi.id);
    if (change) {
      if (!workItemsByReleaseId[change.releaseId]) workItemsByReleaseId[change.releaseId] = [];
      workItemsByReleaseId[change.releaseId].push(wi);
    } else {
      unreleasedItems.push(wi);
    }
  }

  const changeRefForItem = (wi: WorkItem): string | undefined => {
    for (const rel of releases) {
      const ch = rel.changes.find((c) => c.work_item_id === wi.id);
      if (ch) {
        if (ch.pr_number) return `PR #${ch.pr_number}`;
        if (ch.branch) return ch.branch;
      }
    }
    return undefined;
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={12}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Build pipeline</Text>
        <View style={styles.archiveToggle}>
          <Text style={styles.archiveLabel}>DEV</Text>
          <Switch
            value={developerMode}
            onValueChange={(v) => useSettingsStore.getState().setDeveloperMode(v)}
            trackColor={{ false: Colors.surfaceBorder, true: Colors.coral }}
            thumbColor="#fff"
          />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.coral} />}
      >
        <AiDigest digest={digest} />

        {exceptions.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>NEEDS ATTENTION</Text>
            {exceptions.map((ex) => (
              <ExceptionCard
                key={ex.id}
                title={ex.title}
                body={ex.body}
                defaultAction={ex.defaultAction}
                deadlineIso={ex.deadlineIso}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>WORK ITEMS</Text>
          {loading ? (
            <Text style={styles.empty}>Loading…</Text>
          ) : workItems.length === 0 ? (
            <Text style={styles.empty}>No work items yet — submissions will appear here.</Text>
          ) : (
            <>
              {releases.map((rel) => {
                const relItems = workItemsByReleaseId[rel.id];
                if (!relItems || relItems.length === 0) return null;
                return (
                  <ReleaseGroup
                    key={rel.id}
                    releaseLabel={rel.version}
                    releasedAt={rel.created_at}
                  >
                    {relItems.map((wi) => (
                      <WorkItemCard
                        key={wi.id}
                        title={wi.title}
                        status={wi.stage}
                        evidenceCount={wi.submission_count}
                        changeRef={changeRefForItem(wi)}
                      />
                    ))}
                  </ReleaseGroup>
                );
              })}
              {unreleasedItems.length > 0 ? (
                <View style={styles.unreleasedGroup}>
                  <Text style={styles.unreleasedLabel}>UNRELEASED</Text>
                  {unreleasedItems.map((wi) => (
                    <WorkItemCard
                      key={wi.id}
                      title={wi.title}
                      status={wi.stage}
                      evidenceCount={wi.submission_count}
                      changeRef={changeRefForItem(wi)}
                    />
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>

        {!loading && releases.length === 0 ? (
          <Text style={styles.empty}>No releases yet.</Text>
        ) : null}

        {developerMode ? (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>PLUMBING — PIPELINE REQUESTS</Text>
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

            <View style={styles.archiveRowToggle}>
              <Text style={styles.archiveLabel}>Archived</Text>
              <Switch
                value={showArchived}
                onValueChange={setShowArchived}
                trackColor={{ false: Colors.surfaceBorder, true: Colors.coral }}
                thumbColor="#fff"
              />
            </View>

            {loading ? (
              <ActivityIndicator color={Colors.coral} style={{ marginTop: Spacing.xl }} />
            ) : requests.filter((r) => showArchived ? r.archived : !r.archived).length === 0 ? (
              <Text style={styles.empty}>
                No build requests yet. Turn on Developer mode, have a conversation about a change,
                or send a directive above.
              </Text>
            ) : (
              [...requests]
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .filter((r) => showArchived ? r.archived : !r.archived)
                .map((r) => {
                const meta = STATUS_META[r.status] ?? STATUS_META.pending;
                const renderRightActions = () => (
                  <TouchableOpacity
                    style={styles.archiveAction}
                    onPress={() => onArchive(r.id)}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.archiveActionText}>Archive</Text>
                  </TouchableOpacity>
                );
                return (
                  <Swipeable
                    key={r.id}
                    ref={(ref) => { swipeableRefs.current[r.id] = ref; }}
                    renderRightActions={renderRightActions}
                    overshootRight={false}
                    friction={2}
                  >
                    <TouchableOpacity style={styles.card} onPress={() => setSelectedRequest(r)} activeOpacity={0.75}>
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
                      {r.next_retry_at ? (
                        <Text style={styles.retryText}>
                          Retrying automatically{r.attempts ? ` (attempt ${r.attempts + 1})` : ''}…
                        </Text>
                      ) : null}
                      {r.pr_url ? (
                        <Text style={styles.prLink}>
                          View PR{r.pr_number ? ` #${r.pr_number}` : ''} ›
                        </Text>
                      ) : null}
                      {RESUBMITTABLE_STATUSES.includes(r.status) && !r.next_retry_at ? (
                        <TouchableOpacity
                          style={styles.resubmitBtn}
                          onPress={() => onResubmit(r.id)}
                          disabled={resubmitting === r.id}
                          hitSlop={8}
                        >
                          {resubmitting === r.id ? (
                            <ActivityIndicator color={Colors.coral} size="small" />
                          ) : (
                            <Text style={styles.resubmitText}>
                              Resubmit{r.attempts ? ` · ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}` : ''}
                            </Text>
                          )}
                        </TouchableOpacity>
                      ) : null}
                    </TouchableOpacity>
                  </Swipeable>
                );
              })
            )}
          </View>
        ) : null}
      </ScrollView>
      <PRDetailView request={selectedRequest} onDismiss={() => setSelectedRequest(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.surfaceBorder,
  },
  backButton: { paddingVertical: Spacing.xs, paddingRight: Spacing.sm, minWidth: 60 },
  backText: { color: Colors.coral, fontSize: 16, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  archiveToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  archiveLabel: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500' },
  scroll: { paddingHorizontal: Spacing.md, paddingTop: Spacing.lg, paddingBottom: Spacing.xxl },
  section: { marginBottom: Spacing.lg },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.textTertiary,
    letterSpacing: 1,
    marginBottom: Spacing.sm,
  },
  blurb: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18, marginBottom: Spacing.md },
  composer: { marginBottom: Spacing.md },
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
  archiveRowToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.sm },
  empty: { fontSize: 14, color: Colors.textTertiary, lineHeight: 20, marginTop: Spacing.sm },
  unreleasedGroup: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    overflow: 'hidden',
    marginBottom: Spacing.sm,
    padding: Spacing.sm,
  },
  unreleasedLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.textTertiary,
    letterSpacing: 1,
    marginBottom: Spacing.xs,
  },
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
  retryText: { fontSize: 12, color: Colors.textTertiary, marginTop: 4 },
  resubmitBtn: {
    marginTop: Spacing.sm,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: Radii.sm,
    borderWidth: 1,
    borderColor: Colors.coral,
  },
  resubmitText: { fontSize: 13, fontWeight: '600', color: Colors.coral },
  prLink: { fontSize: 13, fontWeight: '600', color: Colors.coral },
  archiveAction: {
    backgroundColor: Colors.error,
    justifyContent: 'center',
    alignItems: 'center',
    width: 88,
    marginBottom: Spacing.sm,
    borderRadius: Radii.md,
  },
  archiveActionText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
