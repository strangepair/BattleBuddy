# BattleBuddy — UX Vision Build Plan

> Comprehensive, phased plan to transform the current tab-based prototype into the mascot-centric, gesture-driven companion app described in Mike's hand-drawn UX sketch.
>
> **North star:** A companion that lives on your phone. It reaches out proactively. The BB robot mascot is the visual anchor. Switching between voice and text feels seamless and intimate. Every decision serves that vision.
>
> **Date:** 2026-06-21. Supersedes the original `docs/04-BUILD-PLAN.md` for UI/UX direction while preserving its backend milestones.

---

## What we're preserving (working infrastructure)

These are solid and reusable regardless of navigation changes:

| Asset | Location | Status |
|---|---|---|
| Claude Haiku streaming backend | `server/index.js` → `/session/turn` | Working, SSE streaming |
| LiveKit voice agent (Claude + Deepgram + Sesame CSM) | `agent/agent.py` | Working |
| LiveKit token endpoint | `server/index.js` → `/livekit/token` | Working |
| System prompt (persona, tools, safety) | `prompts/system.battlebuddy.md` | Complete |
| Supabase schema + RLS | `supabase/migrations/001_initial_schema.sql` | Complete |
| Central config module | `mobile/src/config/index.ts` | Complete |
| Chat streaming logic | `mobile/src/components/feed/ChatSheet.tsx` | Working (will be refactored) |
| Voice mode (pulsing avatar, 3 states) | `mobile/app/session-voice.tsx` | Working (will be refactored) |
| Whisper STT transcription | `server/index.js` → `/transcribe` | Working |
| Sesame CSM TTS server | `sesame-csm/tts_server.py` | Working |
| Expo + TypeScript + Expo Router scaffold | `mobile/` | Working |
| CI: typecheck + lint + jest | `mobile/package.json` scripts | Green (5/5) |

**Key dependencies already installed** (no new installs needed for core gesture/animation work):
- `react-native-gesture-handler` ~2.31.1
- `react-native-reanimated` 4.3.1
- `zustand` ^5.0.14
- `expo-sqlite` ~56.0.5
- `@tanstack/react-query` ^5.101.0
- `expo-linear-gradient` ^56.0.4
- `@livekit/react-native` ^2.11.1

---

## Phase 1 — BB Mascot & Design System

**Goal:** Establish the visual identity. The BB robot character becomes a real asset that can be rendered, animated, and used as the emotional anchor across every screen.

### Why this is first

Every subsequent phase references "the mascot" — the pulsing logo, the home screen centerpiece, the voice-mode avatar. Without a real asset, we'd be building UX around placeholder emojis and then reworking it all. Get the character right first.

### Deliverables

1. **BB mascot SVG asset** — a friendly robot character, simple enough to render at 60fps on a mid-tier phone, expressive enough to convey states (idle, listening, speaking, celebrating, empathy).

2. **Animated mascot component** with discrete states:
   - `idle` — gentle breathing/floating animation (default home screen)
   - `listening` — subtle pulse, ears/antenna active (voice mode, waiting for user)
   - `speaking` — mouth/glow animation, ring color shifts (voice mode, AI responding)
   - `celebrating` — bounce/sparkle (user resisted an urge)
   - `empathy` — soft glow, still (user slipped, no shame)

3. **Design tokens module** — formalized color palette, typography, spacing, and shadow system that every component references.

4. **Mascot test screen** — a temporary dev screen that renders the mascot in all 5 states, confirming animation performance.

### Files to create

| File | Purpose |
|---|---|
| `mobile/assets/bb-mascot.svg` | Static BB robot character (source asset) |
| `mobile/src/components/mascot/BBMascot.tsx` | Animated mascot component using Reanimated |
| `mobile/src/components/mascot/useMascotAnimation.ts` | Animation hook: state → Reanimated shared values |
| `mobile/src/theme/tokens.ts` | Design tokens: colors, typography, spacing, radii, shadows |
| `mobile/src/theme/index.ts` | Re-export barrel |
| `mobile/app/dev-mascot.tsx` | Temporary test screen for mascot states |

### Files to modify

| File | Change |
|---|---|
| `mobile/src/config/index.ts` | Add `MascotState` type export |

### Tech decisions

| Decision | Choice | Rationale |
|---|---|---|
| Mascot format | **SVG rendered via Reanimated** (not Lottie) | We already have Reanimated 4.3 installed. SVG keeps the asset editable in code (no After Effects round-trip). Reanimated's `useAnimatedStyle` + shared values give 60fps on the UI thread. Lottie would require a new dependency (`lottie-react-native`) and a designer workflow we don't have. |
| SVG rendering | **`react-native-svg`** (Expo includes it) | Standard for RN SVG. Pairs directly with Reanimated animated props. |
| Design tokens | **Plain TypeScript object** (not styled-components/Tamagui) | Zero new dependencies. Import and use. Consistent with the codebase's current approach (inline StyleSheet). |

