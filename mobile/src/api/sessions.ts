import { ApiConfig } from '../config';
import { getAuthToken } from '../services/supabase';

export interface Session {
  id: string;
  user_id: string;
  created_at: string;
  ended_at?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FetchSessionsResult {
  sessions: Session[];
  nextCursor: string | null;
}

export async function fetchSessions(
  before: string,
  limit = 20,
): Promise<FetchSessionsResult> {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated');

  const params = new URLSearchParams({ before, limit: String(limit) });
  const res = await fetch(
    `${ApiConfig.CHAT_URL}/api/sessions?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sessions fetch failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { sessions: Session[]; nextCursor: string | null };
  return { sessions: json.sessions ?? [], nextCursor: json.nextCursor ?? null };
}
