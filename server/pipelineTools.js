/**
 * Pipeline CRUD tools — the agent's durable control surface over the dev
 * pipeline.
 *
 * Why this exists: "I'll flag this as a PR request" was empty narration. The
 * model had no tool that filed anything, so a build ask spoken in dev mode
 * produced a warm acknowledgment and no row. This module gives that sentence a
 * body — and returns the id and title so the reply can name what was filed
 * instead of promising it.
 *
 * ── Two hard rules this module exists to respect ────────────────────────────
 *
 * 1. NO DIRECT WRITES. Every operation routes through the governed functions in
 *    devPipeline.js (durable-first intake, double-post guard, dedupe/park, the
 *    resubmit plan, breaker reset, history lines). The pipeline's invariant is
 *    "nothing vanishes"; a tool that inserted rows itself would be the one
 *    caller able to break it. The cautionary tale is already in the tree:
 *    /api/dev-items inserts with source 'agent_tool', which migration 022's
 *    dev_build_requests_source_check (transcript | directive | github |
 *    design-loop) rejects — so every call through it fails at the database.
 *    create_pipeline_item goes through the /dev/directive path, which files
 *    under 'directive'.
 *
 * 2. NO MODULE-SCOPE CLIENT CONSTRUCTION. Everything here is a pure function
 *    over injected `supabase` / `anthropic` handles. A top-level createClient()
 *    that throws during ESM evaluation kills the process before index.js's
 *    uncaughtException handler is even registered — the exact class of bug the
 *    container-boot CI gate was added to catch. This file must stay importable
 *    with no environment at all.
 */

import {
  createPipelineItem,
  listPipelineItems,
  getPipelineItem,
  resubmitPipelineItem,
  cancelPipelineItem,
  expeditePipelineItem,
} from './devPipeline.js';

/** Actions update_pipeline_item accepts, mapped to their governed function. */
export const PIPELINE_ACTIONS = ['retry', 'resubmit', 'cancel', 'expedite'];

export const PIPELINE_TOOLS = [
  {
    name: 'create_pipeline_item',
    description:
      "File a new dev-pipeline build request (a PR/feature/bug/change ask) so it is durably recorded and picked up by the build worker. Call this the MOMENT the developer asks for a product change while developer mode is on — do not merely say you'll flag it, and do not wait for confirmation. Pass their ask in their own words; the server writes the raw text down first, then generates the spec, so nothing is lost even if generation fails. Returns the created item(s) with id, title and status — tell the developer what was filed, by title, and never claim something was filed without a successful result from this tool. If it comes back deduped or duplicate, say plainly that the work was already tracked rather than implying a new item was created.",
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            "The change being asked for, in the developer's own words — the fuller the better (what should change, where, and why). E.g. 'The mission dashboard calendar should scroll to the current hour on open.'",
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_pipeline_items',
    description:
      "List recent dev-pipeline build requests and their statuses — use for 'what's in flight?', 'what's the pipeline doing?', 'anything failing?', 'what shipped?'. Returns items with id, title, status, PR number and error. Statuses: pending (queued), building, in_review, merging, deploying, deployed (shipped), failed, needs_attention (needs a human), duplicate/superseded (closed). Quote what this returns; never guess pipeline state from memory.",
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            "Optional status filter — one status or several comma-separated, e.g. 'failed' or 'pending,building,in_review'. Use 'pending,building,in_review,merging,deploying' for what is genuinely in flight. Omit for the most recent items across all statuses.",
        },
        limit: {
          type: 'integer',
          description: 'Max items to return (default 25, max 100). Keep it small — this goes into the conversation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_pipeline_item',
    description:
      "Get the full detail of one pipeline item by id — status, target, description, PR link, error text, attempt count and history. Find the id with list_pipeline_items first. Use when the developer asks what happened to a specific change or why one failed.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the pipeline item, from list_pipeline_items.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_pipeline_item',
    description:
      "Act on an existing pipeline item: retry/resubmit a failed one, cancel one that should not ship, or expedite one past the build train. Find the id with list_pipeline_items first, and say what you did and what the item is now. These are real state changes on the build pipeline — take the action the developer actually asked for, and report an error result honestly rather than claiming success.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the pipeline item, from list_pipeline_items.' },
        action: {
          type: 'string',
          enum: PIPELINE_ACTIONS,
          description:
            "'retry' / 'resubmit' — re-run a failed or needs_attention item (only those two statuses are retryable; the server picks between re-running the deploy and rebuilding). 'cancel' — stop it terminally and archive it, so the worker will not dispatch it. 'expedite' — flag it to bypass the mobile build train and build alone when it reaches the release stage.",
        },
        note: {
          type: 'string',
          description:
            "Optional short reason, recorded in the item's permanent history — e.g. 'flaky CI, cause fixed' or 'superseded by the calendar rework'. Include it whenever the developer gives a reason.",
        },
      },
      required: ['id', 'action'],
    },
  },
];

export const PIPELINE_TOOL_NAMES = new Set(PIPELINE_TOOLS.map((t) => t.name));

/** Fields worth showing the model. The full row carries spec blobs and history
 * arrays that would crowd out the actual answer — the 128 KB tool-payload
 * poisoning that buried real numbers on 2026-07-29 started exactly this way. */
