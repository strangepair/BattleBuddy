/**
 * Time-truth tests. TZ is pinned to UTC before any Date/Intl use — the exact
 * prod condition (Railway runs UTC). Every assertion here is of the form
 * "a UTC server still renders/stores the user's Central time correctly":
 * if any code path silently falls back to the server's own clock or zone,
 * these fail with an Eastern/UTC-looking value.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TZ, tzOffsetString, formatLocalTime, buildSessionContext, normalizeOccurredAt,
} from './timeContext.js';
import { sessionGapPhrase } from './greeting.js';

// 2026-07-29T21:43:00Z == Wednesday 4:43 PM America/Chicago (CDT, UTC-5)
const SUMMER_INSTANT = new Date('2026-07-29T21:43:00Z');
// 2026-01-15T14:00:00Z == Thursday 8:00 AM America/Chicago (CST, UTC-6)
const WINTER_INSTANT = new Date('2026-01-15T14:00:00Z');

test('tzOffsetString: Central daylight vs standard', () => {
  assert.equal(tzOffsetString('America/Chicago', SUMMER_INSTANT), '-05:00');
  assert.equal(tzOffsetString('America/Chicago', WINTER_INSTANT), '-06:00');
});

test('formatLocalTime renders the user\'s Central clock, not the server\'s UTC clock', () => {
  const s = formatLocalTime('America/Chicago', SUMMER_INSTANT);
  assert.match(s, /Wednesday,? 4:43 PM/);
  assert.match(s, /July 29, 2026/);
  assert.doesNotMatch(s, /9:43/); // the UTC reading — the reported bug
});

test('formatLocalTime falls back to Central (never the server locale) on a bogus timezone', () => {
  const s = formatLocalTime('Not/AZone', SUMMER_INSTANT);
  assert.match(s, /4:43 PM/);
  const s2 = formatLocalTime(undefined, SUMMER_INSTANT);
  assert.match(s2, /4:43 PM/);
});

test('buildSessionContext renders last-session clock time in the user timezone', () => {
  // Last session yesterday 4:43 PM Central; "now" a day later.
  const profile = { last_session_at: '2026-07-28T21:43:00Z' };
  const now = new Date('2026-07-29T22:00:00Z').getTime();
  const ctx = buildSessionContext(profile, 'America/Chicago', now, sessionGapPhrase);
  assert.match(ctx, /\(at 4:43 PM\)/);
  assert.doesNotMatch(ctx, /9:43/); // pre-fix behavior: server-UTC clock
});

test('buildSessionContext: continuation under 30 minutes, no clock time shown', () => {
  const profile = { last_session_at: '2026-07-29T21:30:00Z' };
  const now = new Date('2026-07-29T21:43:00Z').getTime();
  const ctx = buildSessionContext(profile, 'America/Chicago', now, sessionGapPhrase);
  assert.match(ctx, /continuation/);
  assert.doesNotMatch(ctx, /\(at /);
});

test('buildSessionContext: first session', () => {
  assert.equal(buildSessionContext(null, 'America/Chicago', Date.now(), sessionGapPhrase),
    'This is the first session with this user.');
});

// ── normalizeOccurredAt ──────────────────────────────────────────────────────

test('empty/absent occurred_at gets the server\'s authoritative now', () => {
  const now = SUMMER_INSTANT;
  assert.equal(normalizeOccurredAt(undefined, 'America/Chicago', now), now.toISOString());
  assert.equal(normalizeOccurredAt('', 'America/Chicago', now), now.toISOString());
  assert.equal(normalizeOccurredAt('   ', 'America/Chicago', now), now.toISOString());
});

test('offset-less local wall time is interpreted in the user timezone, not as UTC', () => {
  const now = new Date('2026-07-29T22:00:00Z');
  // "4:43 PM" said by a Central user == 21:43Z. Parsing it as UTC (the old
  // behavior, via Postgres) would store 16:43Z == 11:43 AM Central.
  assert.equal(
    normalizeOccurredAt('2026-07-29T16:43:00', 'America/Chicago', now),
    '2026-07-29T21:43:00.000Z'
  );
  // Winter: CST offset applies (DST-correct at the event's own date)
  assert.equal(
    normalizeOccurredAt('2026-01-15T08:00:00', 'America/Chicago', new Date('2026-01-15T15:00:00Z')),
    '2026-01-15T14:00:00.000Z'
  );
  // Minutes-only precision
  assert.equal(
    normalizeOccurredAt('2026-07-29T16:43', 'America/Chicago', now),
    '2026-07-29T21:43:00.000Z'
  );
});

test('explicit instants (Z / offset) pass through unchanged', () => {
  const now = new Date('2026-07-29T22:00:00Z');
  assert.equal(
    normalizeOccurredAt('2026-07-29T21:43:00.000Z', 'America/Chicago', now),
    '2026-07-29T21:43:00.000Z'
  );
  assert.equal(
    normalizeOccurredAt('2026-07-29T16:43:00-05:00', 'America/Chicago', now),
    '2026-07-29T21:43:00.000Z'
  );
});

test('future timestamps are clamped to now — events happen in the past', () => {
  const now = new Date('2026-07-29T21:43:00Z');
  // Model hallucinating "8:43 PM tonight" while it is 4:43 PM Central
  assert.equal(
    normalizeOccurredAt('2026-07-29T20:43:00', 'America/Chicago', now),
    now.toISOString()
  );
  // Small client clock skew is tolerated
  assert.equal(
    normalizeOccurredAt('2026-07-29T21:44:00Z', 'America/Chicago', now),
    '2026-07-29T21:44:00.000Z'
  );
});

test('garbage input falls back to now rather than storing an invalid instant', () => {
  const now = SUMMER_INSTANT;
  assert.equal(normalizeOccurredAt('yesterday evening', 'America/Chicago', now), now.toISOString());
});

test('date-only back-log anchors mid-day local so the calendar day survives bucketing', () => {
  const now = new Date('2026-07-29T22:00:00Z');
  // Noon Central on the 28th == 17:00Z on the 28th — same local calendar day.
  assert.equal(
    normalizeOccurredAt('2026-07-28', 'America/Chicago', now),
    '2026-07-28T17:00:00.000Z'
  );
});

test('default timezone is Central', () => {
  assert.equal(DEFAULT_TZ, 'America/Chicago');
});

// ── Cross-service guards (CI runs no Python tests, so pin these here) ────────

test('voice agent requirements pin tzdata — python-slim ships no zone database', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const reqs = readFileSync(join(here, '../agent/requirements.txt'), 'utf-8');
  // Without this, ZoneInfo("America/Chicago") raises in the container and the
  // per-turn "current local time" injection degrades. It must never silently
  // become the container's UTC clock again.
  assert.match(reqs, /^tzdata==/m, 'agent/requirements.txt must pin the tzdata package');
});

test('voice agent never formats a naked datetime.now() as the user\'s local time', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const agentSource = readFileSync(join(here, '../agent/agent.py'), 'utf-8');
  const localNowBody = agentSource.slice(
    agentSource.indexOf('def local_now'),
    agentSource.indexOf('load_dotenv')
  );
  // datetime.now() with no ZoneInfo is the container's UTC clock — stating it
  // as the user's local time was the voice fabricated-timestamp bug.
  assert.doesNotMatch(localNowBody, /datetime\.now\(\)/,
    'local_now() must never fall back to the zone-less container clock');
});
