# BattleBuddy — Spec Package

This folder is the design/spec handoff for building **BattleBuddy**: a mobile AI companion that acts as a real-time **circuit breaker for urges** — training impulse resistance to help break a habit. MVP target: **quitting smoking/vaping** (US-only); it generalizes to other habits later. It is a habit-change companion, **not** a crisis service.

These docs are written to be read by a **Claude Code** (or Dispatch) session as its source of truth. Start with `../CLAUDE.md`, then read the docs in order.

## How to use this package

1. Open your repo in Claude Code.
2. Point it at `CLAUDE.md` (repo root) — that's the standing brief.
3. Have it read `docs/` in order, then begin **Phase 0** of the build plan.

## Contents

| Doc | What it covers |
|---|---|
| `../CLAUDE.md` | Standing instructions for every Claude Code session. Read first. |
| `01-PRD.md` | Product concept, the slime-mold / circuit-breaker thesis, scope, MVP cut line, success metrics, safety footing. |
| `02-ARCHITECTURE.md` | Stack, agent loop, data model, R2 media storage, personalization engine, security. |
| `03-AGENT-DESIGN.md` | Supportive-coach persona, system prompt, tools, urge-wave exercise, **safety/scope design**. |
| `04-BUILD-PLAN.md` | Phased build sequence (Phase 0 → MVP), exit tests per phase. |
| `05-MODEL-STRATEGY.md` | Hybrid brain: on-device Gemma 4 + cloud Claude, routing tiers, offline behavior. |
| `06-VOICE.md` | Voice layer: building on Sesame CSM (self-/managed-GPU), voice-identity locking, fallback. |
| `07-IDENTITY-AND-METHOD.md` | **The soul of the product:** core identity, values, the evidence base behind every method, and the personalized→shareable framework engine. Read when tuning persona, prompts, or the intelligence layer. |

## The one-paragraph summary

A user feeling an urge taps one button and is instantly with their buddy — a warm, direct, encouraging AI coach (text or voice) that helps them ride the urge wave, redirects them with a dopamine-positive song/video/exercise tuned to what works for *them*, and logs the outcome. Over time the app learns each person's patterns and gets better at the moment that matters. The app is honest that it's a habit companion, not an emergency service. The north star is measurably fewer slips and, ultimately, breaking the habit — the user needing the app less.

## First decisions (settled)

- **First habit to optimize for:** ✅ **smoking / vaping** (frequent urges = fast learning signal; no dangerous withdrawal = clean habit-change scope).
- **MVP media source:** small curated, tagged library hosted in **Cloudflare R2** (controlled quality + content ownership) before any live search.
- **Scope:** **US-only** for MVP (crisis resource = 988); habit app, not crisis/clinical.
- **Voice:** ship text-first, voice in the same phase right behind the core loop.
