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
import { useAuthStore } from '../../src/stores/authStore';
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

// The One Conversation surface: one screen, one stream, three views over it.
// Home and Content are lenses; everything routes back into the conversation.
export default function SessionScreen() {
  const [view, setView] = useState<SessionView>('chat');
  const [input, setInput] = useState('');
  const [paneHeight, setPaneHeight] = useState(0);
  const [hasGreeted, setHasGreeted] = useState(false);
  // Audio is opt-in per the product rule: it turns on ONLY when the user taps
  // the dock's speaker button — never automatically, never on navigation.
  const [audioOn, setAudioOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const isActive = useSessionStore((s) => s.isActive);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const mascotState = useSessionStore((s) => s.mascotState);
  const startSession = useSessionStore((s) => s.startSession);
  const setProfileSummary = useSessionStore((s) => s.setProfileSummary);
  const setRecentHistory = useSessionStore((s) => s.setRecentHistory);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const onSelfEngaged = useEngagementEngine((s) => s.onUserSelfEngaged);
  const { sendMessage, greet, abort } = useSessionChat();

  // Phase 4 wires this to urge detection + the resistance flow.
  const [phase] = useState<SessionPhase>('observation');

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

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    sendMessage(text);
  }, [input, isStreaming, sendMessage]);

  // Dashboard CTAs re-enter the conversation carrying what the user was
  // looking at — the bracketed context rides to the model; the stream strips
  // it for display.
  const handleTalk = useCallback(
    (topic: TalkAboutTopic) => {
      setView('chat');
      sendMessage(
        `[Looking at the "${topic.title}" card on my dashboard: ${topic.detail}] ${topic.userText}`,
      );
    },
    [sendMessage],
  );

  const handleQuickLog = useCallback(
    (kind: QuickLogKind) => {
      setView('chat');
      if (kind === 'urge') {
        sendMessage("I'm having an urge");
        return;
      }
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
    [sendMessage, userId],
  );

  const openChat = useCallback(() => setView('chat'), []);

  const switchMode = useSessionStore((s) => s.switchMode);

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

  const toggleMute = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setMuted((m) => !m);
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <EntityBackground
        targetColor={Colors.stateIdle}
        energy={0.08}
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
          <View
            style={styles.pane}
            onLayout={(e) => setPaneHeight(e.nativeEvent.layout.height)}
          >
            {view === 'chat' && <ConversationStream />}
            {view === 'home' && <HomeDashboard onTalk={handleTalk} onQuickLog={handleQuickLog} />}
            {view === 'content' && paneHeight > 0 && (
              <ContentPane height={paneHeight} onOpenChat={openChat} />
            )}
          </View>

          {/* Voice rides above the dock, in the same conversation. */}
          {audioOn && (
            <>
              <VoiceSession muted={muted} onAudioLevel={setAudioLevel} onError={handleVoiceError} />
              <VoiceBand audioLevel={audioLevel} mascotState={mascotState} muted={muted} />
            </>
          )}

          {/* The unified dock. Audio never auto-enables; only the speaker
              tap turns it on. */}
          <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder="Talk to Buddy…"
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
  mutedBtn: {
    backgroundColor: Colors.error,
  },
  dockBtnDisabled: {
    opacity: 0.4,
  },
  sendGlyph: {
    color: Colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
});
