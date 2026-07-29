/**
 * Memory-tool tests: the executor's validation paths (which must hold even
 * with no database behind them) and the THREE-SURFACE PARITY check — every
 * tool documented in the prompt must exist in AGENT_TOOLS and in the voice
 * agent. Build 55 shipped check_dev_mode in text only and the voice model
 * flip-flopped between claiming and disclaiming it; this test makes that
 * class of drift a CI failure permanently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { FACT_TOOLS, FACT_TOOL_NAMES, executeFactTool, topicPhraseFromKey } from './factTools.js';
import { FACT_CATEGORIES } from './factStore.js';

const here = dirname(fileURLToPath(import.meta.url));

// A client stub whose gate call fails — runGateCycle must swallow it (fail
// closed), so remember still acks without a real API key in CI.
const stubClient = { messages: { create: async () => { throw new Error('no api in tests'); } } };

test('remember schema hard-requires the grounding quote', () => {
  const remember = FACT_TOOLS.find(t => t.name === 'remember');
  assert.ok(remember.input_schema.required.includes('user_words'));
  assert.deepEqual(remember.input_schema.properties.category.enum, FACT_CATEGORIES,
    'tool category enum must match the store taxonomy exactly');
});

test('remember without user_words is a tool error, never a write', async () => {
  const r = await executeFactTool('remember',
    { category: 'trigger', statement: 'Coffee triggers him.' },
    { userId: 'test-user-facttools', client: stubClient });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /user_words/);

  const short = await executeFactTool('remember',
    { category: 'trigger', statement: 'Coffee triggers him.', user_words: 'ok' },
    { userId: 'test-user-facttools', client: stubClient });
  assert.equal(short.is_error, true, 'a 2-char quote grounds nothing');
});

test('remember with a bad category is rejected', async () => {
  const r = await executeFactTool('remember',
    { category: 'vibes', statement: 'x', user_words: 'the user said x' },
    { userId: 'test-user-facttools', client: stubClient });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /category/);
});

test('remember with valid grounding acks and proposes through the gate', async () => {
  const r = await executeFactTool('remember',
    { category: 'person', statement: 'Alec does not have a Chantix prescription.', user_words: 'Alec does NOT have a prescription, I told you twice' },
    { userId: 'test-user-facttools', client: stubClient });
  assert.equal(r.is_error, undefined);
  assert.equal(r.content.ok, true);
  assert.equal(r.content.status, 'remembered');
});

test('correct_memory on an unknown key errors with suggestions, never writes blind', async () => {
  const r = await executeFactTool('correct_memory',
    { key: 'trigger.nonexistent', new_statement: 'whatever' },
    { userId: 'test-user-facttools', client: stubClient });
  assert.equal(r.is_error, true);
  assert.match(r.content.error, /no active fact/);
  assert.ok(Array.isArray(r.content.did_you_mean));
});

test('forget requires a target and refuses tiny over-broad phrases', async () => {
  const r = await executeFactTool('forget', {}, { userId: 'test-user-facttools', client: stubClient });
  assert.equal(r.is_error, true);

  // No matching fact + 3-char phrase → nothing retired, nothing tombstoned.
  const tiny = await executeFactTool('forget', { key_or_topic: 'gym' }, { userId: 'test-user-facttools', client: stubClient });
  assert.equal(tiny.content.episodic_memories_suppressed, 0, 'sub-4-char phrases must not tombstone by substring');
});

test('lookup_fact on nothing recorded says so instead of guessing', async () => {
  const r = await executeFactTool('lookup_fact',
    { key_or_category: 'window.mars-colony' },
    { userId: 'test-user-facttools-fresh', client: stubClient });
  assert.equal(r.content.found, false);
  assert.match(r.content.note, /ask/);
});

test('topicPhraseFromKey derives a tombstone phrase from the slug', () => {
  assert.equal(topicPhraseFromKey('trigger.morning-coffee'), 'morning coffee');
  assert.equal(topicPhraseFromKey('person.alec'), 'alec');
});

// ─── Three-surface parity ───────────────────────────────────────────────────

function promptToolNames() {
  const template = readFileSync(join(here, 'prompts/system.battlebuddy.md'), 'utf-8');
  const toolsSection = template.slice(template.indexOf('## Tools you can use'), template.indexOf('## Runtime context'));
  return [...new Set([...toolsSection.matchAll(/^- `([a-z_]+)\(/gm)].map(m => m[1]))];
}

test('every tool documented in the prompt exists in AGENT_TOOLS (text surface)', () => {
  const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');
  const toolsSource = readFileSync(join(here, 'factTools.js'), 'utf-8');
  for (const name of promptToolNames()) {
    assert.ok(
      indexSource.includes(`name: '${name}'`) || toolsSource.includes(`name: '${name}'`),
      `prompt documents '${name}' but the text agent does not declare it`
    );
  }
});

test('every tool documented in the prompt exists in the voice agent (voice surface)', () => {
  const agentSource = readFileSync(join(here, '../agent/agent.py'), 'utf-8');
  for (const name of promptToolNames()) {
    if (name === 'update_event' || name === 'log_event') {
      // Voice declares these with reduced schemas; presence is what matters.
    }
    assert.ok(
      agentSource.includes(`async def ${name}(`),
      `prompt documents '${name}' but the voice agent does not declare it`
    );
  }
});

test('the retired tool names are gone from every live surface', () => {
  const template = readFileSync(join(here, 'prompts/system.battlebuddy.md'), 'utf-8');
  const agentSource = readFileSync(join(here, '../agent/agent.py'), 'utf-8');
  assert.ok(!template.includes('recall_conversation'), 'prompt still names recall_conversation');
  assert.ok(!agentSource.includes('async def recall_conversation('), 'voice still declares recall_conversation');
  assert.ok(!agentSource.includes('async def lookup_profile_field('), 'voice still declares lookup_profile_field (renamed to lookup_fact)');
});

test('memory-discipline contract is in the prompt', () => {
  const template = readFileSync(join(here, 'prompts/system.battlebuddy.md'), 'utf-8');
  assert.match(template, /Memory discipline:/);
  assert.match(template, /you don't know it/i);
});

test('write cutover gating exists in extraction (flag-off today)', () => {
  const contextSource = readFileSync(join(here, 'contextAgent.js'), 'utf-8');
  assert.ok(contextSource.includes("process.env.FACTS_WRITE_CUTOVER === 'true'"),
    'analyzeAndUpdate must gate fact-like fields behind FACTS_WRITE_CUTOVER');
  assert.ok(contextSource.includes('FACT_LIKE_FIELDS'), 'ceded field set missing');
  const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');
  assert.ok(indexSource.includes("process.env.FACTS_WRITE_CUTOVER !== 'true'"),
    'trigger/insight episodic embeds must stop under the write cutover');
});

test('voice fact-tool endpoint delegates to the shared executor', () => {
  const indexSource = readFileSync(join(here, 'index.js'), 'utf-8');
  assert.ok(indexSource.includes("req.url === '/context/facts/tool'"));
  assert.ok(FACT_TOOL_NAMES.size === 4);
});