function slimItemForModel(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    target: r.target,
    pr_number: r.pr_number ?? null,
    pr_url: r.pr_url ?? null,
    error: r.error ? String(r.error).slice(0, 300) : null,
    attempts: r.attempts ?? 0,
    expedite: r.expedite ?? false,
    archived: r.archived ?? false,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Translate a createPipelineItem() result into what the model is told.
 *
 * Pure and exported because this mapping is the honesty-critical part of the
 * whole tool: "filed", "already tracked" and "parked for review" are three
 * different real outcomes, and the failure mode this tool exists to kill is a
 * reply that rounds the last two up to the first. Kept separate from the I/O so
 * it can be tested exhaustively without standing up the pipeline.
 */
export function mapCreateResult({ status, body = {} }) {
  const items = (body.requests || []).map(slimItemForModel);

  // Anything >= 400 means the text was PARKED, not built: still durable, still
  // visible in the Dev tab, but no build request exists.
  if (status >= 400) {
    return {
      content: {
        ok: false,
        parked: items.length > 0,
        items,
        error: body.error || 'could not file that',
        reason: body.reason || null,
        meaning:
          'This was NOT turned into a build request. The raw wording was saved for review so it is not lost. Say that plainly — do not tell the user it is being built.',
      },
      is_error: true,
    };
  }

  if (body.duplicate || body.deduped) {
    return {
      content: {
        ok: true,
        filed: false,
        duplicate: true,
        items,
        message: body.message || 'Already tracked — no new work was created.',
        meaning: 'Tell the user this was already tracked; do NOT imply a new item was created.',
      },
    };
  }

  return {
    content: {
      ok: true,
      filed: true,
      count: items.length,
      items,
      meaning: 'Filed durably. Name the item(s) by title and status in your reply.',
    },
  };
}

/**
 * Run one pipeline tool.
 *
 * @param {string} name
 * @param {object} input
 * @param {{supabase: object|null, anthropic: object|null, userId: string|null,
 *          sessionId: string|null, devMode: boolean}} deps
 * @returns {Promise<{content: object, is_error?: boolean}>}
 */
export async function executePipelineTool(name, input = {}, deps = {}) {
  const { supabase, anthropic, userId = null, sessionId = null, devMode = false } = deps;

  // Dev-mode gate. The pipeline is developer machinery, not user-facing
  // product: a normal coaching conversation must never be able to file build
  // requests or cancel work. Same live flag check_dev_mode reports, and the
  // message tells the model exactly what to say rather than leaving it to
  // invent an explanation for the refusal.
  if (devMode !== true) {
    return {
      content: {
        error: 'developer_mode_off',
        meaning:
          'Developer mode is OFF for this turn, so pipeline tools are unavailable. Tell the user to flip the DEV toggle on the chat screen — nothing is filed or changed while it is off. Do not claim anything was filed.',
      },
      is_error: true,
    };
  }

  if (!supabase) {
    return { content: { error: 'Pipeline store unavailable' }, is_error: true };
  }

  if (name === 'create_pipeline_item') {
    const text = (input.text || '').toString().trim();
    if (!text) return { content: { error: 'text is required' }, is_error: true };

    return mapCreateResult(await createPipelineItem(supabase, anthropic, { text, userId, sessionId }));
  }

  if (name === 'list_pipeline_items') {
    const limit = Math.min(Math.max(parseInt(input.limit, 10) || 25, 1), 100);
    const { body } = await listPipelineItems(supabase, { status: input.filter || null, limit });
    return {
      content: {
        total: body.total ?? 0,
        pipeline_enabled: body.enabled ?? false,
        dry_run: body.dryRun ?? false,
        items: (body.requests || []).map(slimItemForModel),
      },
    };
  }

  if (name === 'get_pipeline_item') {
    if (!input.id) return { content: { error: 'id is required' }, is_error: true };
    const { status, body } = await getPipelineItem(supabase, input.id);
    if (status !== 200) return { content: { error: body.error || 'not found' }, is_error: true };
    const r = body.request;
    return {
      content: {
        ...slimItemForModel(r),
        description: r.description ? String(r.description).slice(0, 1200) : null,
        source: r.source,
        branch: r.branch ?? null,
        deploy_status: r.deploy_status ?? null,
        failure_class: r.failure_class ?? null,
        next_retry_at: r.next_retry_at ?? null,
        changeSummary: r.changeSummary ?? null,
      },
    };
  }

  if (name === 'update_pipeline_item') {
    const { id, action, note = null } = input;
    if (!id || !action) return { content: { error: 'id and action are required' }, is_error: true };
    if (!PIPELINE_ACTIONS.includes(action)) {
      return {
        content: { error: `action must be one of: ${PIPELINE_ACTIONS.join(', ')}` },
        is_error: true,
      };
    }

    // retry and resubmit are the same governed operation — the model reaches
    // for both words, and forcing it to guess which one this pipeline calls it
    // would just produce failed tool calls.
    const run = {
      retry: resubmitPipelineItem,
      resubmit: resubmitPipelineItem,
      cancel: cancelPipelineItem,
      expedite: expeditePipelineItem,
    }[action];

    const { status, body } = await run(supabase, id, note);
    if (status !== 200) {
      // 409 is the interesting one: the action was refused because the item is
      // in a state that does not allow it (e.g. resubmitting something already
      // deployed). That is a real answer, not a malfunction — say it.
      return {
        content: { ok: false, error: body.error || 'action failed', refused: status === 409 },
        is_error: true,
      };
    }
    return {
      content: {
        ok: true,
        action,
        id,
        plan: body.plan || null,
        item: body.item ? slimItemForModel(body.item) : null,
        expedite: body.expedite ?? undefined,
      },
    };
  }

  return { content: { error: `Unknown pipeline tool: ${name}` }, is_error: true };
}
