# CLAUDE.md — BattleBuddy

Standing instructions for any Claude Code (or Dispatch) session working in this repo. Read this first, then the docs in `docs/`.

## What this is

BattleBuddy is a mobile (iOS + Android) AI companion that acts as a real-time **circuit breaker for urges** — a warm, supportive coach that interrupts a habit loop in the moment, offers dopamine-positive replacements, and learns what works for each user. The skill it trains is **impulse resistance**. **MVP target habit: quitting smoking/vaping** (US-only). It is a habit-change companion for everyday urges, **not** a crisis service or medical provider. Full concept in `docs/01-PRD.md`.

## Spec docs (read in order)

1. `docs/01-PRD.md` — product concept, scope, MVP cut line, safety footing.
2. `docs/02-ARCHITECTURE.md` — stack, agent loop, data model, personalization.
3. `docs/03-AGENT-DESIGN.md` — persona, prompts, tools, and the **safety/scope design**.
4. `docs/04-BUILD-PLAN.md` — the phased build sequence. **Start at Phase 0; ship Phase 1 (circuit-breaker core) before anything else.**
5. `docs/05-MODEL-STRATEGY.md` — hybrid on-device (Gemma) + cloud (Claude) brain, routing tiers, cross-tier safety.
6. `docs/06-VOICE.md` — voice persona / provider selection (Sesame CSM) and integration.

## Stack (don't drift without reason)

- React Native + Expo + TypeScript (Expo Router).
- Supabase: Postgres + Auth + Row-Level Security + Edge Functions.
- **Hybrid, tiered agent brain** (full design in `docs/05-MODEL-STRATEGY.md`):
  - Tier 0 — **on-device Gemma 4 E4B/E2B** (Apache-2.0, quantized): instant, private, **offline-capable** ordinary turns + urge-wave exercise.
  - Tier 1 — **Claude Haiku** (`claude-haiku-4-5-20251001`) via backend proxy: higher-quality / escalated turns. **Never call cloud models from the device.**
  - Tier 2 — **Claude Sonnet** (`claude-sonnet-4-6`) or self-hosted **Gemma 4 31B**: reflective/analytics, off the hot path.
  - All behind one `LLMProvider` interface + a `ModelRouter`. Escalation is biased toward quality: when the small model is unsure or the task is deep, escalate to cloud.
- **Media storage = Cloudflare R2** (S3-compatible, no egress fees) for the curated song/video/image library; Supabase Postgres stores everything else (rows reference R2 URLs).
- Voice = STT → text agent → TTS; same agent in voice and text. **TTS = Sesame CSM** (Apache-2.0, self-/managed-GPU-hosted) per `docs/06-VOICE.md`; ElevenLabs/Hume kept behind the same `VoiceProvider` interface as fallback. Lock ONE consistent buddy voice (fixed reference audio, fine-tune only if it drifts).
- Model strings + feature flags live in one central config module.

## Non-negotiable rules

1. **This is a habit app, not a crisis/clinical product — keep the safety footing light and honest** (see `docs/03-AGENT-DESIGN.md §8`). What we keep: a clear "not for emergencies, contact 988 (US)" disclaimer screen, and a soft model-level off-ramp in the system prompt (if someone sounds in genuine crisis, the buddy says it's an AI for habits, points to 988, and stops). What we deliberately do **not** build: hard-coded crisis gates, deterministic pre/post crisis screens, a blocking crisis-phrase CI test, or any withdrawal-management path. (Nicotine has no dangerous withdrawal.) Don't reintroduce that machinery without a product reason.
2. **No medical/dosing/treatment advice.** The buddy gives encouragement and distraction, not medical instructions.
3. **No shaming slips; no pain/harm-based coping suggestions.** Always honest that it's an AI.
4. **Privacy:** RLS on every table; Claude/STT/TTS/R2 keys server-side only; in-app delete + export. No ad SDKs. Product analytics gets de-identified events only — never conversation content.
5. **Latency is the product:** first agent token <1s on a mid-tier phone. Measure it.
6. **Depth-first:** make one urge (a smoking urge) handled end-to-end before building breadth. No dependency-farming dark patterns — success = the user needing the app less over time.

## The system prompt lives in a file

The buddy persona/system prompt is `server/prompts/system.battlebuddy.md` so it can be tuned without code changes. Keep it there; don't inline it.

## Working agreement

- Every phase ends green: lint + typecheck + unit + that phase's E2E test pass before moving on.
- When you finish a phase, update `docs/04-BUILD-PLAN.md` exit-test status.
- If you must deviate from the spec, note it in a `DECISIONS.md` log with the reason.
- Ask before adding new third-party SDKs (privacy surface).
