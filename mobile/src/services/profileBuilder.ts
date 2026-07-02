import { ApiConfig } from '../config';

export interface UserProfile {
  summary: string;
  recentHistory: string;
  streak: number;
  totalSessions: number;
  resistRate: number;
  topMedia: string[];
  preferredFraming: string | null;
  hardestTime: string | null;
  preferredMode: string | null;
}

const EMPTY_PROFILE: UserProfile = {
  summary: 'New user — no history yet.',
  recentHistory: 'First message in this session.',
  streak: 0,
  totalSessions: 0,
  resistRate: 0,
  topMedia: [],
  preferredFraming: null,
  hardestTime: null,
  preferredMode: null,
};

async function resolveUserId(explicit: string | null): Promise<string | null> {
  if (explicit) return explicit;
  try {
    const { useAuthStore } = await import('../stores/authStore');
    return useAuthStore.getState().user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the user's profile from the server's context store — the same living
 * profile BB itself reads — plus session stats from the event log. Falls back
 * to the locally-rebuilt profile when offline.
 *
 * (The previous version read craving_events/session_reports/framing_stats
 * directly from Supabase, which RLS made permanently empty for local user
 * ids — the remote branch never returned data once.)
 */
export async function fetchUserProfile(userIdArg: string | null): Promise<UserProfile> {
  const userId = await resolveUserId(userIdArg);

  if (userId) {
    try {
      const [profileRes, eventsRes] = await Promise.all([
        fetch(`${ApiConfig.CHAT_URL}/context/profile/${encodeURIComponent(userId)}`),
        fetch(`${ApiConfig.CHAT_URL}/events?userId=${encodeURIComponent(userId)}&eventTypes=session&limit=100`),
      ]);

      if (profileRes.ok) {
        const { summary, profile } = await profileRes.json();
        const events: any[] = eventsRes.ok ? (await eventsRes.json()).events || [] : [];

        const outcomes = events.map((e) => e.metadata?.outcome).filter(Boolean);
        const resisted = outcomes.filter((o) => o === 'resisted').length;
        const resistRate = outcomes.length > 0 ? Math.round((resisted / outcomes.length) * 100) : 0;

        let streak = 0;
        for (const o of outcomes) {
          if (o === 'resisted') streak++;
          else break;
        }

        const textCount = events.filter((e) => e.metadata?.mode === 'text').length;
        const voiceCount = events.filter((e) => e.metadata?.mode === 'voice').length;
        const preferredMode =
          textCount > voiceCount * 1.5 ? 'text' : voiceCount > textCount * 1.5 ? 'voice' : null;

        const topWindow = (profile?.risk_windows || [])
          .slice()
          .sort((a: any, b: any) => (b.weight || 0) - (a.weight || 0))[0];

        const hints: string[] = (profile?.next_session_hints || [])
          .slice(-3)
          .map((h: any) => (typeof h === 'string' ? h : h?.value || ''))
          .filter(Boolean);

        if (summary && !summary.includes('New user')) {
          return {
            summary,
            recentHistory: hints.length > 0 ? `Follow up on: ${hints.join(' | ')}` : 'See profile.',
            streak,
            totalSessions: profile?.session_count || events.length,
            resistRate,
            topMedia: [],
            preferredFraming: null,
            hardestTime: topWindow ? formatHour(topWindow.hour) : null,
            preferredMode,
          };
        }
      }
    } catch {
      // Offline — fall through to the local rebuild
    }
  }

  // Local fallback: profile rebuilt from locally-saved session reports
  try {
    const { useSessionStore } = await import('../stores/sessionStore');
    const state = useSessionStore.getState();
    if (state.profileSummary && !state.profileSummary.includes('New user')) {
      return {
        ...EMPTY_PROFILE,
        summary: state.profileSummary,
        recentHistory: state.recentHistory,
        totalSessions: state.sessionCount,
      };
    }
  } catch {}

  return EMPTY_PROFILE;
}

function formatHour(h: number): string {
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}
