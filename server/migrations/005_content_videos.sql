-- Content video library for the swipe-right home feed
-- Run via Supabase SQL Editor or psql

create table if not exists content_videos (
  id uuid default gen_random_uuid() primary key,
  r2_url text not null,              -- full public URL in R2
  r2_key text not null unique,       -- R2 object key (for dedup)
  theme text not null,               -- content theme category
  tags text[] default '{}',          -- searchable tags
  prompt text not null,              -- the generation prompt used
  duration_seconds int,              -- video length
  video_api text not null,           -- 'runway' | 'kling' | 'luma'
  generation_id text,                -- API's job/task ID
  status text not null default 'active',  -- 'active' | 'archived' | 'failed'
  created_at timestamptz default now()
);

create index if not exists content_videos_theme_idx on content_videos (theme);
create index if not exists content_videos_status_idx on content_videos (status);
