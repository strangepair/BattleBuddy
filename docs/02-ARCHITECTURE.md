# BattleBuddy — Technical Architecture

> Doc 2 of 6. Pairs with `01-PRD.md` (what) and `03-AGENT-DESIGN.md` (the agent's behavior).
> Audience: Claude Code building the app. Status: MVP architecture.

---

## 1. Guiding constraints

- **Latency is the product.** During an urge, every second matters. The first agent token should appear in <1s. Architecture choices bias toward fast responses (streaming, edge-close inference, a fast model for the live loop).
- **Cross-platform, one codebase.** iOS + Android from a single source.
- **Offline-tolerant.** An urge can hit with bad signal. Core flows (start a session, run the urge-wave exercise, log an outcome) must degrade gracefully and sync later.
- **Privacy-first.** Sensitive behavioral data; encrypt, minimize, make deletable.

## 2. Stack (recommended)

| Layer | Choice | Why |
|---|---|---|
| Mobile app | **React Native + Expo** (TypeScript) | One codebase → iOS + Android. Strong audio/media. Expo handles builds, push, OTA updates. Claude Code is highly fluent in it. |
| Navigation | Expo Router | File-based routing, simple. |
| State | Zustand + React Query | Lightweight local state + server cache/sync. |
| Local store | SQLite (expo-sqlite) + MMKV | Offline event log + fast key-value for prefs. |
| Backend | **Supabase** (Postgres + Auth + Row-Level Security + Edge Functions) | Auth, encrypted Postgres, RLS for per-user data isolation, serverless functions for the agent proxy. Fast to stand up. |
| Agent brain | **Hybrid, tiered** — see `05-MODEL-STRATEGY.md` | On-device for speed/privacy/offline; cloud for higher-quality + reflective turns. All behind one `LLMProvider` interface. |
| Tier 0 — on device | **Gemma 4 E4B/E2B** (Apache-2.0), quantized | Instant, private, **offline-capable** supportive conversation + urge-wave exercise. |
| Tier 1 — cloud hot path | **Claude Haiku** (`claude-haiku-4-5-20251001`) via backend proxy | Escalated / higher-quality turns. Never call the model from the device. |
| Tier 2 — cloud reflective | **Claude Sonnet** (`claude-sonnet-4-6`) or self-hosted **Gemma 4 31B** | Off hot path: analytics summaries, pattern detection, personalization. |
| Voice — STT | Streaming speech-to-text provider (e.g., Deepgram or device-native speech) | Real-time transcription of the user during a voice session. |
| Voice — TTS | Streaming text-to-speech provider | The buddy voice. Pick a low-latency, warm-sounding voice. |
| Media storage | **Cloudflare R2** (S3-compatible, no egress fees) | Hosts the curated song/video/image library assets. Postgres `media_library` rows store R2 object URLs, not external links — gives us content ownership + quality control. |
| Media playback | Embedded player (audio/video) streaming from R2 (signed URLs) | Controlled, safe, taggable content for interventions. |
| Push | Expo Notifications | Proactive check-ins. |
| Analytics (product) | PostHog or similar (privacy-respecting) | Funnels, retention — separate from the user's clinical event log. |

> Note: Anthropic does not provide native STT/TTS — voice uses a third-party speech layer wrapped around the Claude text agent. Keep that boundary clean so the voice provider is swappable.

> Gotcha: Supabase Edge Functions run on **Deno**, not Node. The Anthropic SDK works in Deno but imports differ (`npm:` specifiers / esm.sh) and there's no Node `process`/filesystem. The R2 client should use the S3-compatible API over `fetch` (e.g. `aws4fetch`) rather than the AWS Node SDK. Budget a little setup time for this.

## 3. High-level system diagram (textual)

```
┌─────────────────────────────────────────────┐
│  Mobile app (React Native / Expo)            │
│                                              │
│  • Panic button → Session screen             │
│  • Chat / Voice UI (streaming)               │
│  • Media player (song/video/image)           │
│  • Urge-wave exercise                        │
│  • Outcome capture                           │
│  • Analytics screen                          │
│  • Local SQLite event log (offline-first)    │
└───────────────┬──────────────────────────────┘
                │ HTTPS (auth'd)         ▲ stream
                ▼                        │
┌─────────────────────────────────────────────┐
│  Backend (Supabase Edge Functions)           │
│                                              │
│  /session/turn   → builds context, calls     │
│                    Claude (Haiku), streams    │
│                    back, light output check   │
│  /personalize    → updates per-user counters  │
│  /insights       → Sonnet summarizes patterns │
│  /media/suggest  → picks media by user profile│
│                    (returns signed R2 URLs)   │
└───────────────┬──────────────────────────────┘
                │
     ┌──────────┼───────────┬──────────────┐
     ▼          ▼           ▼              ▼
Claude API  Postgres(RLS) Cloudflare R2  Speech provider
(Haiku/     • users       (media assets) (STT/TTS)
 Sonnet)    • urge_events
            • messages
            • media_library  (R2 URLs)
            • user_media_stats
            • risk_windows
```

## 4. The agent loop (in-the-moment session)

1. **Trigger.** User taps the panic button (or responds to a proactive nudge). App opens the Session screen instantly and creates an `urge_event` (status: `active`) locally.
2. **Route (see `05-MODEL-STRATEGY.md`).** The `ModelRouter` picks the tier: on-device Gemma for ordinary turns, escalate to cloud Claude when the small model is low-confidence or the task is deep.
3. **Context assembly.** Build the prompt: system persona (doc 3) + user profile summary + recent history + trigger context + personalization profile. On-device turns assemble locally; escalated turns assemble in the backend `/session/turn`.
4. **Live response.** Stream the chosen model's reply token-by-token to the device. If voice mode: pipe text to TTS (server-side Sesame CSM) as it streams.
5. **Intervention branching.** The agent can call lightweight "tools" (function calls) to: suggest media (`suggest_media`), launch the urge-wave exercise (`start_wave_exercise`), or set a short follow-up timer. The app renders the corresponding UI inline.
6. **Light output check (optional).** A cheap keyword screen on model output (no medical advice, no shaming, no harmful coping) can run as insurance — **not** a blocking gate, never on the latency-critical path. The "this isn't for emergencies → 988" off-ramp lives in the persona prompt, not a deterministic gate. See doc 3 §8.
7. **Resolution.** When the user ends the session, capture the outcome (resisted / gave in / unsure) + a 1-tap "did this help?" The `urge_event` is finalized and synced.
8. **Learn.** `/personalize` updates `user_media_stats` and framing counters from the outcome.

## 5. Data model (Postgres, all per-user RLS-protected)

```sql
users
  id, created_at, display_name, habit_type,   -- MVP: 'smoking' | 'vaping'
  onboarding_profile jsonb,        -- goals, triggers, preferred tone
  consent_flags jsonb

urge_events
  id, user_id, started_at, ended_at,
  trigger_context jsonb,           -- time, place, mood, what set it off
  mode text,                       -- 'text' | 'voice'
  outcome text,                    -- 'resisted' | 'gave_in' | 'unsure' | null
  helped boolean,                  -- 1-tap feedback
  intensity_start int,             -- 0-10 self-report
  intensity_end int

messages
  id, urge_event_id, role,         -- 'user' | 'assistant' | 'system'
  content text, created_at,
  media_id nullable, modality text -- 'text' | 'voice'

media_library
  id, type,                        -- 'song' | 'video' | 'image' | 'exercise'
  title, r2_url, tags text[],      -- r2_url = Cloudflare R2 object; tags e.g. ['healthy-habit','what-you-gain','calming']
  framing text                     -- 'encouragement' | 'what-you-gain' | 'distraction' | 'education'

user_media_stats
  user_id, media_id,
  shown_count int, engaged_seconds int,
  resisted_after int, gave_in_after int
  -- running tallies that drive personalization v1

user_framing_stats
  user_id, framing,                -- which *style* works for this user
  shown_count int, resisted_after int

risk_windows
  user_id, day_of_week, hour, weight  -- learned later; MVP can seed from onboarding
```

> Offline mirror: the device keeps a local SQLite copy of `urge_events` + `messages`; a sync worker reconciles on reconnect. Conflict policy: device is source of truth for an event it created; server-owned counters (e.g. personalization stats) are server-authoritative and merged additively, not overwritten by the device.

## 6. Personalization v1 (no ML — deliberately simple)

The MVP does **not** need machine learning. It needs honest bookkeeping:

- For each media item and each framing style, keep running counters of *shown*, *engaged time*, and *resisted-after*.
- A simple score per item = `resist_rate * engagement_weight`, with a small exploration bonus (so the app occasionally tries under-sampled content — epsilon-greedy).
- `/media/suggest` ranks the library for this user by that score, filtered to the current context tags.
- Same idea for framing: if "what-you-gain" content correlates with resists for this user, the agent's *message* framing shifts that way too (passed into the prompt as a hint).

This is a multi-armed-bandit in spirit, implemented as plain counters. It's explainable, debuggable, and good enough to show real personalization. ML/embeddings is a Phase 3 upgrade, not an MVP dependency.

## 7. Voice architecture notes

> Provider selection (ElevenLabs / Hume EVI / Cartesia / Sesame CSM) is detailed in `06-VOICE.md`. Voice goes behind a swappable `VoiceProvider` interface.

- Voice = STT (user speech → text) → existing text agent → TTS (reply → audio). Keep the text agent identical across modes so behavior/safety are consistent.
- Stream both directions. Barge-in (user interrupts the agent) is a nice-to-have, not MVP-critical.
- Cache the chosen TTS voice identity; the buddy should sound like the *same* person every time — consistency builds the relationship.

## 8. Security & privacy implementation

- Supabase Row-Level Security on every table: a user can only read/write their own rows.
- API keys (Claude, STT/TTS, **Cloudflare R2**) live only in Edge Functions, never on device. Media is served via short-lived signed R2 URLs.
- Encrypt sensitive `jsonb` columns at the app layer if storing free-text about the user's habit; TLS in transit; Postgres encryption at rest.
- Account deletion = hard delete + cascade (Postgres rows + any user-specific R2 objects), exposed in-app alongside export.
- No third-party ad SDKs. Product analytics (PostHog) gets only de-identified events, never raw conversation content.

## 9. Environments & config

- `.env` (server-side only): `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_KEY`, `STT_KEY`, `TTS_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- Model strings centralized in one config module so they're swappable: `MODEL_DEVICE`, `MODEL_CLOUD_HOT`, `MODEL_CLOUD_REFLECT` (see `05-MODEL-STRATEGY.md §7`), plus routing thresholds (`ESCALATE_ON_LOW_CONFIDENCE`, etc.).
- Feature flags: `onDeviceModelEnabled`, `voiceEnabled`, `proactiveNudges`, `personalizationV1`.

## 10. Testing strategy (see doc 4 for where these slot into the build)

- Unit: personalization scoring, the (optional) output keyword screen, data-model serializers.
- Integration: `/session/turn` happy path. (No blocking crisis-routing test — this is a habit app, not a crisis system; the "not for emergencies → 988" handling is a prompt instruction + disclaimer screen, not a tested gate.)
- E2E: panic-button → session → outcome capture → analytics reflects it.
- Manual: latency budget (first token <1s on a mid-tier phone, normal network).
