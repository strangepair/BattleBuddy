# BattleBuddy — Getting Started (from spec to running code)

You have a complete spec package. This is the runbook to start building. Three stages:
**A.** Things only you can do (accounts + one product decision).
**B.** Open the repo in Claude Code.
**C.** Paste the kickoff prompt and build Phase 0.

---

## A. Prerequisites — do these first (≈30–45 min, human-only)

Claude Code can't create accounts or make the product call for you. Knock these out first:

1. **Install the local toolchain** (so Claude Code can run the app):
   - Node.js LTS, Git, and a code editor (VS Code).
   - `npm install -g expo` (Expo CLI).
   - The **Expo Go** app on your phone (to preview the app live as it's built).
2. **Create accounts + keys** (paste them into a local `.env` later — never commit them):
   - **Anthropic API key** — for the cloud (Tier 1/2) model. console.anthropic.com.
   - **Supabase project** — free tier is fine to start. Save the project URL + service key.
   - **Cloudflare R2** — create a bucket for the media library and an API token (account ID, access key id, secret). You already have a Cloudflare account; R2's S3-compatible API is what the backend uses.
   - (Later, not needed for Phase 0–1) Sesame CSM hosting + STT provider for voice; Gemma weights for the on-device tier.
3. **Product decision: ✅ already made — the MVP targets smoking / vaping.**
   - Frequent urges = fast learning signal, and no dangerous withdrawal = the product stays cleanly in habit-change territory.
   - This choice tunes onboarding copy and the seed media library; the architecture generalizes to other habits later.

> That's it for human prerequisites. Voice (Sesame) and the on-device Gemma tier come in later phases — you do **not** need GPUs or model hosting to start.

## B. Open the repo in Claude Code

1. Put this whole folder under version control: `git init && git add -A && git commit -m "spec package"`.
2. Open the folder in Claude Code.
3. Claude Code automatically reads `CLAUDE.md` at the root — that's its standing brief, and it points to `docs/`.

## C. Kickoff prompt — paste this into Claude Code to begin Phase 0

> Copy everything in the block below into your first Claude Code message.

```
Read CLAUDE.md, then read docs/00-README.md and docs/01–06 in order. This is
the spec for BattleBuddy; treat it as the source of truth.

We're starting BUILD PHASE 0 from docs/04-BUILD-PLAN.md. Do only Phase 0 in this
session — do not start Phase 1 features yet.

Phase 0 deliverables:
- Initialize an Expo + TypeScript app using Expo Router, with three tab routes:
  Session, Analytics, Settings (empty screens are fine).
- Stand up the Supabase schema from docs/02-ARCHITECTURE.md §5, with Row-Level
  Security on every table. (Edge Functions run on Deno — see the doc 02 gotcha note.)
- Create a backend Edge Function scaffold with a health-check endpoint.
- Create the Cloudflare R2 bucket and an Edge Function that returns a signed R2
  URL (proves the media-storage path).
- Create the central config module for model strings + feature flags
  (MODEL_DEVICE, MODEL_CLOUD_HOT, MODEL_CLOUD_REFLECT, onDeviceModelEnabled,
  voiceEnabled, etc. — see docs/02 §9 and docs/05 §7).
- Wire CI: lint, typecheck, and a test runner.

Constraints:
- Follow the stack and non-negotiable rules in CLAUDE.md. Keys (incl. R2) live
  server-side only; never call cloud models from the device.
- Don't add third-party SDKs beyond the stated stack without asking me first.
- End the session green: lint + typecheck + the test runner all pass, and the
  Phase 0 exit test passes (sign in, app boots to an empty Session screen,
  backend health check responds, and an RLS test confirms cross-user reads are
  blocked).

When Phase 0 is green, update the Phase 0 exit-test status in docs/04-BUILD-PLAN.md,
summarize what you built and any decisions (log deviations in DECISIONS.md), and
stop. I'll review before we start Phase 1.
```

## After Phase 0

- Review what Claude Code built, run the app in Expo Go, confirm the health check.
- Then start **Phase 1 (the circuit-breaker core)** — the heart of the product — with a similar "do only Phase 1" prompt. Phase 1 is **cloud-only on Claude** by design; the on-device Gemma tier and voice come in later phases so the safe, high-quality loop is proven first.
- The supportive-coach persona Claude Code will wire up in Phase 1 already exists at `prompts/system.battlebuddy.md` — point it there; don't let it inline the prompt.

## The whole path at a glance

| Stage | What happens | Who |
|---|---|---|
| A. Prereqs | Accounts (incl. Cloudflare R2), keys | You |
| B. Open repo | Git + Claude Code reads CLAUDE.md | You |
| Phase 0 | App shell + Supabase + R2 + CI | Claude Code |
| Phase 1 | Circuit-breaker core (text, cloud Claude) ⭐ | Claude Code |
| Phase 2 | Voice (Sesame CSM) + analytics | Claude Code |
| Phase 2.5 | On-device Gemma tier (hybrid brain) | Claude Code |
| Phase 3 | Personalization v1 | Claude Code |

Ship Phase 1 before anything else. One smoking urge, handled end-to-end, beats a half-built everything.
