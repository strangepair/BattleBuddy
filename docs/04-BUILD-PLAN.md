# BattleBuddy — Phased Build Plan

> Doc 4 of 7. The sequence Claude Code should follow. Start at Phase 0, ship the circuit-breaker core (Phase 1) before anything else.
> Each phase ends with a working, testable increment. MVP target habit: **smoking/vaping**.

---

## Principle: depth-first on the circuit breaker

The single most valuable thing this app does is intercept one urge, once, well. Build that end-to-end first — even if everything around it is stubbed. Don't build the analytics dashboard or personalization ML before a single smoking urge can be handled live. Resist horizontal scaffolding.

---

## Phase 0 — Foundation (repo + skeleton)

Goal: a running app shell and backend with auth, nothing clever yet.

- Initialize Expo + TypeScript app; Expo Router; base navigation (Session, Analytics, Settings tabs).
- Stand up Supabase project: auth (email/anon), Postgres schema from `02-ARCHITECTURE.md §5`, Row-Level Security on every table.
- Backend Edge Function scaffold (Deno) with a health check.
- Create the Cloudflare R2 bucket for media; wire an Edge Function that returns a signed R2 URL (proves the storage path end-to-end).
- Central config module for model strings + feature flags.
- CI: lint, typecheck, test runner wired up.
- **Exit test:** user can sign in, app boots to an empty Session screen, backend health check passes, **and an RLS test confirms a user cannot read another user's rows.**
- ✅ **STATUS (2026-06-15):** Expo app scaffolded with Expo Router + 3 tabs. Central config module at `mobile/src/config/index.ts`. Supabase schema + RLS in `supabase/migrations/001_initial_schema.sql`. Edge Functions: `health` + `session-turn` stub. CI: typecheck ✅ lint ✅ jest 5/5 ✅. Live auth + health check require Supabase project credentials (see `mobile/.env.example` and `supabase/.env.example`).
- ✅ **STATUS (2026-06-21):** Full UX vision build complete. See `BATTLEBUDDY-BUILDPLAN.md` for the 8-phase plan that was executed. All phases delivered: mascot-centric navigation, gesture-driven UX, unified session engine, VOIP-style voice mode, push notifications, personalization, offline resilience, onboarding flow, E2E tests. CI: typecheck ✅ lint ✅ jest 19/19 ✅. 57 source files, 5 Maestro E2E flows, 3 Supabase migrations.

## Phase 1 — Circuit-breaker core (the MVP heart) ⭐

Goal: a user with a smoking urge can get real help, end-to-end, in text.

- **Panic button** on app open → instant Session screen → create local `urge_event`.
- **`/session/turn` Edge Function:** assemble context, call Claude **Haiku**, stream tokens back. (Phase 1 is **cloud-only** — the on-device Gemma tier is added later, in Phase 2.5, on top of this proven loop. See `05-MODEL-STRATEGY.md §8`.)
- **Chat UI** with streaming, supportive-coach persona wired from `prompts/system.battlebuddy.md`.
- **Three interventions:**
  - talk-it-through (default chat),
  - `start_wave_exercise` — the guided urge-wave / sensory-anatomy flow (doc 3 §5), capturing `intensity_start`/`intensity_end`,
  - `suggest_media` — pull from a small **curated, tagged media library** (seed 15–20 items) hosted in **Cloudflare R2**.
- **Outcome capture** on session end: resisted / gave in / unsure + 1-tap "did this help?".
- **Scope footing v1:** a "not for emergencies → 988 (US)" disclaimer screen reachable from the app, plus the soft off-ramp baked into the system prompt. (No hard-coded crisis gate, no blocking crisis-phrase CI test — see `03-AGENT-DESIGN.md §8`.) An optional, non-blocking output keyword screen is fine.
- Offline-first local SQLite event log + sync worker.
- **Exit test (E2E):** panic button → conversation → wave exercise shows intensity drop → media suggestion (streamed from R2) → log "resisted" → event persists and syncs.

