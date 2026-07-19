/**
 * Static checks on the system prompt template.
 *
 * Reads index.js as text rather than importing it — importing would start the
 * HTTP server. That keeps these cheap and dependency-free, and they catch the
 * failure mode that matters: a placeholder added to the template with no
 * matching substitution, which ships the literal `{{...}}` into a live prompt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, 'prompts/system.battlebuddy.md'), 'utf-8');
const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');

// Line 5 of the template describes the convention in prose ("`{{placeholders}}`
// are filled in per turn") — it is documentation, not a substitution site.
const DOC_ONLY = new Set(['{{placeholders}}']);

function templatePlaceholders() {
  return [...new Set(template.match(/\{\{[a-z_]+\}\}/g) || [])].filter(p => !DOC_ONLY.has(p));
}

test('every template placeholder has a matching .replace() in index.js', () => {
  const missing = templatePlaceholders().filter(p => !indexSource.includes(`.replace('${p}'`));
  assert.deepEqual(
    missing,
    [],
    `template placeholders with no substitution — these would render literally to a user: ${missing.join(', ')}`
  );
});

test('every .replace() target still exists in the template', () => {
  // The reverse direction: a substitution left behind after its section was
  // removed is dead code, and silently drops whatever it was carrying.
  const replaced = [...new Set(
    (indexSource.match(/\.replace\('(\{\{[a-z_]+\}\})'/g) || [])
      .map(m => m.match(/\{\{[a-z_]+\}\}/)[0])
  )];
  const orphaned = replaced.filter(p => !template.includes(p));
  assert.deepEqual(orphaned, [], `substitutions with no placeholder in the template: ${orphaned.join(', ')}`);
});

test('promoted memory tier is wired end to end', () => {
  // The tier is only useful if it reaches both paths. Voice is the one that
  // matters most — it had no memory at all, which is why greetings read cold.
  assert.ok(template.includes('{{promoted_memories}}'), 'template is missing the promoted tier');
  assert.ok(indexSource.includes('fetchPromotedMemories'), 'index.js never fetches promoted memories');

  const voiceCall = indexSource.slice(indexSource.indexOf('const voiceSystemPrompt = buildSystemPrompt({'));
  const voiceArgs = voiceCall.slice(0, voiceCall.indexOf('});'));
  assert.ok(
    voiceArgs.includes('promotedMemories'),
    'the voice path builds its prompt without the promoted tier — greetings stay memory-blind'
  );
});
