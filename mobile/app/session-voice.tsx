import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import {
  LiveKitRoom,
  useParticipants,
  AudioSession,
  registerGlobals,
  useRoomContext,
} from '@livekit/react-native';
import { RoomEvent, type TranscriptionSegment, type Participant } from 'livekit-client';
import { ApiConfig } from '../src/config';
import EntityBackground from '../src/components/home/EntityBackground';
import type { MascotState } from '../src/components/mascot';
import EndCallOverlay from '../src/components/voice/EndCallOverlay';
import OutcomeCapture from '../src/components/feed/OutcomeCapture';
import HomeButton from '../src/components/common/HomeButton';
import BBNavOverlay from '../src/components/common/BBNavOverlay';
import EdgeEntrance from '../src/components/common/EdgeEntrance';
import { useSessionStore } from '../src/stores/sessionStore';
import { useAuthStore } from '../src/stores/authStore';
import { recordSessionOutcome } from '../src/services/outcomeRecorder';
import { Colors, Spacing } from '../src/theme';

// Same state -> color convention as the hub entity and the old mascot:
// blue = idle/listening, green = hearing the user, coral = Buddy talking/thinking.
const STATE_COLOR: Record<MascotState, string> = {
  idle: Colors.stateIdle,
  listening: Colors.stateIdle,
  user_speaking: Colors.stateUserSpeaking,
  speaking: Colors.coral,
  thinking: Colors.coral,
  celebrating: Colors.stateUserSpeaking,
  empathy: Colors.stateIdle,
};
// Baseline "how alive it looks" per state, before real mic/speaker level is
// layered on top — idle states stay calm, active speech pulses harder.
const STATE_BASE_ENERGY: Record<MascotState, number> = {
  idle: 0.15,
  listening: 0.18,
  user_speaking: 0.5,
  speaking: 0.6,
  thinking: 0.3,
  celebrating: 0.5,
  empathy: 0.2,
};

try {
  registerGlobals();
} catch (e) {
  console.warn('registerGlobals failed:', e);
}

function ensureNameInProfile(): string {
  const profile = useSessionStore.getState().profileSummary;
  const authUser = useAuthStore.getState().user;
  if (authUser?.name && !profile.includes(authUser.name)) {
    return `Name: ${authUser.name}. ${profile}`;
  }
  return profile;
}