### Open question for Mike

> **Q1: BB character design.** I can create a simple, friendly robot character in SVG — rounded shapes, expressive "eyes" (LED-style circles), small antenna, warm color palette (the existing `#E8624A` coral as accent). Should I proceed with this direction, or do you have a specific character design / reference in mind? If you have a sketch or reference image of the BB robot from your drawings, share it and I'll match it.

### Acceptance criteria

- [ ] `BBMascot` component renders in all 5 states without frame drops (test on iOS simulator)
- [ ] Mascot SVG is under 10KB (performance on low-end devices)
- [ ] Design tokens are used by the mascot component (no hardcoded colors)
- [ ] `npm run ci` passes (typecheck + lint + tests)
- [ ] Dev mascot screen shows all states with tap-to-switch

### Estimated scope

~1 session. The mascot is a visual blocker for everything else.

---

## Phase 2 — Navigation Rebuild: Mascot-Centric Home

**Goal:** Replace the tab bar with the sketch's gesture-driven, mascot-centric home. The BB robot is the centerpiece. Swipe down reveals chat. Swipe up enters voice mode. Side drawer holds everything else.

### Why this comes second

The navigation model is the biggest structural change. Every subsequent phase (unified sessions, push notifications, personalization screens) needs to know where things live. Do this early, break it once, then build on stable ground.

### Deliverables

1. **Mascot home screen** — full-screen dark canvas, BB mascot centered and gently animated (idle state). Subtle contextual greeting text below ("Ready when you are" / time-of-day greeting). No tab bar.

2. **Gesture navigation:**
   - **Swipe down** (or tap mascot) → chat bottom sheet slides up from the bottom, auto-starts a conversation
   - **Swipe up** (or long-press mascot) → full-screen voice mode activates with transition animation
   - Visual affordances: subtle chevron hints above and below the mascot so the gestures are discoverable

3. **Side drawer** — swipe from left edge or tap hamburger icon. Contains:
   - History (past sessions list)
   - Analytics (the existing Progress screen, moved here)
   - Goals (placeholder for now — habit targets, milestones)
   - Routines (placeholder — scheduled check-in preferences)
   - Preferences (the existing Settings screen, moved here)

4. **Bottom sheet chat panel** — the existing `ChatSheet` logic refactored into a proper bottom sheet that can be swiped to expand/collapse, with the mascot visible behind it at half-height.

### Files to create

| File | Purpose |
|---|---|
| `mobile/src/components/home/HomeScreen.tsx` | Mascot-centric home with gesture zones |
| `mobile/src/components/home/GestureHints.tsx` | Animated chevron affordances (swipe up/down hints) |
| `mobile/src/components/drawer/AppDrawer.tsx` | Side drawer component |
| `mobile/src/components/drawer/DrawerMenu.tsx` | Menu items: History, Analytics, Goals, Routines, Preferences |
| `mobile/src/components/chat/ChatBottomSheet.tsx` | Bottom-sheet chat (refactored from ChatSheet) |
| `mobile/src/hooks/useGreeting.ts` | Time-of-day contextual greeting logic |
| `mobile/app/(app)/_layout.tsx` | New root layout with drawer wrapping |
| `mobile/app/(app)/index.tsx` | New home screen entry point |
| `mobile/app/(app)/history.tsx` | Session history list |
| `mobile/app/(app)/goals.tsx` | Goals placeholder screen |
| `mobile/app/(app)/routines.tsx` | Routines placeholder screen |

### Files to modify

| File | Change |
|---|---|
| `mobile/app/_layout.tsx` | Replace tab navigator with drawer-based layout |
| `mobile/app/session-voice.tsx` | Integrate mascot component as the voice avatar (replacing 💪 emoji) |

### Files to remove (replaced)

| File | Replaced by |
|---|---|
| `mobile/app/(tabs)/_layout.tsx` | `mobile/app/(app)/_layout.tsx` |
| `mobile/app/(tabs)/index.tsx` | `mobile/app/(app)/index.tsx` (HomeScreen) |
| `mobile/app/(tabs)/analytics.tsx` | `mobile/app/(app)/analytics.tsx` (moved to drawer) |
| `mobile/app/(tabs)/settings.tsx` | `mobile/app/(app)/preferences.tsx` (moved to drawer) |

### Tech decisions

