import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  AppState,
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
import {
  ACTIVE_STATUSES,
  buildPipelineView,
  relativeTime,
  summaryLine,
  type PipelineCard,
} from '../../src/services/pipelineView';
import { Colors, Spacing, Radii } from '../../src/theme';
import { PRDetailView } from '../../src/components/dev/PRDetailView';
import { AiDigest } from '../../src/components/pipeline/AiDigest';
import { WorkItemCard } from '../../src/components/pipeline/WorkItemCard';
import { ReleaseGroup } from '../../src/components/pipeline/ReleaseGroup';
import { ExceptionCard } from '../../src/components/pipeline/ExceptionCard';

// How often the pipeline screen re-reads server state while it is on screen.
// Fast enough that a status change feels immediate, slow enough that a screen
// left open is not a load problem: the reconciler itself only ticks every 60 s.
const PIPELINE_POLL_MS = 10000;

// Work-item stages that are over. An exception raised against a shipped or
// abandoned item is history, and history does not get to sit in the one section
// that means "you have to look at this".
const CLOSED_STAGES = ['live', 'archived', 'released', 'done'];

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
  // Closed unmerged or cancelled. Without this entry the lookup fell through to
  // `pending`, so every dead row on the screen claimed to be queued work.
  superseded: { label: 'Superseded', color: Colors.textTertiary, bucket: 'done' },
};

const TARGET_LABEL: Record<string, string> = {
  backend: 'Backend',
  agent: 'Agent',
  ui: 'UI',
  prompt: 'Prompt',
};

