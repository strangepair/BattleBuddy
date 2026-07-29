# 11 — Memory Architecture: Canonical Facts + Episodic Recall

**Status:** proposal for Mike's review. No code changes ship with this document.
**Scope:** the agent's per-user memory — what BattleBuddy knows about a person, how it stays true, and how it gets into the prompt. The memory is the core IP: the thing that makes the companion personalized, precise, and reliably accurate about one individual over months.

**Thesis in one paragraph.** BattleBuddy already has more memory machinery than "a vector DB" — five stores, two injection tiers, a background extractor, and a promotion loop. The precision problem is not that vectors are the primary store (the profile blob is), it's that **no store in the system has fact-level write discipline**: facts have no identity, no supersede semantics, no conflict resolution beyond "scalar overwrite," no expiry, and no way for the agent or the user to correct them directly. The fix is a **canonical fact layer** — one row per fact, updated in place, superseded never duplicated, rendered into every prompt, editable by the user — with the existing vector store demoted to what it is actually good at: fuzzy recall of the episodic long tail. The hard part is write discipline, and most of this document is about that.

---

## 1. Current-state inventory

### 1.1 The five stores

| Store | What it holds | Where | Write path | Lifecycle |
|---|---|---|---|---|
| **`user_profiles`** (Supabase JSONB) | The structured profile: identity scalars, trigger/coping/motivation arrays, `life_architecture`, `schedule_model`, `activity_log`, `risk_windows`, `session_history` | [007_user_profiles.sql](../server/migrations/007_user_profiles.sql); in-memory cache warmed at boot ([contextAgent.js:331](../server/contextAgent.js:331)) | Sonnet extraction pass `analyzeAndUpdate` ([contextAgent.js:1601](../server/contextAgent.js:1601)), every ~3 text turns ([index.js:1283](../server/index.js:1283)) + session end | Append-mostly; arrays silently capped at 15 (`pruneProfile`, [contextAgent.js:578](../server/contextAgent.js:578)); scalars overwritten on correction |
| **`user_memories`** (pgvector) | Distilled sentences: `observation`, `trigger`, `insight`, `session_summary`, `conversation` | [008_user_memories_embeddings.sql](../server/migrations/008_user_memories_embeddings.sql); 384-dim MiniLM embedded in-process ([embeddings.js:17](../server/embeddings.js:17)) | `embedAndStore` ([vectorStore.js:47](../server/vectorStore.js:47)) from session-end extraction ([index.js:1993](../server/index.js:1993), [index.js:2000](../server/index.js:2000)), session reports ([index.js:1820](../server/index.js:1820)), transcript distillation ([index.js:2521](../server/index.js:2521)) | **Append-only, forever.** No update, supersede, or delete path exists anywhere in the codebase |
| **`bb_events`** (Supabase) | The transactional ledger: cigarettes, urges, resists, decisions, milestones, session reports | [20260702_create_bb_events.sql](../supabase/20260702_create_bb_events.sql) | `log_event` tool, quick-log UI, extraction mirror `mirrorActivityToEvents` ([index.js:646](../server/index.js:646)) | Correctable: `update_event` tool → `updateEvent` ([index.js:769](../server/index.js:769)) |
| **Raw transcripts** (Railway volume JSON) | Full conversation history per session | `saveRawTranscript` ([contextAgent.js:394](../server/contextAgent.js:394)) | Every `/context/analyze` call; periodic voice saves ([agent.py:336](../agent/agent.py:336)) | Kept forever on the volume; keyword-scanned by recall ([index.js:732](../server/index.js:732)) |
| **`user_commitments`** | Inferred follow-ups ("said they'd try the gym Tuesday") | [011_commitments.sql](../server/migrations/011_commitments.sql), gated behind `COMMITMENTS_ENABLED` | Session-end Sonnet pass ([index.js:324](../server/index.js:324)) | `pending → delivered`, dedupe-keyed |

Plus one ephemeral layer: mid-session summaries in a process-local `Map` ([index.js:373](../server/index.js:373)).

### 1.2 How a turn is assembled

`buildSystemPrompt` ([index.js:221](../server/index.js:221)) fills nine placeholders in [system.battlebuddy.md:686-717](../server/prompts/system.battlebuddy.md):

