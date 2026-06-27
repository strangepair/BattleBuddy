# BattleBuddy — Design Decisions

> Captured from the founding build session (June 21–24, 2026). This document records every significant design decision, UX direction, architecture choice, bug fix, and open item so future sessions can pick up without re-deriving context.

---

## UX & Visual Design

### Avatar / Entity
- **Original design:** Geometric SVG robot with rounded rectangular head, large circular LED eyes with glow halos, comm-panel ears, speaker-grille mouth, double chevron chest insignia (military-companion vibe).
- **Current design:** Replaced robot with an **amorphous blob entity** — 5 layered ellipses rotating at co-prime speeds (37s, 43s, 53s) so they never sync. Core bright circle with highlight. Organic, living energy feel.
- **3 color states:** Blue (`#5B9FFF`) = idle/waiting. Green (`#34C759`) = hearing user speak. Orange (`#FF9F0A`) = BB talking/thinking.
- **Audio reactivity:** `audioLevel` prop drives spring-physics scaling — blob expands and breathes with voice input. Each layer responds differently (outer scales more, inner wobbles asymmetrically).
- **Thinking state:** Subtle side-to-side sway with rhythmic glow pulse while model processes. Distinct from idle (still) and speaking (energetic).

### Navigation
- **Mascot-centric home:** No tab bar. Amorphous entity centered on dark background with time-of-day greeting.
- **Gesture navigation:** Swipe down = chat overlay. Swipe up = voice mode. Tap = chat. Long press = voice. Left edge swipe = drawer.
- **Side drawer:** History, Insights, Analytics, Goals, Routines, Preferences. Custom Reanimated drawer, no `@react-navigation/drawer` dependency.
- **Auto-launch:** App opens directly into voice mode after auth + onboarding. `hasAutoLaunched` ref prevents re-triggering.

### Voice Mode (VOIP Call Feel)
- **Layout:** Header (LIVE badge + blinking dot + call timer) → entity centered → 3-button control bar (Text / End / Mute).
- **Audio visualizer:** 24 bars arranged in a ring around the entity, driven by LiveKit `audioLevel` with spring physics (`withSpring`, damping: 12, stiffness: 280, mass: 0.4). Per-bar phase offsets for organic movement.
- **End Call ceremony:** Heavy haptic → `EndCallOverlay` fades in → entity in empathy state → "Call ended / How did it go?" → fades to outcome capture.
- **Mute:** `MuteControl` component inside `LiveKitRoom` calls `localParticipant.setMicrophoneEnabled(false)` at WebRTC level.
- **"Bye bye buddy":** Voice command triggers graceful session end — BB says goodbye with encouragement, waits 3s, disconnects.

### Chat Mode
- **Full-screen overlay** (replaced `@gorhom/bottom-sheet` which caused layout issues with `KeyboardAvoidingView`).
- **Inverted FlatList:** Standard chat pattern — newest messages at bottom, auto-scroll.
- **Input:** Bottom-pinned, `multiline`, expands vertically up to 120px, safe area padding.
- **Voice switch FAB:** Coral pill "🎙 Switch to voice" floating above input.
- **Previous session:** Prior session messages shown above a `── previous session ──` separator.
- **Markdown rendering:** `react-native-markdown-display` for assistant messages (bold, lists, code, blockquotes) with dark theme styles.

### Onboarding
- 4-step flow: Welcome (entity in idle) → Habit target (smoking pre-selected) → Triggers (6 selectable chips) → Disclaimer (988 info).
- Progress dots, fade transitions, stored in AsyncStorage via `useOnboarding` Zustand store.
- Shared store pattern (not `useState`) so layout and onboarding screen see the same state.

### Auth
- **Local auth** (AsyncStorage-based) for now — name, email, password (simple hash).
- Each account gets unique `user-{timestamp}` ID that flows through entire pipeline.
- Name from signup seeded into profile so BB knows the user's name from first interaction.
- Sign out in Preferences screen.
- **Planned:** Supabase Auth with magic link + Apple Sign In for multi-device and cloud persistence.

---

## Architecture

