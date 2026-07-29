# 12 — Canonical Memory: Implementation Plan

**Status:** execution plan for [docs/11-MEMORY-ARCHITECTURE.md](11-MEMORY-ARCHITECTURE.md). That document is the spec; this one sequences it into shippable PRs with tests, flags, and rollback. Read the spec first — nothing here re-argues the design.

**Ground rules carried from the spec and the pipeline:**

- Dual-write and reversible throughout. `user_profiles` keeps being written until the final cutover (stop-point c), and its rows are never dropped even then.
- Every phase is its own PR: CI green (mobile launch gate + server `node --test`) → merge → Deploy. Autonomous workflows (Autobuild, Auto PR hygiene) stay disabled.
- All schema lands in **one migration** (`013_user_facts.sql`) so there is exactly one production-DDL event. deploy.yml re-runs *every* migration file on any migrations change, so 013 must be idempotent end-to-end; and deploy.yml case-insensitively greps all migration files for destructive DDL (`drop table|column|schema`, `truncate`, `delete from`) **including comments** — 013 must not contain those strings anywhere.
- Known ops hazard: the `SUPABASE_DB_URL` GitHub secret was malformed as of 2026-07-27 (bracket-wrapped placeholder password), so deploy.yml's migrations leg fails until it's re-set. Migration 012 was applied out-of-band via the Supabase management API. Plan for 013: same management-API path (or Mike fixes the secret first) — decided at stop-point (a).

**Stop-and-confirm points (report to orchestrator, do not proceed unattended):**

- **(a)** Before the 013 migration reaches production Supabase. Because merging PR 1 auto-triggers deploy.yml's migrations leg, this means: PR 1 opens and goes CI-green, then **stop before merge**.
- **(b)** Before running the data backfill that derives canonical facts from the live profile blob (and before the Sonnet proposal pass over `user_memories`/transcripts). Output is human-audited: Phase 0 exits with Mike reading his own generated memory document.
- **(c)** Before the final cutover that retires the profile blob from prompt-build reads and stops extraction writing fact-like fields (Phase 4 flag flip).

---

## 1. The canonical schema (final)

`server/migrations/013_user_facts.sql` — one file, three parts, all idempotent:

```sql
-- Part 1: the canonical fact store
create table if not exists user_facts (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  category      text not null check (category in
                  ('identity','quit','trigger','window','routine','coping',
                   'motivation','person','preference','watch')),
  key           text not null,        -- 'trigger.morning-coffee' — gate-assigned, ^[a-z]+\.[a-z0-9-]+$
  value         text not null,        -- one plain-language sentence, user's words where possible
  detail        jsonb,                -- hour/dow for windows, effectiveness for coping, etc.
  status        text not null default 'proposed'
                  check (status in ('active','superseded','retired','proposed','rejected')),
  confidence    text not null default 'tentative'
                  check (confidence in ('confirmed','observed','tentative')),
  source        text not null
                  check (source in ('user_edited','user_stated','agent_tool',
                                    'extraction','consolidation','backfill')),
  evidence      jsonb not null default '[]'::jsonb,  -- [{session_id, date, quote?}]
  conflict_with uuid,                 -- set on both rows of a CONFLICTS pair
  superseded_by uuid references user_facts(id),
  review_after  timestamptz,          -- staleness horizon; null = durable
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One active truth per key. Supersede chains, never competing actives.
create unique index if not exists user_facts_active_key
  on user_facts (user_id, key) where status = 'active';
create index if not exists user_facts_user_active
  on user_facts (user_id) where status = 'active';
create index if not exists user_facts_user_status
  on user_facts (user_id, status);

alter table user_facts enable row level security;
-- own_facts policy (guarded do-block, same pattern as 011): auth.uid()::text = user_id.
-- bb-server writes via service role.

-- Part 2: episodic lifecycle columns (additive; graceful-absence readers)
alter table user_memories add column if not exists superseded boolean not null default false;
alter table user_memories add column if not exists superseding_fact uuid;

-- Part 3: retrieval respects tombstones
create or replace function match_user_memories(...)  -- same signature/body as 008/009,
  -- plus `and not superseded` in the where clause.
```

Status values beyond the spec's four: `rejected` (gate verdict kept for audit, never rendered) — cheaper than a separate log table and queryable in the admin console.

`review_after` horizons (set at write time by category, refreshed on confirm/duplicate): identity.occupation/location 90d; quit.usage-level 14d; quit.approach 30d; trigger 60d; window 45d; routine 45d; coping 60d; watch 30d; identity (rest), quit.reason/history, motivation, person, preference: durable (null).

## 2. Server modules (new)

