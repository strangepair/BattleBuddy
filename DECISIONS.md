# DECISIONS.md — BattleBuddy

A running log of significant product/architecture decisions and deviations from the spec, with the reasoning. Newest at the top. Add an entry whenever you make a call that a future reader would otherwise have to reverse-engineer.

---

## 2026-07-19 — Prompt caching, a promoted memory tier, and named args for `buildSystemPrompt`

**Context.** Three complaints — BB can't track time, greetings aren't relevant, it won't introspect without prompting. Diagnosed against the code rather than assumed, and only one turned out to be what it looked like. Time *is* injected (`index.js` `formatLocalTime`); what's missing is deltas, not the clock. The greeting is a hardcoded string (`Say: 'Hey, ${userName}! How's it going?'`). And the reason recall feels absent at session start is structural: `fetchRelevantMemories` keys off the user's last message, so at greeting time there is no query and nothing is retrieved. `user_memories` was a single tier reachable only by similarity. Patterns borrowed from openclaw's `memory-core` (promotion scoring, always-injected `MEMORY.md`, inferred commitments); **no openclaw dependency added** — it is single-operator and filesystem-bound, and its memory provider defaults to OpenAI embeddings, which contradicts the 2026-07-16 decision below.

**Prompt caching (shipped first, and it's the larger win).** `grep cache_control index.js` returned nothing: a ~35K-token system prompt was re-sent uncached on every turn. The template was already almost perfectly ordered for caching — the persona is static and every runtime placeholder sat at the bottom — with one exception, `{{session_context}}` at line 229, which made the whole file uncacheable. Moved it into the `## Runtime context` block and split the prompt there (`server/promptCache.js`): static half marked `ephemeral`, volatile half unmarked. **95.4% of the prompt (~35.7K tokens) now caches.** Render order is tools → system → messages, so the single breakpoint covers `AGENT_TOOLS` too, and Haiku 4.5's 4096-token minimum prefix is cleared ~8.7×. Cache reads bill at 10% of input, but the reason this went first is rule 5 — that re-read was most of time-to-first-token, and it also pays for the extra tokens the memory tier adds. Every turn now logs `[Cache] read=… write=… uncached=…`; `read` stuck at 0 across turns means something per-turn crept above the split.

**Failure mode chosen deliberately:** if the `## Runtime context` marker goes missing — plausible, since the agent design loop edits that file unattended — `toCachedSystemBlocks` degrades to sending the prompt uncached and warns. Caching a prefix that has silently gained per-turn data would serve one user's profile to the next; in this product that is the worst available outcome, so losing the cache is the correct trade.

**Promoted memory tier.** `009_memory_promotion.sql` adds `promoted` / `promoted_at` to `user_memories` plus a partial index, and `getPromotedMemories` reads them with no query and no embedding — that is the point, since at session start there is nothing to embed. Rendered as `{{promoted_memories}}` ("What you carry about this person") on every turn regardless of what was said. Additive and inert until the promotion job lands: nothing sets `promoted`, so today it returns empty and the prompt renders its fallback. **The voice path was the real find** — it called `buildSystemPrompt` with 7 of 9 positional arguments, omitting `relevantMemories` and `sessionMemory` entirely, so voice sessions had *no* memory of any kind. That is the greeting bug, and the promoted tier is now wired there specifically.

**Deviation: `buildSystemPrompt` takes an options object.** Not in the plan. With a tenth field the positional call reads `(…, currentGoal, undefined, undefined, promoted)`, and one misplaced argument renders another section's data into a live prompt with nothing to catch it — the same class of failure as the `[object Promise]` near-miss (2026-07-09), in a product where the blast radius is a person in recovery. Both call sites converted; the voice path's omissions are now explicit rather than positional.

**Testing.** The server had no harness (root `package.json` had no scripts; only `mobile/src/**/__tests__` existed). Added one on Node's built-in `node --test` — no new dependency, per the standing rule about third-party SDKs. `npm test` in `server/`, 8 tests: the cache split, its lossless/fallback behavior, that no per-turn placeholder ever lands in the cached block, that the cached block clears Haiku's minimum, and — both directions — that every template placeholder has a matching `.replace()` and vice versa. That last one guards the specific bug of adding a placeholder and shipping a literal `{{promoted_memories}}` to a user.

**Promotion loop (010 + `promotionJob.js`).** Retrieval frequency is the promotion evidence: `fetchRelevantMemories` fires `recordRecalls` after surfacing memories into a prompt, and a nightly sweep scores the accumulated signal. Weighted `0.30·relevance + 0.24·frequency + 0.15·diversity + 0.15·recency + 0.10·consolidation + 0.06·conceptual`, gated on `recall_count ≥ 3`, `unique_queries ≥ 3`, `score ≥ 0.8`, plus a 30-day staleness cut. Scheduler mirrors the design loop exactly — hourly tick, 23h gap, first boot seeds the state file so a deploy never triggers a surprise sweep.

Recall evidence is one `text[]` of `YYYY-MM-DD:<query-hash>` rather than separate day/hash/dedupe columns: days give spacing, hashes give context diversity, the pair is the dedupe key. **The dedupe is the load-bearing part.** Without it a single long session — same worry, same phrasing, fifteen turns — is indistinguishable from fifteen days of recurrence, and everything touched during one bad night promotes itself into permanent context. Consolidation (0.55·spacing + 0.45·span) exists for the same reason. Day boundaries are computed in the user's local timezone, not UTC, because late-night sessions are common here and an 11pm Central session landing in "tomorrow" UTC would split one evening across two days and inflate the exact signal being measured. Queries are hashed, not stored — the table already holds health content without also keeping verbatim user text in the recall trail.

**Calibration, measured rather than assumed.** At realistic similarity values the effective bar is ~5 recalls spread over ~a week: 3 recalls never promotes (0.67 at sim 0.55, 0.75 at sim 0.75 — both blocked on score), 5 across 7 days clears at 0.804, and it is comfortable above that. Worth knowing the practical consequence: recall evidence only starts accruing when 010 is applied, so **the promoted tier stays empty for roughly a week of active use** before anything appears in it. Backfilling from transcript co-occurrence is possible but not done — the honest version is that the loop should earn its promotions.

**Grounded greeting (`greeting.js`).** The returning-user greeting already asked the model to "reference ONE specific thing you know about them," but handed it no concrete fact and no time-gap, so the model invented from the profile — and invention reads generic, which is the "greeting isn't relevant" complaint. `buildVoiceGreeting` now puts a real elapsed-time gap and one durable promoted fact directly into the instruction. Reuses the existing session-gap and last-event lines rather than recomputing them; `sessionGapPhrase` was extracted from `buildSessionContext` so the two phrasings can't drift. Falls back to last session's `next_session_hints` when the promoted tier is still empty (the first ~week), which still beats a generic opener.

**Correction to the plan: the recall tool already existed.** The subagent survey read `agent.md`'s "NEW HIGHEST PRIORITY: BB needs a recall tool wired to them" and reported it as unbuilt. The code has since gained `recall_conversation` — semantic recall via `retrieveRelevant` plus dated transcript keyword search, wired into both the text tool loop and the voice `/context/recall` endpoint. `agent.md` is stale on this point. What was genuinely missing: `recall_conversation` retrieved memories without recording the recall, so the strongest possible "this matters" signal — the model *deliberately* reaching for a memory — never fed the promotion loop. Fixed; `recordRecalls` now fires from the tool path too, with the model's own search query as the recall context (a legitimately distinct key from the automatic per-turn retrieval).

**Inferred commitments (Phase 4 — `commitments.js` + `011`, OFF by default).** BattleBuddy already reaches out proactively (`runNudgeSweep`), but only on learned time-of-day risk windows — it has no memory of a specific thing someone said. A commitment is the content-derived kind: after a session, a hidden Sonnet pass infers a small number of forward-looking follow-ups ("they said they'd try the gym Tuesday") and one is surfaced later, in-conversation.

This is the highest-risk piece in the memory work and is built to that: **gated behind `COMMITMENTS_ENABLED` (default off)** — nothing infers or delivers until Mike turns it on after reviewing real candidates, the same propose-then-approve posture as the design loop. The product constraints drive the shape (CLAUDE.md): habit companion not crisis service, never shame a slip, success is the user needing the app *less* — so a wrong proactive check-in costs more than a missed one. That is why care check-ins are held to 0.86 vs 0.72 for everything else, the per-session cap is 2, and the extraction prompt is told to prefer no candidate over a weak one. Migration `011` adds `user_commitments` with RLS and a partial unique index (`user_id, dedupe_key WHERE status='pending'`) so the same follow-up inferred twice can't stack.

**Delivery is in-conversation, not push — deliberately.** A due commitment becomes the reason to open a voice session (a new `checkIn` hook on `buildVoiceGreeting`), so BB phrases it warmly in its own words and it never lands on a lock screen as inferred content. Marked delivered the moment it's handed to the agent, so it can't fire twice; only on a fresh greeting, never mid-thread. The commitment summary is framed as untrusted context throughout — a reason to consider reaching out, never an instruction or a line to read verbatim, mirroring the framing on recalled memory. `runNudgeSweep` and its rails are untouched.

**Auto-delivery of high-confidence commitments (2026-07-19, follow-up).** Mike asked to auto-enable high-confidence commitments rather than hold everything for manual review — consistent with the design loop, which already auto-applies HIGH-confidence proposals. Added a delivery-time gate (`shouldAutoDeliver`, and matching filters in `getDueCommitment`): only commitments at/above `COMMITMENTS_AUTO_DELIVER_MIN` (default **0.85**, well above the 0.72 insert gate) auto-deliver; the rest stay queued as the review set. `COMMITMENTS_AUTO_DELIVER_MIN` is tunable — set it above 1.0 for observe-only (populate the table, auto-fire nothing) while looking at real scores.

**One line held: `care_check_in` never auto-delivers by default.** A mistimed "you seemed to be struggling" check-in is the most harmful move this system can make in a recovery context, and no human had yet seen how the model does care check-ins. So care stays on the manual path unless `COMMITMENTS_AUTO_DELIVER_CARE=true` — a safe default, disclosed and overridable, not a silent override. Two caveats at ship time: the app was out of Anthropic API credits, so inference (a Sonnet call) couldn't run and the table was empty — auto-delivery is inert until credits return; and no real candidate had been observed, so the recommendation is to run observe-only for a few days once credits are back before trusting the 0.85 bar. Also fixed an ordering bug: the commitment config consts were read above the `.env` loader (harmless on Railway where env comes from the platform, but a local `.env` wouldn't have been honored).

