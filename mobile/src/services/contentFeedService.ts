import { ApiConfig } from '../config';

export interface ContentVideo {
  id: string;
  r2Url: string;
  r2Key: string;
  r2ThumbnailUrl: string | null;
  theme: string;
  tags: string[];
  prompt: string;
  durationSeconds: number | null;
  videoApi: 'veo' | 'runway' | 'kling' | 'luma';
  generationId: string | null;
  status: 'active' | 'archived' | 'failed';
  createdAt: string;
}

interface ContentVideoRow {
  id: string;
  r2_url: string;
  r2_key: string;
  r2_thumbnail_url: string | null;
  theme: string;
  tags: string[] | null;
  prompt: string;
  duration_seconds: number | null;
  video_api: string;
  generation_id: string | null;
  status: string;
  created_at: string;
}

function toContentVideo(row: ContentVideoRow): ContentVideo {
  return {
    id: row.id,
    r2Url: row.r2_url,
    r2Key: row.r2_key,
    r2ThumbnailUrl: row.r2_thumbnail_url,
    theme: row.theme,
    tags: row.tags ?? [],
    prompt: row.prompt,
    durationSeconds: row.duration_seconds,
    videoApi: row.video_api as ContentVideo['videoApi'],
    generationId: row.generation_id,
    status: row.status as ContentVideo['status'],
    createdAt: row.created_at,
  };
}

// Fetched through the server: content_videos has RLS with no anon-read
// policy, so the app's direct Supabase query silently returned [] forever.
export async function fetchContentFeed(limit = 20, offset = 0): Promise<ContentVideo[]> {
  const res = await fetch(`${ApiConfig.CHAT_URL}/content/feed?limit=${limit}&offset=${offset}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch content feed: ${res.status}`);
  }
  const { videos } = await res.json();
  return ((videos ?? []) as ContentVideoRow[]).map(toContentVideo);
}

export function getVideoUrl(r2Key: string): string {
  const base = ApiConfig.CF_R2_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/${r2Key.replace(/^\//, '')}`;
}