## Phase 2 — Voice + analytics

Goal: the always-on companion feel, plus the user can see their progress.

- **Voice mode:** STT → existing text agent → **Sesame CSM TTS**, streaming both ways. Same persona as text. Lock one consistent buddy voice via fixed reference audio. Stand up CSM on serverless/scale-to-zero GPU; keep ElevenLabs/Hume behind the same `VoiceProvider` interface as fallback. (Full plan in `06-VOICE.md §5`.)
- One-tap voice entry from the panic flow (quick-button-to-voice).
- **Analytics screen:** streak, urge count over time, resist rate + trend, "what helped" (top interventions/media), intensity-drop visualization from wave exercises.
- **`/insights` Edge Function** using Claude **Sonnet** (off hot path) to generate a short weekly plain-language summary of patterns.
- **Simple proactive check-ins:** 1–2 onboarding-driven scheduled nudges via push, respectful of quiet hours.
- **Exit test:** full voice session works end-to-end with safety intact; analytics accurately reflects logged events; a scheduled nudge fires and opens a session.

## Phase 2.5 — On-device tier (hybrid brain)

Goal: instant, private, offline-capable conversation, without weakening safety. Full design in `05-MODEL-STRATEGY.md`.

- Integrate **Gemma 4 E4B/E2B** on-device (quantized) behind the `LLMProvider` interface; device-capability detection picks the size.
- Build the **`ModelRouter`**: on-device generate → escalate to cloud Claude on low confidence / deep task.
- The static "not for emergencies → 988" disclaimer ships in the app bundle, so it's reachable offline too. The small model isn't asked to handle emergencies; the off-ramp instruction is in its prompt like everywhere else.
- The optional output keyword screen applies to on-device output too.
- **Benchmark** the on-device model against Phase 1 Claude behavior (quality, persona fidelity) before it serves real turns.
- **Exit test:** in airplane mode, supportive chat + urge-wave exercise work; with network on, a low-confidence turn escalates to Claude; persona feels identical across runtimes.

## Phase 3 — Personalization v1 + retraining loop

Goal: the app visibly adapts to the individual.

- `user_media_stats` + `user_framing_stats` counters updated on every outcome.
- **`/media/suggest`** ranks library per user (resist-rate × engagement + epsilon-greedy exploration).
- Framing hints injected into the agent prompt per user (doc 3 §7).
- Personalization is **explainable**: settings screen shows the user "what's working for you" and lets them correct it.
- **Exit test:** two simulated users with different response patterns receive measurably different media/framing over a session set.

## Phase 4+ — Scale beyond the core (post-MVP)

- Learned `risk_windows` (real high-risk time/place/mood detection → smarter proactive timing).
- ML personalization (embeddings/bandits) replacing simple counters.
- Generalize from smoking → broader impulse-resistance habits (doomscrolling, snacking, spending, procrastination).
- Optional: data export, wearable/biometric signals, community.

---

## Cross-cutting requirements (apply every phase)

- **Latency budget:** first agent token <1s on a mid-tier phone, normal network. Measure it.
- **Scope stays honest.** The "not for emergencies → 988" disclaimer + the prompt off-ramp ship in Phase 1 and stay. This is a habit app; we don't add crisis machinery.
- **Privacy:** RLS on, keys (incl. R2) server-side only, delete/export reachable in-app.
- **No dark patterns / no dependency-farming.** Success = the user needing the app *less* over time; analytics should be able to show growing self-efficacy, not just engagement.
- **Every phase ends green:** lint + typecheck + unit + the phase's E2E test all pass before moving on. E2E framework: **Maestro** (simplest for Expo/React Native), running on a simulator in CI.

## Definition of done for the MVP

Phases 0–3 complete: a user can, on iOS or Android, hit one button during a smoking urge, get a warm voice-or-text buddy that helps them ride the wave or redirect, log the outcome, see their progress, and feel the app getting more personal — honest about being a habit companion, not an emergency service.