**Not done yet.** In-app (text-path) delivery of commitments — v1 surfaces them through the voice greeting only; an admin surface to review the queued (below-bar + care) commitments. See `RELEASE-PLAN.md`.

---

## 2026-07-16 — Semantic memory recall: self-hosted embeddings, not a hosted API

**Decision.** `user_memories` retrieval (`server/vectorStore.js`) moves from Postgres full-text search (`ts_rank` over a `tsvector` column, per the 2026-07-02 decision below) to real embedding-based cosine similarity. Embeddings are computed **in-process on bb-server** by `server/embeddings.js`, running `Xenova/all-MiniLM-L6-v2` (384-dim, ~90MB) via `@huggingface/transformers` (ONNX runtime) — no external embedding API call, no per-token cost, no new vendor. Model weights cache to the Railway volume (`ADMIN_DATA_ROOT/models`) so a redeploy doesn't re-download them. Schema change in `server/migrations/008_user_memories_embeddings.sql`: enables `pgvector`, adds an `embedding vector(384)` column, and replaces `match_user_memories` (different signature — old text-based overload explicitly dropped rather than left as a dead duplicate). The old `search_vector`/GIN index stay in place, unused, rather than churning a working column for no functional gain.

**Bug found and fixed before shipping: no approximate-search index, and that's deliberate.** The first version of the migration added an `ivfflat(lists=100)` index. Verified against the real table (~3,444 rows) post-backfill: an exact-duplicate query matched fine, but a realistic novel query ("feeling stressed about work and wanting a cigarette") returned **zero** results out of thousands of candidate rows for the canonical user. Root cause: `ivfflat` partitions the vector space into `lists` clusters and, by default, only probes 1 of them per query (`probes=1`) — at ~34 rows/list here, a genuinely novel query has roughly a 1% chance of landing in the right partition. (A small test user with 7 rows worked fine only because the planner likely skipped the index for such a tiny row count.) Fix: dropped the index (`DROP INDEX user_memories_embedding_idx`, run manually by Mike, no data loss) and left `match_user_memories` doing a plain sequential scan — exact nearest neighbor, no recall loss, and fast enough at this size (see Latency below). Revisit indexing (ivfflat needs real data present *before* index creation to cluster well; `hnsw` doesn't have that footgun but costs more to build/maintain) once the table is large enough that a seq scan actually shows up as a cost.