| Decision | Choice | Rationale |
|---|---|---|
| Bottom sheet | **`@gorhom/bottom-sheet`** v5 | Best-in-class for RN. Built on Gesture Handler + Reanimated (both already installed). Supports snap points, backdrop, keyboard handling. Far more reliable than building from scratch. |
| Side drawer | **Custom Reanimated drawer** | Simpler than adding `@react-navigation/drawer` (which brings `react-native-drawer-layout`). We only need a slide-from-left panel with menu items — Reanimated's `useAnimatedStyle` + `PanGestureHandler` handles this in ~80 lines. Keeps dependencies minimal. |
| Gesture detection | **`react-native-gesture-handler`** (installed) | `Gesture.Pan()` for swipe up/down detection on the home screen. Composed gestures so drawer-swipe and chat-swipe don't conflict. |
| Navigation structure | **Expo Router group** `(app)` | Replace `(tabs)` group with `(app)` group. Drawer screens are stack screens within this group, not tabs. Voice mode remains a full-screen modal. |

### Dependency to install

```
npx expo install @gorhom/bottom-sheet
```

This is the **only new dependency** in the entire plan. It has zero transitive deps beyond what's already installed (Reanimated + Gesture Handler).

### Open question for Mike

> **Q2: "Choose AI Buddy" (swipe down).** Your sketch mentions "swipe down to choose AI Buddy." For MVP, there's one buddy personality. Should "choose" mean (a) selecting from multiple buddy personas in the future (in which case we scaffold the concept but show one), or (b) it just means "activate / summon your buddy" (i.e., swipe down starts a chat with *the* buddy)?

### Acceptance criteria

- [ ] App opens to mascot-centric home — no tab bar visible
- [ ] Swipe down on home → chat bottom sheet slides up with auto-greeting
- [ ] Swipe up on home → voice mode screen activates
- [ ] Swipe from left edge → side drawer opens with all 5 menu items
- [ ] Chat bottom sheet can be swiped to collapse back to home
- [ ] Voice mode uses BB mascot component (not emoji) as the avatar
- [ ] Drawer items navigate to their respective screens (History, Analytics, Goals, Routines, Preferences)
- [ ] Deep link `battlebuddy://` still opens the app correctly
- [ ] `npm run ci` passes

### Dependency on Phase 1

Requires: `BBMascot` component and design tokens.

### Estimated scope

~2 sessions. This is the largest structural change — touches every screen.

---

## Phase 3 — Unified Session Engine & Voice ↔ Text Bridge

**Goal:** A single session context that persists across voice and text modes. The user can start talking, switch to typing, and the AI remembers everything. This is what makes the experience feel like one continuous relationship, not two separate tools.

### Why this matters

The sketch shows voice and text as two views of the same conversation, not two separate apps. Today they're completely isolated — separate screens, separate state, no shared history. The bridge is what makes it feel like talking to *one* buddy.

### Deliverables

1. **Session store (Zustand)** — a single source of truth for the active session:
   - Session ID, start time, mode (`text` | `voice` | `transitioning`)
   - Message history (shared across modes)
   - Urge event metadata (trigger context, intensity)
   - Mascot state (drives animation from one place)

2. **Mode-switch controls:**
   - In chat bottom sheet: a microphone FAB that transitions to voice mode (sheet collapses, voice UI activates, conversation context carries over)
   - In voice mode: a "Switch to text" button that transitions to chat (voice disconnects gracefully, chat sheet opens with full history)
   - Transition animation: mascot morphs between chat-header avatar and full-screen voice avatar

3. **Backend context continuity** — when switching modes, the accumulated messages are passed to the next mode's first request so the AI has full context. For voice→text, the LiveKit conversation history is serialized. For text→voice, the chat messages become the agent's context.

4. **Session lifecycle:**
   - Session starts on first interaction (swipe down or swipe up)
   - Session ends explicitly ("End Call" button in voice, close button in chat, or outcome capture)
   - Outcome capture appears regardless of which mode the session ends in

### Files to create

| File | Purpose |
|---|---|
| `mobile/src/stores/sessionStore.ts` | Zustand session store: messages, mode, mascot state, urge event |
| `mobile/src/stores/types.ts` | Shared types: `Session`, `SessionMessage`, `SessionMode`, `MascotState` |
| `mobile/src/hooks/useSessionChat.ts` | Hook: manages text chat within a session (send, stream, history) |
| `mobile/src/hooks/useSessionVoice.ts` | Hook: manages voice within a session (LiveKit connect/disconnect, status) |
| `mobile/src/hooks/useModeSwitch.ts` | Hook: handles voice↔text transitions, context serialization |
| `mobile/src/components/chat/ModeSwitchFAB.tsx` | Floating mic button in chat → switch to voice |
| `mobile/src/components/voice/SwitchToTextButton.tsx` | Button in voice mode → switch to text |
| `mobile/src/components/voice/EndCallButton.tsx` | Red circle "End Call" button (VOIP style) |
| `mobile/src/components/voice/VoiceOverlay.tsx` | Full-screen voice mode with mascot + controls |

