# PIPELINE-STATE

Source of truth for the Developer-mode pipeline's evolution into a general
"continuous innovation" framework. Any actor — Mike, a Claude chat session,
or a headless pipeline agent — should be able to resume from this file alone.
Update this file whenever a numbered submission lands or a decision changes.

Last updated: 2026-08-03 ~01:30 UTC (Claude chat session, working with Mike).

## Vision

The pipeline inside this repo is two things that will eventually separate:

1. **Control plane** (app-agnostic): triage, planner, work items, releases,
   per-change feature flags, rollback cards, crash reporting, Ask-AI on
   cards, meta health metrics.
2. **App contract** (per app): target areas, protected paths, verification
   commands, deploy adapters, health signals — eventually a `pipeline.yml`
   manifest each repo ships.

End state: `echidna/pipeline` as its own repo administering any Echidna app.
Extraction happens when app #2 onboards — NOT before. Until then everything
is built inside BattleBuddy with deliberately generic naming.

## The six-submission build plan (spec: 2026-08-01 chat session)

| # | Scope | Status |
|---|-------|--------|
| 1 | Data layer: submissions, work_items, work_item_submissions, changes, releases, pipeline_events + /api/pipeline routes + backfill | **MERGED** PR #69, deployed |
| 2 | Triage: durability-first intake, dedup classification (claude-sonnet-4-6), repetition escalation marker, never-stall fallbacks | **MERGED** PR #71, deployed |
| 3 | Pipeline screen rebuild: work-item cards, release groups, AI digest, exception cards ("Needs your input", default + deadline), Plumbing view behind DEV toggle | PENDING — dispatch next. Its gate (the duplicate-submission test) is now a REAL gate as of PR #83; see "Duplicate-submission gate" below. |
| 4 | Per-change feature flags: feature_flags table, server cache + realtime invalidation, isEnabled(flag, userHash), wi_{id}_{slug} naming rule in build prompt, flag-debt nightly job | PENDING |
| 5 | Rollback cards (new work_item linked to original, flag unset = instant rollback, health-signal auto path wired to voice_failure_logs) + Refine-this flow (child work item, parent context, flag reuse on supersede) | PENDING |
| 6 | Ask BattleBuddy action on every card: session with work-item context block, tools refine_work_item / rollback_change / resolve_exception / correct_interpretation. MUST respect dispatch metadata cap (summarize diff, cap submissions at 10) | PENDING |

Full submission texts live in the 2026-08-01 chat; Submissions 1–2 were
dispatched via repository_dispatch (event dev_build) after the app intake
path failed. Submissions 3–6 should be re-derived from this table's scope
lines plus the design principles below if the originals are unavailable.

## Design principles (decided, do not silently revisit)

- **No human in the loop as a requirement.** Oversight functions become
  specialized agents (Triage, Planner, Root-Cause, Release, Meta). The human
  holds veto, never obligation: exception cards state a default and a
  deadline; silence never stalls the pipeline.