export default function SessionVoiceScreen() {
  const [token, setToken] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [showOutcome, setShowOutcome] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const mascotState = useSessionStore((s) => s.mascotState);
  const isActive = useSessionStore((s) => s.isActive);
  const mode = useSessionStore((s) => s.mode);
  const messages = useSessionStore((s) => s.messages);
  const cameFromTextRef = useRef(isActive && messages.length > 0);
  const startSession = useSessionStore((s) => s.startSession);
  const switchMode = useSessionStore((s) => s.switchMode);
  const endSession = useSessionStore((s) => s.endSession);
  const setMascotState = useSessionStore((s) => s.setMascotState);

  const entityColor = STATE_COLOR[mascotState];
  const entityEnergy = Math.min(1, STATE_BASE_ENERGY[mascotState] + audioLevel * 0.6);

  const ringScale = useSharedValue(1);
  const ringOpacity = useSharedValue(0.55);
  useEffect(() => {
    ringScale.value = withRepeat(
      withSequence(withTiming(1, { duration: 0 }), withTiming(1.7, { duration: 2600, easing: Easing.out(Easing.ease) })),
      -1,
    );
    ringOpacity.value = withRepeat(
      withSequence(withTiming(0.55, { duration: 0 }), withTiming(0, { duration: 2600, easing: Easing.out(Easing.ease) })),
      -1,
    );
  }, [ringScale, ringOpacity]);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: ringOpacity.value,
    transform: [{ scale: ringScale.value }],
  }));

  // Start session if needed
  useEffect(() => {
    if (!isActive) {
      startSession('voice');
    } else if (mode !== 'voice') {
      switchMode('voice');
    }
  }, [isActive, mode, startSession, switchMode]);

  // Call timer
  useEffect(() => {
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // Connect to LiveKit
  useEffect(() => {
    const connect = async () => {
      try {
        console.warn('[VOICE] Starting audio session...');
        await AudioSession.startAudioSession();
        const profileToSend = ensureNameInProfile();
        console.warn('[VOICE] Profile being sent:', profileToSend.substring(0, 200));
        console.warn('[VOICE] Fetching token from', ApiConfig.CHAT_URL);
        const res = await fetch(`${ApiConfig.CHAT_URL}/livekit/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room: `bb-${Date.now()}`,
            identity: useAuthStore.getState().user?.id || `user-${Date.now()}`,
            context: cameFromTextRef.current ? 'switched_from_text' : 'fresh_session',
            sessionCount: useSessionStore.getState().sessionCount,
            profile: profileToSend,
            recentHistory: useSessionStore.getState().recentHistory,
            triggerContext: useSessionStore.getState().triggerContext,
            priorMessages: cameFromTextRef.current
              ? useSessionStore.getState().messages
                  .filter(m => m.content.length > 0)
                  .slice(-10)
                  .map(m => `${m.role === 'user' ? 'User' : 'BattleBuddy'}: ${m.content}`)
                  .join('\n')
              : undefined,
            timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Chicago'; } })(),
          }),
        });
        if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
        const { token: t, url } = await res.json();
        console.warn('[VOICE] Got token. LiveKit URL:', url);
        setWsUrl(url);
        setToken(t);
        setMascotState('listening');
        console.warn('[VOICE] Connecting to LiveKit room...');
      } catch (err) {
        console.error('[VOICE] Connection failed:', err);
      }
    };
    connect();
    return () => {
      AudioSession.stopAudioSession();
    };
  }, [setMascotState]);

  const handleEndCall = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setEnding(true);
  }, []);

  const handleEndCallComplete = useCallback(() => {
    setEnding(false);
    setShowOutcome(true);
  }, []);

  const goHome = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(app)/');
    }
  }, []);

  const handleSwitchToText = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    switchMode('text');
    router.replace('/(app)/session-chat');
  }, [switchMode]);

  const handleOutcomeComplete = useCallback(
    (outcome: 'resisted' | 'gave_in') => {
      const userId = useAuthStore.getState().user?.id || 'default';
      recordSessionOutcome(userId, outcome);
      endSession();
      goHome();
    },
    [endSession, goHome],
  );

  const handleAudioLevel = useCallback((level: number) => {
    setAudioLevel(level);
  }, []);

  return (
    <EdgeEntrance edge="down">
    <View style={styles.container}>
      <StatusBar style="light" />
      <HomeButton />
      <SafeAreaView style={styles.safeArea}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View style={styles.liveIndicator}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
            <Text style={styles.timer}>{formatTime(elapsed)}</Text>
          </View>
          <Text style={styles.headerTitle}>Buddy</Text>
          <Text style={[styles.statusLabel, { color: entityColor }]}>
            {mascotState === 'speaking' ? 'Buddy is talking...' :
             mascotState === 'thinking' ? 'Thinking...' :
             mascotState === 'user_speaking' ? 'Hearing you...' :
             'Listening...'}
          </Text>
        </View>

        {/* Entity — same living presence as the hub, color/energy driven by call state */}
        <View style={styles.mascotArea}>
          <EntityBackground targetColor={entityColor} energy={entityEnergy} />
          <Animated.View style={[styles.bbRing, ringStyle, { borderColor: entityColor }]} pointerEvents="none" />
          <View style={[styles.bbCircle, { borderColor: entityColor }]}>
            <Text style={styles.bbText}>BB</Text>
          </View>
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          {/* Switch to text */}
          <TouchableOpacity
            style={styles.controlButton}
            onPress={handleSwitchToText}
            activeOpacity={0.7}
          >
            <View style={styles.controlCircle}>
              <Text style={styles.controlIcon}>💬</Text>
            </View>
            <Text style={styles.controlLabel}>Text</Text>
          </TouchableOpacity>

          {/* End Call */}
          <TouchableOpacity
            style={styles.controlButton}
            onPress={handleEndCall}
            activeOpacity={0.7}
          >
            <View style={styles.endCallCircle}>
              <Text style={styles.endCallIcon}>📞</Text>
            </View>
            <Text style={styles.controlLabel}>End</Text>
          </TouchableOpacity>

          {/* Mute */}
          <TouchableOpacity
            style={styles.controlButton}
            onPress={() => setMuted(!muted)}
            activeOpacity={0.7}
          >
            <View style={[styles.controlCircle, muted && styles.controlMuted]}>
              <Text style={styles.controlIcon}>{muted ? '🔇' : '🎤'}</Text>
            </View>
            <Text style={styles.controlLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
          </TouchableOpacity>
        </View>

        {token && wsUrl && (
          <LiveKitRoom
            serverUrl={wsUrl}
            token={token}
            connect={true}
            audio={true}
            video={false}
          >
            <RoomStatus onAudioLevel={handleAudioLevel} />
            <TranscriptCapture />
            <MuteControl muted={muted} />
          </LiveKitRoom>
        )}
      </SafeAreaView>

      {ending && <EndCallOverlay onComplete={handleEndCallComplete} />}
      {showOutcome && <OutcomeCapture onComplete={handleOutcomeComplete} />}

      <BBNavOverlay currentDirection="down" anchor="bottom-center" />
    </View>
    </EdgeEntrance>
  );
}

function MuteControl({ muted }: { muted: boolean }) {
  const room = useRoomContext();

  useEffect(() => {
    const local = room.localParticipant;
    if (!local) return;

    local.setMicrophoneEnabled(!muted).catch(() => {});
  }, [muted, room]);

  return null;
}

function TranscriptCapture() {
  const room = useRoomContext();
  const addUserMessage = useSessionStore((s) => s.addUserMessage);
  const addAssistantMsg = useSessionStore((s) => s.addAssistantMessage);
  const updateAssistantMsg = useSessionStore((s) => s.updateAssistantMessage);
  const lastAgentMsgId = useRef<string | null>(null);

  useEffect(() => {
    const handler = (segments: TranscriptionSegment[], participant?: Participant) => {
      const isAgent = participant && !participant.isLocal;
      const text = segments.map(s => s.text).join('').trim();
      if (!text) return;

      const isFinal = segments.every(s => s.final);

      if (isAgent) {
        if (isFinal) {
          if (lastAgentMsgId.current) {
            updateAssistantMsg(lastAgentMsgId.current, text);
            lastAgentMsgId.current = null;
          } else {
            const id = addAssistantMsg();
            updateAssistantMsg(id, text);
          }
        } else {
          if (!lastAgentMsgId.current) {
            lastAgentMsgId.current = addAssistantMsg();
          }
          updateAssistantMsg(lastAgentMsgId.current, text);
        }
      } else if (isFinal) {
        addUserMessage(text);
      }
    };

    room.on(RoomEvent.TranscriptionReceived, handler);
    return () => { room.off(RoomEvent.TranscriptionReceived, handler); };
  }, [room, addUserMessage, addAssistantMsg, updateAssistantMsg]);

  return null;
}

function RoomStatus({ onAudioLevel }: { onAudioLevel: (level: number) => void }) {
  const participants = useParticipants();
  const setMascotState = useSessionStore((s) => s.setMascotState);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const prevLevelRef = useRef(0);
  const wasSpeakingRef = useRef(false);

  useEffect(() => {
    const local = participants.find(p => p.isLocal);
    const remotes = participants.filter(p => !p.isLocal);
    const agentSpeaking = remotes.some(p => p.isSpeaking);
    const userSpeaking = local?.isSpeaking ?? false;

    const agentLevel = remotes.reduce((max, p) => Math.max(max, (p as any).audioLevel ?? 0), 0);
    const userLevel = (local as any)?.audioLevel ?? 0;

    if (agentSpeaking) {
      setMascotState('speaking');
      wasSpeakingRef.current = false;
    } else if (userSpeaking) {
      setMascotState('user_speaking');
      wasSpeakingRef.current = true;
    } else if (wasSpeakingRef.current && !agentSpeaking) {
      // User just stopped speaking, agent hasn't started — thinking
      setMascotState('thinking');
    } else {
      setMascotState('listening');
    }

    const level = Math.max(agentLevel, userLevel);
    const smoothed = prevLevelRef.current * 0.3 + level * 0.7;
    prevLevelRef.current = smoothed;
    onAudioLevel(smoothed);
  }, [participants, setMascotState, onAudioLevel]);

  return null;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    paddingTop: Spacing.sm,
    gap: 2,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: 4,
  },
  liveIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.error,
  },
  liveText: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.error,
    letterSpacing: 1,
  },
  timer: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  statusLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: Colors.textSecondary,
  },
  mascotArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bbRing: {
    position: 'absolute',
    width: 150,
    height: 150,
    borderRadius: 75,
    borderWidth: 2,
  },
  bbCircle: {
    width: 150,
    height: 150,
    borderRadius: 75,
    borderWidth: 3,
    backgroundColor: 'rgba(28,28,30,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bbText: {
    fontSize: 46,
    fontWeight: '800',
    color: Colors.textPrimary,
    letterSpacing: 1,
    transform: [{ rotate: '-7deg' }],
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 40,
    paddingBottom: 44,
  },
  controlButton: {
    alignItems: 'center',
    gap: 6,
    minWidth: 56,
  },
  controlCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlMuted: {
    backgroundColor: Colors.error,
  },
  controlDisabled: {
    opacity: 0.35,
  },
  controlIcon: {
    fontSize: 22,
  },
  controlLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: Colors.textSecondary,
  },
  controlLabelDisabled: {
    opacity: 0.35,
  },
  endCallCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.error,
    justifyContent: 'center',
    alignItems: 'center',
  },
  endCallIcon: {
    fontSize: 28,
    transform: [{ rotate: '135deg' }],
  },
});