### Conversation Pipeline
```
User ↔ Haiku (fast, real-time conversation)
         ↓ messages stream through LiveKit (voice) or /session/turn (text)
     Sonnet (background context agent) — extracts facts, updates profile
         ↓
     Context Store (server/context-store/{userId}.json)
         ↓
     Next session: server reads profile → bakes into system prompt
```

### Dual-Agent Architecture
- **Real-time agent:** Claude Haiku (`claude-haiku-4-5-20251001`) — fast, conversational, what the user talks to.
- **Background context agent:** Claude Sonnet (`claude-sonnet-4-6`) — runs separately, analyzes conversations, extracts structured facts, updates cumulative user profile. Never on the hot path.
- **Voice TTS:** Deepgram Aura (cloud, instant). Sesame CSM abandoned due to subprocess initialization timeouts and heavy memory usage (~4-12GB per process).
- **Voice STT:** Deepgram Nova 3.
- **Voice transport:** LiveKit Cloud (US West B region).

### Session Store (Zustand)
- Single source of truth: `sessionId`, `mode` (text/voice/idle), `messages[]`, `isStreaming`, `mascotState`, `triggerContext`, `profileSummary`, `recentHistory`, `sessionCount`, `previousMessages`.
- Messages tagged by `mode` so voice and text history interleave correctly.
- `switchMode(to)` changes mode without clearing messages — conversation carries over.
- `endSession()` triggers session report generation and saves messages to AsyncStorage.
- `sessionCount`, `profileSummary`, `recentHistory` persisted to AsyncStorage and hydrated on app launch.

### Voice ↔ Text Bridge
- **Text → Voice:** App sends `priorMessages` (last 10 messages as text), `profile`, `recentHistory`, `triggerContext` in the LiveKit token request body. Server passes all of it via dispatch metadata. Agent reads it and builds system prompt with full context.
- **Voice → Text:** `TranscriptCapture` component inside `LiveKitRoom` listens for `RoomEvent.TranscriptionReceived` and writes transcripts into the session store. When user switches to text, chat reads the full message history including voice turns.
- **Greeting logic:** `switched_from_text` context → casual acknowledgment. Fresh session → "Hey, [name]! How's it going?"

### Context Agent (server/contextAgent.js)
- Maintains a **structured JSON profile** per user at `server/context-store/{userId}.json`.
- Profile only grows — new facts added, existing facts overwritten when corrected, nothing lost.
- Fields: name, age, location, occupation, family, addiction_type, substance_history, daily_usage, quit_reason, health_concerns, previous_quit_attempts, longest_quit, triggers[], coping_strategies[], what_works[], what_doesnt_work[], motivations[], life_context[], preferred_coping_style, response_preference, emotional_patterns, user_quotes[], recent_insights[], next_session_hints[].
- `buildProfileSummary(userId)` generates natural-language profile text from the structured data for injection into `{{profile}}`.
- Extraction prompt demands **verbatim quotes**, exact numbers, specific names — not vague abstractions.
- Corrections overwrite old data — "return the corrected value, not 'user corrected this.'"

### Log Watcher (server/logWatcher.js)
- Agent subprocess can't reliably make HTTP calls or write files (LiveKit forks child processes).
- Solution: agent writes to stdout → piped to `server/agent.log` → LogWatcher polls every 10 seconds → detects `session closed` events → extracts conversation for that room → sends to context agent.
- Processed rooms tracked in a Set to avoid re-processing.

### Server (server/index.js)
- Node.js, no framework, raw HTTP.
- Endpoints: `/session/turn` (text chat streaming), `/session/report` (post-session Sonnet analysis), `/livekit/token` (token + dispatch), `/transcribe` (Whisper STT), `/push/register`, `/nudge/send`, `/context/profile/:userId`, `/context/analyze`, `/context/seed`, `/admin` (voice selection), `/admin/voice`, `/health`.
- System prompt loaded from `prompts/system.battlebuddy.md` at startup.
- For voice: server builds the complete system prompt + greeting and passes via dispatch metadata. Agent doesn't wait for participants.
- For text: server calls `buildProfileSummary(effectiveUserId)` to get context agent's profile, falls back to client-provided profile.
- Both paths fire `analyzeAndUpdate()` in background (non-blocking) for mid-conversation Sonnet analysis.