- `{{profile}}` — `buildProfileSummary` ([contextAgent.js:1016](../server/contextAgent.js:1016)): the profile blob rendered to prose, hard-capped at 12K chars.
- `{{life_architecture}}` — `buildLifeArchitectureSummary` ([contextAgent.js:1212](../server/contextAgent.js:1212)).
- `{{current_goal}}` — `buildCurrentGoal` ([contextAgent.js:1366](../server/contextAgent.js:1366)): deterministic phase/dark-map/insight computation.
- `{{trigger_context}}` — local time + `buildLastEventAwareness` ([index.js:611](../server/index.js:611)): minutes since last event, active risk window.
- `{{promoted_memories}}` — the always-injected tier, `fetchPromotedMemories` ([index.js:301](../server/index.js:301)) reading `promoted=true` rows ([vectorStore.js:131](../server/vectorStore.js:131)).
- `{{relevant_memories}}` — per-turn similarity retrieval against the user's last message, 800ms-raced ([index.js:269](../server/index.js:269)).
- `{{session_memory}}`, `{{session_context}}`, `{{recent_history}}` — continuity plumbing.

Everything below the `## Runtime context` marker is the uncached half of the prompt ([promptCache.js](../server/promptCache.js)); the persona above it caches. The voice path gets the same prompt minus `relevantMemories`/`sessionMemory` (nothing to retrieve against at greeting time — [index.js:1354-1371](../server/index.js:1354)), which is exactly why the promoted tier exists (DECISIONS.md 2026-07-19).

### 1.3 The tool surface ("tools to gather information about the person")

Text agent, `AGENT_TOOLS` ([index.js:402](../server/index.js:402)): `recall_conversation`, `get_usage_stats`, `log_event`, `update_event`, `check_dev_mode`.
Voice agent ([agent.py:130-245](../agent/agent.py:130)): the same set plus `lookup_profile_field` → `/context/field/` ([index.js:1206](../server/index.js:1206)).

Note the asymmetry that defines the current system: the agent has **read** tools for memory (`recall_conversation`, `lookup_profile_field`) and **write** tools only for the event ledger (`log_event`, `update_event`). It has *no way to write, correct, or retire a fact about the person*. All fact writes route through the background extractor, which the agent doesn't control and the user can't see.

### 1.4 The promotion loop (what "curation" exists today)

Every retrieval records recall evidence ([vectorStore.js:199](../server/vectorStore.js:199), [010_memory_recall_signals.sql](../server/migrations/010_memory_recall_signals.sql)); a nightly sweep ([promotionJob.js:140](../server/promotionJob.js:140)) scores `0.30·relevance + 0.24·frequency + 0.15·diversity + 0.15·recency + 0.10·consolidation + 0.06·conceptual`, gated on ≥3 recalls across ≥3 distinct queries, and promotes up to 10 memories per user into the always-injected tier. This is genuinely good machinery — but it curates by **usage**, not by **truth**. Nothing in the pipeline can tell that a heavily-recalled memory is no longer true.

---

## 2. Assessment: where precision actually fails

Mike's framing — "vector similarity is the wrong primitive for canonical facts" — is correct as an engineering principle. Applied to this codebase it needs one refinement: **the vector DB is not the primary fact store today; the profile blob is.** `{{profile}}` carries identity, triggers, coping strategies, quit history into every turn without any similarity search. So the precision problem has two distinct halves, and both need fixing:

**Half 1: the canonical-ish store (profile) has no fact discipline.**

- **Facts have no identity.** A trigger is an anonymous `{value, captured_at}` entry in an array ([contextAgent.js:259](../server/contextAgent.js:259)). There is nothing to update, supersede, or point a correction at.
- **Dedupe is exact-string match** ([contextAgent.js:1775](../server/contextAgent.js:1775)). "Coffee first thing triggers me" and "morning coffee is a trigger" coexist as two facts. Over months, arrays fill with near-duplicates of the same underlying fact, each with a different timestamp.
- **Corrections only work for scalars.** The extraction prompt says "CORRECTIONS OVERWRITE OLD DATA" ([contextAgent.js:1675](../server/contextAgent.js:1675)), and for `occupation`-style scalars the merge does overwrite. But for arrays, the merge **only appends** ([contextAgent.js:1765-1792](../server/contextAgent.js:1765)). If the user says "actually, the gym doesn't help anymore," the old "gym helps" entry in `what_works` is untouchable — best case, a contradicting entry lands in `what_doesnt_work` and both are injected into every future prompt. The Alec/Chantix trust failure recorded in `session_history` ([contextAgent.js:520-524](../server/contextAgent.js:520)) is this exact class of bug reaching a real user.
- **Forgetting is silent truncation, not judgment.** `pruneProfile` drops the *oldest* 15+ entries ([contextAgent.js:580-584](../server/contextAgent.js:580)). The user's founding motivation, captured in week one, is exactly the kind of fact this deletes first.
- **The blob has no provenance or confidence.** `captured_at` exists; "user said it vs. model inferred it," "confirmed twice vs. mentioned once, hedged" mostly do not (only `schedule_model` has a confidence field). The agent can't calibrate how firmly to assert a fact, so it asserts everything with equal confidence — which is where fabrication-adjacent failures come from.

