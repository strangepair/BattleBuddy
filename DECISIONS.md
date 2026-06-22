# DECISIONS.md — BattleBuddy

A running log of significant product/architecture decisions and deviations from the spec, with the reasoning. Newest at the top. Add an entry whenever you make a call that a future reader would otherwise have to reverse-engineer.

---

## 2026-06-15 — Reframe: habit-change, not addiction/crisis

**Decision.** BattleBuddy is positioned as a **habit-change companion that trains impulse resistance**, not an addiction-recovery or crisis tool. The slime-mold → commander thesis, the circuit-breaker loop, and the personalization moat all stay; the clinical/crisis framing goes.
**Why.** Mike clarified the product is for building new habits and resisting everyday urges, not managing acute mental-health emergencies. The clinical framing carried compliance and liability weight that the actual product doesn't warrant.
**Affects.** All docs reframed; persona softened (see below); safety machinery cut down (see below).

## 2026-06-15 — MVP target habit: smoking / vaping

**Decision.** The MVP optimizes for **quitting smoking/vaping** first.
**Why.** It's Mike's own target habit; nicotine produces frequent urges (fast learning signal for personalization) and has **no medically dangerous withdrawal**, so the product stays cleanly in habit-change territory. Architecture generalizes to other habits (scrolling, snacking, spending) later.

## 2026-06-15 — Tone: supportive coach, not military "battle buddy"

**Decision.** Persona softened to a warm, encouraging **supportive coach** ("let's go, you've got this"). Name "BattleBuddy" kept; the drill-sergeant / "2am in the trenches" framing dropped.
**Why.** Mike's preference; better fit for a habit-coaching context than a crisis-companion voice.

## 2026-06-15 — Safety footing: lightweight, not a crisis system

**Decision.** Removed the hard-coded crisis machinery: no deterministic pre/post-model crisis gate, no blocking crisis-phrase CI test, no offline crisis classifier, no dangerous-withdrawal coaching path. **Kept:** a clear "not for emergencies → contact 988" disclaimer screen (US-only MVP), a soft model-level off-ramp in the system prompt (if a user sounds in genuine crisis, the buddy says it's an AI for habits, points to 988, and stops), the standing no-medical-advice rule, and no-shaming. An optional, non-blocking output keyword screen may stay as cheap insurance.
**Why.** This is a habit app for everyday urges, not a clinical/crisis product. The heavy machinery was scoped for an addiction product. Honesty about scope (the disclaimer) is the real protection. Mike accepted keeping the lightweight 988 off-ramp as a sensible, low-cost backstop.
**Revisit if.** The product ever expands into clinical/addiction or non-US territory — then crisis handling and localization need a real design.

## 2026-06-15 — Media storage: Cloudflare R2

**Decision.** The curated media library (songs/videos/images for interventions) is hosted in **Cloudflare R2** (S3-compatible, no egress fees). Postgres `media_library` rows store R2 object URLs; the app streams via short-lived signed URLs.
**Why.** Mike has a Cloudflare account; R2's no-egress pricing fits media delivery, and self-hosting assets (vs. external YouTube embeds) gives content ownership and quality/safety control. Note: Supabase Edge Functions run on Deno — use an S3-over-fetch client (e.g. `aws4fetch`), not the AWS Node SDK.

## 2026-06-15 — Scope: US-only MVP

**Decision.** MVP ships **US-only**, so the single crisis resource is 988. No localization layer.
**Why.** Keeps the disclaimer trivial and avoids building multi-jurisdiction resource routing before there's demand.

## 2026-06-15 — E2E test framework: Maestro

**Decision.** Phase exit E2E tests use **Maestro** on a simulator in CI.
**Why.** Simplest setup for Expo / React Native; good enough for the panic-button → session → outcome flows. (Was previously unspecified.)

---

## 2026-06-15 — Phase 0 build: Jest pinned to v29

**Decision.** `jest` and `@types/jest` pinned to `^29` (not latest v30).
**Why.** `jest-expo@56` targets Jest 29 internals (`@jest/globals@^29`). Installing Jest 30 caused a `clearMocksOnScope` runtime error at test boot.

## 2026-06-15 — Phase 0 build: app.json slug set to `battlebuddy`

**Decision.** Updated Expo `name`, `slug`, and `scheme` to `battlebuddy`. Added deep-link scheme `battlebuddy://` for Supabase auth callback redirect.
**Why.** Expo scaffold defaulted to `mobile` (the folder name). Deep-link scheme is required for Supabase magic-link / OAuth flows in Phase 1.

---

> Tip: pre-existing strategic choices that predate this log and still stand — React Native + Expo, Supabase, the hybrid Gemma (on-device) + Claude (cloud) brain, and Sesame CSM for voice — are documented in `CLAUDE.md` and `docs/`. Only log *changes* and *new* decisions here.
