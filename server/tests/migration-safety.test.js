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

describe('migration safety', () => {
  it('no migration file contains destructive-SQL trigger words', () => {
    const violations = [];
    for (const dir of DIRS) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql'))) {
        const full = path.join(dir, file);
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (PATTERN.test(line)) violations.push(`${full}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    assert.deepEqual(violations, [],
      'Destructive-SQL pattern matched in migration files:\n' + violations.join('\n'));
  });
});
