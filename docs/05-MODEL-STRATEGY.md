# BattleBuddy — Hybrid Model Strategy (on-device + cloud)

> Doc 5 of 6. How the "brain" is split between a small on-device Gemma and cloud models.
> Decision: hybrid. Read alongside `03-AGENT-DESIGN.md` (the persona + scope this must honor).

---

## 1. The idea in one line

Run a **small Gemma 4 model on the phone** for instant, private, offline-capable conversation, and **escalate to a bigger cloud model** when a turn needs higher quality or deeper reasoning. Fast and private by default; heavier and more capable when it helps.

## 2. Why hybrid fits this product

- **Latency:** an urge needs a reply *now*. An on-device model answers with no network round-trip — the fastest possible first token.
- **Offline:** urges hit on the subway, in a basement, on a dead connection. The core loop (supportive chat + the urge-wave exercise) must work with **no signal**. On-device makes that possible.
- **Privacy:** the most sensitive data — what someone's urges are, when they slip — never leaves the phone for ordinary turns. That's both ethically right and a potential selling point.
- **Cost:** ordinary turns cost nothing per token; you only pay for the cloud on escalated turns.

The price is complexity. Because this is a habit app (not a crisis/clinical product), the on-device tier doesn't carry a heavy safety burden — the same lightweight scope rules apply on both runtimes. Section 5 covers it.

## 3. The three tiers

```
                 ┌─────────────────────────────────────────────┐
   User turn ──► │ TIER 0 — ON DEVICE (always, instant, offline)│
                 │  • Gemma 4 E4B/E2B → supportive reply        │
                 │  • Urge-wave exercise (no model needed)      │
                 └───────────────┬─────────────────────────────┘
                                 │ low confidence OR deep task
                                 ▼
                 ┌─────────────────────────────────────────────┐
   escalate ───► │ TIER 1 — CLOUD HOT PATH (higher quality)     │
                 │  • Claude (Haiku)                            │
                 │  • Used when on-device confidence is low,    │
                 │    the topic is heavy, or the user asks for  │
                 │    something beyond the small model          │
                 └───────────────┬─────────────────────────────┘
                                 │ off the hot path, batched
                                 ▼
                 ┌─────────────────────────────────────────────┐
   reflect ────► │ TIER 2 — CLOUD REFLECTIVE (analytics)        │
                 │  • Claude Sonnet OR self-hosted Gemma 4 31B  │
                 │  • Weekly insights, pattern detection,       │
                 │    personalization summaries                 │
                 └─────────────────────────────────────────────┘
```

### Tier 0 — on device (Gemma 4, small)
- Model: **Gemma 4 E4B** (~4.5B effective) where the phone can handle it; **E2B** (~2.3B) on weaker devices. Quantized (e.g., 4-bit) via an on-device runtime (Google AI Edge / MediaPipe LLM Inference, or llama.cpp). Detect device capability at install and pick the size.
- Handles the **normal supportive conversation** and drives the **urge-wave exercise** (which is mostly scripted UI and needs little model power).
- Uses the **same** `prompts/system.battlebuddy.md` persona + the same standing scope rules as the cloud — one persona, two runtimes.
- Works fully **offline**.

### Tier 1 — cloud hot path (Claude)
- Model: **Claude Haiku** (`claude-haiku-4-5-20251001`).
- Invoked when the on-device model is low-confidence, the topic is heavy, or the user explicitly asks for something beyond the small model.
- Higher-quality answers for the moments that warrant them.

### Tier 2 — cloud reflective (off hot path)
- Model: **Claude Sonnet** (`claude-sonnet-4-6`) or **self-hosted Gemma 4 31B** — your choice, swappable.
- Generates weekly summaries, detects high-risk patterns, builds personalization profiles. Latency-insensitive, batched.

## 4. Routing logic (where the intelligence is)

Each user turn, in order:

1. **On-device generate (Tier 0).** Gemma 4 produces the reply locally and streams it.
2. **Confidence / scope check.** If the on-device model is uncertain, the topic is heavy, or the user asks for something beyond the small model's competence → **escalate to Tier 1** for a higher-quality answer.
3. **Light output check (optional).** A cheap keyword screen can run on whatever model produced the text — no medical advice, no shaming, no harmful coping. Non-blocking; never on a latency-critical path.

> Design rule: escalation is cheap to trigger and biased toward quality. When the small model is unsure, escalate — a slightly slower, better answer is worth it.

