# PIPELINE-STATE

Source of truth for the Developer-mode pipeline's evolution into a general
"continuous innovation" framework. Any actor — Mike, a Claude chat session,
or a headless pipeline agent — should be able to resume from this file alone.
Update this file whenever a numbered submission lands or a decision changes.

Last updated: 2026-08-02 ~00:30 UTC (Claude chat session, working with Mike).

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
| 3 | Pipeline screen rebuild: work-item cards, release groups, AI digest, exception cards ("Needs your input", default + deadline), Plumbing view behind DEV toggle | PENDING — dispatch next |
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

## Next actions

1. Mike: run the duplicate-submission test from the app (resubmit a known
   symptom) — expected: stored instantly, classified duplicate, attached as
   evidence, NO build dispatched, response names the existing item.
2. Dispatch Submission 3 (pipeline screen rebuild) after test passes.
3. Submissions 4 → 5 → 6 in order; before 6, verify dispatch-metadata cap
   behavior (promptGuard.js) still holds with the card context block.
4. Optional forensics: Railway bb-server logs 2026-08-01 22:45–23:20 UTC
   for the old intake failure.
5. Audit why auto-merge branch deletion left 45 stale branches.
6. Rotate the tokens named above.
7. When app #2 onboards: extract control plane to its own repo, move bot
   identity from PATs to a GitHub App, define pipeline.yml manifest.