**Why self-hosted over OpenAI/Voyage.** Mike's call, discussed explicitly: at ~2 real users the retrieval-quality gap vs. a hosted embedding model is very unlikely to matter for "does this past memory resemble what's happening now" recall, and self-hosting avoids sending addiction/health conversation content to a third-party API — consistent with the project's existing privacy stance (Claude/STT/TTS/R2 keys are already server-side only; this keeps embeddings the same way). `@huggingface/transformers` runs the model **in the same Node process** (WASM/ONNX, no separate Python microservice) — so "self-hosted" here adds zero new infrastructure, just an ~90MB one-time model download and a modest RAM footprint in the existing bb-server container.

**Backfill.** `server/scripts/backfillMemoryEmbeddings.js` computed embeddings for all 3,444 existing rows (`embedding IS NULL`), paginated and idempotent — 0 failures. Unlike the profile-store backfill, this needed no temporary admin HTTP endpoint — it only touches the shared Supabase table, so it ran directly from a dev machine.

**Verified before running against the real table.** Tried a partial-column upsert (`{id, embedding}` only, to batch writes and avoid re-sending `content`/`type`/`user_id`) against a disposable throwaway row first. Postgres's `ON CONFLICT DO UPDATE` still needs the full row's NOT NULL columns satisfiable in the same statement even though only the conflict/update path is taken, so the backfill script does a plain `UPDATE ... WHERE id = ...` per row instead, with modest concurrency (10 in flight) rather than one massive batch call.

