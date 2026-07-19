# Deploy runbook — memory & recall release

Branch `feat/memory-recall-v1`. Commits `6fd4003` (Phases 0–3) + `66395b9` (Phase 4).
Server-side only — no mobile build, no TestFlight.

## What ships

| | |
|---|---|
| Prompt caching | ~95% of the system prompt cached; first-token latency |
| Two-tier memory | a promoted set injected every turn, greeting included |
| Promotion loop | recall frequency promotes memories automatically (nightly) |
| Grounded greeting | opening line uses a real time-gap + a durable fact |
| Inferred commitments | **OFF** unless `COMMITMENTS_ENABLED=true` |

## Ordering that matters

- **Migrations run in order: 009 → 010 → 011.** 010 and 011 depend on 009. All additive
  (add column / new table); the code tolerates their absence with logged fallbacks, so
  code-before-migration is safe, but apply them the same day to avoid confusion.
- **`COMMITMENTS_ENABLED` stays unset** for this deploy. Everything else is live-safe on day one.

---

## Step 0 — Pre-flight (local, automatable)

```
cd server && npm test          # must be green (43 tests)
git status --short             # must be clean
git log --oneline -2           # 66395b9, 6fd4003
grep -c COMMITMENTS_ENABLED .env* 2>/dev/null || echo "flag unset — correct"
```

## Step 1 — Push the branch

```
git push -u origin feat/memory-recall-v1
```

Open a PR or merge per your normal flow. Nothing is deployed yet.

## Step 2 — Reconcile prod prompt drift  ⚠️ human judgment

`DECISIONS.md` 2026-07-08: prod-applied prompt edits live on the Railway volume and are not
in git until folded in. This release edits `server/prompts/system.battlebuddy.md` (moved one
placeholder, added the promoted-memory + check-in blocks). **If prod diverged, reconcile before
deploy** — the cache split keys off the `## Runtime context` marker, and a prod copy that moved
or renamed it will silently run uncached (the code falls back safely, but you lose the win).

- Fetch the prod copy: `GET /context/...` isn't it — the prompt file is on the volume. Pull it
  from the running container (Railway shell / volume mount) or the admin console if it surfaces there.
- Diff against this branch's `server/prompts/system.battlebuddy.md`.
- If prod has design-loop edits not in git, fold them into the branch's static (persona) section
  — above `## Runtime context` — then re-run `npm test` (the template test will catch a broken
  placeholder), commit, and re-push.

## Step 3 — Apply migrations, in order

Via Supabase SQL Editor (per project convention), paste and run each in sequence:

1. `server/migrations/009_memory_promotion.sql`
2. `server/migrations/010_memory_recall_signals.sql`
3. `server/migrations/011_commitments.sql`

Verify after each:

```sql
-- after 009
select column_name from information_schema.columns
  where table_name='user_memories' and column_name in ('promoted','promoted_at');
-- after 010
select proname from pg_proc where proname='record_memory_recalls';
-- after 011
select tablename from pg_tables where tablename='user_commitments';
```

## Step 4 — Deploy bb-server to Railway

Deploy the branch (or merged main) per your normal Railway flow. Confirm boot:

```
BattleBuddy API running on http://0.0.0.0:<port>
```

## Step 5 — Verify caching is live

In Railway logs, after any two conversation turns, look for:

```
[Cache] read=<N>  write=<M>  uncached=<K>
```

- Turn 1 writes the cache (`write` > 0, `read` = 0).
- Turn 2+ should show **`read` > 0**. If `read` stays 0 across turns, a per-turn value crept
  above the split — most likely a prod prompt that moved the marker (Step 2). The code is
  correct either way; this is a "did the win land" check.

## Step 6 — Watch promotion fill (over ~a week)

The promoted tier starts empty and fills as recall evidence accrues. The nightly sweep logs:

```
[Promotion] Sweep finished: <n> promoted from <c> candidates across <u> users
```

Effective bar is ~5 recalls across ~a week, so expect **zero promotions for the first several
days** — that is correct, not a bug. Spot-check:

```sql
select count(*) from user_memories where promoted;
select recall_count, count(*) from user_memories where recall_count>0
  group by recall_count order by recall_count desc;
```

---

## Enabling commitments — later, deliberately

Do **not** do this during the initial deploy. When ready:

1. Set `COMMITMENTS_ENABLED=true` on bb-server, redeploy.
2. Let a few real sessions end, then inspect what was inferred **before** trusting delivery:
   ```sql
   select kind, summary, confidence, due_after, status
     from user_commitments order by created_at desc limit 20;
   ```
3. Read them as Mike would: are these follow-ups you'd actually want BB to raise? Any that
   read as intrusive, or that touch a slip? If the quality isn't there, set the flag back off
   and tune the extraction prompt (`COMMITMENT_EXTRACTION_PROMPT` in `commitments.js`) — the
   gate is deliberately conservative, so the failure mode should be "too few," not "wrong ones."
4. Delivery is via the voice greeting only in v1 — a due commitment becomes the reason to open
   a session, phrased by BB in its own words. It never appears in a push notification.

## Rollback

- **Migrations**: additive only — no down-migration needed. Leaving the columns/table in place
  is harmless if you revert the code (the old code never reads them).
- **Code**: redeploy the prior commit (`9124777`).
- **Commitments**: unset `COMMITMENTS_ENABLED` and redeploy — inference and delivery both stop
  immediately; queued rows simply never deliver.
