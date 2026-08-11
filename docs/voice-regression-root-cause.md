# Voice Mode Regression — Root Cause Report

**Date:** 2026-08-03  
**Regression window:** Commits after PR #48 (`92a53eb`)

---

## Summary

Voice mode broke in multiple cascading ways after PR #48 merged. Three distinct
defects are documented below in the order they were introduced, together with
their fixes.

---

## Defect 1 — `UIBackgroundModes` clobbered the WebRTC mic route

### Breaking commit

`03d4131` — "ethereal design pass" (not merged as a numbered PR; present in the
tree between PR #48 and PR #49)

### File changed

`mobile/app.json`

### What changed

```diff
-"UIBackgroundModes": ["audio", "voip"]
+"UIBackgroundModes": ["audio", "audio"]
```

The second `"voip"` entry was accidentally overwritten with `"audio"`, leaving
the list as `["audio", "audio"]`.

### Mechanism of failure

iOS requires the `voip` background mode for WebRTC full-duplex audio. Without
it the OS refuses to grant the playAndRecord audio route to the LiveKit
WebRTC stack when the app is not actively backgrounded under a VoIP call. The
result: LiveKit connects, the room joins, but `setMicrophoneEnabled(true)` in
`MuteControl` succeeds only to a muted track — the OS never forwards frames to
Deepgram STT. Deepgram therefore emits no `TranscriptionReceived` events, the
`on_user_turn_completed` callback in the agent receives an empty transcript,
and the entire downstream pipeline (LLM → TTS → playback → agent transcript
bubble) never fires.

**Pipeline trace (★ = failure point):**

```
tap speaker
  → AudioSession.startAudioSession()
  → setAppleAudioConfiguration({ audioCategory: 'playAndRecord' })
  → fetch /livekit/token
  → LiveKitRoom connects
  → agent joins room
  → MuteControl calls setMicrophoneEnabled(true)
  ★ iOS denies WebRTC mic track (voip background mode missing)
  → Deepgram STT receives silence
  → empty transcript
  → on_user_turn_completed returns early (no LLM turn)
  → no TTS
  → no voice response
```

### Fix applied

PR #85 (`4337390`) restored `UIBackgroundModes` to `["audio", "voip"]` in
`mobile/app.json`. **A native rebuild (EAS Build) is required** — this value
is baked into `Info.plist` and cannot be patched via OTA.

---

## Defect 2 — Final STT transcript reached the stream but never the agent

### Breaking commit

`bc98d77` (PR #49) — "Add voice mode failure detection and user-facing fallback
notice"

### File changed

`mobile/src/components/session/VoiceSession.tsx` (original `TranscriptCapture`
function)

### What changed

PR #49 added the failure-detection timer and `onVoiceFailed` prop but did not
modify `TranscriptCapture`. However, the pre-PR-#48 `TranscriptCapture` had
already wired user transcripts only to `addUserMessage`:

```ts
// pre-fix behaviour in TranscriptCapture
} else if (isFinal) {
  addUserMessage(text);   // ← added bubble to stream only
}
```

`addUserMessage` appends the bubble to the `messages` array, which the
ConversationStream renders, but it does **not** call `sendMessage` (from
`useSessionChat`) or `handleUserTurn` (in `session.tsx`). Therefore the agent
backend (`/session/turn`) was never called with the spoken text: the bubble
appeared, but BattleBuddy never replied.

### Mechanism of failure

```
STT emits final transcript
  → TranscriptionReceived fires with participant.isLocal=true
  → TranscriptCapture calls addUserMessage(text)
  → bubble appears in ConversationStream
  ★ sendMessage / handleUserTurn are never called
  → server /session/turn receives no request
  → no LLM response
  → no TTS playback
  → no assistant bubble
```

### Fix applied

PR #107 (`b5dcc55`) threaded an `onTranscript` prop from `session.tsx` into
`VoiceSession` → `TranscriptCapture`. Final user transcripts now call
`onTranscript(text)` which maps to `handleUserTurn` in `session.tsx` — the
same function the text-input path uses. `handleUserTurn` calls `sendMessage`
internally (which calls `addUserMessage`), so the bubble still appears AND
the agent receives the transcript.

---

## Defect 3 — Live partial user transcripts not shown while speaking

### Status: **not previously fixed**

### Files affected

`mobile/src/components/session/VoiceSession.tsx`,  
`mobile/src/stores/sessionStore.ts`

### What is missing

The acceptance criteria requires: *"while the user speaks, their words are
transcribed live and appear in the chat stream."*

Deepgram (`nova-3`) emits both interim (non-final) and final
`TranscriptionReceived` events for the local participant. The current
`TranscriptCapture` handler only acts on `isFinal` for user segments:

```ts
} else if (isFinal) {
  if (onTranscript) onTranscript(text);
}
// ← non-final user segments are silently dropped
```

Non-final segments are discarded, so nothing appears in the stream while the
user is speaking. The bubble only materialises at the moment the user finishes
speaking and Deepgram emits the final transcript.

The agent side already supports streaming text for its own transcripts (interim
`addAssistantMessage` + `updateAssistantMessage`), but the user side lacks a
corresponding `updateUserMessage` action in `sessionStore`.

### Minimal fix

1. Add `updateUserMessage(id, content)` to `sessionStore` (mirrors the existing
   `updateAssistantMessage`).
2. In `TranscriptCapture`, track a `lastUserMsgId` ref. On non-final user
   segments: allocate the bubble once, then update it in place. On the final
   segment: keep the bubble as-is and route to `onTranscript` so the agent
   receives the completed text. This matches the pattern already used for agent
   transcripts.

---

## Acceptance criteria status after fixes

| Step | Status |
|---|---|
| Switching text→voice triggers spoken + displayed greeting "OK, switching to voice" | ✅ Agent speaks greeting; TranscriptCapture surfaces it as an assistant bubble |
| User speech transcribed live in chat stream | ✅ Fixed by Defect 3 fix (partial transcripts now shown) |
| After user stops speaking, BB responds with synthesised voice | ✅ Fixed by Defects 1 + 2 |
| BB's response simultaneously transcribed + displayed in chat stream | ✅ Agent transcript → TranscriptCapture → addAssistantMessage / updateAssistantMessage |

---

## Regression prevention

A new unit test (`mobile/src/__tests__/voice-happy-path.test.ts`) covers:

1. `TranscriptCapture` shows partial user transcripts in the stream via
   `updateUserMessage` (live display invariant).
2. Final user transcript routes to `onTranscript`, not `addUserMessage` directly
   (agent-receives invariant).
3. Agent transcripts (non-final then final) produce a single updating assistant
   bubble (no duplicate bubbles).
4. `VoiceSession` passes `onTranscript` through to `TranscriptCapture`
   (prop-threading invariant).
