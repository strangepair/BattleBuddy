# BattleBuddy — Product Requirements Document (PRD)

> Reading order: this is doc 1 of 7. See `00-README.md` for the full map.
> Status: MVP spec. Owner: Mike. Last updated: 2026-06-15.

---

## 1. One-line concept

BattleBuddy is an AI-powered **habit-change partner** — a "circuit breaker" for the impulses that drive a habit you're trying to break. Not a passive tracker; a proactive, conversational ally that interrupts the loop in real time and offers a dopamine-positive replacement. The core skill it trains is **impulse resistance**: catching the automatic pull and choosing your response instead.

## 2. The core idea (the "why")

### The slime-mold analogy
A habit loop behaves like a slime mold following a chemical gradient toward a reward. The brain carves a neural pathway — the path of least resistance — and then follows it automatically. Often you're not even chasing the chemical; you're chasing a **sensory spike** (the throat hit of a cigarette, the scroll-refresh of a feed). The point is that the loop runs on autopilot because the *signal* is what's been reinforced, over and over.

### The circuit breaker
The app's job is to **intercept that automatic response** by introducing a second voice. In the moment of the urge, you shift from *being the slime mold* (reacting to the gradient) to *being the commander* (choosing the response). That shift — from reaction to choice — is the entire product thesis. It's a muscle, and every rep makes the next one easier. Everything else is in service of making that shift easy, fast, and well-supported.

### Tone
Not clinical. Not preachy. A warm, direct, **supportive coach** who's in your corner — "let's go, you've got this." Plain-spoken and on your side. Never lectures. Celebrates the resist; never shames the slip.

## 3. Who it's for

- **Primary (MVP): people quitting smoking / vaping.** Nicotine is a real, frequent urge — which makes it an ideal first target: lots of in-the-moment reps for the app to help with and learn from. Importantly, nicotine has **no medically dangerous withdrawal**, so the product stays squarely in habit-change territory, not clinical care.
- **Later:** general impulse-resistance habits — doomscrolling, snacking/sugar, impulse spending, procrastination — once the circuit-breaker core is proven on smoking.

> Scope note: BattleBuddy is a **habit-change companion, not a crisis service or medical provider.** It is built for everyday urges, not emergencies. See §8.

## 4. What it does — feature pillars

