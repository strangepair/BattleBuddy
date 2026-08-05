# BattleBuddy — Architecture Review & Register

**Date:** 2026-08-04 · **Reviewed against:** remote `main` @ `03f5716` · **Method:** code/history/docs inspection, every claim verified against the running tree.

This register consolidates architectural issues that surfaced during recent incident work so they stop living as scattered notes. It judges the system against two bars: (a) correctness/observability/trustworthiness of BattleBuddy as a live product, and (b) its viability as the reference implementation of a reusable self-evolving-app platform (dev-mode loop + pipeline + memory core) that gets parameterized for a second app.

> **Note on scope.** This is a review, not a change. No code fixes are included. Items marked **Needs Mike** are decisions that shouldn't be made by an agent.

> **Security detail withheld.** This repository is public. Items S-01/S-02 below describe the *class* of exposure and the remediation, but deliberately omit the route-by-route inventory, payload shapes, and identifiers that would function as an exploitation guide for a live server holding one real person's health data. That detail was relayed privately to the owner.

---

## What to tackle first

Ranked by (blast radius × likelihood) ÷ effort. The top four are all small.

| # | Item | Why now | Effort |
|---|------|---------|--------|
| 1 | **S-01** Unauthenticated hot-path endpoints + identity aliasing | Live exposure of the one real user's behavioral/health profile — read *and write*. Also the hard blocker for any second user or second app. Stopgap is a one-line guard per route. | S (stopgap) / M (real fix) |
| 2 | **S-02** Two tables carry no RLS | Violates the repo's own non-negotiable rule 4. Contains distilled conversation content + full behavioral profile. | S |
| 3 | **P-01** Pipeline kill switch lives in RAM | The autonomy pause reverts to **on** at every redeploy. A control that fails-open is worse than no control. | S |
| 4 | **V-01** Two brains answer every voice utterance | Duplicate replies, only one audible; both pollute conversation history and fire duplicate side effects. Fix is to stop doing something, not to build. | M |
| 5 | **C-01** Green CI still doesn't prove the shipped container boots | Root cause of the ~21h voice outage. Half-closed today: import *spelling* is gated, missing-COPY is not. | S–M |
| 6 | **D-01** CLAUDE.md routes every new session into the stale doc layer | The meta-bug that manufactures the others: triage repeatedly trusted docs as fact and burned cycles. Highest leverage per edit in the whole register. | S |
| 7 | **X-01** System prompt is ~9.7% from a hard cap the pipeline keeps pushing into | At the current auto-PR growth rate this becomes a recurring CI-failure loop within roughly a week. | S |

**Quick wins (small, uncontroversial, no decision needed):** S-02, P-01, D-01, X-01, T-01/T-02 (dead tripwires), PL-01 (dead route), PL-02 (resubmit gate).

**Needs a Mike decision:** A-01 (Sesame vs Deepgram), V-01 (which brain owns voice), PL-05 (which pipeline table is the spine), M-01 (memory decommission date), E-01 (how far to push platform extraction now).

