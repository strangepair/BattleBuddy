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
  fetchWorkItems,
  fetchReleases,
  fetchDigest,
  type DevRequest,
  type DevRequestStatus,
  type WorkItem,
  type Release,
  type ExceptionItem,
} from '../../src/services/devService';
import { Colors, Spacing, Radii } from '../../src/theme';
import { PRDetailView } from '../../src/components/dev/PRDetailView';
import { AiDigest } from '../../src/components/pipeline/AiDigest';
import { WorkItemCard } from '../../src/components/pipeline/WorkItemCard';
import { ReleaseGroup } from '../../src/components/pipeline/ReleaseGroup';
import { ExceptionCard } from '../../src/components/pipeline/ExceptionCard';

// Map internal statuses → the buckets/labels the user asked for.
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
  // Not a failure: triage recognised it as already-tracked work, so no build
  // ran. Neutral colour and the 'done' bucket keep it out of the red pile.
  duplicate: { label: 'Already tracked', color: Colors.textTertiary, bucket: 'done' },
};

const TARGET_LABEL: Record<string, string> = {
  backend: 'Backend',
  agent: 'Agent',
  ui: 'UI',
  prompt: 'Prompt',
};

function deriveExceptions(workItems: WorkItem[]): ExceptionItem[] {
  return workItems
    .filter((i) => i.exception)
    .map((i) => {
      let parsed: { body?: string; defaultAction?: string; deadlineIso?: string } = {};
      try {
        parsed = typeof i.exception === 'string' ? JSON.parse(i.exception) : ((i.exception as unknown) as typeof parsed);
      } catch {
        parsed = {};
      }
      const now = new Date();
      const fallbackDeadline = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
      return {
        id: i.id,
        title: i.title,
        body: parsed.body ?? 'This work item requires your input before proceeding.',
        defaultAction: parsed.defaultAction ?? 'Pipeline will proceed with best-guess interpretation.',
        deadlineIso: parsed.deadlineIso ?? fallbackDeadline,
      };
    });
}

function deriveChangeRef(workItemId: string | null | undefined, releases: Release[]): string | undefined {
  if (!workItemId) return undefined;
  for (const rel of releases) {
    for (const chg of rel.changes) {
      if (chg.work_item_id === workItemId) {
        if (chg.pr_number) return `PR #${chg.pr_number}`;
        if (chg.branch) return chg.branch;
        if (chg.flag_key) return chg.flag_key;
      }
    }
  }
  return undefined;
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
  const swipeableRefs = useRef<Record<string, Swipeable | null>>({});

  const load = useCallback(async () => {
    const [list, items, rels, dig] = await Promise.all([
      listRequests(userId),
      fetchWorkItems(),
      fetchReleases(),
      fetchDigest(),
    ]);
    setRequests(list);
    setWorkItems(items);
    setReleases(rels);
    setDigest(dig);
    setLoading(false);
  }, [userId]);

  // Refresh whenever the screen gains focus (and once on mount).
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

  const onArchive = useCallback(async (id: string) => {
    swipeableRefs.current[id]?.close();
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, archived: true } : r));
    const ok = await archiveRequest(id);
    if (!ok) {
      setRequests((prev) => prev.map((r) => r.id === id ? { ...r, archived: false } : r));
      Alert.alert('Archive failed', 'Could not archive this request. Please try again.');
    }
  }, []);

  const exceptions = deriveExceptions(workItems);

  // Group work items under their release. Items with no matching release go
  // into an "Unassigned" group rendered last.
  const releaseWorkItemMap: Map<string, WorkItem[]> = new Map();
  const unassignedItems: WorkItem[] = [];

  for (const item of workItems) {
    let assigned = false;
    for (const rel of releases) {
      if (rel.changes.some((c) => c.work_item_id === item.id)) {
        if (!releaseWorkItemMap.has(rel.id)) releaseWorkItemMap.set(rel.id, []);
        releaseWorkItemMap.get(rel.id)!.push(item);
        assigned = true;
        break;
      }
    }
    if (!assigned) unassignedItems.push(item);
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={12}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Build pipeline</Text>
        <View style={styles.archiveToggle}>
          <Text style={styles.archiveLabel}>Archived</Text>
          <Switch
            value={showArchived}
            onValueChange={setShowArchived}
            trackColor={{ false: Colors.surfaceBorder, true: Colors.coral }}
            thumbColor="#fff"
          />
        </View>
      </View>

      <ScrollView
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

        {loading ? (
          <Text style={styles.empty}>Loading pipeline data…</Text>
        ) : (
          <>
            <AiDigest digest={digest} />

            {exceptions.length > 0 ? (
              <View style={styles.exceptionsSection}>
                <Text style={styles.sectionHeader}>NEEDS YOUR INPUT</Text>
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

            <Text style={styles.sectionHeader}>WORK ITEMS</Text>

            {workItems.length === 0 ? (
              <Text style={styles.empty}>
                No work items yet — submissions will appear here.
              </Text>
            ) : (
              <>
                {releases.length === 0 ? (
                  <Text style={styles.empty}>No releases yet.</Text>
                ) : null}

                {releases.map((rel) => {
                  const items = releaseWorkItemMap.get(rel.id) ?? [];
                  if (items.length === 0) return null;
                  return (
                    <ReleaseGroup
                      key={rel.id}
                      releaseLabel={`v${rel.version}`}
                      releasedAt={rel.created_at}
                    >
                      {items.map((item) => (
                        <WorkItemCard
                          key={item.id}
                          title={item.title}
                          status={item.stage}
                          evidenceCount={item.submission_count}
                          changeRef={deriveChangeRef(item.id, releases)}
                        />
                      ))}
                    </ReleaseGroup>
                  );
                })}

                {unassignedItems.length > 0 ? (
                  <ReleaseGroup
                    releaseLabel="Unassigned"
                    releasedAt={unassignedItems[0].created_at}
                  >
                    {unassignedItems.map((item) => (
                      <WorkItemCard
                        key={item.id}
                        title={item.title}
                        status={item.stage}
                        evidenceCount={item.submission_count}
                        changeRef={deriveChangeRef(item.id, releases)}
                      />
                    ))}
                  </ReleaseGroup>
                ) : null}
              </>
            )}

            {developerMode ? (
              <View style={styles.plumbingSection}>
                <Text style={styles.sectionHeader}>CHANGES (PLUMBING)</Text>

                {requests.filter((r) => showArchived ? r.archived : !r.archived).length === 0 ? (
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
                          {r.pr_url ? (
                            <Text style={styles.prLink}>
                              View PR{r.pr_number ? ` #${r.pr_number}` : ''} ›
                            </Text>
                          ) : null}
                        </TouchableOpacity>
                      </Swipeable>
                    );
                  })
                )}
              </View>
            ) : null}
          </>
        )}
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
  exceptionsSection: { marginBottom: Spacing.md },
  plumbingSection: { marginTop: Spacing.lg },
  empty: { fontSize: 14, color: Colors.textTertiary, lineHeight: 20, marginTop: Spacing.sm, marginBottom: Spacing.md },
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