1. **Conversational support (text + voice).** A real-time chat/voice interface you can open in seconds during an urge to vent, distract, or get a hit of encouragement.
2. **Proactive intervention.** The agent doesn't only wait to be summoned. It checks in around your known high-risk times, places, and moods.
3. **Dopamine-positive distractions (multimodal).** In the moment, the agent can play a song, present a video, show an image, run a quick mental exercise, or guide you to write out / ride the urge wave. The media is the intervention, not decoration.
4. **Sensory anatomy of the urge.** A guided "name what you're actually feeling" exercise that helps you see the urge as a passing sensory event rather than a command.
5. **Analytics & retraining.** A history of interactions and their outcomes (did an urge happen? did you resist or give in? did the app's response help?), surfaced as behavioral patterns — and fed back into the agent so its future responses get more personal and more effective.

## 5. The personalization loop (the product's long-term moat)

Every urge episode is logged with: trigger context, what the app offered, what media was shown, how long you engaged, and the outcome (resisted / gave in / unsure). Over time the app keeps a **running average of what works for this specific person** and biases future interventions toward it.

Example: if someone consistently engages longer with "healthy-habit-building" videos and resists after them, the app shows more of those. Another person might respond better to "here's what quitting gets you" content — so they get more of that. The agent continually adjusts mode (text vs. voice), media type, and message framing to match the individual. The north star: measurably fewer slips over time and, ultimately, the habit broken through personalized behavior change.

## 6. MVP scope — the cut line

**In scope for MVP (the circuit-breaker core, tuned for smoking/vaping):**

- One-tap "I'm having an urge" entry → instant agent engagement (text first, voice fast-follow).
- Conversational agent with the supportive-coach persona.
- At least 3 in-the-moment intervention types: (a) talk-it-through chat, (b) a guided urge-wave / sensory-anatomy exercise, (c) a dopamine-positive media suggestion (song or video).
- Urge-event logging with outcome capture (resisted / gave in / unsure) after each session.
- Basic analytics screen: streaks, urge count over time, resist rate, what helped.
- Lightweight personalization v1: bias media/message type using simple per-user counters (no ML yet).
- Account + secure storage of behavioral data.
- Lightweight safety footing (see §8): a clear "not for emergencies" disclaimer + standing no-medical-advice rule.

**Explicitly out of scope for MVP (later phases):**

- Full proactive scheduling engine (MVP ships a *simple* check-in: 1–2 scheduled or rule-based nudges; the learned risk-time model comes later).
- ML-based personalization / embeddings.
- Other habits beyond smoking/vaping (added once the core is proven).
- Community / social features.
- Wearable or biometric integration.
- Clinician dashboard / data export.
- Any clinical, crisis, or withdrawal-management functionality — out of scope by design.

## 7. Success metrics

- **Activation:** % of installs that log ≥1 urge session in week 1.
- **In-the-moment efficacy:** resist rate per session, and resist rate *trend* per user over time (the number that should go up).
- **Engagement quality:** median time-to-open during an urge (should be seconds), session completion rate.
- **Retention:** D7 / D30 return rate.
- **Outcome (north star):** reduction in self-reported smoking frequency per user over 30/60/90 days — and, as the habit breaks, the user needing the app *less*.

## 8. Safety, scope & honesty (lightweight by design)

BattleBuddy is a **habit-change companion for everyday urges**, not a medical provider, therapist, or crisis service. Because it is not built for emergencies, the safety footing is deliberately minimal — but a few things are non-negotiable:

- **Clear scope disclaimer.** Onboarding and an always-reachable info screen state plainly: this app helps you build new habits and resist urges; it is **not** for medical or mental-health emergencies. If you're in crisis, contact the 988 Suicide & Crisis Lifeline (call or text **988** in the US) or your local emergency number. **US-only for MVP**, so the resource is simply 988.
- **No medical advice.** BattleBuddy gives encouragement and distraction, not medical, dosing, or treatment instructions. (For nicotine this is easy — there's no dangerous withdrawal to manage. The rule still stands.)
- **A soft off-ramp, not a crisis system.** If a user expresses something that sounds like a genuine emergency or self-harm, the agent gently steps out of coaching mode, says it's an AI and not the right help for that, and points to 988 — then doesn't try to handle it further. This lives in the system prompt (`prompts/system.battlebuddy.md`); there are **no** hard-coded crisis gates or blocking crisis-phrase CI tests. (That heavier machinery was scoped for an addiction/crisis product; this is a habit app and doesn't need it.)
- **No shaming, no harmful coping.** The agent never moralizes a slip and never suggests pain- or harm-based "coping" tricks.
- **Privacy.** Behavioral data is personal. Encrypt at rest and in transit, minimize collection, make export/delete easy, never sell or share it.
- **Honesty about what it is.** The user always knows they're talking to an AI partner.
- **Don't make the app its own habit.** The goal is the user becoming their own commander, not needing the app forever. Analytics should reflect growing self-efficacy, not just usage.

## 9. Open product questions (mostly settled)

- **First habit the MVP optimizes for:** ✅ decided — **smoking / vaping.** (Frequent urges = fast learning signal; no dangerous withdrawal = clean habit-change scope.)
- Where does intervention media come from for MVP? Recommendation: a small curated, tagged library hosted in **Cloudflare R2** (controlled quality + content ownership) before any live search. See `02-ARCHITECTURE.md`.
- Voice in MVP or fast-follow? Recommendation: ship text-first, voice in the same phase but behind the core loop.