### Files to modify

| File | Change |
|---|---|
| `mobile/src/components/chat/ChatBottomSheet.tsx` | Use session store instead of local state; add mode-switch FAB |
| `mobile/app/session-voice.tsx` | Refactor to use session store; add switch-to-text; replace close with "End Call" |
| `mobile/src/components/feed/OutcomeCapture.tsx` | Wire to session store for outcome persistence |
| `server/index.js` | Accept optional `session_id` + `prior_messages` in `/session/turn` for cross-mode context |

### Tech decisions

| Decision | Choice | Rationale |
|---|---|---|
| Session state | **Zustand store** (installed) | Already a dependency. Lightweight, no provider wrapper needed. Supports subscriptions for mascot animation sync. The architecture doc (`02-ARCHITECTURE.md`) recommends Zustand. |
| Voice→text transcript | **Serialize LiveKit agent messages via events** | LiveKit's `DataChannel` or `RoomEvent.DataReceived` can capture the agent's text responses during voice. Store them in the session store as regular messages. |
| Context handoff | **Pass full message history to backend on mode switch** | Simple, stateless backend. The `/session/turn` endpoint already accepts a `messages` array — we just ensure it includes voice-mode messages too. No server-side session storage needed. |

### Acceptance criteria

- [ ] Start a text chat → switch to voice → AI acknowledges what was discussed in text
- [ ] Start a voice session → switch to text → chat shows prior voice transcript
- [ ] Mascot animation state is consistent across mode switches (no glitch/reset)
- [ ] "End Call" button in voice mode shows outcome capture
- [ ] Close chat bottom sheet shows outcome capture
- [ ] Session messages persist in Zustand across mode switches
- [ ] `npm run ci` passes

### Dependency on Phase 2

Requires: mascot-centric home, chat bottom sheet, voice screen refactored with mascot.

### Estimated scope

~2 sessions. The Zustand store is straightforward; the tricky part is the LiveKit voice transcript capture and smooth transition animations.

---

## Phase 4 — Voice Mode Polish: The VOIP Call Feel

**Goal:** Voice mode should feel like a phone call with your buddy — not like using a voice assistant. The mascot is alive, the audio is responsive, and ending the call feels deliberate.

### Deliverables

1. **Animated mascot states in voice mode:**
   - `listening` — mascot's eyes/antenna gently pulse, ring glows soft blue
   - `speaking` — mascot's mouth area animates, ring shifts to coral (`#E8624A`), subtle scale pulse
   - `user_speaking` — ring shifts to green (`#34C759`), faster pulse, mascot "attentive" pose
   - `connecting` — mascot in muted state, loading indicator

2. **Audio visualization** — subtle waveform or particle effect around the mascot ring that responds to audio amplitude (voice activity level from LiveKit participant events).

3. **"End Call" ceremony:**
   - Red circle button at bottom center (phone-hangup icon)
   - Tap → brief "call ending" animation (mascot waves/nods) → outcome capture
   - Satisfying haptic feedback on end

4. **Call duration timer** — small, unobtrusive timer showing session length (like a phone call).

5. **Background audio handling** — voice session continues if the app goes to background briefly (answering another call, checking a text), resumes when foregrounded.

### Files to create

| File | Purpose |
|---|---|
| `mobile/src/components/voice/AudioVisualizer.tsx` | Waveform/particle ring around mascot driven by audio levels |
| `mobile/src/components/voice/CallTimer.tsx` | Elapsed time display |
| `mobile/src/hooks/useAudioLevel.ts` | Hook: extracts audio amplitude from LiveKit participant |
| `mobile/src/hooks/useHaptics.ts` | Light haptic feedback wrapper (end call, mode switch) |

### Files to modify

| File | Change |
|---|---|
| `mobile/src/components/voice/VoiceOverlay.tsx` | Integrate audio visualizer, call timer, end-call button, mascot states |
| `mobile/src/components/mascot/BBMascot.tsx` | Add audio-level driven animation props for voice mode |
| `mobile/app.json` | Add `UIBackgroundModes: ["audio"]` for iOS background audio |

### Tech decisions

| Decision | Choice | Rationale |
|---|---|---|
| Audio levels | **LiveKit participant `audioLevel` property** | Already available via `useParticipants()`. No new audio processing needed. |
| Haptics | **`expo-haptics`** (Expo built-in) | Already available in Expo SDK 56, no install needed. Light/medium impact for end-call. |
| Background audio | **LiveKit + iOS audio category** | LiveKit handles WebRTC background; we just need the correct audio session category. |

