import { supabase } from './supabase';
import { ApiConfig } from '../config';

export interface ContentVideo {
  id: string;
  r2Url: string;
  r2Key: string;
  theme: string;
  tags: string[];
  prompt: string;
  durationSeconds: number | null;
  videoApi: 'runway' | 'kling' | 'luma';
  generationId: string | null;
  status: 'active' | 'archived' | 'failed';
  createdAt: string;
}

interface ContentVideoRow {
  id: string;
  r2_url: string;
  r2_key: string;
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

export async function fetchContentFeed(limit = 20, offset = 0): Promise<ContentVideo[]> {
  const { data, error } = await supabase
    .from('content_videos')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to fetch content feed: ${error.message}`);
  }

  return (data ?? []).map(toContentVideo);
}

export function getVideoUrl(r2Key: string): string {
  const base = ApiConfig.CF_R2_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/${r2Key.replace(/^\//, '')}`;
}
