import { useEffect, useRef, useState } from 'react';
import {
  LiveKitRoom,
  useParticipants,
  AudioSession,
  registerGlobals,
  useRoomContext,
} from '@livekit/react-native';
import { RoomEvent, type TranscriptionSegment, type Participant, type RemoteTrackPublication, type RemoteParticipant } from 'livekit-client';
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

/** Must always exceed TTS_TIMEOUT_SECONDS in agent/sesame_tts.py (currently 30 s).
 * If you lower the agent budget, lower this too, or the cross-repo test will fail. */
export const VOICE_FIRST_AUDIO_TIMEOUT_MS = 35_000;

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
        // Root cause: iOS defaults to soloAmbient, which silences remote
        // (agent TTS) audio when another audio source interrupts or the app
        // backgrounds. playAndRecord keeps the output route alive for the
        // full duplex voice session.
        await AudioSession.startAudioSession();
        await AudioSession.setAppleAudioConfiguration({ audioCategory: 'playAndRecord' });
        const state = useSessionStore.getState();
        const hasHistory = state.messages.some((m) => m.content.length > 0);
        const activeSessionId = state.sessionId;
        const res = await fetch(`${ApiConfig.CHAT_URL}/livekit/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room: activeSessionId ? `bb-${activeSessionId}` : `bb-${Date.now()}`,
            identity: useAuthStore.getState().user?.id || `user-${Date.now()}`,
            context: hasHistory ? 'switched_from_text' : 'fresh_session',
            sessionId: activeSessionId ?? undefined,
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
      const text = segments.map((s) => s.text).join('').trim();
      if (!text) return;

      const isFinal = segments.every((s) => s.final);

      // When participant is undefined the SDK emits transcription without
      // attribution. Treat undefined the same as a remote (agent) participant
      // since user STT transcripts always carry isLocal=true when attributed.
      // An undefined participant here means the agent emitted the segment.
      const isLocal = participant ? participant.isLocal : false;
      const isAgent = !isLocal;

      console.log(`[VOICE] TranscriptionReceived: isAgent=${isAgent} isFinal=${isFinal} len=${text.length} participant=${participant?.identity ?? 'undefined'}`);

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
        console.log(`[VOICE] User transcript captured: "${text.slice(0, 80)}"`);
        addUserMessage(text);
      }
    };

    console.log('[VOICE] TranscriptCapture: registering TranscriptionReceived handler');
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
  const room = useRoomContext();
  const participants = useParticipants();
  const setMascotState = useSessionStore((s) => s.setMascotState);
  const prevLevelRef = useRef(0);
  const wasSpeakingRef = useRef(false);
  const failedRef = useRef(false);
  const audioStartedRef = useRef(false);
  const agentTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userSpokeRef = useRef(false);

  const cancelTimer = () => {
    if (agentTurnTimerRef.current) {
      clearTimeout(agentTurnTimerRef.current);
      agentTurnTimerRef.current = null;
    }
  };

  // Root cause: a network blip fires RoomEvent.Reconnecting and drops the
  // remote audio tracks. Without a handler the audio consumer never restarts
  // and the session goes silent. On Reconnected we reconfigure the audio
  // session so the OS route is restored before LiveKit republishes tracks.
  useEffect(() => {
    const onReconnecting = () => {
      console.warn('[VOICE] room reconnecting — audio may drop momentarily');
      setMascotState('thinking');
    };
    const onReconnected = async () => {
      console.log('[VOICE] room reconnected — restoring audio session');
      try {
        await AudioSession.startAudioSession();
        await AudioSession.setAppleAudioConfiguration({ audioCategory: 'playAndRecord' });
      } catch (e) {
        console.error('[VOICE] audio session restore failed after reconnect:', e);
      }
      setMascotState('listening');
      failedRef.current = false;
    };
    const onDisconnected = (...args: unknown[]) => {
      console.error('[VOICE] room disconnected, reason:', args[1]);
    };
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, setMascotState]);

  // Listen for a remote audio track subscription — cancel the failure timer
  // as soon as the agent's audio track is wired up, even before first audio.
  useEffect(() => {
    const onTrackSubscribed = (
      _track: unknown,
      publication: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ) => {
      if (publication.kind === 'audio') {
        audioStartedRef.current = true;
        cancelTimer();
      }
    };
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    };
  }, [room]);

  // Listen for the explicit VOICE_FAILURE signal from the agent — show the
  // fallback banner immediately rather than waiting for the backstop timer.
  useEffect(() => {
    const onDataReceived = (payload: Uint8Array) => {
      try {
        const text = new TextDecoder().decode(payload);
        if (text === 'VOICE_FAILURE' && !failedRef.current) {
          failedRef.current = true;
          cancelTimer();
          onVoiceFailed?.();
        }
      } catch {
      }
    };
    room.on(RoomEvent.DataReceived, onDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room, onVoiceFailed]);

  useEffect(() => {
    const local = participants.find((p) => p.isLocal);
    const remotes = participants.filter((p) => !p.isLocal);
    const agentSpeaking = remotes.some((p) => p.isSpeaking);
    const userSpeaking = local?.isSpeaking ?? false;

    const agentLevel = remotes.reduce((max, p) => Math.max(max, (p as any).audioLevel ?? 0), 0);
    const userLevel = (local as any)?.audioLevel ?? 0;

    if (agentSpeaking || agentLevel > 0) {
      setMascotState('speaking');
      audioStartedRef.current = true;
      cancelTimer();
      wasSpeakingRef.current = false;
    } else if (userSpeaking) {
      setMascotState('user_speaking');
      userSpokeRef.current = true;
      wasSpeakingRef.current = true;
    } else if (wasSpeakingRef.current && !agentSpeaking) {
      setMascotState('thinking');
      if (!failedRef.current && !agentTurnTimerRef.current) {
        audioStartedRef.current = false;
        agentTurnTimerRef.current = setTimeout(() => {
          if (!audioStartedRef.current && !failedRef.current && userSpokeRef.current) {
            failedRef.current = true;
            onVoiceFailed?.();
          }
          agentTurnTimerRef.current = null;
        }, VOICE_FIRST_AUDIO_TIMEOUT_MS);
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