**Half 2: the episodic store (vector) has no lifecycle at all.**

- **Append-only means stale facts stay retrievable forever.** There is no code path that updates or removes a `user_memories` row. "Mike is using the patch" written in June is still retrieved in December, with a similarity score but no truth status.
- **Promotion amplifies staleness.** A superseded fact that was recalled often is *promoted into every prompt*. The one lifecycle gate is a 30-day recency cut at promotion time ([promotionJob.js:119](../server/promotionJob.js:119)) — nothing demotes an already-promoted memory when the world changes.
- **Contradictions retrieve together.** Two embeddings saying opposite things about the same topic are both near the same query. The model is left to adjudicate in-context, per turn, nondeterministically — the opposite of "precise and always accurate."

**Half 3 (structural): five stores, no spine.**

The same fact can live in `profile.activity_log`, `bb_events` (via a ±10-minute heuristic mirror, [index.js:646](../server/index.js:646)), a `user_memories` embedding, and the raw transcript — with no shared key. `get_usage_stats` even ships both `profile_stats` and `event_log` and tells the model in the prompt to trust the ledger when they disagree ([system.battlebuddy.md:676](../server/prompts/system.battlebuddy.md)). Asking the model to referee disagreements between its own memory stores is a symptom: the architecture doesn't know which store is authoritative for which class of fact.

**What's genuinely right and must be kept:**

- `bb_events` as a deterministic ledger + tools, instead of "recall" for numbers. This was the single best memory decision in the project (DECISIONS.md 2026-07-02) — it's already the canonical pattern, applied to events.
- Two-tier injection (always-in vs. retrieved). The promoted tier's *shape* is right; its *population mechanism* (usage frequency) is the wrong authority for facts.
- Background extraction off the hot path, with the 800ms race protecting first-token latency.
- Self-hosted embeddings for privacy (DECISIONS.md 2026-07-16).
- The verified/unverified timestamp discipline and "never present unverified times as fact" ([contextAgent.js:1679](../server/contextAgent.js:1679)) — this is exactly the write-discipline instinct, applied narrowly. The proposal below generalizes it.

**On the Obsidian angle:** the concept — canonical memory as human-readable, structured, *editable* documents — is sound and is adopted below as the rendering/transparency pattern. Obsidian-the-app is a single-user local vault; for a multi-user cloud companion the same pattern is per-user rows rendered to a per-user markdown document, surfaced in-app so the user can see and correct what BB knows. (This also happens to be how Claude Code's own memory works: one file per fact, an index, edit-in-place, supersede-don't-append.) No new storage tech is needed — Supabase Postgres already holds everything; this is a schema and discipline change, not an infrastructure change.

---

## 3. Proposed architecture

### 3.1 Three layers, each authoritative for one thing

```
┌─────────────────────────────────────────────────────────────┐
│ CANONICAL — user_facts (Postgres rows → rendered markdown)  │
│ One row per fact. Updated in place via supersede chains.    │
│ Injected into EVERY turn. The agent reads truth, never      │
│ infers it. User-visible and user-editable.                  │
├─────────────────────────────────────────────────────────────┤
│ LEDGER — bb_events (unchanged)                              │
│ Authoritative for anything countable: cigarettes, resists,  │
│ streaks, milestones. Derived stats computed, never stored   │
│ as prose. Already correct today.                            │
├─────────────────────────────────────────────────────────────┤
│ EPISODIC — user_memories pgvector (kept, demoted, lifecycled)│
│ The long tail of lived narrative: sessions, moments, quotes,│
│ color. Fuzzy recall is fine here — that's what similarity   │
│ is FOR. Gains supersede/tombstone columns so contradicted   │
│ episodes stop surfacing as if current.                      │
└─────────────────────────────────────────────────────────────┘
```

Decision rule for where a piece of information lives: **if being wrong about it would break trust, it's canonical. If it's countable, it's the ledger. If it's texture, it's episodic.**

### 3.2 Canonical schema: `user_facts`