### Acceptance criteria

- [ ] Mascot visually distinguishes all 4 voice states (connecting, listening, speaking, user_speaking)
- [ ] Audio visualizer responds to actual voice volume (not just on/off)
- [ ] "End Call" button has red phone-hangup styling, triggers haptic, shows outcome capture
- [ ] Call timer displays accurate elapsed time
- [ ] Voice session survives a brief app background (5 seconds)
- [ ] Voice mode feels qualitatively different from a "screen" — it should feel like a call
- [ ] `npm run ci` passes

### Dependency on Phase 3

Requires: unified session engine, VoiceOverlay component, mascot integration.

### Estimated scope

~1 session. Mostly animation and polish work on existing infrastructure.

---

## Phase 5 — Push Notifications & Proactive Outreach

**Goal:** The buddy reaches out. Push notifications bring the user to the app at the right moment — this is the "companion that lives on your phone" part of the vision.

### Why this changes everything

Today the app is passive — the user must open it. The sketch starts with a push notification arriving on the lock screen. This inverts the relationship: the buddy initiates. Even simple time-based nudges ("Hey — it's after lunch, your tough spot. All good?") transform the product from a tool into a companion.

### Deliverables

1. **Push notification infrastructure:**
   - Expo push token registration on app launch
   - Backend stores push tokens per user in Supabase
   - Edge Function or server endpoint to send push via Expo Push API

2. **Proactive nudge types (MVP — 3 types):**
   - **Scheduled check-in** — user sets 1–2 times during onboarding ("after lunch", "evening")
   - **Streak celebration** — "3 days strong! Your commander's getting built."
   - **Gentle re-engagement** — if no session in 48hrs: "Just checking in — no pressure."

3. **Deep link from notification → session:**
   - Tap notification → app opens → mascot home → auto-starts chat or voice based on notification payload
   - Uses existing `battlebuddy://` deep link scheme

4. **Quiet hours** — respect user-set quiet hours (default 10pm–7am). Stored in `onboarding_profile`.

5. **Notification preferences screen** — in the Routines drawer item: toggle each nudge type, set check-in times, set quiet hours.

### Files to create

| File | Purpose |
|---|---|
| `mobile/src/services/pushNotifications.ts` | Register for push, store token, handle incoming notifications |
| `mobile/src/hooks/usePushSetup.ts` | Hook: runs on app launch, registers token |
| `mobile/app/(app)/routines.tsx` | Full routines screen (replace placeholder): nudge toggles, check-in times, quiet hours |
| `server/notifications.js` | Push notification sender module (Expo Push API) |
| `supabase/migrations/002_push_tokens.sql` | `push_tokens` table + RLS |

### Files to modify

| File | Change |
|---|---|
| `mobile/app/(app)/_layout.tsx` | Add push registration on mount |
| `mobile/app/(app)/index.tsx` | Handle deep link from notification → auto-start session |
| `server/index.js` | Add `/nudge/send` endpoint (called by scheduled job or Edge Function) |
| `mobile/src/config/index.ts` | Add `FeatureFlags.proactiveNudges = true` |

### Supabase migration

```sql
-- 002_push_tokens.sql
create table public.push_tokens (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.users(id) on delete cascade,
  token      text not null,
  platform   text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  unique(user_id, token)
);

alter table public.push_tokens enable row level security;

create policy "push_tokens: own rows only"
  on public.push_tokens for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

### Tech decisions

| Decision | Choice | Rationale |
|---|---|---|
| Push service | **`expo-notifications`** + **Expo Push API** | Expo handles APNs/FCM abstraction. Already available in SDK 56, no install. The Expo Push API is a simple HTTP call from the backend. |
| Scheduling | **Supabase `pg_cron`** or **server-side cron** | For MVP, a simple cron job that queries users with scheduled check-in times and sends pushes. No complex job queue. |
| Deep linking | **Expo Router deep links** (existing `battlebuddy://` scheme) | Already configured in `app.json`. Notification payload includes a route path. |

### Open question for Mike

> **Q3: Nudge frequency / tone.** The PRD says "respectful of quiet hours" and "never nagging." For MVP, I'm planning max 2 nudges per day (the user's scheduled check-ins) plus occasional streak celebrations. Does that feel right, or do you want more/fewer?

### Acceptance criteria

- [ ] App registers for push notifications on first launch (with permission prompt)
- [ ] Push token is stored in Supabase, per-user
- [ ] A test nudge sent from the server arrives on the device
- [ ] Tapping the notification opens the app and auto-starts a chat session
- [ ] Quiet hours are respected (no notifications between user-set times)
- [ ] Routines screen allows toggling nudge types and setting times
- [ ] `npm run ci` passes

### Dependency on Phase 2

