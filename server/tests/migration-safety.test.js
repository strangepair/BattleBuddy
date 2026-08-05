import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATTERN = /(drop\s+(table|column|schema)|truncate\s|delete\s+from)/i;
const DIRS = [
  path.resolve(__dirname, '../../server/migrations'),
  path.resolve(__dirname, '../../supabase/migrations'),
];

// CREATE forms that error on re-run unless they carry IF NOT EXISTS.
const NEEDS_INE = /^\s*create\s+(unique\s+)?(table|index|extension|sequence|schema|type|view|materialized\s+view)\b/i;
// CREATE forms Postgres offers no IF NOT EXISTS for; they must instead sit
// inside a catalog-check DO block or follow a DROP ... IF EXISTS.
const NEEDS_GUARD = /^\s*create\s+(policy|trigger)\b/i;
const GUARD_BEFORE = /(if\s+not\s+exists\s*\(|drop\s+(policy|trigger)\s+if\s+exists)/i;
const GUARD_LOOKBACK = 25;

function sqlFiles() {
  const out = [];
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql'))) {
      out.push(path.join(dir, file));
    }
  }
  return out;
}

describe('migration safety', () => {
  // Two agents working in parallel both grabbed 019 on 2026-08-02
  // (019_dev_build_requests_change_summary + 019_dev_build_requests_duplicate_status).
  // Those two happened to be independent, so the deploy's `ls | sort` order was
  // harmless — but two files sharing a number that touch the same object apply
  // in an order nobody chose. Numbers must be unique per directory.
  it('no two migrations in a directory share a numeric prefix', () => {
    const violations = [];
    for (const dir of DIRS) {
      if (!fs.existsSync(dir)) continue;
      const byPrefix = new Map();
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql'))) {
        const m = file.match(/^(\d+)_/);
        if (!m) continue;               // date-stamped files (20260702_…) are exempt
        const prefix = m[1];
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
        byPrefix.get(prefix).push(file);
      }
      for (const [prefix, files] of byPrefix) {
        if (files.length > 1) {
          violations.push(`${dir}: ${files.length} migrations numbered ${prefix} — ${files.sort().join(', ')}`);
        }
      }
    }
    assert.deepEqual(violations, [],
      'Duplicate migration numbers (pick the next free number):\n' + violations.join('\n'));
  });

  it('no migration file contains destructive-SQL trigger words', () => {
    const violations = [];
    for (const full of sqlFiles()) {
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (PATTERN.test(line)) violations.push(`${full}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(violations, [],
      'Destructive-SQL pattern matched in migration files:\n' + violations.join('\n'));
  });

  // deploy.yml re-runs every migration file on every migration-touching push,
  // so a single non-idempotent statement fails the deploy for the whole repo
  // (ON_ERROR_STOP=1) and blocks every later migration in the same run.
  it('every CREATE is re-runnable (IF NOT EXISTS or an explicit guard)', () => {
    const violations = [];
    for (const full of sqlFiles()) {
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (NEEDS_INE.test(line) && !/if\s+not\s+exists/i.test(line)) {
          violations.push(`${full}:${i + 1}: missing IF NOT EXISTS — ${line.trim()}`);
          return;
        }
        if (NEEDS_GUARD.test(line)) {
          const before = lines.slice(Math.max(0, i - GUARD_LOOKBACK), i).join('\n');
          if (!GUARD_BEFORE.test(before)) {
            violations.push(`${full}:${i + 1}: unguarded — ${line.trim()}`);
          }
        }
      });
    }
    assert.deepEqual(violations, [],
      'Non-idempotent migration statements (these break re-runs):\n' + violations.join('\n'));
  });

  // 2026-08-05: THE MIGRATION PLANE DEADLOCKED, and this is the guard for it.
  //
  // 021 and 022 both define `dev_build_requests_status_check`; 022's list is
  // wider (it adds 'superseded'). Because every file re-runs on every deploy in
  // numeric order, 021 replaced 022's constraint with its own narrower one on
  // each pass. Harmless until a row actually held 'superseded' — then 021
  // failed, ON_ERROR_STOP aborted the job, and NOTHING numbered above 021 could
  // ever be applied again. A later widening silently makes an earlier one a
  // narrowing.
  //
  // So: for any named constraint, only the LAST file that defines it may
  // drop-and-add unconditionally. Earlier definitions must be conditional on
  // the constraint not already existing.
  it('only the last definition of a check constraint is unconditional', () => {
    const ADD = /add\s+constraint\s+([a-z0-9_]+)/gi;
    const byConstraint = new Map();

    for (const full of sqlFiles().sort()) {
      const sql = fs.readFileSync(full, 'utf8');
      for (const m of sql.matchAll(ADD)) {
        const name = m[1].toLowerCase();
        if (!byConstraint.has(name)) byConstraint.set(name, []);
        const guarded = /pg_constraint/i.test(sql);
        const files = byConstraint.get(name);
        if (!files.some((f) => f.full === full)) files.push({ full, guarded });
      }
    }

    const violations = [];
    for (const [name, files] of byConstraint) {
      if (files.length < 2) continue;
      // Every file but the last must be guarded against re-narrowing.
      for (const f of files.slice(0, -1)) {
        if (!f.guarded) {
          violations.push(
            `${f.full}: redefines "${name}" unconditionally, but `
            + `${files[files.length - 1].full} defines it later — wrap this one in a `
            + 'DO block guarded on pg_constraint so it cannot narrow the later definition',
          );
        }
      }
    }
    assert.deepEqual(violations, [],
      'A later widening turned an earlier one into a narrowing:\n' + violations.join('\n'));
  });
});
