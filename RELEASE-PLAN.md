# Release Plan — Memory & Recall v1

Branch: `feat/memory-recall-v1`
Target: bb-server (Railway). **Mobile is untouched — see "Does this need TestFlight?" below.**

## Why

Three reported symptoms, diagnosed against the code:

| Symptom | Actual cause |
|---|---|
| "Can't keep track of time" | Time *is* injected (`index.js:174`) but only as "now". Deltas ("3 days since we spoke", "6h since last cigarette") are not computed from `bb_events`. |
| "Greeting isn't relevant" | Greeting is a hardcoded string (`index.js:1198`: `Say: 'Hey, ${userName}! How's it going?'`). It is not built from memory. On text turns there is no greeting path at all. |
| "No introspection without prompting" | `fetchRelevantMemories` (`index.js:199`) keys off the user's message. No message ⇒ no recall. Nothing tracks open loops between sessions. |

Underneath all three: `user_memories` is a **single flat tier** reachable only by query relevance. At greeting time there is no query, so nothing surfaces.

The fix is a second, always-injected tier — and a feedback loop that decides what earns a place in it.

Prior art reviewed: openclaw's `memory-core` (promotion scoring, commitments, active recall). Patterns are borrowed; **no openclaw dependency is added** — it is single-operator and filesystem-bound, and its default embedding provider is OpenAI, which contradicts `DECISIONS.md` 2026-07-16 (self-hosted embeddings, health data never leaves the server).

## Status

- **Phase 0 — done.** 95.4% of the prompt (~35.7K tokens) cacheable.
- **Phase 1 — done.** `009` written, promoted tier wired into both the text and voice paths.
- **Phase 2 — done.** `010` written, recall recording on the hot path, nightly sweep scheduled.
- **Phase 3 — done.** Grounded voice greeting; recall-tool now feeds the promotion loop. The
  temporal deltas and the recall tool the plan called for were already in the code
  (`buildSessionContext`, `buildLastEventAwareness`, `recall_conversation`) — Phase 3 was
  mostly grounding and wiring, not new machinery.
- **Phase 4 — not started.**

30 tests green (`npm test` in `server/`). Nothing is committed, and no migration has been
applied to any environment.

**Effective promotion bar, measured:** ~5 recalls across ~a week. Because recall evidence
only starts accruing once `010` is applied, the promoted tier will be empty for roughly a
week of active use before it does anything visible.

## Phase 0 — Prompt caching (enabler, ships first)

`grep cache_control server/index.js` → no matches. A ~37K-token prompt is re-sent uncached every turn.

- Move `{{session_context}}` (template line 229) down into the volatile block at 689–709.
- Split the system prompt into two blocks: static persona (lines 1–688) with `cache_control: {type: 'ephemeral'}`, and a volatile tail.
- Move `User's local time` out of the cached prefix.

**Why first:** it is the largest latency and cost win available, it is low-risk, and every later phase adds prompt tokens that would otherwise make latency worse. Cache reads bill at 10% of input.

Exit test: two consecutive turns show `cache_read_input_tokens > 0` in the API response; measured TTFT drops.

## Phase 1 — Two-tier memory

- Migration `009`: add `promoted boolean default false`, `promoted_at timestamptz` to `user_memories`.
- New `{{promoted_memories}}` placeholder in the volatile tail; injected every turn regardless of query.
- `getPromotedMemories(userId)` in `vectorStore.js` — plain select, no embedding, no timeout race (it is small and always needed).

Exit test: a promoted memory appears in the prompt on a turn whose user message is unrelated to it.

## Phase 2 — Promotion loop (recall-as-signal)

Retrieval frequency becomes the evidence for promotion — memory that proves useful graduates itself.

- Migration `010`: `recall_count int default 0`, `total_score real default 0`, `recall_days text[]`, `concept_tags text[]`, `last_recalled_at`.
- `recordRecall()` — called after every `retrieveRelevant`, fire-and-forget so it never touches turn latency. Dedupe per (memory, day) so one chatty session can't inflate frequency.
- `server/promotionJob.js`, scored on openclaw's weights:
  `0.30·relevance + 0.24·frequency + 0.15·diversity + 0.15·recency + 0.10·consolidation + 0.06·conceptual`
  Gates: `recall_count ≥ 3`, `unique_days ≥ 3`, `score ≥ 0.8`.
- Runs inside the existing nightly Sonnet background pass (`contextAgent.js`) — off the hot path, no new scheduler.

Exit test: unit tests for the scoring function; a memory recalled 5× across 5 days promotes, one recalled 5× in one afternoon does not.

## Phase 3 — Temporal grounding + memory-grounded greeting

- `buildTemporalContext(userId)` — derives from `bb_events`: time since last session, since last cigarette, since last resisted urge, current streak, and whether now falls in a known `risk_window`.
- Replace the hardcoded voice greeting with one composed from promoted memories + temporal context + phase.
- Add a `recall_history` tool (the fourth tool) wired to transcripts + `match_user_memories`, closing the gap `agent.md` flags as **highest priority**: *"BB needs a recall tool wired to them."*

Exit test: greeting after a 3-day gap references both the gap and a specific prior detail.

## Phase 4 — Commitments (open loops)

- Migration `011`: `user_commitments` (kind, sensitivity, due_window, confidence, dedupe_key, status), RLS on.
- Extraction runs in the existing Sonnet background agent, not the hot path.
- Confidence gates: **0.72 general, 0.86 for care check-ins.** Max 3/day. Never delivered in the same session it was inferred.
- Commitment text is treated as **untrusted context** when re-injected — it cannot issue instructions or trigger tools.

Given this is addiction support, the bar is deliberately high and the prompt instruction is *"prefer no candidate over weak candidates."* A wrong proactive check-in costs more here than a missed one.

## Testing

The server has **no test harness** (root `package.json` has no scripts; the only tests are `mobile/src/**/__tests__`). CLAUDE.md requires phases end green, so Phase 0 adds one using Node's built-in `node --test` — no new dependency, consistent with "ask before adding third-party SDKs."

## Deployment

**Railway (bb-server):** phases ship independently; 0 and 1 are safe to deploy together.

Migrations 009–011 are additive (`add column if not exists`, new table) — no destructive DDL, deploy-before-code safe.

**Does this need TestFlight?** On current scope, **no** — every change is server-side, and the mobile app talks to bb-server over HTTP. A TestFlight build is only needed if we add a mobile surface for commitments. Flagging because it would cut release risk substantially.

## Open questions

1. **Is this the dev machine?** No clone and no git repos were found on it. `DECISIONS.md` 2026-07-08 notes prod prompt edits live on the Railway volume and are not in git until folded in manually. If prod has drifted from `main`, Phase 0's template edit needs reconciling first.
2. **Migration application** — 009–011 are written as SQL files following the existing convention (applied by hand via Supabase SQL Editor/psql). Confirm that is still the process.
3. **Promotion backfill** — ~3.4K existing memories have no recall history. Options: start the loop cold, or seed from transcript co-occurrence.