Requires: drawer navigation (Routines screen lives in drawer), deep-link handling on home screen.

Can run **in parallel with Phase 3 or 4** since push infrastructure is backend-heavy and doesn't depend on the session engine.

### Estimated scope

~1.5 sessions. Push setup is well-documented Expo territory; the scheduling logic is the interesting part.

---

## Phase 6 — Personalization & User Profile

**Goal:** The AI knows you. It remembers your history, learns what works, and adapts — not generic responses, but "I know you, and here's what's worked for you before."

### Why this is the moat

The sketch emphasizes this: "Knows each individual user's history. Provides personalized interactions based on context — not generic responses." The infrastructure exists (Supabase tables for stats, prompt template slots) but nothing is wired up. This phase connects the dots.

### Deliverables

1. **Profile builder service** — after each session outcome, update `user_media_stats` and `user_framing_stats` counters. Build a compact natural-language profile summary from the counters.

2. **Real `{{profile}}` hydration** — the `/session/turn` endpoint queries the user's stats, builds the profile string (as described in `docs/03-AGENT-DESIGN.md §7`), and injects it into the system prompt per turn.

3. **History screen** — list of past sessions with date, duration, mode (text/voice icon), outcome (resisted/slipped/unsure), and "did this help?" feedback. Tappable to view conversation transcript.

4. **Goals screen** — habit target, quit date, current streak, milestones achieved. Milestone celebrations pushed to mascot animations ("You hit 7 days!" → celebrating state).

5. **Analytics moved to drawer** — the existing Progress screen gets real data: streak, resist rate over time, "what helped" breakdown.

6. **Trigger context capture** — on session start, a quick 2-tap capture: "What triggered this?" (boredom, stress, social, routine, other) + "How strong? (1–5 quick slider)." Feeds `trigger_context` on the `craving_event` and into `{{trigger_context}}` in the prompt.

### Files to create

| File | Purpose |
|---|---|
| `mobile/src/services/profileBuilder.ts` | Queries user stats, builds natural-language profile string |
| `mobile/src/services/outcomeRecorder.ts` | After session: update craving_event, media stats, framing stats |
| `mobile/src/components/session/TriggerCapture.tsx` | Quick trigger + intensity capture at session start |
| `mobile/app/(app)/history.tsx` | Full history screen (replace placeholder) |
| `mobile/app/(app)/goals.tsx` | Full goals screen (replace placeholder) |
| `mobile/src/components/history/SessionCard.tsx` | Individual session card in history list |
| `mobile/src/components/history/TranscriptView.tsx` | Past conversation viewer |
| `mobile/src/components/analytics/StreakCard.tsx` | Streak display with milestone markers |
| `mobile/src/components/analytics/ResistRateChart.tsx` | Resist rate over time visualization |
| `mobile/src/components/analytics/WhatHelped.tsx` | Breakdown of effective interventions |

### Files to modify

| File | Change |
|---|---|
| `server/index.js` | `/session/turn` queries user profile from Supabase, injects into prompt |
| `mobile/src/stores/sessionStore.ts` | Add trigger context capture, wire outcome recording |
| `mobile/app/(app)/analytics.tsx` | Replace placeholder with real analytics components |
| `mobile/src/components/feed/OutcomeCapture.tsx` | Wire to `outcomeRecorder` service |
| `agent/agent.py` | Accept user profile context from backend (for voice sessions) |

### Tech decisions

| Decision | Choice | Rationale |
|---|---|---|
| Profile format | **Natural language string** (not JSON) | The system prompt's `{{profile}}` slot expects a human-readable paragraph. Claude performs better with natural-language context than structured data in a prompt. Matches the example in `03-AGENT-DESIGN.md §7`. |
| Stats → profile | **Server-side query on each turn** | The profile must reflect the latest data. A Supabase query joining `user_media_stats` + `user_framing_stats` + recent `craving_events` is fast (indexed, single user). No caching needed at MVP scale. |
| Analytics charts | **`react-native-svg`** (installed via Expo) | Simple line/bar charts drawn with SVG paths. No charting library needed for 2–3 charts. Keeps bundle small. |

### Acceptance criteria

- [ ] After 3+ sessions, the AI's responses visibly differ based on user history (e.g., references past patterns, offers previously-successful interventions)
- [ ] History screen shows all past sessions with correct metadata
- [ ] Tapping a session in History shows the conversation transcript
- [ ] Goals screen shows current streak and quit date
- [ ] Analytics screen shows resist rate trend and "what helped" breakdown
- [ ] Trigger capture appears at session start and feeds into AI context
- [ ] `npm run ci` passes

### Dependency on Phase 3

Requires: session store (for outcome recording), unified session lifecycle.

### Estimated scope