### Voice Agent (agent/agent.py)
- LiveKit Agents SDK, Python.
- `AgentSession` with Deepgram STT (nova-3), Claude Haiku LLM, Deepgram TTS (configurable voice via `server/voice-config.json`).
- `min_endpointing_delay=0.5`, `max_endpointing_delay=1.5` — responds faster than default.
- `conversation_item_added` event tracks all messages in `session_messages[]`.
- `close` event attempts to write transcript to disk and call context agent (unreliable in subprocess — LogWatcher is the backup).
- Voice configurable from in-app Preferences → Buddy's Voice screen.

### Persistence
- **On-device:** AsyncStorage for auth, onboarding, session count, profile summary, recent history, last session messages, local session reports.
- **On-device (SQLite):** `expo-sqlite` for craving_events, messages, biometric_events — write-local-first.
- **Server:** `context-store/{userId}.json` — cumulative structured profile.
- **Cloud (Supabase):** Schema exists (users, craving_events, messages, media_library, user_media_stats, user_framing_stats, risk_windows, push_tokens, notification_preferences, session_reports, journey_phases, user_context_profiles, biometric_anomalies) but not fully wired due to no auth userId in production yet.

---

## System Prompt Philosophy

The system prompt (`prompts/system.battlebuddy.md`) was iteratively refined during user testing. Key principles:

1. **AA Sponsor Model:** The north star. Always available, no judgment, no interrogation, normalize slips, inspire resilience, call bullshit gently, let them sit with hard things.
2. **The conversation IS the intervention.** Picking up the phone instead of a cigarette. If they're smoking while talking, that's fine — it's data, not shame.
3. **Observe, don't interrogate.** Don't ask "what are your triggers?" Listen to five conversations and say "I've noticed you always light up after you eat."
4. **ONE question at a time.** 2-3 sentences max. In voice, 10 seconds max.
5. **Never mention internal state.** No "my profile says," no "I don't have context," no "blank slate." Use what you know. Ask naturally for what you don't.
6. **Corrections overwrite.** When the user corrects something, the old data is gone. No "user corrected this" — just the right answer.
7. **First session:** Greet by name, ask what they're battling, explain how BB works (training partner, not countdown app), don't interview.
8. **Returning sessions:** Greet by name, one observation from what you know, "How are you doing?"

---

## Bugs Fixed During Founding Session

| Bug | Root cause | Fix |
|---|---|---|
| Onboarding "I understand" button did nothing | `useState` in two components = two separate state copies | Replaced with shared Zustand store (`useOnboardingStore`) |
| Chat overlay not bottom-justified | `@gorhom/bottom-sheet` fighting with `KeyboardAvoidingView` | Replaced with full-screen overlay + inverted `FlatList` |
| Voice not responding (simulator) | iOS simulator doesn't pass mic audio through WebRTC | Switched to physical iPhone testing |
| Sesame CSM TTS crashes | Missing `torchao`, `bitsandbytes`, `huggingface_hub` version mismatches, FFmpeg incompatibility | Switched to Deepgram TTS (cloud, instant, no GPU) |
| Server IP hardcoded to wrong address | LAN IP changed since config was written | Added `EXPO_PUBLIC_CHAT_URL` to `.env.local`, updated fallback |
| Voice agent not receiving profile | Participant metadata race — agent reads metadata before user joins | Server now builds prompt and passes via dispatch metadata (no waiting) |
| Agent keeps re-onboarding | `sessionCount` not persisting across app restarts (Zustand in-memory) | Added AsyncStorage persistence + hydration on launch |
| Profile says "New user" after sessions | `outcomeRecorder` writes to AsyncStorage, server reads from `context-store/` — two separate stores | Unified on server-side `context-store/` via context agent |
| Session transcripts not captured from voice | LiveKit subprocess swallows HTTP calls and file writes | LogWatcher parses agent stdout log for `session closed` events |
| AppDrawer crash on gesture | `animateTo` called from Reanimated worklet but is a JS function | Inlined animation logic in worklet with `'worklet'` directive |
| Push notifications crash on free dev account | `aps-environment` entitlement not supported | Removed `expo-notifications` plugin from `app.json`, stripped entitlement |
| `react-native-health` build failure | Incompatible with React Native 0.85 | Removed from dependencies (biometrics deferred) |
| Google Sign-In pod conflict | `AppCheckCore` Swift pod needs `use_modular_headers!` | Removed Google native SDK, switched to Supabase OAuth redirect |

