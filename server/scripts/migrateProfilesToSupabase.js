/**
 * One-time migration: copies every {userId}.json profile file on the Railway
 * volume (server/context-store/*.json) into the Supabase `user_profiles`
 * table, which is now the source of truth (see contextAgent.js's
 * warmProfileStoreFromSupabase / loadProfile / saveProfile).
 *
 * Mirrors the volume 1:1 — every file (canonical and alias) gets its own row
 * under its own filename as user_id. resolveUserId() already redirects alias
 * reads to the canonical row at read time, so this needs no merge logic.
 *
 * Safe to re-run — each file is upserted on user_id.
 *
 * Usage: node server/scripts/migrateProfilesToSupabase.js
 */

import { readFileSync, readdirSync } from 'node:fs';
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
    if (eqIdx > 0) process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
} catch {}

const STORE_DIR = process.env.CONTEXT_STORE_DIR || resolve(__dirname, '..', 'context-store');
const SKIP_FILES = new Set(['audit-state.json', 'design-loop-state.json']);

export async function runMigration() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log('[ProfileMigration] SUPABASE_URL / SUPABASE_SERVICE_KEY not set, aborting');
    return { migrated: 0, failed: 0, files: [] };
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    realtime: { transport: WebSocket },
  });

  let files = [];
  try {
    files = readdirSync(STORE_DIR).filter(f => f.endsWith('.json') && !SKIP_FILES.has(f));
  } catch (e) {
    console.log(`[ProfileMigration] Could not read ${STORE_DIR}: ${e.message}`);
    return { migrated: 0, failed: 0, files: [] };
  }

  console.log(`[ProfileMigration] Found ${files.length} profile file(s) in ${STORE_DIR}`);

  let migrated = 0;
  let failed = 0;
  const results = [];

  for (const file of files) {
    const userId = file.replace(/\.json$/, '');
    let profile;
    try {
      profile = JSON.parse(readFileSync(resolve(STORE_DIR, file), 'utf-8'));
    } catch (e) {
      console.error(`[ProfileMigration] Could not parse ${file}, skipping:`, e.message);
      failed++;
      results.push({ userId, ok: false, error: e.message });
      continue;
    }

    const { error } = await supabase.from('user_profiles').upsert(
      { user_id: userId, profile, updated_at: profile.last_updated || new Date().toISOString() },
      { onConflict: 'user_id' }
    );

    if (error) {
      console.error(`[ProfileMigration] Failed to upsert ${userId}:`, error.message);
      failed++;
      results.push({ userId, ok: false, error: error.message });
    } else {
      console.log(`[ProfileMigration] Migrated ${userId} (${profile.session_count || 0} sessions)`);
      migrated++;
      results.push({ userId, ok: true, sessions: profile.session_count || 0 });
    }
  }

  console.log(`[ProfileMigration] Done. Migrated ${migrated}/${files.length} profile(s), ${failed} failure(s).`);
  return { migrated, failed, files: results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration().then(() => process.exit(0)).catch(err => {
    console.error('[ProfileMigration] Fatal error:', err.message);
    process.exit(1);
  });
}