```sql
create table user_facts (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  category      text not null,     -- see taxonomy below
  key           text not null,     -- stable slug, e.g. 'trigger.morning-coffee',
                                   -- 'coping.cold-water', 'quit.reason', 'person.alec'
  value         text not null,     -- one plain-language sentence, user's words where possible
  detail        jsonb,             -- structured payload where useful (hour/dow for windows,
                                   -- intensity for triggers, relationship for people)
  status        text not null default 'active',
                                   -- 'active' | 'superseded' | 'retired' | 'proposed'
  confidence    text not null,     -- 'confirmed' (user stated plainly / user edited)
                                   -- 'observed'  (evidenced by ledger data)
                                   -- 'tentative' (extractor inferred, said once, hedged)
  source        text not null,     -- 'user_edited' | 'user_stated' | 'agent_tool'
                                   -- | 'extraction' | 'consolidation' | 'backfill'
  evidence      jsonb,             -- [{session_id, date, quote?}] — where this came from
  superseded_by uuid references user_facts(id),
  review_after  timestamptz,       -- staleness horizon; null = durable
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One active truth per key. Supersede chains, never competing actives.
create unique index user_facts_active_key
  on user_facts (user_id, key) where status = 'active';
create index user_facts_user_active on user_facts (user_id) where status = 'active';
-- RLS from day one (CLAUDE.md rule 4), service-role writes via bb-server.
```

**Category taxonomy** (maps ~1:1 from today's profile fields, deliberately — it's what months of extraction tuning already decided matters for this mission):

| Category | Today's source | Staleness (`review_after`) |
|---|---|---|
| `identity` — name, age, location, occupation, family | profile scalars | occupation/location: 90d; rest: durable |
| `quit` — substance, usage level, quit reason (their words), past attempts, longest quit, current approach (patch/cold turkey/tapering) | profile scalars | usage level: 14d; approach: 30d; reason/history: durable |
| `trigger` — situation, context, intensity | `triggers` + `life_architecture.trigger_taxonomy` | 60d unless re-evidenced |
| `window` — high-risk times with reason | `risk_windows` + `schedule_model.vulnerability_windows` | 45d |
| `routine` — daily structure, protective and risky blocks | `schedule_model.routine_blocks` | 45d |
| `coping` — strategy + whether it works *for this person* (`detail.effectiveness: working/failed/untested`, with resist-count evidence) | `coping_strategies`, `what_works`, `what_doesnt_work`, `resistance_strategies` | 60d |
| `motivation` — why they're doing this, in their words | `motivations`, `quit_reason` | durable |
| `person` — people who matter, with the one-line context that burned us before (Alec: friend, does NOT have a Chantix prescription) | scattered in `life_context` | durable |
| `preference` — how they want BB to behave, voice, response style | `response_preference`, `preferred_coping_style`, `voice_preference` | durable |
| `watch` — life changes in flight (new job, travel) | `life_change_watch`, `unknowns` | 30d |
| `commitment` — kept in `user_commitments` (already has the right lifecycle), rendered alongside | — | — |

Merging today's *nine* overlapping fact-ish arrays (`triggers`, `trigger_taxonomy`, `what_works`, `coping_strategies`, `resistance_strategies`…) into one keyed table with a `category` column is itself a large precision win — most of the near-duplicate problem is those arrays not knowing about each other.

**The `key` is the linchpin.** It's what makes "update in place" possible: a new statement about morning coffee resolves to `trigger.morning-coffee` and supersedes, rather than appending a rival. Keys are assigned at write time by the merge gate (§3.5), not by exact string match.

### 3.3 Rendering: the per-user memory document (the Obsidian pattern, cloud-shaped)

A pure function `renderMemoryDoc(userId)` selects `status='active'` facts and renders grouped, ordered markdown — the direct replacement for `buildProfileSummary`'s prose blob:

```markdown
## What you know about Mike            (identity, quit — confirmed facts first)
## Why he's quitting — his words       (motivation, verbatim quotes)
## His triggers and risk windows       (trigger, window — with intensity/time detail)
## What works and what doesn't         (coping — annotated with ledger evidence:
                                        "cold water: 6 resists since 07-02")
## His people                          (person)
## Watch for                           (watch + facts past review_after, marked:
                                        "⚠ may be stale — reconfirm naturally: still on the patch?")
## How he wants you to be              (preference)
```

Properties that matter:

- **Same injection slot, same budget.** It fills `{{profile}}` (and replaces `{{promoted_memories}}` for facts — see §3.7), below the cache split, under the existing 12K-char cap ([contextAgent.js:1185](../server/contextAgent.js:1185)). Latency cost ≈ today's: one indexed select (or the warmed in-memory cache pattern already used for profiles) instead of blob-render. No new hot-path LLM call.
- **Trim by importance, not recency.** When over budget: `tentative` facts drop first, then stale-flagged, then lowest-evidence — never "oldest first."
- **Confidence is visible to the model.** Tentative facts render hedged ("mentioned once: …"), so the agent's certainty tracks the store's. This generalizes the verified-timestamp rule that already works.
- **The same render is the user-facing screen.** "What BattleBuddy knows about me" in the app is this document with edit/confirm/delete controls (§3.6). One renderer, two consumers — the doc the user corrects is byte-for-byte the doc the agent reads. That identity is the trust win.

