import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import PagerView from 'react-native-pager-view';
import type { FeedCard } from '../../src/components/feed/FeedPager';
import EntityBackground from '../../src/components/home/EntityBackground';
import SessionHeader, { type SessionPhase } from '../../src/components/session/SessionHeader';
import SegBar, { type SessionView } from '../../src/components/session/SegBar';
import ConversationStream from '../../src/components/session/ConversationStream';
import HomeDashboard, {
  type QuickLogKind,
  type TalkAboutTopic,
} from '../../src/components/session/HomeDashboard';
import ContentPane from '../../src/components/session/ContentPane';
import VoiceSession from '../../src/components/session/VoiceSession';
import VoiceBand from '../../src/components/session/VoiceBand';
import { useSessionStore } from '../../src/stores/sessionStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import { useAuthStore } from '../../src/stores/authStore';
import { FeatureFlags } from '../../src/config';
import { useSessionChat } from '../../src/hooks/useSessionChat';
import { useEngagementEngine } from '../../src/services/engagementEngine';
import { fetchUserProfile } from '../../src/services/profileBuilder';
import { logEvent } from '../../src/services/eventService';
import { Colors } from '../../src/theme';

const QL_EVENT: Record<Exclude<QuickLogKind, 'urge'>, string> = {
  resisted: 'urge_resisted',
  cigarette: 'cigarette',
  decision: 'decision',
};

const QL_LABEL: Record<Exclude<QuickLogKind, 'urge'>, string> = {
  resisted: 'urge resisted',
  cigarette: 'cigarette',
  decision: 'decision · conscious choice',
};