- **Durability first.** A submission gets a database row and a 'submitted'
  pipeline_event before ANY other processing. Failures leave trace events.
  A submission must never vanish silently (this was tonight's worst bug).
- **Every behavioral change ships behind its own flag** (once Submission 4
  lands). Rollback = flag unset: instant, per-PR, no rebuild — critical
  because mobile deploys cost a full EAS → TestFlight cycle.
- **Rollback creates a new card** linked to the original, never mutates it.
  Releases group changes; a release can be partially rolled back.
- **Repetition is a signal.** 3+ items/evidence on one subsystem in 7 days
  auto-creates a root-cause investigation item instead of more patches.
- **Escalation to the user is the exception** (~5% budget; more means the
  agents are under-deciding — a Meta Agent finding).

## Incidents from 2026-08-01 and what they hardened (the guard catalog)

These are the framework's reusable invariants — each incident maps to a guard:

1. **PR #60 death loop**: log_activity added to voice + prompt but not the
   text surface; the three-surface parity test failed on every auto-merge
   retry for ~10 h. Fixed by adding the text declaration/executor.
   → Guard: cross-surface parity tests (keep; generalize per app).
2. **23:15 UTC autobuild crash (96 s)**: Claude Code step died; no webhook
   fired; request hung at "Under development" forever. → Fixed in PR #70:
   if:failure() needs_attention callback in autobuild.yml.
3. **Five of six chat-submitted directives vanished at intake** with no
   trace. Root cause unconfirmed (evidence is in Railway bb-server logs,
   window 2026-08-01 22:45–23:20 UTC — forensics optional now). → Fixed
   structurally by Submission 2's durability-first intake.
4. **45 stale branches** made the backlog unreadable (auto-merge's
   --delete-branch not cleaning up; hygiene workflow worth auditing).
   → Cleaned 2026-08-02; only active branches remain.
5. **PR #53** was a duplicate of already-merged work with an add/add
   migration conflict (permanently "dirty"). → Closed unmerged. Triage
   dedup (Submission 2) exists to prevent the class.
6. Pre-existing guards that proved their worth and must survive extraction:
   prompt-size gate (56 KB cap / 2 KB per-run growth vs LiveKit's 64 KB
   dispatch cap), autobuild scope fence (protected paths, 988 safety
   markers), additive-only migration guard in deploy.yml.

## Access / operational notes (no secrets in this file)

- Pipeline flow: app → server dev_build_requests → repository_dispatch
  (dev_build) → autobuild.yml (headless Claude Code, model pinned
  claude-sonnet-4-6, 20 min) → scope fence → PR + auto-merge on green CI →
  deploy.yml (Railway server/agent, Supabase migrations, EAS → TestFlight).
- main is branch-protected: changes land via PR + green CI only.
- Workflow file edits require a token with the Workflows permission; the
  autobuild fence rightly forbids the bot itself from touching .github/**.
- Direct dispatch (bypassing app intake) works but is invisible to the Dev
  tab — Submissions 1–2 were dispatched this way; acceptable stopgap only.
- Tokens used on 2026-08-01/02 (GitHub fine-grained PAT; Railway project
  token) were shared in a chat session and should be ROTATED after the
  session's work concludes.
- Claude chat sessions: network egress allowlist is stamped at session
  start; backboard.railway.com was added to Mike's allowlist and becomes
  reachable in sessions started after that change.

## Self-heal (2026-08-02) — the pipeline recovers without a human

Shipped so the pipeline "just runs". All three landed green.

| PR | What |
|----|------|
| #83 | Duplicate path is a real gate: a duplicate submission parks its pre-created `dev_build_requests` row in terminal status `duplicate` (so `runDevBuildWorker`, which only picks up `pending`, never dispatches a redundant build), and `submitDirective` returns `duplicate`/`attachedTo` so the Dev screen names the existing work item. |
| #86 | Classified auto-retry + circuit breaker (migration 020). |
| #93 | Manual resubmit endpoint + Resubmit button. |

**Retry policy — classified, never blanket.** `classifyFailure()` in
`server/devPipeline.js`:

- `transient` (ETIMEDOUT / ECONNRESET / network unreachable / dispatch 5xx /
  npm / onnxruntime): retry up to 2x, exponential backoff from `DEV_RETRY_BASE_MS`.
- `stale_branch` (merge conflict, "not mergeable (dirty)", add/add): regenerate
  once — autobuild branches from current main, so a re-dispatch resolves the
  conflict by construction.
- `terminal` (scope fence, protected path, destructive migration, forbidden,
  988 safety marker): never auto-retried.

Two rules that must survive refactors: **terminal is matched first** (a
scope-fence failure that mentions a timeout must not be retried), and
**anything unrecognised falls through to terminal** (a pipeline that retries
what it doesn't understand burns build minutes and hides the fault).

**Circuit breaker.** `failureSignature(stage, error)` normalises away uuids, run
numbers and paths so repeats collapse onto one key. At `DEV_BREAKER_THRESHOLD`
(default 3) rows sharing a signature: retries stop, rows escalate to
`needs_attention`, and ONE `pipeline_alerts` row is raised. Enforced by a
partial unique index (`unique (signature) where resolved_at is null`), not by
application logic, so concurrent worker ticks cannot double-alert. A later
success — or a manual resubmit — resolves the alert. This is the guard that
would have caught the IPv6 `SUPABASE_DB_URL` break after row one.

**Manual resubmit.** `POST /dev/requests/:id/resubmit` (client-token auth,
mirrors the archive route). Routes by classification: a *deploy* failure re-runs
the Deploy workflow for that PR's merge commit (the code already merged —
regenerating would write the same change twice); everything else re-dispatches a
build. Only `failed` / `needs_attention` are resubmittable, so an in-flight
build cannot be double-dispatched. The button is hidden while `next_retry_at` is
set, so a human cannot race the auto-retry worker.

## Duplicate-submission gate (Submission 3's entry test)

Run from the **Dev / Build pipeline screen's directive box** ("Send to
pipeline") — NOT the dev-mode chat toggle. Only `POST /dev/directive` runs
triage; `/dev/capture` (the transcript path) does not.

1. Submit a symptom, e.g. "Voice mode goes silent partway through a session."
   Expect: classified `new`, work item created, build dispatched.
2. Submit the same symptom in different words, e.g. "The buddy stops talking
   mid-conversation in voice."

Pass = stored instantly (durable `submissions` row before any classification),
classified `duplicate`, attached as `evidence`, **no build dispatched**, and the
app names the existing item. Criteria 4 and 5 were NOT implemented until PR #83;
before that a duplicate still shipped a redundant build and the app said
nothing. Criteria 1–3 are only observable with the service-role key until
Submission 3 ships the screen that renders them.

## Working rules for agents and debugging sessions

**Agent/debug work runs REMOTE-ONLY.** On Mike's machine the repo working tree
is large and dirty, and local git/filesystem commands (`git status`, `git diff`,
`git log`, `ls`/`find`/`grep` over the tree, anything touching the macOS
keychain) have wedged sessions indefinitely with no timeout. Every change in
this file's Self-heal table was authored and landed without a single local git
command, using only:

- `gh api repos/:owner/:repo/git/{blobs,trees,commits,refs}` to create branches
  and commits (never `git push`)
- `gh api repos/:owner/:repo/contents/...` to read files at a ref
- `gh pr create` / `gh pr merge` / `gh run list` / `gh api .../actions/...` for
  PRs, CI and deploy verification (add `--allow-escape-sequences` when reading
  job logs)
- `curl --max-time 15` against Supabase PostgREST to verify migrations landed
  (HTTP 200 with `[]` = table exists but RLS blocks; 404 = table missing)

Always bound commands with a timeout. If a local command is unavoidable, prefer
a targeted, non-recursive one over anything that walks the tree.

**Non-interactive git config (CI-safe).** Any automated context must never sit
at a credential or host-key prompt. Export before any git/gh use:

```
export GIT_TERMINAL_PROMPT=0        # fail instead of prompting for credentials
export GCM_INTERACTIVE=never        # git-credential-manager, if installed
export GH_PROMPT_DISABLED=1         # gh never opens an interactive prompt
git config --global credential.helper ''   # do NOT reach for the macOS keychain
```

On macOS the default `credential.helper=osxkeychain` is the specific hazard: a
locked keychain blocks forever rather than failing. GitHub Actions is already
safe here — `actions/checkout` injects a scoped token and sets its own helper.

**Workflows carry no local-machine dependency (verified 2026-08-02).** Every job
in `autobuild.yml`, `deploy.yml`, `ci.yml` and `auto-pr-hygiene.yml` is
`runs-on: ubuntu-latest`; there are no self-hosted runners and no `localhost` or
`/Users/...` paths anywhere in the workflow files. The pipeline runs end to end
with Mike's laptop closed. Note that `.github/**` is inside the autobuild scope
fence, so the bot cannot edit workflows — that is deliberate; workflow changes
need a human with a Workflows-scoped token.

**Migration numbering.** Numbers must be unique per directory. On 2026-08-02 two
parallel agents both took `019` (`_change_summary` and `_duplicate_status`);
they were independent so the deploy's `ls | sort` order was harmless, but two
same-numbered files touching one object would apply in an order nobody chose.
`server/tests/migration-safety.test.js` now fails CI on duplicate numbers, and
every migration must be idempotent (that guard predates this, from PR #77).

## Submission 7 — build-train batch releases + GitHub-truth reconciliation

Approved by Mike 2026-08-03. Replaces per-PR mobile builds with a build train,
and makes the app's pipeline view a faithful mirror of GitHub rather than a
parallel ledger that drifts.

### Why: the drift is structural, not incidental

Every status callback in `deploy.yml` and `autobuild.yml` is `curl -sf ... || true`
(3 in each). A transient failure drops that transition PERMANENTLY — no retry,
nothing notices. Transitions also only exist if a workflow posts one, so a
cancelled, crashed or superseded run posts nothing, and `ci.yml`'s report job is
gated on a `Dev-Request-Id` trailer so hand-made PRs post nothing at all.

Push-only delivery + best-effort + no reconciler = guaranteed drift. That is
what made "Rebuild build-pipeline screen" read in-flight 16 h after it shipped,
and merged rows read failed. **Correctness must never depend on delivery.**

### The build train (mechanism — do not replace with a custom scheduler)

GitHub Actions concurrency already implements this. When a run enters a busy
concurrency group it goes *pending*, and **any previously pending run in that
group is cancelled**. With `cancel-in-progress: false` that yields exactly the
train:

- idle + mobile change lands -> runs immediately (zero latency)
- build running + N more merges -> each supersedes the previous pending run, so
  exactly ONE pending run survives
- build finishes -> the survivor starts, checks out current main HEAD, and
  therefore carries ALL accumulated changes
- nothing pending -> drains to idle

The batch window self-paces to build duration. One build at a time also
permanently removes the resubmit concurrency-bypass collision.

**Consequence that must be handled:** a superseded pending run never executes,
so its `report` job never fires and its row would sit in `deploying` forever.
Release grouping is therefore the completion mechanism, not garnish — the
release marks every carried request deployed.

### Reconciliation (the correctness backbone)

GitHub is read as truth; the DB is a projection. ONE pure `deriveState(pr,
checks, release) -> patch` is used by both the reconcile tick and (later)
webhooks, so the paths cannot disagree.

Tick (~60 s, beside `runDevBuildWorker`):
1. list PRs updated since a cursor (`state=all`, sorted by `updated`)
2. map PR -> request id from `headRefName` matching `^auto/dev-(<uuid>)$`,
   falling back to the `Dev-Request-Id` trailer. This is a STATELESS re-link:
   orphaned rows and orphaned PRs both recover from scratch.
3. derive: open -> `in_review`; merged + released -> `deployed` + `release_id`;
   merged, unreleased -> `deploying`; closed unmerged -> `superseded`; CI from
   the check suite
4. patch only on difference (no history spam)
5. upsert the matching `changes` row; pull the `work_item` stage along
6. orphan detection: `building` with no branch/PR after a grace period ->
   `needs_attention` with a real reason

**Precedence rule:** GitHub wins for anything GitHub knows about. Local-only
states (`pending`, `duplicate`, scope-fence `needs_attention`) survive only
while no PR exists. That is what stops a merged row reading failed.

**Webhooks are a latency optimisation, not the mechanism** (stage 6, optional).
Reconcile-first needs no new secret and no repo-settings change, and converges
even when delivery fails — which is today's actual bug.

### work_items sync is stages 1+2, not a separate task

Nothing writes `changes` or `releases` — grep every `.from(...)` in
`devPipeline.js` and only `work_items` is touched, at intake. `changes` is the
missing join between `work_items` and `dev_build_requests`. Populating it IS the
sync.

### Stages

| # | Scope | Gate |
|---|-------|------|
| 1 | Build train + releases grouping: `mobile-release.yml` (concurrency `mobile-release`), migration 022, `/dev/release/complete`, changelog "Build N — M changes" | touches `.github/**` -> direct PR, outside the autobuild fence |
| 2 | Reconciler: GitHub-as-truth tick, `deriveState`, `changes`/`work_items` projection, orphan detection, stale-row repair | server-only |
| 3 | Expedite flag: `expedite boolean`, dispatch under a UNIQUE concurrency group so it bypasses the train | trade-off: two concurrent EAS builds; EAS remote autoIncrement is atomic |
| 4 | Live status: broadcast reconciler transitions over the existing SSE (`registerSseClient` in `server/broadcast.js`) instead of polling | — |
| 5 | Merge queue (rebase+retest before landing) | **NEEDS MIKE**: Workflows-scoped token + branch-protection change. Do not attempt silently. |
| 6 | Optional GitHub webhooks (`pull_request`, `workflow_run`, `check_suite`) into the same `deriveState` | needs a webhook secret |

### Stage 1 — SHIPPED (build train + releases grouping)

Traceability id `21c1b312-156e-4bb3-9694-1eeafec20b46` (carried as a
`Dev-Request-Id` trailer on the commit, so the stage-2 reconciler adopts it).

What landed:

- **`.github/workflows/mobile-release.yml`** — the train. `concurrency: { group:
  mobile-release-<train|expedite id>, cancel-in-progress: false }`. The group is
  an expression so stage 3 only has to set the dispatch input; on a `push`,
  `github.event.inputs` is null and every build falls into the one `train` group.
- **`deploy.yml` no longer builds mobile.** Its `report` job also stops claiming
  `deployed` when the push touched `mobile/` — the server side is done but the
  change has not ridden a build yet, and saying otherwise is precisely the lie
  the app has been showing. It stays `deploying` until a release carries it.
- **Migration 022** — `releases` learns `run_id` (its natural key), `run_number`,
  `commit_sha`, `changelog`, `started_at`/`completed_at`, `platform`,
  `expedite_request_id`; `changes` finally gets `dev_request_id` (the join that
  was missing while the table sat empty) plus a nullable `work_item_id`;
  `dev_build_requests` gets `work_item_id`, `release_id`, `expedite`,
  `reconciled_at`, status `superseded` and source `github`.
- **`server/githubApi.js`** — one definition of how the control plane reads
  GitHub, shared by `devPipeline`, `devRelease` and (stage 2) the reconciler.
- **`server/devRelease.js` + tests** — `POST /dev/release/start` and
  `/dev/release/complete` (status-token auth, same as the other workflow
  callbacks). Both upsert on `run_id`, and `complete` re-derives the batch rather
  than trusting that `start` landed.

Two invariants worth keeping:

1. **Membership comes from git, not from what a workflow remembered to say.**
   The commits between the previous release's `commit_sha` and this one carry
   `Dev-Request-Id:` trailers and `(#123)` squash subjects, so the batch is
   always recomputable. With no previous release the base is the head commit
   alone: under-claiming is safe (stage 2 settles a merged change from its own
   Deploy run), over-claiming would stamp `release_id` onto changes the build
   never contained.
2. **A superseded pending run never executes and therefore never reports.** So
   completion cannot be "my own run finished" — it is "a release that carried me
   went live". `completeRelease` is what settles the whole batch, and it runs
   under `if: always()` so a failed build fails its batch instead of stranding it
   in `deploying` forever.

### Stage 2 — SHIPPED (GitHub-truth reconciler)

Traceability id `ba7765f8-a4b7-4f99-acbc-9d09d8cf4263`.

`server/devReconcile.js`, a 60 s tick beside `runDevBuildWorker`. It asks GitHub
what is true and patches the difference. Stateless by construction: it re-derives
everything every tick, so it repairs rows that drifted before it existed, rows
that drift while it is down, and rows nobody ever told it about.

**One derivation.** `deriveState()` is pure and is the only place a status is
decided. Stage 6's webhooks call the same function with the same argument shape,
so a webhook and a tick cannot disagree about the same PR.

| GitHub says | derived |
|---|---|
| no PR | nothing — local-only states survive |
| open, checks running | `in_review` |
| open, checks green | `merging` (waiting on auto-merge) |
| open, checks red | `failed` + `checks_status: failed` |
| closed, never merged | `superseded` |
| merged, Deploy run absent or running | `deploying` |
| merged, Deploy run success | `deployed` |
| merged, Deploy run failed | `failed` — **unless** a later successful main deploy carries it |
| merged, touches `mobile/` | `deploying` until a release carrying it is `live` |

**The rule that repairs the four stale rows.** `deploy.yml` deploys main
WHOLESALE — `railway up` from a fresh checkout, `psql` over every migration
file — so a later successful deploy of main means the earlier code is live no
matter what its own run concluded. `758e028b` (#62) and `a43d0e91` (#74) had
successful deploys and simply lost their callback; `cf741fe7` (#59) and
`08f6ba57` (#73) failed their own deploy on the old non-idempotent migration
AFTER the real work had succeeded. Both classes derive to `deployed`.

The same rule settles a run that was CANCELLED rather than failed — Deploy #103
(`63772c8e`, PR #109) was superseded while pending in the `deploy-main` group and
so reported nothing at all. That is the drift mechanism operating in the repo
today, not a hypothetical.

**Precedence.** GitHub wins for anything GitHub knows about. `pending`,
`duplicate` and a scope-fence `needs_attention` survive only while no PR exists —
they are decisions GitHub never saw.

**Adoption is how "every change is tracked" holds.** A PR with no row (a hand
edit, an agent branch, the PRs shipping this submission) gets one, `source =
'github'`, id reused from an `auto/dev-<uuid>` branch when there is one. Bounded:
14-day window, 5 adoptions per tick.

**Projection.** Each reconciled row upserts its `changes` row and pulls its
`work_item` stage along — that IS the work-items sync, and it is what finally
fills `changes`, empty since 018 because nothing wrote it. A row that already
agrees gets only `reconciled_at`, never a history entry.

**Orphans.** `building` with no branch and no PR after 30 minutes becomes
`needs_attention` with a real reason (the Autobuild run died before it could
push, so autobuild's own crash-net never fired).

Not gated on `DEV_PIPELINE_ENABLED`: repairing state is correct even while
dispatching is paused. `DEV_RECONCILE_ENABLED=false` is the kill switch.

### Traceability note

`dev_build_requests` is service-only RLS, so a chat session cannot insert rows
directly. The Railway server holds the service-role key and writes these tables,
so per-stage rows are created THROUGH a server path, and the stage-2 reconciler
adopts any `Dev-Request-Id`-trailered commit on its first tick. Every stage ends
up tracked either way.

The same fact is why the reconciler repairs the stale rows automatically: the
server can write them even though a chat session cannot.

## Incident 2026-08-03 — voice crash-loop postmortem (guards 7–11)

Voice was hard-dead from 2026-08-01 19:28 UTC to 2026-08-03 evening: PR #62
added `@server.prewarm` to agent/agent.py — an attribute that does not exist
on livekit-agents 1.6.2's AgentServer — so bb-agent crash-looped at import
and never registered with LiveKit. Five subsequent pipeline "fixes"
(#64/#75/#76/#85/#107) patched STT/transcript/audio layers without once
reading the agent's boot logs; the crash was the first five lines of
`railway logs --service bb-agent --lines 250`. Fix: directive request
`84c54095` (pure deletion of the block). Mike perceived the break as "around
PR 48" — the same morning's timeout regression (#49–#61) blurred into the
hard outage. What this exposed, continuing the guard catalog:

7. **Every target area ships gated or not at all.** agent/ had ZERO CI —
   required contexts covered only mobile and server, so an import-time crash
   merged green five more times. Guard: `agent (compile · import)` job in
   ci.yml + required context (this PR); platform rule for pipeline.yml — an
   area with no boot/import gate is not a valid build target. agent/tests/
   existed but never ran anywhere; they now run as a non-blocking job,
   promoted to required once green history exists.
8. **"Deploy green" must mean "process alive."** Railway restarted the
   crash-looping container for two days with zero signal into the pipeline.
   Guard (to build): post-deploy boot verification per service — bb-agent =
   "registered worker" line within N minutes, bb-server = /health 200 —
   failure auto-creates an exception card. Natural home: Submission 5's
   health-signal path.
9. **Runtime evidence before generated fixes.** Defect-report submissions
   produced five plausible-but-blind forward patches. Guard (to build): the
   triage path for "X is broken" reports must attach service logs / health
   signals to the work item BEFORE a builder is dispatched, and repetition
   root-cause items get an Investigator agent with log access — never a
   code-writing agent patching from the report text alone.
10. **Intake integrity end-to-end.** A repository_dispatch fired directly at
    autobuild (bypassing /dev/directive) produced an untracked, Dev-tab-
    invisible build (caught and cancelled same day, 2026-08-03). Guard (to
    build): autobuild's first step verifies the requestId has a
    dev_build_requests row via the status webhook; unknown ids abort before
    the agent runs.
11. **The human-exception surface is a product, not a page.** Decision
    (Mike, 2026-08-03): the platform's end state is every future app being
    continuously designed/developed from the front end of the user-facing
    app itself (dev mode first); anything requiring human dev involvement —
    PRs, issues, escalations, exception cards — lands in a dedicated backend
    web admin site (to be built). Today's /admin console and the Dev tab are
    its seeds; exception cards (Submission 3) and that site are the same
    surface at different maturities. Spec it as its own numbered submission
    once Submissions 4–6 land.

## Next actions

1. Mike: run the duplicate-submission test above from the app. It is now a real
   gate — expect NO redundant build and an "Already tracked" alert naming the
   existing item.
2. Dispatch Submission 3 (pipeline screen rebuild) after that passes.
3. Submissions 4 -> 5 -> 6 in order; before 6, verify dispatch-metadata cap
   behaviour (promptGuard.js) still holds with the card context block.
4. Stale rows `758e028b` (PR #62, build 72), `08f6ba57` (PR #73), `a43d0e91`
   (PR #74, build 79), `cf741fe7` (PR #59) still read failed / needs_attention
   for work that actually shipped — an artifact of the old non-idempotent
   migration failing the deploy job AFTER the real work succeeded. Submission 7
   stage 2's reconciler repairs these automatically on its first tick (the
   server holds the service-role key); no manual key handover needed.
5. Store the Supabase service-role key as a GitHub Actions secret and confirm it
   in Railway env, so no future session needs it handed over:
   `gh secret set SUPABASE_SERVICE_ROLE_KEY --repo strangepair/BattleBuddy < <file>`.
   A chat session should not upload it on Mike's behalf — this key bypasses RLS
   entirely, so widening its blast radius is a human decision.
6. Rotate the tokens named in "Access / operational notes" above (still
   outstanding from 2026-08-01), plus the leaked DB password.
7. Audit why auto-merge branch deletion left 45 stale branches.
8. When app #2 onboards: extract control plane to its own repo, move bot
   identity from PATs to a GitHub App, define pipeline.yml manifest.
9. DONE 2026-08-03 21:0x UTC: voice-fix 84c54095 deployed (PR #115, agent
   re-registered with LiveKit 20:57:39Z), agent-CI-gate PR #116 merged, and
   `agent (compile · import)` added to required contexts. Found in passing:
   agent/tests/test_deduplication.py imports `agent.utils`, which has never
   existed (PR #101 wrote tests against an imagined module layout) — repair
   before promoting the pytest job to required.
10. Submit directives for guards 8–10 (post-deploy boot verification,
    evidence-first root cause, intake verification) after the queue clears
    the parked menu-cut item (559ffc0c — restore to pending post-voice-fix).
11. Promote `agent tests (pytest · non-blocking)` to a required context once
    it shows a green history on real PRs.