~2 sessions. The profile builder and analytics screen are the meaty parts.

---

## Phase 7 — Offline Resilience & Local Persistence

**Goal:** The app works when the signal doesn't. Core flows (start a session, talk to the on-device buddy, log an outcome) degrade gracefully offline and sync when connectivity returns.

### Deliverables

1. **Local SQLite event log** — all `craving_events` and `messages` are written to SQLite first, then synced to Supabase. The device is source of truth for events it creates.

2. **Sync worker** — background task that reconciles local SQLite with Supabase on reconnect. Conflict policy per `02-ARCHITECTURE.md`: device-authoritative for events, server-authoritative for stats counters (merged additively).

3. **Offline-aware session flow** — if offline, the session still starts (local event created), chat works against cached/on-device model (Gemma tier, Phase 2.5 prerequisite — or graceful "I can't connect right now, but I'm here" fallback for Phase 7 without Gemma), and outcome is captured locally.

4. **Network status indicator** — subtle indicator on home screen when offline (mascot shows a small "offline" badge, not alarming).

### Files to create

| File | Purpose |
|---|---|
| `mobile/src/services/localDb.ts` | SQLite schema setup + CRUD for craving_events, messages |
| `mobile/src/services/syncWorker.ts` | Background sync: local → Supabase reconciliation |
| `mobile/src/hooks/useNetworkStatus.ts` | Network connectivity hook |
| `mobile/src/components/home/OfflineBadge.tsx` | Small offline indicator on mascot |

### Files to modify

| File | Change |
|---|---|
| `mobile/src/stores/sessionStore.ts` | Write to local SQLite on every state change |
| `mobile/src/services/outcomeRecorder.ts` | Write locally first, queue sync |
| `mobile/app/(app)/_layout.tsx` | Start sync worker on app launch |

### Tech decisions

| Decision | Choice | Rationale |
|---|---|---|
| Local DB | **`expo-sqlite`** (installed) | Already a dependency. Synchronous API for fast writes during sessions. |
| Sync strategy | **Write-local-first, background push** | Per architecture doc. Device creates events, syncs when online. Server-side counters merge additively. |
| Network detection | **`@react-native-community/netinfo`** (Expo compatible) | Standard RN network detection. May need install if not already available via Expo. |

### Acceptance criteria

- [ ] With airplane mode on: session starts, messages are captured locally, outcome is recorded
- [ ] With airplane mode off: local events sync to Supabase within 30 seconds
- [ ] No duplicate events after sync (idempotent upsert)
- [ ] Mascot shows subtle offline indicator
- [ ] `npm run ci` passes

### Dependency on Phase 3 + 6

Requires: session store, outcome recorder.

Can run **in parallel with Phase 5** (push notifications).

### Estimated scope

~1.5 sessions.

---

## Phase 8 — Integration, Polish & End-to-End Testing

**Goal:** Everything works together. The full sketch vision is realized: notification → mascot home → swipe to chat or voice → mode switch → personalized AI → outcome → analytics. Tested end-to-end.

### Deliverables

1. **Onboarding flow** — first launch: name, habit target (smoking, pre-filled), biggest triggers (multi-select), preferred check-in times, notification permission, disclaimer screen ("not for emergencies → 988").

2. **Disclaimer screen** — always reachable from Preferences. "BattleBuddy is a habit-change companion, not for emergencies..." with 988 info.

3. **End-to-end Maestro tests:**
   - Notification → open → chat session → outcome → shows in history
   - Home → swipe down → chat → switch to voice → switch back → end → outcome capture
   - Home → swipe up → voice session → end call → outcome capture
   - Drawer → History → view past session transcript
   - Drawer → Analytics → charts render with data

4. **Performance audit:**
   - First agent token <1s on Wi-Fi (measure with the server)
   - Mascot animation 60fps on iPhone 12 / equivalent Android
   - App cold start <2s

5. **Visual polish pass:**
   - Consistent use of design tokens everywhere
   - Smooth transitions between all screens
   - Dark mode refinement (the app is dark-themed by design)

### Files to create

| File | Purpose |
|---|---|
| `mobile/app/(app)/onboarding.tsx` | First-launch onboarding flow |
| `mobile/app/(app)/disclaimer.tsx` | Safety disclaimer screen |
| `mobile/src/hooks/useOnboarding.ts` | Onboarding completion state (MMKV or SecureStore) |
| `maestro/flows/full-session.yaml` | E2E: full chat session flow |
| `maestro/flows/voice-session.yaml` | E2E: voice session + end call |
| `maestro/flows/mode-switch.yaml` | E2E: voice ↔ text switching |
| `maestro/flows/drawer-nav.yaml` | E2E: drawer navigation |

### Files to modify

