// Central config — all model strings and feature flags live here.
// Change values here (or via env) to swap providers without touching app code.

export const ModelConfig = {
  // Tier 0: on-device (Gemma 4) — added in Phase 2.5
  DEVICE: 'gemma4-e4b',
  DEVICE_FALLBACK: 'gemma4-e2b',

  // Tier 1: cloud hot path — used from Phase 1 onward
  CLOUD_HOT: 'claude-haiku-4-5-20251001',

  // Tier 2: cloud reflective — off hot path, analytics/insights
  CLOUD_REFLECT: 'claude-sonnet-4-6',
} as const;

export const FeatureFlags = {
  // Enables on-device Gemma tier (Phase 2.5+)
  onDeviceModelEnabled: false,

  // Enables voice mode (Phase 2+)
  voiceEnabled: false,

  proactiveNudges: true,

  // Enables personalization v1 counters (Phase 3+)
  personalizationV1: false,

  // Enables offline-first SQLite persistence + sync (Phase 7)
  offlineResilience: true,
} as const;

export const RouterConfig = {
  // Escalate to cloud when on-device confidence falls below this (0–1)
  ESCALATE_ON_LOW_CONFIDENCE: 0.7,

  // Always escalate for these topic signals (regardless of confidence)
  ESCALATE_TOPICS: ['crisis', 'medical', 'withdrawal', 'emergency'] as const,
} as const;

export const ApiConfig = {
  // Backend base URL — set via EXPO_PUBLIC_API_URL env var
  BASE_URL: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:54321/functions/v1',

  // Chat proxy URL — local dev server (moves to Supabase Edge Function in prod)
  // Uses LAN IP so the iOS simulator can reach the host machine
  CHAT_URL: process.env.EXPO_PUBLIC_CHAT_URL ?? 'http://192.168.1.102:3333',

  // Sesame CSM TTS server
  TTS_URL: process.env.EXPO_PUBLIC_TTS_URL ?? 'http://192.168.1.95:3334',

  // Supabase project URL — set via EXPO_PUBLIC_SUPABASE_URL
  SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',

  // Supabase anon key — safe to expose (RLS enforces access)
  SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',

  // Cloudflare R2 public bucket URL — base for the content video feed
  CF_R2_PUBLIC_URL: process.env.EXPO_PUBLIC_CF_R2_PUBLIC_URL ?? '',
} as const;

export const EngagementConfig = {
  // How long (ms) to wait for the user to self-engage before nudging. System-wide, not per-user.
  WINDOW_DURATION_MS: 5 * 60 * 1000, // 5 minutes

  // Minimum time (ms) between proactive nudges to avoid nagging
  MIN_NUDGE_INTERVAL_MS: 60 * 60 * 1000, // 1 hour

  // Cooldown (ms) after a completed session before the engine re-arms
  POST_SESSION_COOLDOWN_MS: 30 * 60 * 1000, // 30 minutes
} as const;

export const BatchConfig = {
  // How often (hours) the batch profiler runs. The single cost knob.
  FREQUENCY_HOURS: 6,
} as const;

export const AppConfig = {
  // MVP habit target (drives onboarding copy + seed media tags)
  HABIT_TARGET: 'smoking' as const,

  // US-only MVP: crisis resource shown in disclaimer + soft off-ramp
  CRISIS_RESOURCE: '988' as const,
  CRISIS_RESOURCE_LABEL: '988 Suicide & Crisis Lifeline' as const,
} as const;
