/**
 * Static checks on migration 013 — deploy.yml re-runs EVERY migration file on
 * any migrations change and case-insensitively greps them all for destructive
 * DDL (comments included). A single non-idempotent statement or a stray
 * destructive keyword in 013 would therefore break every future deploy that
 * touches migrations, not just this one. Same reads-source-as-text style as
 * systemPromptTemplate.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, 'migrations/013_user_facts.sql'), 'utf-8');
const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');

test('013 contains none of deploy.yml\'s destructive-DDL patterns (grep matches comments too)', () => {
  // Mirror of the deploy workflow's refusal grep.
  assert.doesNotMatch(sql, /(drop\s+(table|column|schema)|truncate\s|delete\s+from)/i,
    'deploy.yml would refuse to auto-apply migrations containing destructive DDL');
});

test('013 is idempotent: every DDL statement is guarded for re-runs', () => {
  assert.match(sql, /create table if not exists user_facts/i);
  const indexStatements = sql.match(/create\s+(unique\s+)?index[^;]+;/gi) || [];
  assert.ok(indexStatements.length >= 3, 'expected the three user_facts indexes');
  for (const stmt of indexStatements) {
    assert.match(stmt, /if not exists/i, `index statement missing guard: ${stmt.slice(0, 60)}`);
  }
  const alterAdds = sql.match(/alter table [^;]*add column[^;]+;/gi) || [];
  assert.ok(alterAdds.length >= 2, 'expected the two episodic lifecycle columns');
  for (const stmt of alterAdds) {
    assert.match(stmt, /add column if not exists/i, `alter statement missing guard: ${stmt.slice(0, 60)}`);
  }
  assert.match(sql, /create or replace function match_user_memories/i,
    'function update must be a re-create, not a new overload');
  assert.match(sql, /if not exists \(\s*select 1 from pg_policies/i,
    'RLS policy creation must be guarded (011 pattern)');
});

test('one active truth per key: the partial unique index exists exactly as specified', () => {
  assert.match(sql, /create unique index if not exists user_facts_active_key\s+on user_facts \(user_id, key\) where status = 'active'/i);
});

test('RLS is enabled on user_facts (CLAUDE.md rule 4)', () => {
  assert.match(sql, /alter table user_facts enable row level security/i);
});

test('retrieval excludes tombstoned episodic rows', () => {
  const fn = sql.slice(sql.indexOf('create or replace function match_user_memories'));
  assert.match(fn, /and not um\.superseded/, 'match_user_memories must skip superseded rows');
});

test('phase-0 surface is wired: backfill + review routes and the boot cache warm', () => {
  assert.ok(indexSource.includes("req.url === '/admin/facts/backfill'"), 'backfill route missing');
  assert.ok(indexSource.includes("req.url.startsWith('/admin/facts/')"), 'review route missing');
  assert.ok(indexSource.includes("req.url === '/admin/facts/resolve'"), 'resolve route missing');
  assert.ok(indexSource.includes('warmFactCache()'), 'boot warm missing');
  // Phase 2: prompt-path reads exist but ONLY behind the read-cutover flag,
  // which must default OFF (gated on Mike approving the Phase-0 audit doc).
  assert.ok(indexSource.includes("process.env.MEMORY_FACTS_ENABLED === 'true'"),
    'read cutover must be opt-in via MEMORY_FACTS_ENABLED');
  const fn = indexSource.slice(indexSource.indexOf('function buildFactsProfile'));
  assert.ok(fn.slice(0, 400).includes('if (!MEMORY_FACTS_ENABLED) return null'),
    'buildFactsProfile must bail to the profile blob when the flag is off');
});