| File | Change |
|---|---|
| `mobile/app/(app)/_layout.tsx` | Add onboarding gate (redirect if not completed) |
| `mobile/app/(app)/preferences.tsx` | Add disclaimer link, account delete, data export |

### Acceptance criteria

- [ ] First launch shows onboarding → disclaimer → mascot home
- [ ] All 4 Maestro E2E flows pass on iOS simulator
- [ ] First agent token <1s (measured, logged)
- [ ] Mascot animations hold 60fps (Reanimated performance monitor)
- [ ] The full flow from the sketch works: push → open → mascot → chat/voice → personalized AI → outcome → history
- [ ] `npm run ci` passes
- [ ] Product feels like the sketch — a companion, not a tool

### Dependency

Requires: all previous phases complete.

### Estimated scope

~2 sessions. Onboarding, E2E tests, and polish.

---

## Phase dependency graph

```
Phase 1 (Mascot & Design)
  │
  ▼
Phase 2 (Navigation Rebuild)
  │
  ├──────────────────┐
  ▼                  ▼
Phase 3 (Session     Phase 5 (Push
  Engine)             Notifications)
  │                      │
  ▼                      │
Phase 4 (Voice           │
  Polish)                │
  │                      │
  ▼                      │
Phase 6 (Personal-       │
  ization)               │
  │                      │
  ├──────────────────────┘
  ▼
Phase 7 (Offline)
  │
  ▼
Phase 8 (Integration & Polish)
```

**Parallelism:** Phases 5 (push) can run alongside Phases 3–4 since push infrastructure is mostly backend + a new screen in the drawer. Phase 7 (offline) can start alongside Phase 5 as well.

---

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Mascot design iterations** — getting the character "right" may take multiple rounds | Blocks Phase 2 | Start with a clean, simple robot (geometric shapes, expressive eyes). Iterate the art later without changing the component API. |
| **Bottom sheet + gesture conflicts** — swipe-down for chat vs. scroll-down inside chat | UX confusion | `@gorhom/bottom-sheet` handles this with `simultaneousHandlers`. Test thoroughly on device, not just simulator. |
| **LiveKit voice transcript capture** — extracting text from the voice agent's responses | Blocks Phase 3 mode-switching | LiveKit's data channel or the agent's text events can be captured. Fallback: re-query the backend for the session's messages. |
| **Push notification permission rejection** — user denies push | Degrades the entry flow | The app must work fully without push. Push is an enhancement, not a requirement. The mascot home screen is the primary entry. |
| **Reanimated SVG performance** — complex mascot animation on low-end Android | Frame drops | Keep the SVG simple (<10 paths). Use `useAnimatedProps` for GPU-accelerated transforms only. Profile on a mid-tier Android device before Phase 2. |
| **Expo SDK 56 compatibility** — `@gorhom/bottom-sheet` v5 with latest Expo | Build failure | Check compatibility before installing. Bottom sheet v5 targets Reanimated 3+; we have 4.3 which is backward compatible. |

---

## Open questions summary

These need Mike's input before or during the relevant phase:

| # | Question | Needed by | Default if no answer |
|---|---|---|---|
| Q1 | BB mascot character design — proceed with geometric robot, or do you have a specific reference? | Phase 1 | Geometric robot with LED eyes, antenna, coral accent |
| Q2 | "Choose AI Buddy" — multiple personas in the future, or just "summon your buddy"? | Phase 2 | "Summon your buddy" (single persona, scaffold for multiple later) |
| Q3 | Push nudge frequency — max 2/day (scheduled check-ins) + occasional streaks? | Phase 5 | Max 2 scheduled + 1 streak/day, quiet hours respected |
| Q4 | Onboarding depth — how many screens? Minimal (name + triggers + check-in times) or detailed? | Phase 8 | Minimal: 3–4 screens, get to the mascot fast |

---

## Success definition

When this plan is complete, a user's experience matches the sketch:

1. A push notification arrives: "Hey — it's after lunch. All good, or want to talk?"
2. They tap it. The app opens to the BB robot, gently floating, ready.
3. They swipe down. A chat panel slides up. "I know afternoons are tough for you. What's going on?" — the AI remembers.
4. They talk it through. The AI suggests a wave exercise. Intensity drops from 7 to 3.
5. They tap the mic button. The chat collapses. The mascot fills the screen, pulsing. They're now in a voice call with the same buddy, mid-conversation. "You were saying the wave helped — want to keep going?"
6. The urge passes. They tap the red "End Call" button. "Resisted." One tap. Done.
7. They swipe from the left. History shows the session. Analytics shows their streak: 12 days. The resist rate chart is climbing.
8. The buddy is quiet until the next check-in. Not nagging. Just there.

That's the product. That's what we're building.
