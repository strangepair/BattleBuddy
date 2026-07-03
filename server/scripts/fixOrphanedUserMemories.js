/**
 * One-time repair: the now-removed /admin/backfill-transcripts endpoint
 * (added in 56bbc7b, removed in 3edbec7) wrote rows to `user_memories` with
 * whatever raw directory name it found on disk, bypassing resolveUserId().
 * Any transcripts filed under an old/aliased user ID are invisible to
 * retrieveRelevant(), which always queries under the canonical ID.
 *
 * This re-keys those orphaned rows to their canonical user_id so BB can
 * find them again. Safe to re-run — it's a no-op once everything is
 * canonical.
 *
 * Usage: node server/scripts/fixOrphanedUserMemories.js
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { resolveUserId } from '../contextAgent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '..', '.env');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
} catch {}

export async function runRepair() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[Repair] SUPABASE_URL / SUPABASE_SERVICE_KEY not set, aborting');
    return { checked: 0, fixed: 0 };
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    realtime: { transport: WebSocket },
  });

  const { data: rows, error } = await supabase
    .from('user_memories')
    .select('user_id')
    .neq('user_id', '');
  if (error) {
    console.error('[Repair] Failed to read user_memories:', error.message);
    return { checked: 0, fixed: 0 };
  }

  const distinctUserIds = [...new Set((rows || []).map(r => r.user_id))];
  console.log(`[Repair] Found ${distinctUserIds.length} distinct user_id value(s)`);

  let fixed = 0;
  for (const rawId of distinctUserIds) {
    const canonicalId = resolveUserId(rawId);
    if (canonicalId === rawId) continue;

    const { data: updated, error: updateError } = await supabase
      .from('user_memories')
      .update({ user_id: canonicalId })
      .eq('user_id', rawId)
      .select('id');

    if (updateError) {
      console.error(`[Repair] Failed to re-key ${rawId} -> ${canonicalId}:`, updateError.message);
      continue;
    }

    const count = updated?.length || 0;
    fixed += count;
    console.log(`[Repair] Re-keyed ${count} row(s): ${rawId} -> ${canonicalId}`);
  }

  console.log(`[Repair] Done. Re-keyed ${fixed} row(s) across ${distinctUserIds.length} user_id value(s).`);
  return { checked: distinctUserIds.length, fixed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRepair().then(() => process.exit(0)).catch(err => {
    console.error('[Repair] Fatal error:', err.message);
    process.exit(1);
  });
}
