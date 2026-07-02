# BattleBuddy — Voice Persona & Provider Selection

> Doc 6 of 7 (added per requirement: high-quality conversational voice, Sesame-AI-grade).
> Audience: Mike (decision) + Claude Code (integration). Status: recommendation, pending Mike's pick.

---

## 0. Key correction on Sesame

You assumed Sesame has no offering you can build on. That's **partly wrong, in your favor**:

- Sesame open-sourced its base model, **CSM-1B**, under the **Apache 2.0 license** (March 2025) — broad commercial use allowed. You *can* legally build BattleBuddy's voice on it. Third parties (Cerebrium, Vogent) already deploy CSM as ultra-low-latency hosted APIs.
- The catch: CSM-1B is the **base** speech model, not the full polished "Maya/Miles" experience from their app, and it ships with essentially **no safety guardrails** — Sesame just asks you not to misuse it. For a health-adjacent product, you'd own all the safety work yourself, plus the infra to host it.
- Sesame's own consumer app shipped an iOS preview (May 2026), but there isn't a clean, supported *commercial* API for the full experience the way there is with the providers below.

So Sesame CSM is a viable "closest to the feel you loved" path **if** you're willing to run model infra. The managed providers below get you 90% of that feel with far less operational burden and real safety/support.

## 1. The important distinction: voice ≠ personality

What you loved about Sesame is two separate things:

1. **The voice itself** — tone, pacing, prosody, natural turn-taking. That's the **TTS/voice layer**.
2. **What it said and how it related to you** — warmth, helpfulness, *not* sycophantic. That's the **language/agent layer**.

In BattleBuddy, layer 2 is **Claude with the supportive-coach persona** (`docs/03-AGENT-DESIGN.md`), whose prompt already forbids fake cheerfulness and sycophancy and carries our standing scope rules. The voice provider only supplies layer 1. **Don't outsource the personality to the voice vendor** — keep Claude in control so our persona and "no sycophancy" rules always apply. This is why we keep the pipeline architecture (below) rather than a black-box speech-to-speech model that brings its own LLM.

## 2. Architecture decision: pipeline, not black-box

```
User speech ──► STT ──► Claude (supportive-coach agent) ──► TTS ──► reply audio
```

- Keeps Claude + our persona/scope rules in control.
- Lets us swap the voice vendor without touching the agent logic.
- Trade-off vs. end-to-end speech-to-speech models (e.g., OpenAI Realtime, Hume EVI in native mode): slightly higher latency and less seamless barge-in. Acceptable — control and safety win here. (If latency ever becomes the blocker, several of these support "bring your own LLM" modes that keep Claude in the loop.)

## 3. Provider comparison (mid-2026)

| Provider | Best at | Latency (time-to-first-audio) | Fit for BattleBuddy |
|---|---|---|---|
| **ElevenLabs** | Most realistic + expressive voices; full Conversational-AI platform; 70+ languages | Low (Flash models ~75ms class) | **Top all-round pick.** Warmth + realism + a maintained platform. Safe default. |
| **Hume (EVI / Octave)** | **Empathy** — reads emotion in the user's voice and adjusts; expressive control ("speak with warmth") | Low, real-time | **Strong fit for a supportive habit coach** where emotional attunement matters. Supports bring-your-own-LLM so Claude stays in control. |
| **Cartesia** | **Lowest latency** (~40ms time-to-first-audio); efficient streaming | ~40ms | Best if in-the-moment speed is the deciding factor. Voices are good, slightly less expressive than ElevenLabs. |
| **Rime** | Natural conversational cadence grounded in sociolinguistics (real speech rhythm) | ~200ms | Great "sounds like a real person" feel; good alternative. |
| **Deepgram (Aura / Voice Agent)** | Strong STT + TTS combo under one roof | <250ms | Convenient if you want STT+TTS from one vendor. |
| **Sesame CSM-1B (self-host)** | Closest to the Sesame feel you liked; Apache-2.0, free to use | Ultra-low (engineered deployments) | Only if you'll run infra and own all safety. Highest effort. |
| **Inworld TTS-2** | Topped the realtime-TTS arena (May 2026) | Real-time | Worth A/B testing for naturalness. |

> Note on "without sycophancy": none of these vendors controls that — Claude's persona does. Keep the no-sycophancy rules in `server/prompts/system.battlebuddy.md`.

## 4. Decision: build on Sesame CSM (chosen)

Mike prefers the Sesame experience, so the plan targets **Sesame CSM** as the voice layer, with a managed TTS provider (ElevenLabs / Hume) kept behind the same interface as a fallback if quality, latency, or ops don't pan out. The rest of this doc is the Sesame implementation plan.