---

## Open Items / Backlog

### Critical Path
- [ ] **Automated session capture:** LogWatcher v2 is deployed but needs verification that it reliably processes every closed session without manual intervention.
- [ ] **Supabase Auth:** Wire magic link + Apple Sign In so data persists in cloud, not just local. Enables multi-device.
- [ ] **Railway deployment:** Move Node server + agent off Mac for the app to work without the dev machine.

### Product
- [ ] **Media library during voice:** While BB speaks, show relevant imagery/video behind the entity — calming nature for urge-wave, motivational for celebration, empathetic for tough moments. Tagged by sentiment, matched to conversation context.
- [ ] **Session transcript export:** Flag conversations for product review (separate from user's private profile).
- [ ] **Proactive outreach:** Engagement engine state machine is built but needs push notification infrastructure (requires paid Apple Developer account).
- [ ] **Biometric integration:** HealthKit code exists but `react-native-health` is incompatible with RN 0.85. Need alternative library.

### Technical
- [ ] **Profile size management:** Context agent profile grows unbounded. Need to summarize/compress older entries when profile exceeds token budget.
- [ ] **Supabase pgvector:** Semantic search over past sessions for "find the conversation where Mike talked about X."
- [ ] **On-device model (Gemma):** Tier 0 for instant, private, offline-capable responses. Architecture scaffolded but not implemented.
- [ ] **Batch profiler:** `server/batchProfiler.js` exists but not scheduled. Needs cron or Railway scheduled task.
- [ ] **Wave exercise UI:** `start_wave_exercise()` tool defined in system prompt but no guided UI component built.
- [ ] **Media suggestion endpoint:** `suggest_media()` tool defined but no R2 media library or `/media/suggest` endpoint.

### Design
- [ ] **Onboarding redesign:** Current 4-step flow may be unnecessary — BB handles onboarding conversationally now. Consider removing formal onboarding in favor of just the auth screen → straight to voice.
- [ ] **Insights screen:** Built but needs real data flowing through Supabase to be useful. Currently shows empty state.
- [ ] **Analytics/Goals screens:** Scaffolded with profile data but limited without persistent Supabase auth.

---

## Key Files

| File | Purpose |
|---|---|
| `prompts/system.battlebuddy.md` | The system prompt — BB's personality, rules, knowledge |
| `server/index.js` | Node server — all API endpoints |
| `server/contextAgent.js` | Background Sonnet agent — fact extraction + profile building |
| `server/logWatcher.js` | Watches agent log for session closures → triggers context analysis |
| `agent/agent.py` | LiveKit voice agent — Haiku + Deepgram |
| `mobile/src/stores/sessionStore.ts` | Zustand store — session state, messages, profile |
| `mobile/src/stores/authStore.ts` | Local auth (AsyncStorage-based) |
| `mobile/src/components/mascot/BBMascot.tsx` | Amorphous blob entity |
| `mobile/src/components/mascot/useMascotAnimation.ts` | Animation hook — 3 color states, breathing, ring pulse |
| `mobile/src/components/chat/ChatBottomSheet.tsx` | Full-screen chat overlay |
| `mobile/app/session-voice.tsx` | Voice mode screen |
| `mobile/src/hooks/useSessionChat.ts` | Chat orchestration hook |
| `mobile/src/services/chatStream.ts` | SSE streaming client |
| `mobile/src/config/index.ts` | Central config — model strings, feature flags, API URLs |
| `BATTLEBUDDY-BUILDPLAN.md` | Original 8-phase build plan |

---

> This document should be updated as major decisions are made. It is the source of truth for "why is it built this way?"