### 3.4 Tool surface

Read side stays; write side is new. Same tools in both `AGENT_TOOLS` ([index.js:402](../server/index.js:402)) and the voice agent ([agent.py](../agent/agent.py)) — the parity the event tools already have.

| Tool | Behavior |
|---|---|
| *(no read tool for canon)* | Canonical memory is **injected, not fetched** — turn-start injection *is* the read. `lookup_profile_field` survives as `lookup_fact(key_or_category)` for long-tail lookups that didn't make the render budget. |
| `remember(category, statement, permanence?)` | Agent writes a fact the user just stated. Goes in as `status='proposed'` and flows through the same merge gate as extraction (§3.5) — the tool call is a *proposal with high provenance* (`source='agent_tool'`, user-stated), not a direct DB write. Guardrail: the tool schema requires a `user_words` field quoting what the user actually said; the gate rejects proposals whose quote doesn't ground the statement. This is the anti-fabrication mechanism: the agent physically cannot mint a memory without citing the utterance it came from. |
| `correct_memory(key, new_statement \| retire)` | The user said something BB knows is wrong or outdated. Supersedes the active fact (or retires it with no successor). `source='user_stated'`, `confidence='confirmed'` — user corrections take the highest precedence tier and apply immediately (a correction the user watches BB acknowledge must not sit in a queue). The old fact's row survives as `superseded` — history is kept, but out of the prompt. |
| `forget(key \| topic)` | User asks BB to forget something. Hard-retires the fact AND tombstones matching episodic rows (§3.7) AND redacts transcript hits. Confirmed back to the user. This is a promise the current architecture cannot make at all. |
| `recall_episodes(query, date?)` | Today's `recall_conversation` ([index.js:715](../server/index.js:715)), renamed to what it is. Excludes tombstoned rows. Keeps feeding recall signals. |
| `get_usage_stats` / `log_event` / `update_event` | Unchanged — the ledger already has the right shape. |

System-prompt contract (extends the existing tool-etiquette section, [system.battlebuddy.md:673-682](../server/prompts/system.battlebuddy.md)): *facts about the person come from the injected memory document or `lookup_fact` — never from conversational inference. If it's not in the document, you don't know it; say so and ask. When the user corrects you, call `correct_memory` in that turn and acknowledge it.* The design-loop's recurring fabrication findings ([system.battlebuddy.md:719-733](../server/prompts/system.battlebuddy.md)) are prompt-level patches for what is really this missing contract.

### 3.5 Write discipline — the actual hard part

**Write triggers** (three, ordered by precedence):

1. **User edit** in the memory screen → immediate, `confirmed`, no gate.
2. **In-conversation** — `remember`/`correct_memory`/`forget` tool calls → `correct_memory`/`forget` apply immediately (user-witnessed); `remember` proposals resolve through the gate within the same background cycle.
3. **Background extraction** — `analyzeAndUpdate` keeps its cadence (every ~3 turns + session end, [index.js:1283](../server/index.js:1283)) but its output becomes **fact proposals**, not direct profile mutations.

**The merge gate** (new module, `server/factGate.js`; the one new LLM call, off the hot path — Haiku, batched per extraction cycle). Input: proposals + the user's current active facts in the relevant categories. For each proposal, exactly one verdict:

- `NEW` — no active fact covers this; insert with a fresh key.
- `DUPLICATE` — an active fact already says this; **strengthen instead of append** (bump evidence, `tentative → observed` on second independent sighting, refresh `review_after`). Repetition becomes confidence, not clutter — this replaces exact-string dedupe with semantic dedupe.
- `SUPERSEDES <key>` — same subject, new truth ("down to 3/day" vs "smokes 8/day"). Old row → `superseded`, new row active, chain linked via `superseded_by`.
- `CONFLICTS <key>` — same subject, incompatible truths, and precedence can't resolve it. **Both stay, flagged**; the render marks it ("conflicting notes — clarify naturally: does the gym still help?") and the agent's next natural opening resolves it via `correct_memory`. The agent asking one grounded clarifying question *is* the conflict-resolution mechanism — it reads as attentiveness, which is exactly what a human friend does with contradictory information.
- `REJECT` — ungrounded, speculative, or a therapy-style inference rather than a fact. Logged, not stored.