### 4.1 What Sesame CSM actually is (set expectations)

CSM-1B is a **conversational text-to-speech model**, not a full voice agent. It turns text (plus audio context) into very natural speech. It does **not** do speech recognition and does **not** decide what to say. So it slots into our existing pipeline as the **TTS box only**:

```
User speech ─► STT (Whisper / Deepgram) ─► Claude (agent + safety) ─► CSM-1B (TTS) ─► audio ─► phone
```

Nothing about the agent design changes — Claude still controls every word, so our "no sycophancy" persona and scope rules apply exactly as written. Sesame only changes *how the words sound*.

### 4.2 The three things the Sesame path costs you (vs. a managed API)

1. **You host a GPU model.** CSM-1B needs an NVIDIA GPU (≥8 GB VRAM; RTX 4060-class for dev). It does **not** run on the phone for a fleet — it runs server-side and streams audio down. Either self-host on GPU cloud or use a managed CSM deployment (Cerebrium, Vogent, Spheron, NVIDIA NIM). Rough cost: GPU time ~\$3/hr base; use **serverless / scale-to-zero GPU** for the MVP so you're not paying 24/7 at low traffic.
2. **You must lock the voice identity yourself.** This is the big gotcha. CSM-1B is a **base** model with **no fixed voice identities** — speaker-ID tokens keep a voice consistent *within one conversation* but **not across separate sessions**. To make the buddy sound like the *same coach every time*, you must either (a) **prompt every generation with a fixed reference-audio sample** of the chosen voice (simplest), or (b) **fine-tune** the model to bake in one identity (what powered Sesame's polished "Maya" demo; modifying weights is preferred over LoRA). Start with (a); move to (b) only if drift is audible.
3. **You own the audio layer.** CSM ships with essentially no guardrails. For us that's fine because Claude controls content — and if the optional output keyword screen is enabled, run it before handing text to CSM.

### 4.3 Latency reality

CSM synthesis is ~150 ms time-to-first-audio. Add STT (~30–80 ms) + Claude first token (~150–300 ms) and, **with streaming**, first audio reaches the user in ~1–2 s — comparable to a cascaded managed pipeline and within our budget. Without streaming it feels like ~6 s, so streaming both directions is mandatory, not optional.

### 4.4 Licensing

CSM-1B is **Apache 2.0** — commercial use allowed, no per-character vendor fees, full control of the model. The trade is infra + the engineering above instead of a usage bill.

## 5. Sesame build plan (slots into Phase 2 of `04-BUILD-PLAN.md`)

1. **Stand up a CSM inference service** behind our `VoiceProvider` interface. Start with a **managed serverless-GPU deployment** (Cerebrium / Spheron / NIM) to avoid running a GPU full-time; revisit self-hosting once concurrency justifies it.
2. **Pick + lock one buddy voice.** Record or source a ~3-minute reference sample with the right warmth/pacing, and use it as the fixed audio context on every generation. Cache it. This *is* the buddy's voice — choose it carefully.
3. **Wire STT** (Whisper or Deepgram streaming) for the user's side.
4. **Stream end-to-end:** Claude tokens → CSM in chunks → audio to the phone as it's produced. Measure first-audio latency on a real device.
5. **Keep ElevenLabs/Hume as a config-flippable fallback** behind the same interface, so a bad day on the Sesame path can't block the release.
6. **If voice identity drifts or quality lags,** schedule a fine-tune of CSM on the chosen voice (and optionally domain audio) — budget this as a stretch task, not an MVP blocker.

### Definition of done (voice)
A voice urge-session works end-to-end on a real phone: user talks, Claude answers, the buddy replies in **one consistent, warm voice**, first audio within ~1–2 s, and the "not for emergencies → 988" off-ramp reads the same in voice as in text.

## 6. Integration requirements (for Claude Code)

- Abstract behind `VoiceProvider { transcribeStream(); synthesizeStream(text); }` so vendors are swappable via config (`TTS_PROVIDER`, `STT_PROVIDER`). CSM is one implementation; ElevenLabs/Hume are fallbacks.
- Stream both directions; begin TTS as Claude's tokens stream in (don't wait for the full reply).
- One fixed voice identity per user-facing persona — cache and reuse it; consistency builds the relationship.
- All keys server-side (Edge Functions) only.
- Voice mode uses the **same** Claude agent and the **same** persona/scope rules as text — no separate path. The "not for emergencies" off-ramp behaves the same in voice.
- Latency budget: first audio out within the app's <1s first-token target as closely as the provider allows.