| Module | Responsibility |
|---|---|
| `server/factStore.js` | All `user_facts` reads/writes via service-role Supabase. In-process per-user cache of active facts, warmed at boot (same rationale as the profile cache: sync reads on the prompt path, no `[object Promise]` risk). Every write updates the cache. Graceful absence: missing table → empty, log once. API: `getActiveFacts(userId)`, `insertFact`, `supersedeFact(oldKey, newFact)`, `retireFact`, `confirmFact(key)`, `strengthenFact(key, evidence)` (dup → evidence bump, tentative→observed on 2nd independent sighting, refresh review_after), `listKeys(userId)`, `flagConflict(idA, idB)`. |
| `server/factGate.js` | The merge gate. Pure half: `groundProposals()` (rejects any proposal without a grounding quote — the anti-fabrication invariant enforced in code, before any LLM sees it), `applyVerdicts()` (enforces precedence: `user_edited > user_stated > agent_tool ≥ observed-from-ledger > extraction`; a lower-tier SUPERSEDES/DUPLICATE-overwrite against a higher-tier fact is downgraded to CONFLICTS — never auto-supersedes downward; within a tier newer wins). LLM half: one batched Haiku call (`claude-haiku-4-5-20251001`) per extraction cycle: proposals + active facts in the touched categories → per-proposal verdict `NEW | DUPLICATE <key> | SUPERSEDES <key> | CONFLICTS <key> | REJECT`, key assigned against the live key list (never freehand; slug-format validated, category prefix must match). Conservative bias: instructed to prefer CONFLICTS over SUPERSEDES when unsure. |
| `server/memoryDoc.js` | `renderMemoryDoc(facts, {commitments, ledgerAnnotations, budget})` — pure. Renders the spec §3.3 sections (identity/quit → why-quitting verbatim → triggers & windows → what works/doesn't with ledger evidence → people → watch+stale reconfirm flags → preferences). Confidence visible: `tentative` renders hedged ("mentioned once: …"); facts past `review_after` render under "Watch for" with a reconfirm nudge, **at most one nudge marked per render** (interrogation guard); CONFLICTS pairs render as "conflicting notes — clarify naturally". Over budget (12K chars): drop `tentative` first, then stale-flagged, then lowest evidence count — never oldest-first. Same function feeds the prompt and the My Memory screen/export. |
| `server/factExtraction.js` | Turns `analyzeAndUpdate`'s existing extraction output into fact proposals (shadow path), so the Sonnet extraction prompt doesn't change in Phase 1. Each proposal must carry a quote lifted from the transcript window (the extractor already quotes; proposals that can't be grounded are dropped, counted, logged). |
| `server/factConsolidation.js` | Nightly job (hourly tick, 23h min gap, own state file — same scheduler shape as promotionJob): (1) sweep past-`review_after` actives → flag for reconfirm; (2) near-duplicate scan within category via existing embeddings → merge candidates through the gate; (3) recompute ledger-derived coping effectiveness (resists per strategy from bb_events) into `detail.effectiveness` + `detail.resist_count`; (4) tombstone `user_memories` rows contradicted by newly superseded facts; (5) unresolved-conflict digest → admin console. `FACTS_CONSOLIDATION_MODE=report|act` (report-only until Phase 3). |

Feature flags (central, env-read like `COMMITMENTS_ENABLED`): `FACTS_SHADOW_WRITE` (Phase 1, default on once shipped — writes are invisible until something reads them), `MEMORY_FACTS_ENABLED` (Phase 2 read cutover, default off), `FACTS_WRITE_CUTOVER` (Phase 3/4: tools live + extraction stops mutating fact-like profile fields, default off), `FACTS_CONSOLIDATION_MODE`.

## 3. The PRs

### PR 1 — Phase 0: schema, fact store, renderer, backfill tooling (no behavior change)

**Changes**

- `server/migrations/013_user_facts.sql` as §1.
- `server/factStore.js`, `server/memoryDoc.js` (no callers on any hot path yet).
- `server/scripts/backfillUserFacts.js` + admin routes `GET /admin/facts/:userId` (list, with rendered doc preview), `POST /admin/facts/backfill` (run per-user), `POST /admin/facts/:userId/resolve` (activate / reject proposed rows) — all `x-bb-admin-secret`-gated. Backfill mechanics:
  - **Deterministic pass** (no LLM): profile scalars → `identity.*`/`quit.*`; `triggers` + `life_architecture.trigger_taxonomy` → `trigger.*`; `risk_windows` + `vulnerability_windows` → `window.*` (detail: hour/dow/weight/reason); `routine_blocks` → `routine.*` (detail.protects); `coping_strategies`/`what_works` → `coping.*` (`detail.effectiveness='working'|'untested'`), `what_doesnt_work`/`resistance_strategies` merged onto the same keys where they match, else `coping.*` with `effectiveness='failed'`; `motivations` → `motivation.*`; `preferred_coping_style`/`response_preference`/`voice_preference` → `preference.*`; `life_change_watch` → `watch.*`. Confidence: `confirmed` only where an existing confidence/verified field says so, else `tentative`. Keys slugified from values, `-2` suffix on collision. All rows `status='proposed'`, `source='backfill'`, evidence pointing at the profile field + `captured_at`.
  - **Sonnet proposal pass** over the unstructured remainder (`life_context`, `user_quotes`, `unknowns`, `emotional_patterns`, `session_history` person-facts like Alec/Chantix, plus `user_memories` rows and recent transcripts): proposes `person.*`/`watch.*`/missed facts, every one with a grounding quote, all `proposed`.
  - Nothing activates without review (stop-point b + Mike's audit).
- `docs/11` and `docs/12` committed.

**Tests** — `memoryDoc.test.js`: section ordering, hedged rendering of tentative, single reconfirm nudge, conflict rendering, budget trim order (tentative → stale → low-evidence; never oldest-first), byte-identical output for identical input (the one-renderer-two-consumers property). `factStore.test.js`: pure helpers (slugify, collision suffix, review_after horizons per category). `migration013.test.js`: reads the SQL as text — asserts idempotency markers (`if not exists` / `create or replace`) and asserts it contains none of deploy.yml's destructive-grep strings.

**Ship**: PR open → CI green → **STOP (a)** → on confirm, apply 013 to production (management API or fixed secret + merge), merge, verify deploy. Then **STOP (b)** → on confirm, run backfill for Mike's user, render his memory document, surface it for the Phase-0 exit audit.

### PR 2 — Phase 1: merge gate + shadow writes + report-only consolidation

**Changes**

- `server/factGate.js`, `server/factExtraction.js`, `server/factConsolidation.js` (report-only).
- `analyzeAndUpdate` call sites (`/context/analyze`, `/session/turn` throttle): after the existing profile merge, ALSO pipe the same extraction output through `factExtraction` → gate → `user_facts`, under `FACTS_SHADOW_WRITE`. Profile behavior byte-identical.
- Admin console: gate-verdict log view (what landed as NEW/DUP/SUPERSEDES/CONFLICTS/REJECT per cycle) + conflict digest, so the ~2-week shadow comparison is reviewable.

**Tests** — `factGate.test.js` (the load-bearing suite, all pure): ungrounded proposal → rejected before the LLM; extraction-tier verdict against a `user_stated` fact downgrades to CONFLICTS; within-tier newer supersedes; DUPLICATE strengthens (evidence bump, tentative→observed on second *independent* sighting only, review_after refresh); SUPERSEDES chains link `superseded_by` and never leave two actives per key; freehand/miscategorized keys from the LLM are rejected; malformed LLM JSON → whole batch no-ops (fail closed, facts unchanged).

**Exit**: shadow period runs ≥2 weeks alongside later PRs; gate precision reviewed against real conversations at stop-point (c) before anything depends on it.

### PR 3 — Phase 2: read cutover behind `MEMORY_FACTS_ENABLED`

**Changes**

- `buildSystemPrompt`: flag on → `{{profile}}` = `renderMemoryDoc` (facts + commitments + ledger annotations) and `{{promoted_memories}}` population dropped (placeholder stays, renders its existing fallback — placeholder-parity test keeps passing). Flag off → today's path, untouched.
- Voice: `/livekit/token` assembly gets the same document — voice finally reads full memory at greeting time.
- `/context/field/` (`lookup_profile_field`) answers from active facts first (key or category), profile fallback while dual-running.
- Rollout: dev-mode sessions first (flag + `devMode` gating), then all users — a flag flip, no deploy.

**Tests** — prompt assembly with flag on/off (profile blob absent from the on-path, document present below the cache split so the cached prefix is untouched); `systemPromptTemplate.test.js` still green; latency guard: renderMemoryDoc over a 200-fact fixture stays sync-cheap (cache-warmed read, no LLM, no network).

**Exit**: live memory probes (the Alec/Chantix class) pass consistently in dev sessions; `[Cache] read=` stays nonzero (cache split not poisoned); rollback = unset flag.

### PR 4 — Phase 3: write cutover — agent tools + consolidation acting

**Changes**

- New tools in **all three surfaces at once** (AGENT_TOOLS in index.js, `agent.py` function_tools, prompt Tools section — parity is a known live hazard, see build 55):
  - `remember(category, statement, user_words, permanence?)` → proposal with `source='agent_tool'`; schema-required `user_words` grounding quote; flows through the gate in the same background cycle.
  - `correct_memory(key, new_statement | retire)` → immediate supersede/retire, `source='user_stated'`, `confidence='confirmed'` (user-witnessed; never queued).
  - `forget(key_or_topic)` → hard-retire fact + tombstone matching episodic rows + redact matching transcript lines on the volume; confirmed back to the user.
  - `lookup_fact(key_or_category)` (voice already had the profile-field version; text gains it).
  - `recall_conversation` → `recall_episodes` (rename per spec, all three surfaces + language-table refs in one commit); excludes tombstoned rows; keeps recording recall signals.
- System-prompt contract (spec §3.4): facts come from the injected document or `lookup_fact`, never conversational inference; if it's not there, say so and ask; corrections trigger `correct_memory` in-turn.
- Under `FACTS_WRITE_CUTOVER`: extraction stops mutating fact-like profile fields (keeps `activity_log` mirroring + `session_history`); `embedAndStore` call sites for `trigger`/`insight` become gate proposals; consolidation `report → act`; promotion sweep re-scoped to episodic relevance annotation (no longer populates a prompt tier).
- Voice tool handlers call new server endpoints (`/context/facts/remember|correct|forget`, client-token-gated) mirroring the text executors.

**Tests** — tool executor tests (remember without `user_words` → tool error; correct_memory supersedes immediately and updates the cache; forget round-trip retires + tombstones); a **three-surface parity test**: every tool named in the prompt's Tools section exists in AGENT_TOOLS *and* in `agent.py` (regex over source, same style as the existing static checks) — this encodes the standing prompt/tool-parity hazard permanently; extraction-stops-writing assertions under the flag.

**Exit**: a correction round-trips — correct in conversation → visible in the document → old fact absent from the next session's behavior.

### PR 5 — Phase 4: "My Memory" screen + delete/export off facts

**Changes (mobile — the launch-gate-sensitive one)**

- New route `mobile/app/(app)/memory.tsx` ("My Memory"), pushed from a new Preferences row. **Not reachable from, rendered on, or state-coupled to the session screen.** No changes to `session.tsx`, `SessionHeader`, or anything in its animated subtree; session-screen structure stays dev- and state-invariant. The screen renders the §3.3 document (per-fact rows grouped by section) with: confirm (→ `confirmed`, refreshes staleness), edit (→ supersede, `source='user_edited'`), delete (→ `forget` pipeline), plus export (the document is the export) and delete-all.
- Server: JWT-authorized per-user endpoints (`authorizeProfileAccess` pattern): `GET /context/memory/:userId` (doc + structured facts), `POST /context/memory/:userId/confirm|edit|delete`, `GET .../export`, `POST .../delete-all`. Preferences "Export my data" row goes live against it.
- `session_history` → episodic summaries (already duplicated there); `activity_log` fully ceded to bb_events for stats; what remains of `user_profiles` is app state (voice preference, counters).

**Tests** — mobile: launch gate untouched and green; new screen mount/unmount test (mock fetch), structural dev-invariance of session screen re-asserted by the existing gate; server: endpoint auth tests (wrong-user JWT → 403), edit → supersede chain, delete-all leaves ledger + tombstoned episodics consistent.

**Ship**: CI (including launch gate) green → merge → Deploy (TestFlight build). Then **STOP (c)**: final cutover — `FACTS_WRITE_CUTOVER` + `MEMORY_FACTS_ENABLED` default-on, profile blob no longer read at prompt-build time — only after Mike confirms, with the shadow-period gate-precision review in hand. `user_profiles` rows are kept (stale, unread), never dropped.

## 4. Recovery-mission mappings (what each PR buys the product)

Spec §4 is the authority; operationally: PR 1+backfill = the first-ever accuracy audit of what BB believes (Phase-0 exit even if nothing else ships). PR 3 = never re-suggest what failed (coping effectiveness on one row), windows stop nagging after failed reconfirm (anti-dependency-farming), the user's why rendered verbatim and durable. PR 4 = corrections structurally outrank the extractor (the re-forgot-my-correction failure becomes impossible) + "how do you know that?" answerable verbatim from `evidence.quote`. PR 5 = the memory page as trust proof and the delete/export obligation turned into a feature.

## 5. Risks & mitigations (delta over spec §6)

- **Deploy migrations leg**: 013 merge triggers a re-run of every migration file; if `SUPABASE_DB_URL` is still malformed the leg red-x's. Resolution decided at stop-point (a); out-of-band management-API application is the proven fallback (012 precedent). Either way 013 is idempotent so a later secret fix + re-run is harmless.
- **Gate fails closed**: any gate/LLM failure leaves `user_facts` untouched and (until stop-point c) the profile path is still primary — no single bad cycle can lose truth.
- **Cache split**: the document injects below `## Runtime context`; nothing in these PRs touches the cached prefix. `[Cache] read=` monitored after each deploy.
- **Mobile crash class**: PR 5 adds zero elements to the session screen tree; the launch gate's structural fingerprint would catch any accidental coupling.