**Precedence for auto-resolution:** `user_edited > user_stated > observed-from-ledger > extraction`. Within a tier, newer wins. Cross-tier downward (extraction contradicting something the user stated) never auto-supersedes — it files a `CONFLICTS` flag instead. The founder-visible failure mode ("BB re-forgot the thing I corrected twice") becomes structurally impossible: a correction sits in a higher tier than anything the extractor can write.

**Staleness:** `review_after` per category (table in §3.2). Expiry never deletes — it *demotes to "reconfirm"*: the render flags it, the agent verifies it in conversation within a session or two, and the confirmation refreshes the horizon. Volatile facts (usage level, quit approach, active stressors) stay accurate through gentle reconfirmation instead of silently rotting; durable facts (their reason, their people) never expire.

**Consolidation pass** (nightly, extending the scheduler slot `promotionJob` uses):

1. Sweep facts past `review_after` → flag for reconfirmation.
2. Near-duplicate scan within category (embedding similarity — the right use of vectors: as a *maintenance* index, not a truth oracle) → merge candidates through the gate.
3. Recompute ledger-derived annotations: coping effectiveness from resist counts (replacing `rankCopingStrategies`' day-granularity heuristic, [contextAgent.js:914](../server/contextAgent.js:914)), streak state, window weights from actual event clustering.
4. Episodic hygiene: tombstone `user_memories` rows contradicted by newly superseded facts (§3.7).
5. Unresolved-conflict digest → admin console, same surface the insights feedback loop already uses ([contextAgent.js:176](../server/contextAgent.js:176)).

**Anti-fabrication guardrails**, stated as invariants:

- Every fact row carries `evidence` pointing at real sessions; `remember` requires a grounding quote; the gate rejects proposals without one.
- The agent asserts only what the injected document contains; the document contains only gated facts; therefore every assertion has a provenance chain terminating in something the user said or did. "How do you know that?" is always answerable — and `evidence.quote` lets BB answer it verbatim.
- The extractor keeps its existing verified/unverified time discipline; unverified times can never harden into `confirmed` facts without user confirmation.

### 3.6 User-facing transparency

A "My Memory" screen (Preferences, next to the existing voice/dev settings) rendering the §3.3 document with per-fact controls: **confirm** (→ `confirmed`, refreshes staleness), **edit** (→ supersede, `user_edited`), **delete** (→ `forget` pipeline). Plus export (the document *is* the export) and delete-all — turning CLAUDE.md rule 4's in-app delete/export from a data-dump obligation into a feature.

Why this is worth mobile surface area: every user correction is free, perfectly-labeled training signal for the gate; seeing an accurate memory page is the strongest possible trust proof for a companion whose pitch is "it knows you"; and it is a visible competitive moat — nobody can audit what a similarity search "knows," but anyone can read a page of facts. V1 can be read-only-plus-delete if the edit UX is too much scope; even read-only converts memory from a black box into a product surface.

### 3.7 Episodic layer and turn-time composition

`user_memories` keeps its pipeline — embed, retrieve, recall-signal — scoped to what it's good at:

- **Types:** `session_summary`, `conversation`, `observation` (moments, quotes, texture). `trigger` and `insight` rows stop being written as memories — those are facts now and go through the gate. (`embedAndStore` call sites at [index.js:1993-2001](../server/index.js:1993) become gate proposals.)
- **Lifecycle columns:** `superseded boolean default false`, `superseding_fact uuid`. `match_user_memories` gains `and not superseded`. Consolidation and `forget` set it. Cheap, additive, and closes the stale-forever hole.
- **The promoted tier retires for facts.** Its job — "durable knowledge present at greeting time with no query" — is exactly the canonical document's job, done by curation instead of recall-frequency. Promotion machinery (recall signals, scoring, [promotionJob.js](../server/promotionJob.js)) survives with a cheaper mandate: annotate *episodic* rows that keep proving useful so retrieval ranks them higher — a relevance booster, no longer a truth mechanism.

**Per turn** (same latency envelope as today — the document read replaces the profile-blob render and the promoted fetch):

```
canonical document (always, both text and voice — voice finally gets full memory
                    at greeting time, not just 8 promoted rows)
+ ledger stats (existing trigger_context / last-event awareness)
+ episodic retrieval on the last user message (existing 800ms race; skipped at
  greeting time exactly as today)
+ session continuity (session_context / session_memory / recent_history, unchanged)
```

`buildCurrentGoal`'s dark-map/insight logic ([contextAgent.js:1366](../server/contextAgent.js:1366)) survives unchanged in spirit, reading facts instead of blob arrays — "still dark on the map" becomes "categories with no active facts," which is crisper than the current null-checks.

---

## 4. Why this serves the recovery mission specifically

The product is a circuit breaker for urges. In the moment of an urge, seconds matter and wrong personalization is worse than none. Mapping the layers to recovery jobs:

| Recovery job | Memory requirement | Where it lands |
|---|---|---|
| **Interrupt the urge with what works for THIS person** | Coping strategies with honest effectiveness state — never re-suggest what failed for them | `coping` facts annotated from ledger resists; `what_doesnt_work` becomes `detail.effectiveness='failed'` on the same fact, so one row holds the whole verdict — the current architecture can't even represent "this used to work and stopped" |
| **Get ahead of the urge** | Accurate triggers + high-risk windows driving the nudge sweep and `buildLastEventAwareness` | `trigger`/`window` facts with staleness — windows that stop being real stop firing nudges after reconfirmation fails, instead of nagging forever (dependency-farming is an explicit anti-goal, CLAUDE.md rule 6) |
| **Hold the story straight** | Streaks, counts, slips — exact, never guessed | `bb_events`, unchanged; canonical stores only *interpretations* ("the July relapse followed the job change"), keyed to ledger rows via `evidence` |
| **Handle a slip without shame** | Relapse context: what preceded it, what they said about it, what helped them restart | `quit` + `watch` facts plus episodic recall of the actual conversation — facts give accuracy, episodes give empathy ("last time this happened, going to the gym the next morning is what reset you") |
| **Reflect their own reasons back** | The user's stated why, verbatim, forever | `motivation` facts, durable, `evidence.quote` — the single highest-leverage memory in a weak moment is their own words, and it must never be paraphrased-drifted or pruned |
| **Earn trust that everything else rides on** | Never assert a wrong fact; recover gracefully when corrected | The gate + precedence + `correct_memory` + the memory screen. The session-history record shows trust hinged on exactly this: memory probes ([contextAgent.js:520-548](../server/contextAgent.js:520)) flipped Mike from "frustrated" to "first recorded approval" on the strength of one accurate recall |
| **Need the app less over time** | Memory that notices durable progress and says so | Consolidation's ledger-derived annotations feed `computeInsightReady`-style reflection with facts, not vibes |

The proactive loop closes cleanly: **facts decide when to reach out** (windows, watches, commitments), **the ledger decides what's true right now** (gap since last event), **episodes supply the human texture of how to say it**. Today those three roles are smeared across stores that disagree.

---

## 5. Migration path — phased, reversible, both systems in parallel

Precedents to reuse: additive migrations with graceful absence ([vectorStore.js:150](../server/vectorStore.js:150) pattern), feature flags default-off (`COMMITMENTS_ENABLED`), backfill scripts ([scripts/backfillMemoryEmbeddings.js](../server/scripts/backfillMemoryEmbeddings.js), [migrations/migrate_profile_to_v3.js](../server/migrations/migrate_profile_to_v3.js)), and the admin console as the review surface. User count is tiny (a handful of profiles, ~3.4K memory rows per DECISIONS.md 2026-07-16) — every backfill is human-reviewable, which is a luxury; spend it.

**Phase 0 — Schema + backfill (no behavior change).**
Migration `013_user_facts.sql` (table, indexes, RLS). One-time backfill script: deterministically map profile fields → fact rows (scalars and structured arrays translate mechanically; `source='backfill'`, confidence from existing `confidence`/`verified` fields where present, else `tentative`), then one Sonnet pass over `user_memories` + recent transcripts proposing facts the profile missed — all landing as `status='proposed'`. Review and activate per-user in the admin console (`admin-api.js` already lists profiles via `listKnownProfiles`). Exit test: Mike reads his own generated memory document and signs off on every fact — the first real accuracy audit the memory has ever had, valuable even if nothing else ships.

**Phase 1 — Shadow writes.**
`analyzeAndUpdate` keeps updating the profile exactly as today AND emits proposals through the new gate. Nightly consolidation runs in report-only mode. For ~two weeks, compare: does the fact store stay cleaner than the blob? Are gate verdicts right? Tuning happens here, invisible to users. Exit: gate precision reviewed against real conversations; no hot-path regression (nothing touched the hot path).

**Phase 2 — Read cutover, flagged.**
`MEMORY_FACTS_ENABLED`: `buildSystemPrompt` fills `{{profile}}` from `renderMemoryDoc` and drops `{{promoted_memories}}` population (template placeholder stays; renders the fallback — the placeholder-parity test in `systemPromptTemplate.test.js` keeps passing). Voice path gets the document in `/livekit/token` assembly ([index.js:1361](../server/index.js:1361)). Dev-mode sessions first, then on for real users. Rollback = unset flag; the old profile is still being written (Phase 1 dual-write continues through Phase 3). Exit: memory probes in live sessions — the Alec/Chantix class of test — pass consistently; latency budget holds (the doc read must fit the same envelope the profile render does today).

**Phase 3 — Write cutover.**
`remember`/`correct_memory`/`forget`/`lookup_fact` land in both tool surfaces with the system-prompt contract (§3.4). Extraction stops mutating fact-like profile fields (keeps `activity_log` mirroring and `session_history` until Phase 4 relocates them). Consolidation goes live (report-only → acting). Promotion sweep re-scoped to episodic annotation. Exit: a user correction round-trips — correct in conversation, see it in the document, see the old fact gone from the next session's behavior.

**Phase 4 — Retire the blob, ship the screen.**
`session_history` → episodic summaries (already duplicated there); `activity_log` fully ceded to `bb_events` (the mirror already treats the ledger as truth); what remains of `user_profiles` is app state (voice preference, session counters), not memory. "My Memory" screen ships. Episodic tombstoning wired to `forget`. Exit: profile JSONB no longer read at prompt-build time; delete/export runs off `user_facts`.

Each phase is independently shippable and independently reversible; nothing destructive happens until Phase 4, and even then `user_profiles` rows are kept (stale, unread) rather than dropped.

**Deliberately out of scope here:** multi-tenant hardening of transcripts-on-volume and the in-memory profile cache (tracked in [docs/10-PLATFORM-EXTRACTION.md](10-PLATFORM-EXTRACTION.md) §1.5 — this design removes the per-turn dependency on that cache, which makes that extraction *easier*); on-device Tier-0 memory access (the document is small and serializable — it can ride to the device for Gemma turns later, which the blob never could cleanly).

---

## 6. Risks and honest trade-offs

- **Gate quality is the new single point of failure.** A bad `SUPERSEDES` verdict deletes truth from the prompt (recoverable — chains keep history — but wrong until noticed). Mitigations: conservative bias (prefer `CONFLICTS`-and-ask over auto-supersede; the extraction pipeline already prefers "too few over wrong," [commitments.js precedent](../server/commitments.js)), cross-tier demotions never automatic, nightly conflict digest to the admin console, and Phase 1's shadow period to measure before trusting.
- **One more LLM call per extraction cycle.** Haiku, batched, background — cost noise next to the existing Sonnet extraction, and Phase 3 lets extraction itself get cheaper (proposals are a simpler task than maintain-this-entire-JSON-dossier, [contextAgent.js:1647](../server/contextAgent.js:1647)'s 100-line prompt shrinks).
- **Reconfirmation could feel like interrogation** if staleness horizons are too aggressive. The render gives the agent *at most one* reconfirm nudge at a time (same one-starter-per-session discipline as `computeEligibleStarters`, [contextAgent.js:1328](../server/contextAgent.js:1328)); horizons tune long.
- **Key discipline can drift** (same fact under two keys → the duplicate problem returns wearing a lanyard). The consolidation near-duplicate scan exists precisely to catch this; keys are gate-assigned against the live key list, never freehand.
- **Scope honesty:** this is roughly a phase of build-plan work (schema + gate + render + tools + two jobs + a screen), competing with everything else in [docs/04-BUILD-PLAN.md](04-BUILD-PLAN.md). The phasing front-loads the highest-value/lowest-risk pieces: Phases 0–2 alone — accurate facts injected every turn, user-audited once — fix the majority of the precision problem without touching tools or UI.

---

## 7. Summary of the decision being asked

1. **Adopt the hybrid split:** canonical facts in a new `user_facts` store (structured, keyed, superseded-in-place, injected every turn, user-visible); `user_memories` pgvector kept for episodic recall with tombstoning; `bb_events` unchanged as the ledger.
2. **Adopt the write discipline as the core of the work:** gated writes with provenance and precedence, evidence-grounded `remember`, immediate user corrections, staleness-as-reconfirmation, nightly consolidation. Storage is the easy 20%; this is the 80%.
3. **Adopt the Obsidian *pattern*, not the app:** per-user memory documents rendered from rows, one renderer serving both the prompt and a user-facing memory screen.
4. **Migrate in five reversible phases**, dual-writing until Phase 4, with Mike auditing the backfilled documents as the first gate.
