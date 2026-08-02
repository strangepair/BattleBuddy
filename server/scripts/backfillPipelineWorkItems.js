/**
 * One-time backfill: creates one work_item per dev_build_requests row whose
 * status is not 'deployed', 'archived', or 'failed' — i.e. the current active
 * queue — so the new pipeline tables reflect the real state on day one.
 *
 * Safe to re-run: looks for existing work_items whose title + subsystem match
 * before inserting, so running it twice does not create duplicates.
 *
 * Usage: node server/scripts/backfillPipelineWorkItems.js
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '..', '.env');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
} catch {}

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket },
});

// Map dev_build_requests.target → work_items.subsystem
function targetToSubsystem(target) {
  switch (target) {
    case 'ui': return 'dashboard';
    case 'backend': return 'pipeline';
    case 'agent': return 'voice';
    case 'prompt': return 'other';
    default: return 'other';
  }
}

// Skip statuses that represent the terminal / done states of the old table.
const SKIP_STATUSES = new Set(['deployed', 'failed', 'archived']);

async function run() {
  console.log('[backfillPipelineWorkItems] fetching active dev_build_requests...');

  const { data: requests, error: fetchErr } = await supabase
    .from('dev_build_requests')
    .select('id, title, description, target, status, created_at, archived')
    .order('created_at', { ascending: true });

  if (fetchErr) {
    console.error('[backfillPipelineWorkItems] fetch error:', fetchErr.message);
    process.exit(1);
  }

  const active = (requests || []).filter(
    (r) => !r.archived && !SKIP_STATUSES.has(r.status),
  );

  console.log(`[backfillPipelineWorkItems] ${active.length} active request(s) to backfill`);

  if (active.length === 0) {
    console.log('[backfillPipelineWorkItems] nothing to do');
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const req of active) {
    const subsystem = targetToSubsystem(req.target);

    // Check for an existing work_item with the same title + subsystem to avoid
    // creating duplicates when the script is re-run.
    const { data: existing } = await supabase
      .from('work_items')
      .select('id')
      .eq('title', req.title.slice(0, 200))
      .eq('subsystem', subsystem)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[backfillPipelineWorkItems] skip (exists): "${req.title.slice(0, 60)}"`);
      skipped++;
      continue;
    }

    const { error: insErr } = await supabase.from('work_items').insert({
      title: req.title.slice(0, 200),
      interpretation: (req.description || req.title).slice(0, 500),
      subsystem,
      stage: 'building',
      created_at: req.created_at,
      updated_at: new Date().toISOString(),
    });

    if (insErr) {
      console.error(`[backfillPipelineWorkItems] insert error for "${req.title.slice(0, 60)}":`, insErr.message);
    } else {
      console.log(`[backfillPipelineWorkItems] created work_item for: "${req.title.slice(0, 60)}"`);
      created++;
    }
  }

  console.log(`[backfillPipelineWorkItems] done — created=${created} skipped=${skipped}`);
}

run().catch((err) => {
  console.error('[backfillPipelineWorkItems] fatal:', err.message);
  process.exit(1);
});
