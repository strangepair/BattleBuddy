# DECISIONS.md — BattleBuddy

A running log of significant product/architecture decisions and deviations from the spec, with the reasoning. Newest at the top. Add an entry whenever you make a call that a future reader would otherwise have to reverse-engineer.

---

## 2026-07-09 — Profile store moved to Supabase, kept synchronous via boot-time cache warm-up

**Decision.** `contextAgent.js`'s `loadProfile`/`saveProfile` now read/write a Supabase `user_profiles` table (jsonb column) instead of `context-store/{userId}.json` on the Railway volume. The volume file is the fallback for migration only — session transcripts (a separate concern) are untouched and still live there. `USER_ALIASES` (previously a hardcoded const, contrary to how the migration request described it — it was never actually persisted anywhere) is now mirrored into a `user_aliases` table too, seeded from the hardcoded map on first boot; the hardcoded map remains the offline fallback.

**Why kept synchronous.** `loadProfile`/`saveProfile` are called from ~20 sites across `contextAgent.js` and `index.js`, several inside per-turn prompt-building functions (`buildProfileSummary`, `buildCurrentGoal`, etc.) that are not awaited by their callers. Converting all of them to `async`/`await` would cascade through most of both files, and a single missed `await` would inject a literal `"[object Promise]"` into a live system prompt shown to a real user. Instead: `warmProfileStoreFromSupabase()` runs once at module load via **ESM top-level await** — Node blocks `index.js`'s import of `contextAgent.js` (and therefore `server.listen()`) until every `user_profiles` row is pulled into the existing in-memory `profiles` cache and every `user_aliases` row is merged into `USER_ALIASES`. From then on, `loadProfile` is a pure cache read (a cache hit *is* "read from Supabase" — it was populated from there at boot); `saveProfile` fire-and-forgets an upsert (errors logged, never thrown — the pre-existing `writeFileSync` call it replaces wasn't awaited by callers either, so this preserves the exact same call contract).

**Also fixed (not in the original ask, but would have silently broken).** `admin-api.js`'s admin-console user list and `agentDesignLoop.js`'s in-process (production) profile loader both read `context-store/*.json` directly, bypassing `contextAgent.js` entirely. Once `saveProfile` stopped writing to the volume, both would have frozen at whatever was on disk at cutover — new users and profile updates would silently stop appearing in the admin console and the design loop's per-user signal digest. Both now read `contextAgent.js`'s new `listKnownProfiles()` export (a live snapshot of the same in-memory cache `saveProfile` writes through). The design loop's dev-only `--remote` CLI path still discovers candidate userIds from the local volume checkout — that's a manual tool run from a dev machine, not a production path, and was left alone with a comment flagging the limitation.

**Not yet done — needs the repo owner.** There's no `psql`/Supabase-CLI/management-API credential available to this session, so the `CREATE TABLE` statements in `server/migrations/007_user_profiles.sql` must be run manually via the Supabase SQL Editor before any of this can read/write real data (same convention as the existing `002/005/006` migrations in that directory, none of which are auto-applied either). Until that's run, every profile read falls back to the volume and every write logs an error and no-ops on the Supabase side — verified locally, doesn't crash the server. The one-time backfill script (`server/scripts/migrateProfilesToSupabase.js`) and its temporary `POST /admin/migrate-profiles` endpoint are ready to run once the table exists.

---

## 2026-07-08 — Design loop moved into bb-server (no dev-machine dependency)

**Decision.** `agentDesignLoop.js` is now an importable module (`runDesignLoop()`) that bb-server runs in-process: scheduled daily (hourly check, 23h min gap, only when new sessions exist since the last run; first boot seeds state rather than running) and on demand via `POST /admin/console/design-loop/run` / the console's "Run design loop" button. Mike's requirement: operating the product must not depend on his laptop being awake or on a Claude Code session.

**Prod adaptations.** Proposals write to `/data/agent-proposals/`; the applied prompt persists via the volume prompt store (`persistPromptLive` in contextAgent.js — shared with console saves) instead of git; `agent.md` comes from a console-managed volume copy (`GET/POST /admin/console/agent-md`) because the repo file isn't in the image; git commit/push is skipped when `RAILWAY_ENVIRONMENT` is set. CLI behavior on a dev machine is unchanged (repo paths, commit+push), so the repo can still be brought back in sync from a dev session.

