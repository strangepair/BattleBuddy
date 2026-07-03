/**
 * One-time backfill: embed existing session transcripts into the vector
 * store (user_memories). The vector store only recently started working —
 * this catches up transcripts that were saved before that, so BB can recall
 * past sessions instead of only sessions going forward.
 *
 * Usage: node server/scripts/backfillTranscripts.js
 * (Reads CONTEXT_STORE_DIR from env, same as the rest of the server — must
 * run somewhere with access to the actual transcript files, e.g. the
 * Railway volume in production.)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedAndStore } from '../vectorStore.js';
import { resolveUserId } from '../contextAgent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env the same way the rest of the server does
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

function transcriptToContent(messages) {
  return messages
    .map(m => `${m.role === 'user' ? 'User' : 'BattleBuddy'}: ${m.content}`)
    .join('\n');
}

export async function runBackfill() {
  const storeDir = process.env.CONTEXT_STORE_DIR || resolve(__dirname, '..', 'context-store');
  const transcriptDir = resolve(storeDir, 'session-transcripts');

  if (!existsSync(transcriptDir)) {
    console.log(`[Backfill] No transcript directory at ${transcriptDir}`);
    return { total: 0, embedded: 0 };
  }

  const userDirs = readdirSync(transcriptDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const files = [];
  for (const userId of userDirs) {
    const dir = resolve(transcriptDir, userId);
    for (const f of readdirSync(dir).filter(name => name.endsWith('.json'))) {
      files.push({ userId, sessionId: f.replace('.json', ''), path: resolve(dir, f) });
    }
  }

  console.log(`[Backfill] Found ${files.length} session transcripts across ${userDirs.length} user(s)`);

  let embedded = 0;
  for (let i = 0; i < files.length; i++) {
    const { userId, sessionId, path } = files[i];
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      const messages = data.messages || [];
      if (!messages.length) {
        console.log(`[Backfill] Skipped ${i + 1} of ${files.length}: ${sessionId} (no messages)`);
        continue;
      }
      const content = transcriptToContent(messages);
      await embedAndStore(resolveUserId(userId), content, 'session_transcript', sessionId);
      embedded++;
      console.log(`[Backfill] Embedded session ${i + 1} of ${files.length}: ${sessionId}`);
    } catch (err) {
      console.error(`[Backfill] Failed on ${sessionId}: ${err.message}`);
    }
  }

  console.log(`[Backfill] Done. Embedded ${embedded} of ${files.length} sessions.`);
  return { total: files.length, embedded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackfill().then(() => process.exit(0)).catch(err => {
    console.error('[Backfill] Fatal error:', err.message);
    process.exit(1);
  });
}
