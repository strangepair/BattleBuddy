import { useEffect, useRef, useState } from 'react';
import {
  LiveKitRoom,
  useParticipants,
  AudioSession,
  registerGlobals,
  useRoomContext,
} from '@livekit/react-native';
import { RoomEvent, type TranscriptionSegment, type Participant } from 'livekit-client';
import { ApiConfig } from '../../config';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';

// The invisible half of the unified dock's audio toggle: mounting this
// component connects full-duplex LiveKit voice into the SAME session store
// the text stream renders from — no navigation, no separate screen. It is
// only ever mounted by an explicit user tap on the dock's speaker button
// (audio never auto-enables), and unmounting tears the room down.
//
// Extracted from app/session-voice.tsx, which Phase 5 retires.

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

interface VoiceSessionProps {
  muted: boolean;
  onAudioLevel: (level: number) => void;
  /** Token fetch / connection failure — the dock falls back to text mode. */
  onError: (message: string) => void;
  /** Called when audio output fails to start within 5 s of a bot turn. */
  onVoiceFailed?: () => void;
}

export default function VoiceSession({ muted, onAudioLevel, onError, onVoiceFailed }: VoiceSessionProps) {
  const [token, setToken] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const setMascotState = useSessionStore((s) => s.setMascotState);

  useEffect(() => {
    let cancelled = false;
    const connect = async () => {
      try {
        await AudioSession.startAudioSession();
        const state = useSessionStore.getState();
        const hasHistory = state.messages.some((m) => m.content.length > 0);
        const res = await fetch(`${ApiConfig.CHAT_URL}/livekit/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room: `bb-${Date.now()}`,
            identity: useAuthStore.getState().user?.id || `user-${Date.now()}`,
            context: hasHistory ? 'switched_from_text' : 'fresh_session',
            sessionCount: state.sessionCount,
            profile: ensureNameInProfile(),
            recentHistory: state.recentHistory,
            triggerContext: state.triggerContext,
            priorMessages: hasHistory
              ? state.messages
                  .filter((m) => m.content.length > 0)
                  .slice(-10)
                  .map((m) => `${m.role === 'user' ? 'User' : 'BattleBuddy'}: ${m.content}`)
                  .join('\n')
              : undefined,
            timezone: (() => {
              try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Chicago'; }
            })(),
            // Read at connect time, same as the text path reads it at send
            // time — the voice agent holds it for the life of this connection.
            devMode: useSettingsStore.getState().developerMode,
          }),
        });
        if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
        const { token: t, url } = await res.json();
        if (cancelled) return;
        setWsUrl(url);
        setToken(t);
        setMascotState('listening');
      } catch (err) {
        console.error('[VOICE] Connection failed:', err);
        if (!cancelled) {
          onError(err instanceof Error ? err.message : 'voice connection failed');
        }
      }
    };
    connect();
    return () => {
      cancelled = true;
      AudioSession.stopAudioSession();
    };
    // Connect exactly once per mount — the dock remounts to reconnect.
  }, []);

  if (!token || !wsUrl) return null;

  return (
    <LiveKitRoom serverUrl={wsUrl} token={token} connect audio video={false}>
      <RoomStatus onAudioLevel={onAudioLevel} onVoiceFailed={onVoiceFailed} />
      <TranscriptCapture />
      <MuteControl muted={muted} />
    </LiveKitRoom>
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
      const text = segments.map((s) => s.text).join('').trim();
      if (!text) return;

      const isFinal = segments.every((s) => s.final);

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
    return () => {
      room.off(RoomEvent.TranscriptionReceived, handler);
    };
  }, [room, addUserMessage, addAssistantMsg, updateAssistantMsg]);

  return null;
}

function RoomStatus({
  onAudioLevel,
  onVoiceFailed,
}: {
  onAudioLevel: (level: number) => void;
  onVoiceFailed?: () => void;
}) {
  const participants = useParticipants();
  const setMascotState = useSessionStore((s) => s.setMascotState);
  const prevLevelRef = useRef(0);
  const wasSpeakingRef = useRef(false);
  const failedRef = useRef(false);
  const audioStartedRef = useRef(false);
  const agentTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const local = participants.find((p) => p.isLocal);
    const remotes = participants.filter((p) => !p.isLocal);
    const agentSpeaking = remotes.some((p) => p.isSpeaking);
    const userSpeaking = local?.isSpeaking ?? false;

    const agentLevel = remotes.reduce((max, p) => Math.max(max, (p as any).audioLevel ?? 0), 0);
    const userLevel = (local as any)?.audioLevel ?? 0;

    if (agentSpeaking) {
      setMascotState('speaking');
      audioStartedRef.current = true;
      if (agentTurnTimerRef.current) {
        clearTimeout(agentTurnTimerRef.current);
        agentTurnTimerRef.current = null;
      }
      wasSpeakingRef.current = false;
    } else if (userSpeaking) {
      setMascotState('user_speaking');
      wasSpeakingRef.current = true;
    } else if (wasSpeakingRef.current && !agentSpeaking) {
      setMascotState('thinking');
      if (!audioStartedRef.current && !failedRef.current && !agentTurnTimerRef.current) {
        agentTurnTimerRef.current = setTimeout(() => {
          if (!audioStartedRef.current && !failedRef.current) {
            failedRef.current = true;
            onVoiceFailed?.();
          }
          agentTurnTimerRef.current = null;
        }, 5000);
      }
    } else {
      setMascotState('listening');
    }

    const level = Math.max(agentLevel, userLevel);
    const smoothed = prevLevelRef.current * 0.3 + level * 0.7;
    prevLevelRef.current = smoothed;
    onAudioLevel(smoothed);
  }, [participants, setMascotState, onAudioLevel, onVoiceFailed]);

  useEffect(() => {
    return () => {
      if (agentTurnTimerRef.current) {
        clearTimeout(agentTurnTimerRef.current);
      }
    };
  }, []);

  return null;
}
