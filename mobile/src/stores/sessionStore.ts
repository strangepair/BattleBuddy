import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MascotState } from '../components/mascot';
import {
  insertMessage,
  updateMessageContent,
  insertCravingEvent,
  updateCravingEvent,
} from '../services/localDb';
import { scopedKey } from '../services/scopedStorage';

const PERSIST_KEYS = {
  sessionCount: 'bb_session_count',
  profileSummary: 'bb_profile_summary',
  recentHistory: 'bb_recent_history',
  lastSessionMessages: 'bb_last_session_messages',
};

export type SessionMode = 'text' | 'voice' | 'idle';

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode: SessionMode;
  timestamp: number;
}

export type SessionOutcome = 'resisted' | 'submitted' | 'unsure' | 'gave_in';

export interface TriggerContext {
  trigger: string;
  intensity: number;
  time: string;
}

interface SessionState {
  // --- Session lifecycle ---
  sessionId: string | null;
  mode: SessionMode;
  startedAt: number | null;
  isActive: boolean;

  // --- Messages (shared across modes) ---
  messages: SessionMessage[];
  previousMessages: SessionMessage[];
  isStreaming: boolean;

  // --- Mascot ---
  mascotState: MascotState;

  // --- Personalization ---
  triggerContext: TriggerContext | null;
  profileSummary: string;
  recentHistory: string;
  sessionCount: number;

  // --- Push notification deep link ---
  pendingNotificationRoute: 'chat' | 'voice' | null;

  // --- Actions ---
  startSession: (mode: SessionMode) => void;
  endSession: () => void;
  switchMode: (to: SessionMode) => void;

  addUserMessage: (content: string) => void;
  addAssistantMessage: () => string;
  updateAssistantMessage: (id: string, content: string) => void;
  setStreaming: (streaming: boolean) => void;

  setMascotState: (state: MascotState) => void;
  setTriggerContext: (ctx: TriggerContext) => void;
  setProfileSummary: (summary: string) => void;
  setRecentHistory: (history: string) => void;
  setPendingNotificationRoute: (route: 'chat' | 'voice' | null) => void;
  consumePendingNotificationRoute: () => 'chat' | 'voice' | null;

  getMessagesForApi: () => { role: string; content: string }[];
}

let idCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessionId: null,
  mode: 'idle',
  startedAt: null,
  isActive: false,

  messages: [],
  previousMessages: [],
  isStreaming: false,

  mascotState: 'idle',

  triggerContext: null,
  profileSummary: 'New user — no history yet.',
  recentHistory: 'First message in this session.',
  sessionCount: 0,

  pendingNotificationRoute: null,

  startSession: (mode) => {
    const current = get();
    if (current.isActive) return;

    const sessionId = `session-${Date.now()}`;
    const now = Date.now();

    set((state) => {
      const newCount = state.sessionCount + 1;
      AsyncStorage.setItem(scopedKey(PERSIST_KEYS.sessionCount), String(newCount)).catch(() => {});
      return {
        sessionId,
        mode,
        startedAt: now,
        isActive: true,
        messages: [],
        isStreaming: false,
        mascotState: mode === 'voice' ? 'listening' : 'listening',
        sessionCount: newCount,
      };
    });

    insertCravingEvent({
      id: sessionId,
      user_id: 'local',
      started_at: now,
      ended_at: null,
      mode: mode === 'idle' ? 'text' : mode,
      outcome: null,
      helped: null,
      intensity_start: null,
      intensity_end: null,
      trigger_context: null,
    }).catch(() => {});
  },

  endSession: () => {
    const current = get();

    if (current.sessionId) {
      updateCravingEvent(current.sessionId, { ended_at: Date.now() }).catch(() => {});
    }

    const nonEmpty = current.messages.filter(m => m.content.length > 0);
    if (nonEmpty.length > 0) {
      AsyncStorage.setItem(scopedKey(PERSIST_KEYS.lastSessionMessages), JSON.stringify(nonEmpty.slice(-30))).catch(() => {});

      // Always generate a session report when there's meaningful content.
      // finalize:true marks a real session end — the server increments
      // session_count and records the session summary (voice sessions are
      // finalized by the voice agent instead; recordOutcome skips those).
      import('../services/outcomeRecorder').then(({ recordOutcome }) => {
        recordOutcome({
          userId: null,
          sessionId: current.sessionId || 'end',
          mode: current.mode,
          outcome: 'unsure',
          helped: false,
          startedAt: current.startedAt || Date.now(),
          endedAt: Date.now(),
          triggerContext: current.triggerContext,
          messages: current.messages,
          intensityStart: null,
          intensityEnd: null,
          finalize: true,
        });
      }).catch(() => {});
    }

    set({
      sessionId: null,
      mode: 'idle',
      startedAt: null,
      isActive: false,
      isStreaming: false,
      mascotState: 'idle',
      triggerContext: null,
      previousMessages: nonEmpty,
    });
  },

  switchMode: (to) => {
    const current = get();
    if (!current.isActive) return;

    set({
      mode: to,
      mascotState: to === 'voice' ? 'listening' : 'listening',
    });
  },

  addUserMessage: (content) => {
    const { sessionId, mode } = get();
    const msg: SessionMessage = {
      id: nextId(),
      role: 'user',
      content,
      mode,
      timestamp: Date.now(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));

    if (sessionId) {
      insertMessage({
        id: msg.id,
        session_id: sessionId,
        role: msg.role,
        content: msg.content,
        mode: msg.mode,
        timestamp: msg.timestamp,
      }).catch(() => {});
    }
  },

  addAssistantMessage: () => {
    const { sessionId, mode } = get();
    const id = nextId();
    const msg: SessionMessage = {
      id,
      role: 'assistant',
      content: '',
      mode,
      timestamp: Date.now(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));

    if (sessionId) {
      insertMessage({
        id: msg.id,
        session_id: sessionId,
        role: msg.role,
        content: msg.content,
        mode: msg.mode,
        timestamp: msg.timestamp,
      }).catch(() => {});
    }

    return id;
  },

  updateAssistantMessage: (id, content) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, content } : m,
      ),
    }));

    updateMessageContent(id, content).catch(() => {});
  },

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  setMascotState: (mascotState) => set({ mascotState }),

  setTriggerContext: (ctx) => set({ triggerContext: ctx }),

  setProfileSummary: (summary) => {
    AsyncStorage.setItem(scopedKey(PERSIST_KEYS.profileSummary), summary).catch(() => {});
    set({ profileSummary: summary });
  },

  setRecentHistory: (history) => {
    AsyncStorage.setItem(scopedKey(PERSIST_KEYS.recentHistory), history).catch(() => {});
    set({ recentHistory: history });
  },

  setPendingNotificationRoute: (route) =>
    set({ pendingNotificationRoute: route }),

  consumePendingNotificationRoute: () => {
    const route = get().pendingNotificationRoute;
    if (route) set({ pendingNotificationRoute: null });
    return route;
  },

  getMessagesForApi: () => {
    return get()
      .messages.filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content }));
  },
}));

// Hydrate persisted fields on app start
export async function hydrateSessionStore(): Promise<void> {
  try {
    const [countStr, profile, history, lastMsgs, reportsStr] = await Promise.all([
      AsyncStorage.getItem(scopedKey(PERSIST_KEYS.sessionCount)),
      AsyncStorage.getItem(scopedKey(PERSIST_KEYS.profileSummary)),
      AsyncStorage.getItem(scopedKey(PERSIST_KEYS.recentHistory)),
      AsyncStorage.getItem(scopedKey(PERSIST_KEYS.lastSessionMessages)),
      AsyncStorage.getItem(scopedKey('bb_session_reports')),
    ]);

    let finalProfile = profile || 'New user — no history yet.';
    let finalHistory = history || 'First message in this session.';

    // Always rebuild the profile from local reports if we have any
    if (reportsStr) {
      try {
        const { buildLocalProfile } = await import('../services/outcomeRecorder');
        const reports = JSON.parse(reportsStr);
        if (reports.length > 0) {
          const built = buildLocalProfile(reports);
          finalProfile = built.summary;
          finalHistory = built.recentHistory;
          AsyncStorage.setItem(scopedKey(PERSIST_KEYS.profileSummary), finalProfile).catch(() => {});
          AsyncStorage.setItem(scopedKey(PERSIST_KEYS.recentHistory), finalHistory).catch(() => {});
        }
      } catch {}
    }

    console.warn(`[HYDRATE] Session count: ${countStr || '0'}`);
    console.warn(`[HYDRATE] Profile: ${finalProfile.substring(0, 200)}`);
    console.warn(`[HYDRATE] Reports in storage: ${reportsStr ? JSON.parse(reportsStr).length : 0}`);

    useSessionStore.setState({
      sessionCount: countStr ? parseInt(countStr, 10) : 0,
      profileSummary: finalProfile,
      recentHistory: finalHistory,
      previousMessages: lastMsgs ? JSON.parse(lastMsgs) : [],
    });
  } catch (err) {
    console.warn('[HYDRATE] Error:', err);
  }
}