**Latency.** `retrieveRelevant` does one embedding inference (single-digit ms once the model is warm) then the Supabase RPC call, inside `fetchRelevantMemories`'s existing 800ms race in `index.js`. Measured against the real 3,444-row table post-index-drop: first call after a fresh connection ~934ms (one-time TLS/plan-cache warm-up), steady state ~106–123ms — comfortably inside budget. If the local embedding model isn't warm yet (first request after a cold boot), that race already degrades gracefully to "no memories this turn" rather than blocking the reply.

---

## 2026-07-14 — One Conversation mobile port: reconstructed brief, TestFlight profile, voice entry points

**Decision.** The native One Conversation port (new `app/(app)/session.tsx` surface replacing the separate-screens UI) was built against `server/web/index.html` (the /app web head) as the behavioral and visual spec. The planning brief it was supposed to follow — `battlebuddyredesign/mobile/MOBILE-PORT.md`, including a drafted `BreathingCard.tsx` — does not exist anywhere on the dev machine (repo, ~/Downloads zip, Trash); the web head is the same design from the same deliverable, so it served as the spec of record. BreathingCard was written fresh from the web head's `breathingCard()`.

**Deviations worth knowing.**
- TestFlight builds use the `production` EAS profile, not `preview`: `preview` is `distribution: internal` (ad-hoc), which App Store Connect rejects, and every prior TestFlight build in the project used `production`.
- Both hub swipe directions (up AND down) now open `/session`. There is no separate voice screen to point "down" at anymore, and a route that pre-armed the mic would violate the audio-never-auto-enables rule — voice is the dock's speaker tap, opt-in per session.
- Push notifications that used to deep-link to `session-voice` now open `/session` with audio off, same rule.
- `goals.tsx` needed no "streak ladder" removal — it was already the records/milestones screen (records only grow; no streaks).

**Affects.** `session-chat.tsx`, `session-voice.tsx`, and `TriggerCapture.tsx` are deleted; `ChatBottomSheet` (kept for the legacy `HomeScreen`) lost its dead TriggerCapture branch. `statsService` now validates `/stats/*` response shapes — the previously assumed shapes crash the journey charts for any real signed-in userId.

---

## 2026-07-09 — Profile store moved to Supabase, kept synchronous via boot-time cache warm-up

**Decision.** `contextAgent.js`'s `loadProfile`/`saveProfile` now read/write a Supabase `user_profiles` table (jsonb column) instead of `context-store/{userId}.json` on the Railway volume. The volume file is the fallback for migration only — session transcripts (a separate concern) are untouched and still live there. `USER_ALIASES` (previously a hardcoded const, contrary to how the migration request described it — it was never actually persisted anywhere) is now mirrored into a `user_aliases` table too, seeded from the hardcoded map on first boot; the hardcoded map remains the offline fallback.