**Consequence accepted.** Prod-applied prompt changes are not in git history until someone folds them in from a dev machine; the audit trail in prod is the volume (prompt-backups, agent-proposals, applied summaries via email).

---

## 2026-07-08 — Console prompt edits persist via volume restore, not git

**Problem.** The admin console's "Save & Commit" failed in production: the bb-server image (build context `server/`, `node:20-slim`) has no git binary, no `.git` dir, and no credentials. The design loop's commit+push works only because it runs on Mike's machine, not on Railway.

**Decision.** Dropped Save & Commit. Every console save now writes the prompt to the container file (instant hot-reload) AND mirrors it to `/data/prompt-live/` with the sha256 of the prompt the running image shipped with. On boot (admin-api.js import), if the image's prompt hash matches the recorded one, the console edit is restored — it survives redeploys of the same prompt. If a deploy ships a *different* prompt (design-loop commit, dev change), the repo wins and the console edit is archived as `prompt-live/superseded-<ts>.md`, never silently lost. The console shows a "console-edited" marker whenever the live prompt differs from the repo version, as a reminder to fold edits back into git during a dev session.

**Rejected.** Installing git + shipping the repo and a PAT into the image (fat image, credentials in container, and server-side pushes to one mirror would diverge the strangepair/codegrad dual-push setup); GitHub Contents-API commits (same divergence problem).

---

## 2026-07-06 — UX & agent-experience roadmap adopted; gamification = personal records, not live streaks

**Decision.** Adopted `docs/08-UX-AGENT-EXPERIENCE-PLAN.md` as the sequencing source of truth for post-MVP work: trust/reliability fixes → `bb_events` taxonomy v2 (adds `urge` + `decision` types, structured trigger metadata, `source` incl. `retroactive`) → proactive engagement v1 (risk-window sweep made live behind an engagement window; self-initiated vs prompted logged distinctly) → personal records + Journey dashboard.
**Gamification call (Mike, 2026-07-06).** **Personal records, not live streaks.** Records only ever grow; a slip never resets anything visible; honesty (including disclosed slips) is what gets celebrated. This supersedes the current `goals.tsx` milestone ladder (1/3/7/14/30/60/100 *consecutive* resists), which is a fragile-streak design and must be reworked into a records wall + competence milestones.
**Why.** A visible streak reset is a shame moment that triggers the abstinence-violation effect ("I already failed, so why stop") — the exact spiral the product exists to prevent. Records preserve the self-competitive motivation Mike wants without ever punishing a slip. Also consistent with the standing persona rules: no day-counting, no cheerleader texts, no shaming.
**Amendment (2026-07-06, same day).** Added §6 "Privacy, Trust & Data Ownership" to doc 08 per Mike: transcripts are addiction conversations — users must be able to see/export/delete everything BB knows about them, and nobody else can ever access it. Verified in code that `GET /context/transcripts/*`, `GET/PUT /context/profile/*`, and `/admin/*` on bb-server are **unauthenticated** today → endpoint lockdown promoted to Week 1 of the 30-day plan. **New gate: Privacy Policy + Terms (written in plain language) and the endpoint lockdown ship before the second real user (Alec).**

**Context.** A full audit found that every mobile-direct Supabase write was silently failing: the app uses local text ids (`user-<timestamp>`, no Supabase Auth), while `craving_events`, `messages`, `push_tokens`, and `session_reports` all have uuid FKs + `auth.uid()` RLS policies. All four tables had 0 rows in prod. Consequences: History/Insights screens permanently empty, session reports generated by Sonnet then discarded, offline sync retrying the same batch forever (server returned 200 + empty `synced_ids`), push registration failing invisibly.