## 5. Scope & honesty across tiers (lightweight — this is a habit app)

There is **no** heavy cross-tier safety system here, because BattleBuddy isn't a crisis or clinical product. The same lightweight rules apply identically on both runtimes:

1. **One persona, both runtimes.** On-device and cloud both load `prompts/system.battlebuddy.md`, including its standing rules (no medical advice, no shaming, honest it's an AI) and the soft "if this sounds like a real emergency → 988, and stop" off-ramp.
2. **The "not for emergencies" disclaimer is a product screen**, shipped in the app bundle, so it's reachable on either runtime and **offline**. It does not depend on a model.
3. **No deterministic crisis gate, no blocking crisis-phrase CI test, no offline crisis-classifier.** That machinery was scoped for an addiction/crisis product; we're not building one. (If the product ever expands into clinical territory, revisit — see `DECISIONS.md`.)
4. **The optional output keyword screen** applies to on-device output too, the same as cloud — but it's insurance, not a gate.

## 6. Privacy boundary (be honest about it)

- **Tier 0 turns stay on the phone.** Nothing leaves the device for ordinary conversation — including when someone logs an urge or a slip. Big win.
- **Escalation (Tier 1/2) sends context to the server/Claude.** When a turn escalates, the relevant conversation context crosses the network. This is the right trade for quality, but the user should understand it. Surface a simple, honest notice ("for tougher moments I bring in extra help, which means this part is processed securely on our servers").
- **Voice mode caveat:** Sesame CSM runs server-side (it needs a GPU), so in **voice** mode the reply *text* leaves the device to be synthesized even when Gemma generated it on-device. On-device privacy is therefore fullest in **text** mode. Document this; don't imply voice is fully local.
- Everything that does leave the device is still bound by the privacy rules in `02-ARCHITECTURE.md §8` (encryption, RLS, minimal logging, delete/export).

## 7. The `LLMProvider` abstraction

Mirror the `VoiceProvider` pattern so the brain is swappable and the tiers are clean:

```ts
interface LLMProvider {
  generate(messages, opts): Stream<Token>;   // streaming
  readonly tier: 'device' | 'cloud-hot' | 'cloud-reflective';
  readonly id: string;                        // 'gemma4-e4b', 'claude-haiku', ...
}

// Router decides which provider handles a turn, given the
// pre-screen result, on-device confidence, connectivity, and task type.
class ModelRouter {
  route(turnContext): LLMProvider
}
```

- All model strings + the routing thresholds live in the central config module (feature-flagged): `MODEL_DEVICE`, `MODEL_CLOUD_HOT`, `MODEL_CLOUD_REFLECT`, `ESCALATE_ON_LOW_CONFIDENCE`, etc.
- Swapping Tier 1 from Claude to a self-hosted Gemma 31B later is a config change, not a rewrite.

## 8. Build sequencing (important — de-risk it)

**Do not build the hybrid in Phase 1.** Nail the experience first, then add the on-device tier:

- **Phase 1 (circuit-breaker core):** ship the loop **cloud-only on Claude**. This gets a high-quality agent working fast and gives you the reference behavior the on-device model must match.
- **Phase 2.5 / dedicated phase — "On-device tier":** introduce Gemma 4 on-device behind the `LLMProvider` interface, wire the router, and **benchmark the small model against the Phase 1 Claude behavior** (quality, persona fidelity) before letting it serve real turns.
- **Exit test for the on-device phase:** on a real phone in airplane mode, the supportive chat + urge-wave exercise work and the "not for emergencies" disclaimer is reachable; with network on, a low-confidence turn escalates to Claude. Persona feels identical across runtimes.

> Rationale: the on-device model is an optimization on top of a proven loop, not the foundation. Build the foundation first.

## 9. Open questions to settle during the on-device phase

- Which on-device runtime (Google AI Edge / MediaPipe vs llama.cpp) and quantization give acceptable quality at acceptable battery/thermal cost?
- E2B vs E4B cut line by device class.
- **Low-confidence signal:** what concretely triggers escalation? Options: average token logprob below a threshold, the model emitting an explicit "I'm not sure" / refusal pattern, or a short heuristic on reply length/coherence. Start with a logprob threshold + escalate often, then tighten as the on-device model proves itself.
- Does on-device handle the urge-wave exercise entirely scripted (no model) to save battery and guarantee offline reliability? (Recommended: yes.)