**Why kept synchronous.** `loadProfile`/`saveProfile` are called from ~20 sites across `contextAgent.js` and `index.js`, several inside per-turn prompt-building functions (`buildProfileSummary`, `buildCurrentGoal`, etc.) that are not awaited by their callers. Converting all of them to `async`/`await` would cascade through most of both files, and a single missed `await` would inject a literal `"[object Promise]"` into a live system prompt shown to a real user. Instead: `warmProfileStoreFromSupabase()` runs once at module load via **ESM top-level await** — Node blocks `index.js`'s import of `contextAgent.js` (and therefore `server.listen()`) until every `user_profiles` row is pulled into the existing in-memory `profiles` cache and every `user_aliases` row is merged into `USER_ALIASES`. From then on, `loadProfile` is a pure cache read (a cache hit *is* "read from Supabase" — it was populated from there at boot); `saveProfile` fire-and-forgets an upsert (errors logged, never thrown — the pre-existing `writeFileSync` call it replaces wasn't awaited by callers either, so this preserves the exact same call contract).

**Also fixed (not in the original ask, but would have silently broken).** `admin-api.js`'s admin-console user list and `agentDesignLoop.js`'s in-process (production) profile loader both read `context-store/*.json` directly, bypassing `contextAgent.js` entirely. Once `saveProfile` stopped writing to the volume, both would have frozen at whatever was on disk at cutover — new users and profile updates would silently stop appearing in the admin console and the design loop's per-user signal digest. Both now read `contextAgent.js`'s new `listKnownProfiles()` export (a live snapshot of the same in-memory cache `saveProfile` writes through). The design loop's dev-only `--remote` CLI path still discovers candidate userIds from the local volume checkout — that's a manual tool run from a dev machine, not a production path, and was left alone with a comment flagging the limitation.

**Update 2026-07-10 — migration completed.** Mike ran `007_user_profiles.sql` via the Supabase SQL Editor. `POST /admin/migrate-profiles` was then called against production: 6 profiles migrated (`user-1782351957094` at 149 sessions, `user-1782249813276`/`default` aliases, `a330de06-...` and `user-1782945554220` — real but session_count:0, likely orphaned auth UIDs/new signups, `test-verify` — a manual test profile, left as-is), 0 failures. The temporary endpoint has been removed (`server/index.js`) now that it's served its purpose.

---

## 2026-07-10 — Bug found during migration verification: bookkeeping files masquerading as profiles

**Problem.** `context-store/audit-state.json` (`runTranscriptAudit`'s last-run marker) and `design-loop-state.json` (`agentDesignLoop`'s last-run marker) live in the same directory as real profile JSON files. Nothing ever stopped `loadProfile()` from being called with `'audit-state'` or `'design-loop-state'` as a literal userId — e.g. `GET /context/profile/audit-state` — which would read that bookkeeping file, run it through `migrateProfile()` (which unconditionally bolts default profile fields, and via `backfillSessionHistory()`, Mike's own hardcoded session-history text, onto *any* object missing them), cache the hybrid result, and — now that `saveProfile()` upserts to Supabase instead of writing back to the same volume file — permanently plant a bogus "user" row that would show up in the admin console's user list and the design loop's per-user digest forever, with no prune path. Found by hitting those two ids manually while verifying the migration (`listKnownProfiles()` surfaced them as fake users with `name: null, sessions: 0`); confirmed via a direct Supabase query that no such rows had actually been written yet, i.e. this was live-fire but caught before it did damage. Under the *old* volume-only system this same call would have overwritten the real `audit-state.json`/`design-loop-state.json` with the hybrid junk — an equally real but less visible version of the same bug that predates this migration.

**Fix.** `contextAgent.js` now has `RESERVED_PROFILE_IDS = new Set(['audit-state', 'design-loop-state'])`. `loadProfile()` returns a fresh, uncached `buildDefaultProfile()` for either id instead of reading the volume; `replaceProfile()` (the admin `PUT /context/profile/:userId` upload path) has the same guard. Extracted the inline default-profile object literal into `buildDefaultProfile()` so both the reserved-id short-circuit and the genuine-new-user path share one definition.

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