**Already in flight — do not duplicate:** the build-train + GitHub-reconciler workstream (PRs #108 → #112 → #119) and the post-outage CI hardening (#116, #120, #122, #123). Assessed in PL-06 and C-01.

---

## 1. Voice architecture

### V-01 — Two independent brains answer every voice utterance · **Needs Mike** · Effort **M**

**Current reality.** During a voice session two full Claude Haiku loops run per utterance, and neither knows about the other.

- The LiveKit agent is self-contained: `agent/agent.py:753-774` builds an `AgentSession` with Deepgram STT (`nova-3`), `anthropic.LLM(model="claude-haiku-4-5-20251001")`, and Deepgram TTS. It never calls `/session/turn`. It fetches its system prompt via a nonce handshake (`agent.py:265-285`, `:319-328`) and injects time + a usage-facts line per turn.
- In parallel, the app pipes the *same* final STT transcript to the text backend: `VoiceSession.tsx:223-233` → `onTranscript` → `session.tsx:464-470` → `handleUserTurn` → `useSessionChat.ts:36-76` → `chatStream.ts:42` → `POST /session/turn` (`server/index.js:1377`), which builds its own prompt and streams a second, different reply.

Per spoken utterance the user gets: one spoken reply (the agent's), rendered as an assistant bubble from LiveKit transcription (`VoiceSession.tsx:208-222`), **plus** a second, never-spoken assistant bubble from the text brain. Both land in the session store, so the next turn's history contains both brains' answers interleaved — divergence compounds. Both paths independently trigger fact extraction and dev capture.

**How the two prompt builds differ.** Same persona file, same model. The text brain rebuilds every turn with query-time vector retrieval (`relevantMemories`, `index.js:1421`) and mid-session summaries; the voice brain builds **once at session start** (`index.js:1548-1558`) and deliberately omits both (comment at `:1541-1546` — they need a conversation that hasn't started yet). So a mid-call voice turn never gets retrieval-augmented memory. Canonical fact memory reaches both paths correctly when `MEMORY_FACTS_ENABLED` is on (`buildFactsProfile` called at `:1414` and `:1541`) — the 64 KiB dispatch cap fix does **not** strip memory, because the prompt travels via the nonce fetch, not the metadata.

**Why it exists.** The wiring was added by auto-PR #107 ("Fix voice mode: connect STT transcript to chat stream"). The code comments still assert the premise — `VoiceSession.tsx:84-89`: without this callback "the agent would never receive the transcript and would never reply." That is factually wrong; the LiveKit agent replies on its own. This is a misdiagnosis fossilized into architecture, and it is worth treating as a case study: an autonomous pipeline can encode a wrong mental model as durable structure, and the comment then teaches that model to the next agent.

**Risk.** User-visible duplicate answers; conversation history polluted with un-spoken replies that feed future prompts; duplicated side effects and token spend; two divergent prompt builds to keep in sync forever.

**Recommended direction.** Make voice single-brain with the **LiveKit agent owning the voice reply**. Concretely: stop calling `sendMessage` from `onTranscript` while audio is live — render the user's transcript bubble locally and let the agent's transcription remain the sole assistant output; keep `POST /context/analyze` as the memory/capture path. This matches the existing "same store, same stream" design intent and preserves voice latency. The alternative — proxy voice turns through `/session/turn` for one prompt build — gives a single brain and full retrieval parity, but adds a network hop to the hot path where latency is the product. **Decision for Mike:** own-loop (fast, some prompt duplication) vs proxy (one brain, slower). Recommend own-loop, plus closing the retrieval gap by letting the agent request memories mid-call through an existing tool rather than by rebuilding the prompt.

### A-01 — Sesame CSM is documented as the voice; Deepgram has always been the voice · **Needs Mike** · Effort **S** (adopt Deepgram) / **L** (build Sesame)

**Current reality.** `CLAUDE.md` ("TTS = Sesame CSM") and `docs/06-VOICE.md` §4 ("Decision: build on Sesame CSM (chosen)") declare Sesame. Reality since the **initial commit** (`agent.py@1d4f516`, 2026-06-22, docstring "Claude + Deepgram") is Deepgram Aura — currently `aura-2-arcas-en` (`agent.py:213`, `:747`), hot-swappable via `server/voice-config.json`.

`agent/sesame_tts.py` is dead code and always has been: imported nowhere, `torch` absent from `agent/requirements.txt` (so it would crash on import), and **not COPY'd into the image** — verified, `agent/Dockerfile` copies only `agent.py`, `utils/`, `tools/`, prompts, and voice-config. Notably, `DESIGN-DECISIONS.md:67,142` already records the abandonment ("Sesame CSM abandoned due to subprocess initialization timeouts and heavy memory usage (~4-12GB per process)") — so the repo contradicts itself, and the *stale* copy is the one CLAUDE.md points new sessions at.

**Risk.** Low operationally (production works), high in wasted-cycles terms: this is the canonical case of triage trusting docs as fact. It also spawned live tripwires guarding dead code (T-01).

**Recommended direction.** **Formally adopt Deepgram.** Update `docs/06-VOICE.md` + the CLAUDE.md stack bullet, add a DECISIONS.md entry, delete `agent/sesame_tts.py` and its dependents. Building Sesame for real would require (per docs/06 §4.2) a GPU host ≥8 GB VRAM (~$3/hr, or serverless scale-to-zero), CSM-1B weights, a fixed reference-audio voice identity, a torch stack in the agent image, and bidirectional streaming to reach ~1–2 s first audio — against which the repo's own recorded experience is that CPU/MPS synthesis blew 3 s and then 30 s timeouts. The only argument for Sesame is voice ownership/differentiation; nothing in the product currently depends on it. **Decision for Mike:** confirm Deepgram is the supported voice so the docs can be made true.

### T-01 — Tripwires asserting against dead code · Effort **S**

Each of these is a guard that can never fire, i.e. a false sense of coverage:

1. `mobile/src/__tests__/voice-timeout-invariant.test.ts` — regex-parses `TTS_TIMEOUT_SECONDS` out of `agent/sesame_tts.py` and asserts the client backstop exceeds it. Guards a timeout that is never armed, and creates a cross-package dependency from mobile's jest run into `agent/`. **Remove.** If a real invariant is wanted it should relate the 35 s client backstop (`VoiceSession.tsx:56`) to the agent's actual budgets (`APIConnectOptions(timeout=45.0)`, `agent.py:760-773`) — note 35 s < 45 s, so the client can declare failure while the agent is still trying.
2. `[SesameTTS] VOICE_FAILURE` log (`sesame_tts.py:36`) — unreachable. Carries a `# TODO: add unit test` on dead code. **Remove with the file.**
3. **Dead receiver:** `VoiceSession.tsx:324-340` listens for a `VOICE_FAILURE` room-data packet to show the fallback banner immediately. Its only publisher in the repo is `sesame_tts._publish_voice_failure` — dead. The live path (`agent.py:843-872`) only *prints* to Railway logs. So only the 35 s timer ever fires. **Repair** (one `publish_data` call in the agent's error branch — mobile is already wired) or remove the listener.
4. Stale keyword `"SesameTTS"` in the live error classifier (`agent.py:847`) — can never match a Deepgram-stack error. **Prune.**
5. `_LoggedTTS.synthesize()` `[TTS]` logs (`agent.py:122-132`) — self-documented as dead since PR #75 (Deepgram advertises streaming, so LiveKit calls `stream()`). **Delete.**
6. `scripts/test-voice-pipeline.sh` — hardcodes a LAN IP, a `~/Claude/Projects/` path that no longer exists, and a machine-specific scratchpad log path. **Remove or rewrite against Railway.**

### T-02 — A purpose-built diagnostic pipeline with zero callers · Effort **S**

`POST /events/voice-failure` (`index.js:3131-3210`, JWT-authed, dedup middleware) writes to `client_events` (migration 014) and `voice_failure_logs` (migration 015). **Nothing in the repo calls it.** The actual mobile handler (`session.tsx:311-324`) calls `logEvent(...)` → `POST /events` → `bb_events`. So two migrations, an endpoint, and dedup middleware sit unused while `PIPELINE-STATE.md:33` lists a PENDING feature that depends on `voice_failure_logs`. **Repair** (point the handler at the purpose-built endpoint) rather than remove, given that pending dependency.

---

## 2. CI, containers, and deploy verification

### C-01 — "Green CI" still doesn't mean "the shipped container works" · Effort **S–M**

**Current reality.** Four required jobs (`mobile`, `server`, `agent`, `agent-tests`). **No Docker build occurs anywhere in CI** — not in `ci.yml`, `autobuild.yml`, `deploy.yml`, `auto-pr-hygiene.yml`, or `mobile-release.yml`. All agent checks run against a pip-installed repo checkout, never the image.

The image is **flat** (`/app/agent.py` + `/app/utils/` + `/app/tools/`), so `from agent.utils…` resolves in a repo-root checkout (PEP 420 namespace package) and fails in the container. That asymmetry was the entire #101 bug: an import added *inside a method body* referencing `agent/utils/`, which the Dockerfile never COPY'd. Every LiveKit job crashed ~84 ms after acceptance; ~21 h of no voice.

**What the post-outage work already fixed (#116, #120, #122, #123):** a `compileall` gate; a container-path grep gate rejecting `agent.*`-prefixed imports; an import gate running `python -c "import agent"` under the pinned `livekit-agents==1.6.2`; pytest promoted to a required check (#122 — it had flagged the exact `ModuleNotFoundError` while still advisory); `PYTHONUNBUFFERED=1`; and `[VOICE-DIAG]` runtime tracing (#123) that separates "LLM never answered" from "TTS never spoke".

**What remains open.** The grep closes the import-*spelling* half of #101; it does not close the missing-*COPY* half. `utils/` and `tools/` are now copied wholesale, but a new top-level dir (say `agent/handlers/`) or a new data-file dependency would ship green and crash identically. `ci.yml` documents its own blind spot verbatim: the import gate "executes module-level code ONLY. An import inside a function or method body is never evaluated here." And post-deploy, **nothing verifies the agent works**: `deploy.yml` runs `railway up` and reports `deployed` on exit-0. Railway builds the image remotely; no check confirms the container stayed up, registered with LiveKit as `battlebuddy`, or can accept a job. The first signal of a dead agent is a human trying to talk to it.

Two related config landmines, both flagged in `docs/09-DEV-PIPELINE.md`: `bb-agent`'s Dockerfile path is dashboard-side and doc-flagged as needing a pin, and `bb-server`'s Railway build source still watches a stale fork — a push there would silently roll production back. There is no `railway.json`/`railway.toml` in the repo; all service config is unversioned.

**Recommended direction**, in order:

1. **Build the real image in CI and import inside it** (S). A `docker/build-push-action` job with `context: .`, `file: agent/Dockerfile`, GHA layer cache, then `docker run --rm bb-agent:ci python -c "import agent"` with dummy env. This makes the checkout/image asymmetry structurally impossible for module-level code: a missing COPY *or* a bad import path fails here regardless of the grep. Promote to required. Keep the fast source-tree gates for sub-minute signal.
2. **Close the deferred-import blind spot inside the image** (S). Walk shipped sources with `ast`, collect every `Import`/`ImportFrom` at any depth, and `importlib.util.find_spec()` each top-level name inside the container. Catches method-body imports of modules that aren't in the image — exactly the latent `tools.log_activity` defect #120 found by hand — without executing side-effectful code.
3. **Verify the deploy actually registered** (M). After `railway up`, poll LiveKit for a `battlebuddy` worker with a fresh join time (or at minimum assert the Railway deployment reached RUNNING and printed the registration line) before reporting `deployed`; report `deploy_failed` otherwise. This is what converts an 18-hour outage into a 5-minute one, and it is the single highest-value item in this section after (1).
4. **Version Railway config** (S) — `railway.json` with `dockerfilePath: agent/Dockerfile`; disconnect the stale fork source.
5. Optional (M): boot-far-enough smoke with `livekit-server --dev` as a CI service container, asserting the worker-registered line. Real fidelity, some flake surface (plugin model downloads) — make it required only after a green soak.

---

## 3. Documentation integrity

### D-01 — CLAUDE.md routes every new session into the stale layer · Effort **S**

**Current reality.** The repo has two doc layers. `docs/08`, `docs/09`, `docs/11`, `docs/12`, `DECISIONS.md`, `PIPELINE-STATE.md`, and `RELEASE-PLAN.md` accurately describe the running system. `CLAUDE.md` and `docs/00–06` — the June-2026 spec package — do not, and **CLAUDE.md tells every session to read exactly those first, in order, and to "start at Phase 0."** It never mentions the accurate layer.

Verified drift in the layer sessions are told to trust:

| Doc claim | Reality |
|---|---|
| Backend = Supabase Edge Functions (Deno) | Node HTTP server on Railway (`server/index.js`). `supabase/functions/` holds only `_shared/cors.ts` — zero functions. `/personalize`, `/insights`, `/media/suggest` never existed. |
| Tier 0 on-device Gemma; offline-capable turns | No on-device LLM. Zero gemma/llama/mediapipe/onnx deps in `mobile/package.json`; `onDeviceModelEnabled: false`. Every turn is cloud Haiku. Offline = local SQLite logging + sync only. |
| `LLMProvider` interface + `ModelRouter` | Neither exists in `server/` or `mobile/`. |
| Model strings + flags in one central config module | No such module. Model strings hardcoded at ≥11 sites across `index.js`, `contextAgent.js`, `devPipeline.js`, `agentDesignLoop.js`, `factGate.js`, `agent.py`. A model swap is a multi-file, two-language diff. |
| R2 = curated media library, signed URLs, keys server-side only | R2 is a **public** bucket of AI-generated theme videos (`content_videos.r2_url` — "full public URL"), consumed client-side via a public base URL. No signed URLs, no S3 client in `server/package.json`. The `media_library` tables are dormant. |
| Agent tools = `suggest_media`, `start_wave_exercise`, `set_followup_timer` | None exist. Real set: `recall_episodes`, `get_usage_stats`, `log_activity`, `log_event`, `update_event`, `check_dev_mode`, plus `remember`/`correct_memory`/`forget`/`lookup_fact`. (`docs/11` §1.3 is the correct reference.) |
| Data model = `users`/`urge_events`/`messages`/`media_library`/… | Live system runs on `bb_events`, `user_profiles`, `user_memories`, `user_facts`, `user_commitments`, `content_videos`, `dev_build_requests`, the 018–022 pipeline tables, and more — none named in `docs/02`. |
| Maestro E2E "running on a simulator in CI" | No Maestro job in any workflow. The flows exist; nothing runs them. |
| RLS on every table, Supabase Auth per-user | Local AsyncStorage auth with `user-{timestamp}` ids and server-side RLS workarounds (the repo's own `docs/08` §1 says so). See S-01/S-02. |
| Multi-user US-only consumer MVP, ship Phase 1 first | Single user (n=1), pivoted to the self-evolving-app platform. A session following CLAUDE.md literally tries to resume a finished/abandoned greenfield plan. |

Minor: `docs/02` cites React Query + MMKV (absent); `mobile/src/config/index.ts` still defaults `BASE_URL` to a Supabase functions URL and labels `TTS_URL` "Sesame CSM"; per `DECISIONS.md` (2026-07-08) the *production* prompt may be a console-edited volume copy, so the git file is not guaranteed to be the live prompt.

**Risk.** This is the meta-issue that produces wasted triage across every other item — dead tripwires got *added* to dead code by pipeline work in August because the docs said that code was the voice. It compounds as pipeline throughput rises: the autonomous coding agent reads these docs too, so drift becomes an input to code generation, not just to human confusion.

**Recommended direction — three cheap, durable moves.**

1. **Fix CLAUDE.md's routing paragraph first** — the single highest-leverage edit in this register. Replace "read docs 1–6 in order, start at Phase 0" with a two-layer map (current-reality docs vs historical spec package) and correct the stack bullets (Node-on-Railway, LiveKit + Deepgram, no on-device tier, public-R2 content feed, no central config module).
2. **One-line status header on every doc:** `Status: CURRENT | DESIGN (partially built) | HISTORICAL (superseded by docs/NN)`. Only CURRENT docs are obliged to be true; HISTORICAL ones are frozen and explicitly exempt. This keeps the maintenance burden proportional and honest rather than pretending everything gets updated.
3. **One line in the working agreement / PR template:** "if this change contradicts a claim in CLAUDE.md or a `Status: CURRENT` doc, update the claim in the same PR." Cheap to comply with, and it puts the burden where the knowledge is.
4. Optional: tombstone dead config that reads as live (`ModelConfig.DEVICE`, `TTS_URL`, the edge-functions `BASE_URL` default). Dead config is documentation too.

---

## 4. Dev pipeline — data model & observability

Much of this area is **already in flight**. Assessed below is what that work covers versus what remains.

### PL-06 — What the in-flight work already covers · *No action*

The GitHub-truth reconciler (#119) + build-train (#112) already handle: status-drift repair for `dev_build_requests` via a 60 s tick that re-derives PR-linked rows from GitHub through a single pure `deriveState` (`devReconcile.js:110-215`); lost `pr_opened`/`checks`/`merged`/`deployed` callbacks; closed-unmerged → `superseded`; orphaned dispatch → `needs_attention` after 30 min; adoption of hand-made PRs into rows; run-id-idempotent release upsert with membership re-derived from git trailers rather than callback memory (`devRelease.js:162-201`); class-based retries and a signature-keyed circuit breaker (migration 020). It also **fixed the empty `changes` table** — migration 022:8-11 states verbatim that it "has been an empty table since migration 018 because nothing wrote it," and `upsertChangeForRequest` (`devRelease.js:210-243`) is now its writer. Fire-and-forget callbacks (every workflow uses `curl -sf … || true`) remain, but the reconciler is the correct architectural answer to them: reconcile against source-of-truth rather than trust delivery.

### PL-01 — The voice agent's `create_dev_item` route is dead on arrival · Effort **S**

`handleDevItems` inserts `source: 'agent_tool'` (`devPipeline.js:1233`), but the check constraint allows only `('transcript','directive','github')` (verified: `012:12` originally, widened at `022:108-110`). Every insert fails with a 23514 constraint violation → 500, and the item is silently lost from the agent's perspective. **This has never worked against a migrated database.** Fix is one migration line, but route it through `processSubmission` at the same time so it inherits triage and dedupe rather than bypassing them.

### PL-02 — Resubmit bypasses every gate · Effort **S**

`POST /dev/requests/:id/resubmit` (`devPipeline.js:1133-1179`) checks only that the status is resubmittable, then calls `dispatchBuild(row)` directly — verified. It does not check `isPipelineEnabled()` (so it dispatches **while the pipeline is paused**), nor `MAX_CONCURRENT` (enforced only in the worker loop at `:543`), nor `MAX_PER_DAY`. Combined with P-01 this means the pause control is advisory in two independent ways. Cleanest fix: set the row to `pending` and let the worker pick it up — it inherits every gate for free.

### PL-03 — Release reconciliation is claimed in comments but not implemented · Effort **M**

`mobile-release.yml:25` and `devRelease.js:12-13` both state that the stage-2 reconciler rebuilds releases from the Actions API if a callback is lost. It does not: `loadGitHubSnapshot` fetches only `pulls` and `deploy.yml` runs (`devReconcile.js:253-255`); nothing queries `mobile-release.yml`. If both retried release callbacks fail, no `releases` row is ever created and **every mobile-touching request pins at `deploying` forever** (`deriveState:196-208` needs `release.status`). The scope is unfinished rather than wrong — but a comment asserting coverage that doesn't exist is a trap of exactly the D-01 species, in code this time.

### PL-04 — Two-ledger intake asymmetry and backfill orphans · Effort **S–M**

Only `/dev/directive` runs triage into `submissions`/`work_items`/`pipeline_events` (`devPipeline.js:1020`). `/dev/capture`, the server-side capture flush, and `/api/dev-items` write **only** `dev_build_requests` — so transcript-sourced work never gets a submission row, and `handleRepetition`'s per-subsystem repetition detection is blind to most real traffic. The reconciler lazily backfills a work item but hardcodes `subsystem: 'pipeline'` (`devReconcile.js:319`). Separately, `backfillPipelineWorkItems.js:102-109` creates work items without stamping `dev_build_requests.work_item_id`, so the first reconcile tick creates a *second* work item per request and the backfilled ones are permanently stranded.

### PL-05 — Decide which table is the spine · **Needs Mike** · Effort **M**

`dev_build_requests` is the operational source of truth; the migration-018 layer (`work_items`, `changes`, `releases`, `submissions`, `pipeline_events`) is a half-integrated second representation of the same work, built for the card timeline. Symptoms: the intake asymmetry above, orphaned backfills, `work_items.stage` values (`canary`, `rolled_back`) that nothing ever sets, `pipeline_events` kinds (`canary_started`, `went_live`, `refined`) with no emitters, and feature-flag fields (`changes.flag_key`, `flag_off`/`flag_on`) that are pure aspiration. **Recommendation:** declare `dev_build_requests` the spine and make `work_items`/`changes` reconciler-derived projections only — this deletes the entire intake-asymmetry bug class rather than patching instances. The alternative (promote `work_items` to the spine) is more work and buys little today. Either way, unbuilt schema should be dropped rather than left looking implemented.

### PL-07 — The pipeline can't see itself · Effort **M**

`runReconcileTick` returns `{checked, patched, adopted}` and `index.js` discards it. No counters on tick outcomes, so drift-repair volume — the clearest health signal the pipeline has — is invisible. `pipeline_alerts` rows surface nowhere outside the Dev tab. No GitHub API rate-budget accounting despite a per-tick cost of two list calls plus up to ~25 check-run calls plus per-PR file calls. Also worth noting: webhook and reconciler both do read-modify-write on the JSONB `history` column with no row lock or version check, so concurrent writes can drop an entry (low severity, real).

### PL-08 — Expedite is schema and workflow plumbing with no trigger · Effort **M** (or S to delete)

The `expedite` column, publicRow field, workflow concurrency group, and callback plumbing all exist; no server code dispatches `mobile-release.yml`. Expedite is manual `gh workflow run` only. Either wire the trigger or drop the column — dead schema reads as capability.

---

## 5. Cross-cutting risks

### S-01 — Unauthenticated hot-path endpoints and identity aliasing · Effort **S** (stopgap) / **M** (real fix)

*(Route inventory and repro withheld — public repo. Full detail relayed privately.)*

**Current reality.** Three credential tiers exist (`index.js:1022-1080`): an admin secret with timing-safe compare, a shared `BB_CLIENT_TOKEN` that ships **inside the mobile build**, and real per-user Supabase JWT — but the JWT tier guards only profile routes. Several high-value endpoints, including the main LLM turn endpoint and a memory-write tool endpoint, have **no guard at all** (verified: no auth check anywhere in the `/session/turn` handler), and identity is taken from the request body rather than derived server-side.

This interacts badly with `USER_ALIASES` (`contextAgent.js:283-288`), a hardcoded map that resolves a generic default identity to the founder's canonical user id. The code shows the hazard was *seen*: `/session/turn` deliberately avoids the alias for an **omitted** userId, with a comment explaining it "would hand his history to any client that omits userId" — but a **supplied** one is not filtered. So the guard covers the accidental case and misses the adversarial one.

Everything guarded only by the client token is public-with-effort, since that token is extractable from the app binary, and those routes also take a body-supplied user id — including the pipeline event injector, which can forge dashboard state.

**Risk.** **Highest concrete risk on main today.** Single-user status limits the blast radius to one person — but that person's complete behavioral and health profile (smoking patterns, triggers, personal facts) is readable *and writable* by anyone who finds the server URL, and the server is a public Railway host. For MindCap or any second user this posture is disqualifying.

**Recommended direction.** (1) Stopgap now: minimum client-token guard on every unguarded route — one line each (S). (2) Real fix before any second user: per-user JWT on the hot path with the user id **derived from the token, never the body**, and retire the alias map into a proper identity layer (M; overlaps E-01). Also outstanding from prior notes: the leaked DB password remains unrotated.

### S-02 — Two tables carry no RLS · Effort **S**

`server/migrations/002_user_memories.sql` and `007_user_profiles.sql` enable no RLS and key on a plain `text` user_id rather than an auth UID — so they are reachable via PostgREST with the public anon key. They hold distilled conversation content and the full behavioral profile respectively. Other tables are fine (`001_initial_schema.sql`, `013_user_facts.sql`, `018` all have RLS + policies), which makes this an inconsistency rather than an absent practice — and a direct violation of CLAUDE.md's non-negotiable rule 4. Fix: RLS-enable migrations, or revoke anon on both.

### P-01 — The autonomy kill switch lives in RAM · Effort **S**

`PAUSED` is a module-level variable (`devPipeline.js:28`, toggled at `:1185`). **Any redeploy silently un-pauses the autonomous PR pipeline** — and redeploys are exactly what the pipeline itself causes, so pausing after a bad run is undone by the next deploy. A control governing autonomous code-writing must fail closed and survive restarts. Persist it to the migration-018 tables (or an env-backed setting). Pair with PL-02, which lets resubmit bypass the pause anyway.

Other in-memory operational state, for completeness: `voiceAgentConfig` entries (10-min TTL by design — a redeploy mid-handshake yields a silent-greeting session and a fall back to the image's build-time prompt snapshot), `midSessionSummaries` (benign), dev-capture segments (mitigated by a SIGTERM flush; a hard kill still drops the tail), and the fact cache (fire-and-forget warm at listen time; a slow warm degrades early turns to the blob profile). Everything — API, six cron loops, pipeline worker, reconciler — is one Node process on one Railway instance, with transcripts on a single volume.

### X-01 — The prompt is ~9.7% from a cap the pipeline keeps pushing into · Effort **S**

`server/prompts/system.battlebuddy.md` is **51,811 bytes** against `MAX_PROMPT_BYTES = 57,344` (`promptGuard.js:28`) — **5,533 bytes of headroom**, verified. History: trimmed 153 KB → 49 KB on 2026-07-29 (PR #31), then three *auto-pipeline* PRs (#43, #57, #60) added ~2.8 KB in three days. At that rate auto-PRs begin failing CI on prompt size within roughly a week.

The guard itself is good (enforced in CI *and* at write time, covering the git-less Railway-volume path). The structural problem is that the system writing the prompt has no notion of a budget: the fix belongs at **spec-generation time** (teach the pipeline's spec prompt to replace rather than append) rather than at CI-failure time, where it produces a retry loop. Two adjacent fragilities: `promptCache.js` splits on the literal heading `'## Runtime context'` (rename it and caching silently degrades — latency is the product), and `buildSystemPrompt` fills nine `{{placeholder}}`s with unvalidated single-occurrence `.replace()`, so a renamed placeholder ships the literal `{{...}}` to the model.

### X-02 — `server/index.js` is a 3,944-line monolith · Effort **M**

184 KB, one `createServer` handler with ~50 inline route branches, holding prompt assembly, the streaming agent loop, tool execution, auth guards, user routes, admin routes, pipeline API, the Sonnet audit job, and **six `setInterval` background loops**. Several domains have been properly extracted (`promptCache`, `promptGuard`, `devMode`, `devPipeline`, `devCapture`, `factStore`/`factGate`), so the pattern exists — the composition root, hot path, and cron layer just haven't followed. The pipeline-specific risk: every auto-PR targets this same file, so merge-conflict probability and regression blast radius scale with pipeline throughput, and the coding agent must reason about a file that also contains the cron layer. Split into route modules + a `jobs/` scheduler; mechanical and testable.

### M-01 — Four memory layers running in parallel with no decommission date · **Needs Mike** · Effort **M**

Canonical `user_facts` reaches both text and voice correctly (see V-01), but three older layers remain fully live: the `user_profiles` blob (still mutated every ~3 turns), the `user_memories` vector store (**still queried every text turn regardless of flag**, still written by the 20-minute sweep), and the promotion tier (still scored nightly; only *injection* is suppressed). With both flags on, a single conversation drives three write pipelines and two read paths for the same information.

The sharp edge: `buildFactsProfile` returns null when a user has zero facts (`index.js:106-108`), silently reverting that user to the old system — so contradictions between blob-profile and fact-doc are reachable, not hypothetical. Cross-system coupling exists too (`forget` must suppress related past-session memories across both stores). This is an acceptable deliberate dual-run, but there is **no dated decommission plan in the code**. **Decision for Mike:** set a soak end-date, after which promoted-tier injection retires, `analyzeAndUpdate` stops mutating the blob (or narrows to episodic fields, which `factExtraction.js` already delineates), and `user_memories` becomes purely episodic recall.

### E-01 — Platform extraction seams for MindCap · **Needs Mike** · Effort **M**

Extracting the platform core today would be fork-and-sed, not reuse. Concrete couplings:

- **App identity inside pipeline LLM prompts:** `devPipeline.js:131-133` hardcodes "BattleBuddy mobile app… React Native/Expo (mobile/) + Node backend (server/) + Python voice agent (agent/) + Supabase" into spec generation; `:685` hardcodes it into triage; `index.js:250` into the dev-session prompt. The pipeline's *reasoning* is app-specific, not just its config.
- **Repo/agent identity:** `GITHUB_REPO || 'strangepair/BattleBuddy'` (`githubApi.js:12`, `devPipeline.js:44`) — env-overridable, good seam, bad default. LiveKit dispatch name `'battlebuddy'` and the prompt path are hardcoded (`index.js:141`, `:1493`, `:1647`).
- **Domain taxonomy inside the memory core:** `factStore.js:57-60` bakes smoking-domain categories (`quit`, `trigger`, `window`, `coping`) and their review horizons into the supposedly reusable canonical store, and the voice tool schemas mirror them.
- **Single-user assumptions woven through the data layer:** `resolveUserId`/`USER_ALIASES` is imported by `index.js`, `factStore.js`, and `devCapture.js`, and ~15 routes default to "no user = the founder."
- **No central config module** despite CLAUDE.md claiming one (see D-01).

**Recommended direction.** An `appConfig` module (app name, repo, subsystem map, dispatch name, prompt path, model ids, flags) that the pipeline prompts template over (S–M); a config-supplied fact taxonomy (M); and a real identity layer replacing the alias map (M — same work as S-01's real fix). **Decision for Mike:** whether to do this now as a deliberate extraction pass (aligned with the in-progress `docs/10-PLATFORM-EXTRACTION.md`) or defer until MindCap actually starts and let its first week drive the seams. Deferring is defensible; doing it ad hoc per-item is not.

---

## Summary table

| ID | Item | Severity | Effort | Decision? |
|----|------|----------|--------|-----------|
| S-01 | Unauthenticated hot path + identity aliasing | **High** | S / M | — |
| S-02 | Missing RLS on two tables | **High** | S | — |
| P-01 | Pipeline pause is in-memory (fails open) | **High** | S | — |
| V-01 | Two brains answer every voice utterance | **High** | M | ✅ |
| C-01 | CI doesn't build/boot the shipped container | **High** | S–M | — |
| D-01 | CLAUDE.md routes to the stale doc layer | **High** | S | — |
| X-01 | Prompt ~9.7% from cap; pipeline pushes into it | Medium | S | — |
| PL-01 | `create_dev_item` violates a check constraint | Medium | S | — |
| PL-02 | Resubmit bypasses pause + concurrency gates | Medium | S | — |
| PL-03 | Release reconciliation claimed, not implemented | Medium | M | — |
| PL-04 | Intake asymmetry + orphaned backfill work items | Medium | S–M | — |
| PL-05 | Which pipeline table is the spine | Medium | M | ✅ |
| PL-07 | Pipeline has no self-observability | Medium | M | — |
| A-01 | Sesame documented, Deepgram shipped | Medium | S | ✅ |
| M-01 | Four memory layers, no decommission date | Medium | M | ✅ |
| X-02 | `server/index.js` monolith | Medium | M | — |
| E-01 | Platform extraction seams | Medium | M | ✅ |
| T-01 | Tripwires guarding dead code | Low | S | — |
| T-02 | Voice-failure pipeline with zero callers | Low | S | — |
| PL-08 | Expedite plumbing with no trigger | Low | S / M | — |

---

## The pattern worth naming

Three of the most expensive items here — the two-brain wiring (V-01), tripwires added to dead code (T-01), and the "reconciler rebuilds releases" comment (PL-03) — share a mechanism: **a confident but false claim, written into code or docs, that a later agent then trusted and built on.** The 21-hour outage came from the same family, where a *test-passing* signal was trusted as a *shipping* signal.

The durable countermeasure isn't more documentation; it's making the load-bearing claims *executable*. CI that builds the real image (C-01) turns "the container works" from a comment into a check. A status header (D-01) turns "this doc is true" from an assumption into a declaration someone owns. Reconciling against GitHub instead of trusting callbacks — the in-flight work already gets this right, and it's the model to copy: **prefer verifying reality over trusting a report of it.** Each item above is worth fixing individually, but that principle is what keeps them from recurring in new forms.
