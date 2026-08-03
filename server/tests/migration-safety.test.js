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
});