const SOURCE_LABEL: Record<string, string> = {
  directive: 'from directive',
  transcript: 'from conversation',
  github: 'raised on GitHub',
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
  const [showRecent, setShowRecent] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [resubmitting, setResubmitting] = useState<string | null>(null);
  const swipeableRefs = useRef<Record<string, Swipeable | null>>({});
  const isSwipingMap = useRef<Record<string, boolean>>({});

  const load = useCallback(async () => {
    // Two request feeds on purpose. The window is the newest 100 rows, which is
    // what history is drawn from; the second asks the server for EVERY in-flight
    // row whatever its age, so a change stuck since last week cannot fall off
    // the back of the window and leave the screen claiming the pipeline is clear.
    const [list, active, wis, rels, dg] = await Promise.all([
      listRequests(userId),
      listRequests(userId, { statuses: ACTIVE_STATUSES, limit: 100 }),
      fetchWorkItems(),
      fetchReleases(),
      fetchDigest(),
    ]);
    setRequests([...list, ...active]);
    setWorkItems(wis);
    setReleases(rels);
    setDigest(dg);
    setLoading(false);
  }, [userId]);

  // The pipeline moves on its own — a build lands, the reconciler flips a status
  // from GitHub truth, a PR raised straight on GitHub gets adopted — so a screen
  // that only loads on focus is stale the moment it finishes rendering. Poll
  // while focused, stop on blur so a backgrounded screen costs nothing.
  //
  // Polling rather than the SSE broadcast is deliberate as the PRIMARY path: the
  // server also pushes these transitions, but a push channel that quietly stops
  // working looks exactly like a pipeline with nothing to report. The poll is
  // the one that cannot fail silently.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const tick = () => { if (!cancelled) load(); };
      tick();
      const timer = setInterval(tick, PIPELINE_POLL_MS);
      return () => { cancelled = true; clearInterval(timer); };
    }, [load]),
  );

  // Coming back from the background is the case the interval cannot cover: iOS
  // suspends timers, so a screen left open overnight would otherwise show
  // yesterday's pipeline until the next tick fires.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') load();
    });
    return () => sub.remove();
  }, [load]);

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
    await load();
    Alert.alert(
      'Resubmitted',
      result.plan === 'rerun_deploy'
        ? 'The code was already merged, so the deploy is being re-run.'
        : 'A fresh build has been dispatched from current main.',
    );
  }, [resubmitting, load]);

  const onArchive = useCallback(async (id: string) => {
    swipeableRefs.current[id]?.close();
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, archived: true } : r));
    const ok = await archiveRequest(id);
    if (!ok) {
      isSwipingMap.current[id] = false;
      setRequests((prev) => prev.map((r) => r.id === id ? { ...r, archived: false } : r));
      Alert.alert('Archive failed', 'Could not archive this request. Please try again.');
    } else {
      isSwipingMap.current[id] = false;
    }
  }, []);

  // ── What the screen shows ──────────────────────────────────────────────────

  const view = useMemo(() => buildPipelineView(requests), [requests]);

  const archivedRequests = useMemo(() => {
    const byId = new Map<string, DevRequest>();
    for (const r of requests) if (r.archived) byId.set(r.id, r);
    return [...byId.values()].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [requests]);

  const exceptions: ExceptionItem[] = workItems
    .filter((wi) => !CLOSED_STAGES.includes(String(wi.stage)))
    .map(parseException)
    .filter((e): e is ExceptionItem => e !== null);

  // History, grouped by the release that shipped it. Only rendered once the
  // operator asks for it.
  const releaseById = useMemo(
    () => new Map<string, Release>(releases.map((r) => [r.id, r] as [string, Release])),
    [releases],
  );
  const recentByRelease = useMemo(() => {
    const grouped = new Map<string, PipelineCard[]>();
    const loose: PipelineCard[] = [];
    for (const card of view.recent) {
      const relId = card.request.release_id;
      if (relId && releaseById.has(relId)) {
        const g = grouped.get(relId);
        if (g) g.push(card); else grouped.set(relId, [card]);
      } else {
        loose.push(card);
      }
    }
    return { grouped, loose };
  }, [view.recent, releaseById]);

  const renderRequestCard = (card: PipelineCard) => {
    const r = card.request;
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
        key={card.key}
        ref={(ref) => { swipeableRefs.current[r.id] = ref; }}
        renderRightActions={renderRightActions}
        overshootRight={false}
        friction={2}
        onSwipeableWillOpen={() => { isSwipingMap.current[r.id] = true; }}
        onSwipeableClose={() => { isSwipingMap.current[r.id] = false; }}
      >
        <TouchableOpacity
          style={styles.card}
          onPress={() => { if (!isSwipingMap.current[r.id]) setSelectedRequest(r); }}
          activeOpacity={0.75}
        >
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
              {SOURCE_LABEL[r.source] ?? 'from conversation'}
              {r.updated_at ? ` · ${relativeTime(r.updated_at)}` : ''}
            </Text>
          </View>
          {card.collapsed.length > 0 ? (
            <Text style={styles.collapsedText}>
              +{card.collapsed.length} earlier attempt{card.collapsed.length === 1 ? '' : 's'} for this change
            </Text>
          ) : null}
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
  };

  const renderRecentCard = (card: PipelineCard) => (
    <WorkItemCard
      key={card.key}
      title={card.request.title}
      status={(STATUS_META[card.request.status] ?? STATUS_META.pending).label}
      evidenceCount={card.collapsed.length + 1}
      changeRef={card.request.pr_number ? `PR #${card.request.pr_number}` : undefined}
    />
  );

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
        {/* The verdict, before any card. Whether the pipeline is clear is the
            question this screen exists to answer, and it should never have to be
            inferred from how many cards happen to be on screen. */}
        <View style={[styles.banner, view.isClear ? styles.bannerClear : styles.bannerBusy]}>
          <View style={styles.bannerRow}>
            <View style={[styles.dot, { backgroundColor: view.isClear ? Colors.success : Colors.coral }]} />
            <Text style={styles.bannerText}>
              {loading && requests.length === 0 ? 'Checking the pipeline…' : summaryLine(view)}
            </Text>
          </View>
          {view.isClear && view.lastShipped ? (
            <Text style={styles.bannerSub} numberOfLines={3}>
              Last shipped: {view.lastShipped.request.title}
              {view.lastShipped.request.pr_number ? ` · PR #${view.lastShipped.request.pr_number}` : ''}
              {' · '}{relativeTime(view.lastShipped.request.updated_at ?? view.lastShipped.request.created_at)}
            </Text>
          ) : null}
        </View>

        <AiDigest digest={digest} />

        {exceptions.length > 0 ? (
          <View style={styles.section}>
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

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>IN FLIGHT</Text>
          {loading && requests.length === 0 ? (
            <ActivityIndicator color={Colors.coral} style={{ marginTop: Spacing.md }} />
          ) : view.isClear ? (
            <View style={styles.clearCard}>
              <Text style={styles.clearTitle}>Pipeline clear — nothing in flight</Text>
              <Text style={styles.clearBody}>
                Nothing is building, reviewing or deploying right now. New work appears here
                within a minute — whether you send it from the app or raise the PR yourself
                on GitHub.
              </Text>
            </View>
          ) : (
            view.active.map(renderRequestCard)
          )}
        </View>

        {/* History, collapsed. It is evidence, not work, and it was the wall of
            cards that made a clear pipeline unreadable. */}
        {view.recent.length > 0 ? (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.disclosure}
              onPress={() => setShowRecent((v) => !v)}
              activeOpacity={0.7}
              hitSlop={8}
            >
              <Text style={styles.sectionHeader}>
                RECENT RELEASES · {view.recent.length}
              </Text>
              <Text style={styles.disclosureChevron}>{showRecent ? '▾' : '▸'}</Text>
            </TouchableOpacity>
            {showRecent ? (
              <>
                {[...recentByRelease.grouped.entries()].map(([relId, cards]) => {
                  const rel = releaseById.get(relId);
                  if (!rel) return null;
                  return (
                    <ReleaseGroup key={relId} releaseLabel={rel.version} releasedAt={rel.created_at}>
                      {cards.map(renderRecentCard)}
                    </ReleaseGroup>
                  );
                })}
                {recentByRelease.loose.length > 0 ? (
                  <View style={styles.unreleasedGroup}>
                    <Text style={styles.unreleasedLabel}>EARLIER CHANGES</Text>
                    {recentByRelease.loose.map(renderRecentCard)}
                  </View>
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}

        {developerMode ? (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>PLUMBING — SEND A DIRECTIVE</Text>
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

            {showArchived ? (
              archivedRequests.length === 0 ? (
                <Text style={styles.empty}>Nothing archived.</Text>
              ) : (
                archivedRequests.map((r) =>
                  renderRequestCard({ key: r.id, request: r, lane: 'recent', collapsed: [] }),
                )
              )
            ) : null}
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
  archiveToggle: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm - 2 },
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
  banner: {
    borderRadius: Radii.md,
    borderWidth: 1,
    padding: Spacing.md,
    marginBottom: Spacing.lg,
    gap: Spacing.xs,
  },
  bannerClear: { borderColor: Colors.success, backgroundColor: Colors.surface },
  bannerBusy: { borderColor: Colors.coral, backgroundColor: Colors.surface },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  bannerText: { flex: 1, fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  bannerSub: { fontSize: 12, color: Colors.textSecondary, lineHeight: 17 },
  clearCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  clearTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  clearBody: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  disclosure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  disclosureChevron: { fontSize: 14, color: Colors.textTertiary, marginBottom: Spacing.sm },
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
    paddingVertical: Spacing.sm + 4,
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  archiveRowToggle: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm - 2, marginBottom: Spacing.sm },
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
    borderRadius: Radii.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs / 2,
    flexShrink: 1,
  },
  badgeText: { fontSize: 11, fontWeight: '700', flexShrink: 1 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flexWrap: 'wrap' },
  targetPill: {
    backgroundColor: Colors.background,
    borderRadius: Radii.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs / 2,
  },
  targetText: { fontSize: 11, fontWeight: '600', color: Colors.textSecondary },
  sourceText: { flex: 1, fontSize: 12, color: Colors.textTertiary },
  collapsedText: { fontSize: 12, color: Colors.textTertiary },
  errorText: { fontSize: 12, color: Colors.error, lineHeight: 16 },
  retryText: { fontSize: 12, color: Colors.textTertiary, marginTop: Spacing.xs },
  resubmitBtn: {
    marginTop: Spacing.sm,
    alignSelf: 'flex-start',
    paddingVertical: Spacing.sm - 2,
    paddingHorizontal: Spacing.sm + 4,
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
