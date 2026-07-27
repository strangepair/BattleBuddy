# Developer Mode → Autonomous Build & Deploy Pipeline

Talk to BattleBuddy with **Developer mode** on, and the conversation is captured,
turned into product requests, implemented, PR'd, merged, and deployed —
automatically. This doc is the operator's guide: how it works, what's wired, and
the one-time secrets needed to turn it on.

## How it works

Two planes:

- **Control plane** — the Node backend (`server/devPipeline.js`, routes under
  `/dev/*`). Captures dev-mode transcripts (`POST /dev/capture`) and typed
  directives (`POST /dev/directive`), converts them to structured product
  requests with Claude Sonnet, stores them in Supabase (`dev_build_requests`),
  and serves the app's Dev tab (`GET /dev/requests`). A 60-second worker
  (`runDevBuildWorker`) dispatches `pending` requests to GitHub.
- **Execution plane** — GitHub Actions:
  - `.github/workflows/autobuild.yml` (on `repository_dispatch: dev_build`) —
    headless Claude Code implements the change on `auto/dev-<id>`, the diff is
    scope-fenced, a PR is opened, and (unless dry-run) auto-merge is enabled.
  - `.github/workflows/ci.yml` (on PR) — typecheck/lint/test. The required
    green-gate for auto-merge; reports pass/fail back to the backend.
  - `.github/workflows/deploy.yml` (on push to `main`) — path-filtered deploys
    to Railway (server/agent), Supabase (migrations), and EAS→TestFlight
    (mobile), then reports `deployed`.

Status surfaced in the Dev tab: **Pending development → Under development →
Deploying → Deployed**, plus **Failed** / **Needs attention**.

## Safety rails (automated, not human gates)

- Auto-merge only completes when `ci.yml` passes (branch protection).
- The coding agent is **scope-fenced**: `autobuild.yml` refuses any diff that
  touches `.github/**`, `eas.json`, signing/secret material, or that would drop
  the `988` / `## Hard limits` block from the system prompt → the request is
  marked `needs_attention` instead.
- Destructive migrations (`DROP/TRUNCATE/DELETE`) are refused by `deploy.yml`.
- The spec generator drops low-confidence / non-actionable items and anything
  that smells of a protected area.
- Rate limits: `DEV_MAX_CONCURRENT` (default 2), `DEV_MAX_PER_DAY` (default 20).
- Kill switch: `DEV_PIPELINE_ENABLED` env + `POST /dev/pause` (admin).
- Dry run: `DEV_PIPELINE_DRYRUN=true` opens PRs but never auto-merges/deploys.

## Activation checklist

**1. GitHub repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Used by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | autobuild | headless Claude Code |
| `BB_PAT` | autobuild | fine-grained PAT used to open the PR + enable auto-merge. **Must not be the built-in `GITHUB_TOKEN`** — GitHub does not trigger workflows from events it raises, so a PR opened with it never runs `ci.yml` and can never satisfy the green gate. Same PAT as the backend's `GITHUB_TOKEN`. |
| `BB_SERVER_URL` | all | backend base URL for status callbacks (the Railway URL) |
| `BB_STATUS_WEBHOOK_TOKEN` | all | authenticates callbacks → `/dev/github/webhook` |
| `RAILWAY_TOKEN` | deploy | Railway CLI deploy. Must be a **project token** (Project → Settings → Tokens), not an account token: `deploy.yml` runs `railway up` with no `railway link` step, so the project/environment can only be resolved from the token itself. |
| `SUPABASE_DB_URL` | deploy | Postgres connection string for migrations (`psql`) |
| `EXPO_TOKEN` | deploy | EAS build/submit |
| `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | deploy | App Store Connect API key for TestFlight submit |

**2. GitHub repository variables:**

| Variable | Value | Purpose |
|---|---|---|
| `DEV_PIPELINE_AUTOMERGE` | `true` | enable full autonomy (auto-merge on green) |
| `RAILWAY_SERVICE_SERVER` | e.g. `bb-server` | Railway service name for the backend |
| `RAILWAY_SERVICE_AGENT` | e.g. `bb-agent` | Railway service name for the voice agent |

**3. Branch protection** on `main`: require the two status checks from `ci.yml`,
and enable auto-merge in repo settings (`allow_auto_merge`) or `gh pr merge
--auto` fails.

Required check *contexts* are the jobs' display names, not their job ids —
requiring `mobile`/`server` would wait forever on contexts that never report:

- `mobile (typecheck · lint · test)`
- `server (node --test)`

(the separator is a middle dot, U+00B7)

**4. Backend (Railway) env:**

| Var | Value |
|---|---|
| `GITHUB_TOKEN` | fine-grained PAT: contents, pull-requests, workflows, actions |
| `GITHUB_REPO` | `strangepair/BattleBuddy` |
| `BB_STATUS_WEBHOOK_TOKEN` | same value as the GitHub secret |
| `DEV_PIPELINE_ENABLED` | `true` when ready (start with `DEV_PIPELINE_DRYRUN=true`) |

**5. Mobile build env** (EAS profile): `EXPO_PUBLIC_DEV_MODE_AVAILABLE=1` to show
the toggle in that build.

**6. Apply the migration** `server/migrations/012_dev_build_requests.sql`.

## Bring-up sequence

1. Apply the migration; set backend env with `DEV_PIPELINE_DRYRUN=true`.
2. In the app: Preferences → Developer mode on → Dev tab → submit a tiny
   directive ("make the greeting warmer"). Confirm a real PR opens with green CI.
3. Flip `DEV_PIPELINE_AUTOMERGE=true` and drop `DEV_PIPELINE_DRYRUN`; submit the
   same directive and confirm it auto-merges and deploys, and the Dev tab reaches
   **Deployed**.
4. Rails check: submit a directive that tries to edit `eas.json` or the crisis
   off-ramp → expect **Needs attention**, no PR merged.

## Account topology (as of 2026-07-26)

Code and CI live on GitHub under **strangepair**; the Railway project lives under
the **codegrad** workspace. This split is fine — every cross-plane hop is a
token-mediated HTTPS call, and `railway up` uploads the runner's checked-out
strangepair tree, so deploys carry the right code regardless of which repo
`bb-server` is nominally connected to (its `rootDirectory` is `/server`, so the
repo-root upload still builds `server/Dockerfile`).

Two caveats:

- `bb-server`'s build source is still the stale `codegrad/BattleBuddy` (frozen,
  4 commits behind). Deploys bypass it, but Railway still watches it — a push
  there would auto-deploy old code over the pipeline's deploy, a silent
  production rollback. Recommend disconnecting the source so the service is
  CLI-deploy-only.
- `bb-agent` has no source and no root directory, but `agent/Dockerfile` expects
  the **repo root** as build context. A `railway up` from the repo root finds no
  Dockerfile at the upload root and Railpack would misdetect the root
  `package.json`. Pin `dockerfilePath: agent/Dockerfile` before any directive
  targets `agent/**`.

## Notes / validation surface

The three deploy jobs (Railway CLI, `psql` migrations, EAS submit) run on
GitHub's runners and depend on the exact CLI flags/service names for your
accounts; validate them during the dry-run bring-up. The `anthropics/claude-code-base-action@beta`
input names are pinned to `@beta` — pin a release and adjust inputs if it drifts.
