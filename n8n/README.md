# Content Video Batch Pipeline

n8n workflow that generates the AI video library for the home screen's
swipe-right content feed: Claude writes per-theme prompts, Runway renders the
clips, Cloudflare R2 stores them, and Supabase catalogues the results for the
mobile app to query.

## 1. Run the Supabase migration first

```sh
psql "$SUPABASE_DB_URL" -f ../server/migrations/005_content_videos.sql
```

Or paste the file contents into the Supabase SQL Editor. This creates the
`content_videos` table the workflow writes to — the workflow will fail on
every "Save to Supabase" / "Log Failure to Supabase" node until this exists.

## 2. Required environment variables

Set these in n8n (Settings → Environment Variables, or your n8n host's env)
before running the workflow:

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Generating per-theme video prompts via Claude (Messages API) |
| `RUNWAY_API_KEY` | Generating video clips via Runway Gen-3 Alpha Turbo |
| `CF_ACCOUNT_ID` | Building the R2 S3-compatible endpoint (used in the R2 credential, not directly in node params) |
| `CF_R2_PUBLIC_URL` | Public base URL for the R2 bucket, used to build `r2_url` rows in Supabase |
| `SUPABASE_URL` | Supabase project REST URL (e.g. `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key — needed to insert past RLS |

The R2 upload itself uses an n8n **S3 credential** (R2 is S3-compatible), not
an env var on the node — see step 4 below.

## 3. Import the workflow

1. In n8n: **Workflows → Import from File** → select `content-video-pipeline.json`.
2. n8n will create all 21 nodes and connections as-is — nothing needs to be
   rewired, but two things need configuring post-import (steps 4–5).
3. Set the workflow as its own **Error Workflow** (Workflow Settings → Error
   Workflow → select this workflow) so the `Error Trigger` node fires on
   unhandled node failures and logs a `status: 'failed'` row to Supabase.

## 4. Configure the R2 credential

The **Upload to R2** node uses n8n's built-in S3 node type pointed at
Cloudflare R2's S3-compatible endpoint. Create a credential named
`Cloudflare R2 (S3-compatible)`:

- **Endpoint**: `https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com`
- **Region**: `auto`
- **Access Key ID**: `CF_R2_ACCESS_KEY`
- **Secret Access Key**: `CF_R2_SECRET_KEY`
- **Force Path Style**: enabled

Then assign it on the **Upload to R2** node (it's referenced by name on
import; n8n will prompt you to bind it to a real credential).

## 5. Run it

- **Manual test**: trigger via the `Manual Trigger` node (Test Workflow).
- **Scheduled**: the `Schedule Trigger` node runs daily at 2am server time —
  active as soon as the workflow is activated.

The workflow loops: 10 themes × `VIDEOS_PER_THEME` (default 3) prompts each
→ ~30 videos per run. Adjust `VIDEOS_PER_THEME` or the `THEMES` array in the
**Set Config** node to change batch size — themes should stay in sync with
[`../content/video-themes.md`](../content/video-themes.md).

## How it works

1. **Set Config** — fixes `VIDEO_API` (`runway`), `VIDEOS_PER_THEME`, and the `THEMES` list for the run.
2. **Split By Theme** loops one theme at a time into **Generate Prompts (Claude)**, which asks `claude-haiku-4-5-20251001` for `VIDEOS_PER_THEME` cinematic prompts and returns them as JSON.
3. **Parse Claude Response** extracts the JSON array; **Split By Prompt** loops one prompt at a time.
4. **Generate Video (Runway)** kicks off a **Gen-3 Alpha Turbo** `text_to_video` job (5s, 9:16 portrait `768:1344`) against `api.dev.runwayml.com` and stores the task ID.
5. **Wait 30s → Poll Video Status → Read Poll Status** checks the task status. This is a quality-first batch job (runs offline overnight), so the poll loop is patient: Runway jobs typically resolve in 60–90s, but the loop tolerates up to **10 retries at a 30s interval** (~5.5 minutes total) before giving up on a single video — **Increment Attempt → Check Retry Limit** tracks the count across loop iterations.
6. On `SUCCEEDED`: **Download Video → Upload to R2 → Save to Supabase** (status `active`), then **Wait Between Videos** (5s, rate-limit friendly) before looping to the next prompt.
7. On `FAILED` (Runway-reported) or retry-limit exhaustion (timeout): **Log Failure to Supabase** writes a `status: 'failed'` row — including the last known status and poll-attempt count in `r2_key` for debugging — and the loop continues to the next prompt.
8. Any unhandled node error anywhere in the run is caught by **Error Trigger → Log Critical Failure**.

## Estimated cost per run

Runway Gen-3 Alpha Turbo pricing is roughly **$0.05/second** of generated
video.

```
10 themes × 3 videos/theme = 30 videos
30 videos × 5 seconds × $0.05/sec ≈ $7.50/batch
```

Claude Haiku prompt-generation calls (10 requests/run, ~1K output tokens
each) add well under $0.05/run and are not the cost driver. Adjust
`VIDEOS_PER_THEME` to scale spend linearly — e.g. 5 videos/theme ≈ $12.50/batch.