// Same client-side triggers as the web head's live mode: an urge flips
// phase and leads with the Rule of Three (action before questions); a
// journey question puts the map in the stream where BB can talk to it.
const URGE_RE = /(urge|craving|about to (smoke|light)|need help|it'?s loud|want one)/i;
const NOT_RESISTING_RE = /not (trying|resisting)/i;
const JOURNEY_RE = /(how am i doing|journey|progress|show me|reflect)/i;

// Tab order for the horizontal swipe (Phase 1a): left/right moves one view.
// Deliberately static: builds 50–53 crashed while developer mode could add a
// fourth page to this pager at runtime. The dock's DEV toggle may only vary
// PROPS (icon glyph, style, placeholder) with developerMode — never this
// pager's children, the SegBar segments, or anything inside SessionHeader.
// CI's launch gate (src/__tests__/launch-gate.test.tsx) enforces this.
const VIEW_ORDER: SessionView[] = ['home', 'chat', 'content'];

// The One Conversation surface: one screen, one stream, three views over it.
// Home and Content are lenses; everything routes back into the conversation.
export default function SessionScreen() {
  // Launch lands on Mission (the dashboard); Comms is one tap away and the
  // greeting is already streaming in when the user gets there.
  const [view, setView] = useState<SessionView>('home');
  const [input, setInput] = useState('');
  const [paneHeight, setPaneHeight] = useState(0);
  const [hasGreeted, setHasGreeted] = useState(false);
  // Audio is opt-in per the product rule: it turns on ONLY when the user taps
  // the dock's speaker button — never automatically, never on navigation.
  const [audioOn, setAudioOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceOutputFailed, setVoiceOutputFailed] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isActive = useSessionStore((s) => s.isActive);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const mascotState = useSessionStore((s) => s.mascotState);
  const startSession = useSessionStore((s) => s.startSession);
  const setProfileSummary = useSessionStore((s) => s.setProfileSummary);
  const setRecentHistory = useSessionStore((s) => s.setRecentHistory);
  const addReceipt = useSessionStore((s) => s.addReceipt);
  const addCard = useSessionStore((s) => s.addCard);
  const addPhaseBanner = useSessionStore((s) => s.addPhaseBanner);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const onSelfEngaged = useEngagementEngine((s) => s.onUserSelfEngaged);
  const { sendMessage, greet, abort } = useSessionChat();

  // Observation is the resting state; an urge flips the surface into
  // resistance — chip, banner, and the entity's color all say "I'm right
  // here" until the wave is ridden out. The ref keeps the current phase
  // readable synchronously so the banner lands in the stream BEFORE the
  // turn that caused the flip (store writes inside a setState updater run
  // during render — React forbids it, and it reordered the stream).
  const [phase, setPhaseState] = useState<SessionPhase>('observation');
  const phaseRef = useRef<SessionPhase>('observation');
  // When resistance began — the HUD's wave timer counts from here.
  const [resistanceSince, setResistanceSince] = useState<number | null>(null);

  const setPhase = useCallback(
    (to: SessionPhase) => {
      if (phaseRef.current === to) return;
      phaseRef.current = to;
      addPhaseBanner(to);
      Haptics.impactAsync(
        to === 'resistance' ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
      ).catch(() => {});
      setResistanceSince(to === 'resistance' ? Date.now() : null);
      setPhaseState(to);
    },
    [addPhaseBanner],
  );

  useEffect(() => {
    onSelfEngaged();
  }, [onSelfEngaged]);

  useEffect(() => {
    return () => abort();
  }, [abort]);

  // Auto-greet on first mount, same contract as the old chat sheet.
  useEffect(() => {
    if (hasGreeted) return;
    if (!isActive) {
      startSession('text');
    }
    setHasGreeted(true);

    fetchUserProfile(null).then((profile) => {
      setProfileSummary(profile.summary);
      setRecentHistory(profile.recentHistory);
    });

    greet();
  }, [hasGreeted, isActive, startSession, setProfileSummary, setRecentHistory, greet]);

  const handleUserTurn = useCallback(
    (text: string) => {
      if (URGE_RE.test(text) && !NOT_RESISTING_RE.test(text)) {
        setPhase('resistance');
        addCard({ type: 'breathing' });
      } else if (JOURNEY_RE.test(text)) {
        addCard({ type: 'heatmap' });
        addCard({ type: 'records' });
      }
      sendMessage(text);
    },
    [sendMessage, setPhase, addCard],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    handleUserTurn(text);
  }, [input, isStreaming, handleUserTurn]);

  // The HUD's resistance command: straight into the Rule of Three, in Comms.
  const handleRuleOfThree = useCallback(() => {
    setView('chat');
    addCard({ type: 'breathing' });
  }, [addCard]);

  // The wave was ridden out: receipt with the intensity delta, tell BB
  // (hidden), and settle back into observation.
  const handleBreathingDone = useCallback(
    (from: number, to: number) => {
      addReceipt('resisted', `urge ridden out · ${from}→${to}`);
      if (userId) {
        logEvent(userId, 'urge_resisted', {
          source: 'one-conversation',
          exercise: 'rule_of_three',
          intensity_start: from,
          intensity_end: to,
        });
      }
      sendMessage(
        `[app event: I just rode out an urge with the Rule of Three — intensity ${from} down to ${to}. Acknowledge briefly, warmly; no homework.]`,
      );
      setPhase('observation');
    },
    [addReceipt, sendMessage, setPhase, userId],
  );

  // Dashboard CTAs re-enter the conversation carrying what the user was
  // looking at — the bracketed context rides to the model; the stream strips
  // it for display.
  const handleTalk = useCallback(
    (topic: TalkAboutTopic) => {
      setView('chat');
      // "Practice one now" runs a calm-water drill — reps make the rough
      // water easier. No resistance phase; there's no urge to fight.
      if (topic.userText === "Let's run one now.") {
        addCard({ type: 'breathing' });
      }
      sendMessage(
        `[Looking at the "${topic.title}" card on my dashboard: ${topic.detail}] ${topic.userText}`,
      );
    },
    [sendMessage, addCard],
  );

  const handleQuickLog = useCallback(
    (kind: QuickLogKind) => {
      setView('chat');
      if (kind === 'urge') {
        handleUserTurn("I'm having an urge");
        return;
      }
      addReceipt(kind, `${QL_LABEL[kind]} · quick log`);
      if (userId) {
        logEvent(userId, QL_EVENT[kind], { source: 'one-conversation', quick_log: true });
        // A conscious decision to smoke implies a cigarette — same convention
        // as the web head and the hub's radial menu.
        if (kind === 'decision') {
          logEvent(userId, 'cigarette', { source: 'one-conversation', quick_log: true });
        }
      }
      sendMessage(`[app event: I just quick-logged "${QL_LABEL[kind]}". Acknowledge briefly, per my phase.]`);
    },
    [sendMessage, handleUserTurn, addReceipt, userId],
  );

  const openChat = useCallback(() => setView('chat'), []);

  // A content card's "Talk" rides into Comms as a reply-quoted turn —
  // same wire format as the dashboard CTAs, so the quote renders for free.
  const handleContentTalk = useCallback(
    (card: FeedCard) => {
      const title = card.overlayText || 'this one';
      setView('chat');
      sendMessage(
        `[I'm looking at this in my content feed: "${title}"] Let's talk about this one.`,
      );
    },
    [sendMessage],
  );

  const hand = useSettingsStore((s) => s.hand);
  const switchMode = useSessionStore((s) => s.switchMode);

  // Developer mode: flips the CONVERSATION into a dev session (the devMode
  // flag rides on every chat turn — the agent switches persona server-side
  // and the transcript is captured into the build pipeline) and back to
  // companion mode when off. A plain, non-animated dock button on purpose:
  // it changes only its own icon/style/placeholder, never the screen's
  // structure — the two launch-crash triggers from builds 50–53 were a
  // control inside the animated header and a dev-dependent pager child.
  const developerMode = useSettingsStore((s) => s.developerMode);
  const setDeveloperMode = useSettingsStore((s) => s.setDeveloperMode);
  const toggleDevMode = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setDeveloperMode(!developerMode);
  }, [developerMode, setDeveloperMode]);

  // Phase 1a: horizontal swipe between views — a native PagerView, which is
  // built to page horizontally over vertically-scrolling children (a raw
  // Pan gesture loses the touch to the panes' own scroll recognizers).
  // `view` stays the single source of truth: taps call setView, and the
  // effect below steers the pager; swipes land in onPageSelected.
  const pagerRef = useRef<PagerView>(null);
  const handlePageSelected = useCallback((position: number) => {
    const next = VIEW_ORDER[position];
    if (!next) return;
    setView((current) => {
      if (current === next) return current;
      Haptics.selectionAsync().catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    pagerRef.current?.setPage(VIEW_ORDER.indexOf(view));
  }, [view]);

  // The speaker tap: voice joins the same stream in place. Turning it off
  // drops the room, resets mute, and the conversation just keeps going.
  const toggleAudio = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setAudioOn((on) => {
      const next = !on;
      if (!next) {
        setMuted(false);
        setAudioLevel(0);
      }
      switchMode(next ? 'voice' : 'text');
      return next;
    });
  }, [switchMode]);

  const handleVoiceError = useCallback((message: string) => {
    console.warn('[session] voice failed, falling back to text:', message);
    setAudioOn(false);
    setMuted(false);
    setAudioLevel(0);
    switchMode('text');
  }, [switchMode]);

  const handleVoiceFailed = useCallback(() => {
    const sessionId = useSessionStore.getState().sessionId;
    setVoiceOutputFailed(true);
    setAudioOn(false);
    setMuted(false);
    setAudioLevel(0);
    switchMode('text');
    if (userId) {
      logEvent(userId, 'voice_output_failure', {
        session_id: sessionId ?? undefined,
        timestamp: new Date().toISOString(),
      });
    }
  }, [switchMode, userId]);

  const toggleMute = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setMuted((m) => !m);
  }, []);

  const dockButtons = (
    <>
      <TouchableOpacity
        style={[styles.dockBtn, styles.sendBtn, (!input.trim() || isStreaming) && styles.dockBtnDisabled]}
        onPress={() => {
          handleSend();
          inputRef.current?.focus();
        }}
        disabled={!input.trim() || isStreaming}
        activeOpacity={0.7}
        accessibilityLabel="Send"
      >
        <Text style={styles.sendGlyph}>↑</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.dockBtn, audioOn && styles.audioOnBtn]}
        onPress={toggleAudio}
        activeOpacity={0.7}
        accessibilityLabel={audioOn ? 'Turn audio off' : 'Turn audio on'}
        accessibilityState={{ selected: audioOn }}
      >
        <Ionicons
          name={audioOn ? 'volume-high' : 'volume-mute-outline'}
          size={19}
          color={Colors.textPrimary}
        />
      </TouchableOpacity>
      {audioOn && (
        <TouchableOpacity
          style={[styles.dockBtn, muted && styles.mutedBtn]}
          onPress={toggleMute}
          activeOpacity={0.7}
          accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
          accessibilityState={{ selected: muted }}
        >
          <Ionicons name={muted ? 'mic-off' : 'mic-outline'} size={19} color={Colors.textPrimary} />
        </TouchableOpacity>
      )}
    </>
  );

  const devModeRow = FeatureFlags.developerModeAvailable ? (
    <View style={styles.devModeRow}>
      <Text style={styles.devModeLabel}>Dev Mode</Text>
      {/* developerModeAvailable is a build-time constant, so this render is
          runtime-invariant; toggling only swaps the icon glyph and style. */}
      <TouchableOpacity
        style={[styles.dockBtn, developerMode && styles.devOnBtn]}
        onPress={toggleDevMode}
        activeOpacity={0.7}
        accessibilityLabel={
          developerMode
            ? 'Developer mode on — switch back to companion mode'
            : 'Developer mode off — switch to developer mode'
        }
        accessibilityState={{ selected: developerMode }}
      >
        <Ionicons
          name={developerMode ? 'construct' : 'construct-outline'}
          size={19}
          color={Colors.textPrimary}
        />
      </TouchableOpacity>
    </View>
  ) : null;

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <EntityBackground
        targetColor={phase === 'resistance' ? Colors.coral : Colors.stateIdle}
        energy={phase === 'resistance' ? 0.35 : 0.08}
        center={{ x: width / 2, y: height * 0.3 }}
      />
      <View style={[styles.surface, { paddingTop: insets.top }]}>
        <SessionHeader mascotState={mascotState} phase={phase} />
        <SegBar view={view} onChange={setView} />

        <KeyboardAvoidingView
          style={styles.body}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          <PagerView
            ref={pagerRef}
            style={styles.pane}
            initialPage={VIEW_ORDER.indexOf(view)}
            onPageSelected={(e) => handlePageSelected(e.nativeEvent.position)}
            onLayout={(e) => setPaneHeight(e.nativeEvent.layout.height)}
          >
            <View key="home" style={styles.page} collapsable={false}>
              <HomeDashboard
                phase={phase}
                resistanceSince={resistanceSince}
                active={view === 'home'}
                onTalk={handleTalk}
                onQuickLog={handleQuickLog}
                onRuleOfThree={handleRuleOfThree}
              />
            </View>
            <View key="chat" style={styles.page} collapsable={false}>
              <ConversationStream onBreathingDone={handleBreathingDone} />
            </View>
            <View key="content" style={styles.page} collapsable={false}>
              {/* Ten video players are heavy — mount only while visible. */}
              {view === 'content' && paneHeight > 0 ? (
                <ContentPane height={paneHeight} onOpenChat={openChat} onTalk={handleContentTalk} />
              ) : null}
            </View>
          </PagerView>

          {/* Voice rides above the dock, in the same conversation. */}
          {audioOn && (
            <>
              <VoiceSession
                muted={muted}
                onAudioLevel={setAudioLevel}
                onError={handleVoiceError}
                onVoiceFailed={handleVoiceFailed}
              />
              <VoiceBand audioLevel={audioLevel} mascotState={mascotState} muted={muted} />
            </>
          )}

          {/* Non-blocking banner shown when voice output has failed. */}
          {voiceOutputFailed && (
            <View style={styles.voiceFailBanner}>
              <Text style={styles.voiceFailText}>
                {"Voice isn't working right now \u2014 switching to text. I'm still here."}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setVoiceOutputFailed(false);
                  inputRef.current?.focus();
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Dismiss voice failure notice"
              >
                <Text style={styles.voiceFailCta}>Got it</Text>
              </TouchableOpacity>
            </View>
          )}

          {devModeRow}

          {/* The unified dock. Audio never auto-enables; only the speaker
              tap turns it on. Buttons ride the thumb side. */}
          <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            {hand === 'left' && dockButtons}
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder={developerMode ? 'DEV MODE — tell Buddy what to build…' : 'Talk to Buddy…'}
              placeholderTextColor={Colors.textTertiary}
              value={input}
              onChangeText={setInput}
              onSubmitEditing={() => {
                handleSend();
                inputRef.current?.focus();
              }}
              returnKeyType="send"
              blurOnSubmit={false}
              editable={!isStreaming}
              multiline
              textAlignVertical="top"
            />
            {hand === 'right' && dockButtons}
          </View>
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  surface: {
    flex: 1,
  },
  body: {
    flex: 1,
  },
  pane: {
    flex: 1,
  },
  page: {
    flex: 1,
  },
  dock: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.surfaceBorder,
    backgroundColor: Colors.background,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: Colors.textPrimary,
    minHeight: 40,
    maxHeight: 120,
  },
  dockBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtn: {
    backgroundColor: Colors.coral,
  },
  audioOnBtn: {
    backgroundColor: Colors.stateIdle,
  },
  devOnBtn: {
    backgroundColor: Colors.coral,
  },
  mutedBtn: {
    backgroundColor: Colors.error,
  },
  dockBtnDisabled: {
    opacity: 0.4,
  },
  devModeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: Colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.surfaceBorder,
  },
  devModeLabel: {
    flex: 1,
    fontSize: 13,
    color: Colors.textSecondary,
  },
  sendGlyph: {
    color: Colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  voiceFailBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,69,58,0.12)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.error,
    gap: 8,
  },
  voiceFailText: {
    flex: 1,
    fontSize: 13,
    color: Colors.textSecondary,
  },
  voiceFailCta: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.stateIdle,
  },
});