**Decision.** Standardize all event-shaped data on `bb_events` (text `user_id`, service-role writes through the server):
- `/sync/events` writes sessions as `event_type='session'` rows, idempotent on the client-side id (`metadata->>local_id`).
- `/sync/messages` now merges into the volume-backed transcript store (`context-store/session-transcripts/`) — the old path referenced a `urge_event_id` column that doesn't exist in the `messages` table.
- `/session/report` stores reports as `event_type='session_report'` rows (previously required a `craving_events` uuid the app can never produce, so every report was dropped).
- History reads `GET /events?eventTypes=session`; Insights reads `eventTypes=session_report`; `profileBuilder` reads `GET /context/profile/` — all through the server.
- Conversation-extracted smokes/resists are mirrored into `bb_events` (deduped ±10 min) so voice and text answer count questions from one source of truth (`buildUsageSummary`).
- `push_tokens.user_id` altered to text (`supabase/migrations/20260703_identity_alignment.sql`) so registration can succeed.
The `craving_events`/`messages`/`session_reports` tables and their RLS design stay in place for a future migration to real Supabase Auth; nothing writes to them today.

**Session accounting.** Text sessions now finalize (`isSessionEnd: true → /context/analyze`) from `endSession`; the LiveKit `room_finished` webhook no longer increments `session_count` (it double-counted every voice session on top of the voice agent's own finalization). Background checkpoint saves pass `finalize: false`.

**Cost/latency.** Per-turn Sonnet extraction throttled to every 6th message (session end still runs full extraction). `buildProfileSummary` is budgeted: last 5 sessions in full detail, older ones as one-liners, 2 days of activity timeline, 12K-char hard cap — the runtime prompt had reached 68K chars.

**Also.** vectorStore.js Node-20 WebSocket crash fixed (`ws` transport) and `retrieveRelevant` finally wired into `/session/turn` (`{{relevant_memories}}`, 800ms budget); system prompt v1.1 documents the three real tools and drops three fabricated ones; `/transcribe` (whisper venv absent from the Docker image), the transcript-dir watcher (nothing writes that dir since the voice agent posts HTTP), and `syncRiskWindowsToSupabase` (never called) removed; a conservative risk-window nudge scheduler now runs in-process (15-min sweep, quiet hours, ≥90 min gap, ≤3/day); `server/context-store/` untracked from git (real user personal data was committed).

---

## 2026-07-02 — Transactional event store (`bb_events`) + `get_usage_stats` tool

**Decision.** Added a `bb_events` table (Supabase) as a deterministic log of discrete events — `cigarette`, `urge_resisted`, `urge_gave_in`, `milestone`, etc. — with `POST /events` / `GET /events` endpoints and a real Anthropic `get_usage_stats` tool wired into the `/session/turn` streaming call in `server/index.js`, so the agent queries the DB instead of guessing "when was my last cigarette" from conversational memory. `server/index.js` uses raw `node:http` (not Express) and Supabase writes elsewhere in that file go through hand-rolled `fetch` calls to the PostgREST endpoint rather than the `@supabase/supabase-js` client — the tool handler needed a real client for `.from().select()/.insert()` query building, so a module-level `supabase` client (service-role key) was added to `server/index.js` for this feature, following the same pattern already used in `server/vectorStore.js`.
**Also fixed in passing.** `POST /sync/events` (offline sync of full craving-session records) was writing to a Supabase table named `urge_events`, which doesn't exist — the real table (per `supabase/migrations/001_initial_schema.sql` and the online path in `mobile/src/services/outcomeRecorder.ts`) is `craving_events`. Fixed the table name rather than rerouting through `bb_events`, since offline-synced records carry richer session data (intensity, mode, trigger_context) that `bb_events`'s simple schema doesn't model — this was a straightforward typo, not a schema mismatch.
**Discovered, not fixed (out of scope).** While testing, found that `server/vectorStore.js`'s `createClient()` call throws on Node 20 (`server/Dockerfile` is `node:20-slim`) because `@supabase/supabase-js`'s realtime client requires a WebSocket global Node 20 doesn't provide by default — even though vectorStore only does REST calls, never realtime. The throw is silently swallowed by blanket `.catch(() => {})` at call sites, so the AI-memory vector store has likely been a silent no-op in production. Fixed for the new `bb_events` client here by installing `ws` and passing `{ realtime: { transport: WebSocket } }` to `createClient()`; the same fix should be applied to `vectorStore.js` but was left as a follow-up to keep this change scoped to the event store.
**Why.** "When was my last cigarette" / "how many today" are exactly the kind of fact an LLM should never be trusted to recall from a conversation transcript — small errors compound into the agent contradicting itself across sessions, which erodes trust fast in a habit-coaching product.

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

## 2026-06-27 — Backend: Node.js over Supabase Edge Functions

**Decision.** The spec called for Supabase Edge Functions (Deno). During Phase 1 we switched to a Node.js HTTP server in `server/` because LiveKit, Whisper STT, and the Anthropic SDK are difficult on Deno Edge. Supabase is still used for the database (Postgres/pgvector/RLS) but not as the compute layer. The `supabase/functions/` stubs have been removed; `server/` is canonical.

---

## 2026-07-02 — `prompts/` moved into `server/prompts/`

**Decision.** Moved `prompts/system.battlebuddy.md` and `prompts/knowledge.rat-park.md` from the repo root into `server/prompts/`. The Dockerfile moved from repo root to `server/Dockerfile` and now uses `server/` as its own build context (`COPY . .` plus a new `server/.dockerignore` excluding `.env`, `node_modules`, `agent.log`, `transcripts`, `context-store`).
**Why.** The Railway `bb-server` service has its Root Directory set to `/server`, which also scopes the Docker build context to `server/`. The old root Dockerfile did `COPY prompts/ ./prompts/`, which needs the monorepo root as context and silently fails/misses files under a `/server`-scoped build. Moving `prompts/` inside `server/` (rather than duplicating it) was required because `server/agentDesignLoop.js` auto-commits proposal-driven edits straight to `prompts/system.battlebuddy.md` and pushes to `main` — a duplicate copy at the repo root would drift out of sync with what Railway actually serves the moment the design loop wrote to the wrong copy.
**Affects.** `server/index.js` and `server/agentDesignLoop.js` now resolve prompt paths relative to `server/` (no more `../prompts`). All doc references (`CLAUDE.md`, `docs/*.md`) updated to `server/prompts/system.battlebuddy.md`.

---

## 2026-07-07 — `agentDesignLoop.js`: streamed apply-proposals call + admin auth header

**Decision.** Two fixes to `server/agentDesignLoop.js`, found while running the scheduled design loop: (1) `applyProposalsToSystemPrompt` now calls `client.messages.stream(...).finalMessage()` instead of a plain non-streaming `client.messages.create(...)`; (2) `fetchRemoteProfile` now sends `x-bb-admin-secret` on its request to `/context/profile/:userId`.
**Why.** (1) That call regenerates the full system prompt (up to 16,384 output tokens) in one non-streaming response. It hit `APIConnectionTimeoutError` three times in a row on 2026-07-07 as the prompt crossed ~46K chars — including once with the client `timeout` option explicitly raised to 20 minutes, which made no difference. That rules out a client-side timeout being too short; something in the network path (likely a proxy/load balancer enforcing an idle-connection limit) drops long non-streaming responses before the first byte arrives. Streaming keeps bytes flowing so nothing treats the connection as idle — this is Anthropic's own standing recommendation for long-running generations, not a workaround specific to this bug. (2) The same day, an unrelated security fix (`8a14aa3`, lock down unauthenticated endpoints) started requiring `x-bb-admin-secret` or a per-user Supabase JWT on that route. The design loop is neither a logged-in user nor able to obtain a JWT — it's internal tooling, same category as `admin.html`, so it authenticates the same way `admin.html` does.
**Affects.** `server/agentDesignLoop.js` only. Any future full-file rewrite call added to this script (or a similar one) should default to streaming if `max_tokens` is large — a non-streaming call that *happens* to be fast today can start silently timing out once the file it's rewriting grows past whatever threshold the network path enforces.

---

> Tip: pre-existing strategic choices that predate this log and still stand — React Native + Expo, Supabase, the hybrid Gemma (on-device) + Claude (cloud) brain, and Sesame CSM for voice — are documented in `CLAUDE.md` and `docs/`. Only log *changes* and *new* decisions here.
