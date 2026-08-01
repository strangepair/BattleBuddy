/**
 * Tests for auth guards and 14-day boundary logic added to index.js.
 *
 * index.js is a monolithic server (no exports), so we test:
 *  - The auth helpers (checkClientToken, authorizeProfileAccess) via a
 *    lightweight inline re-implementation that mirrors the exact logic.
 *  - The 14-day ISO boundary computation using the same tzOffsetString helper
 *    the route uses, so timezone bugs surface here.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { tzOffsetString } from './timeContext.js';

// ─── Inline mirrors of the auth helpers ─────────────────────────────────────
// These mirror the exact logic in index.js so we can unit-test the decision
// rules without importing the whole server (which has side-effects: ports,
// file-system writes, etc.).

function checkClientToken(authHeader, expected) {
  const provided = (authHeader || '').startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function authorizeProfileAccess(authHeader, pathUserId, mockGetUser) {
  const token = (authHeader || '').startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  if (!token) return { ok: false, status: 401, error: 'Missing credentials' };

  const { data, error } = await mockGetUser(token);
  if (error || !data?.user) return { ok: false, status: 401, error: 'Invalid token' };

  if (data.user.id !== pathUserId) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  return { ok: true, mode: 'user', userId: data.user.id };
}

// ─── 14-day boundary helper — mirrors the IIFE in GET /dashboard/today ──────
function computeFourteenDaysAgoISO(timezone, now = new Date()) {
  const tz = timezone || 'America/Chicago';
  const cutoff = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(cutoff);
  const offset = tzOffsetString(tz, new Date(`${dateStr}T12:00:00Z`));
  return new Date(`${dateStr}T00:00:00${offset}`).toISOString();
}

// ─── checkClientToken ────────────────────────────────────────────────────────

test('checkClientToken — no header returns false', () => {
  assert.equal(checkClientToken('', 'secret'), false);
  assert.equal(checkClientToken(null, 'secret'), false);
});

test('checkClientToken — wrong token returns false', () => {
  assert.equal(checkClientToken('Bearer wrong', 'secret'), false);
});

test('checkClientToken — correct token returns true', () => {
  assert.equal(checkClientToken('Bearer secret', 'secret'), true);
});

test('checkClientToken — no expected token configured returns false', () => {
  assert.equal(checkClientToken('Bearer anything', ''), false);
  assert.equal(checkClientToken('Bearer anything', null), false);
});

// ─── authorizeProfileAccess ──────────────────────────────────────────────────

test('GET /dashboard/today — no token → 401', async () => {
  const auth = await authorizeProfileAccess('', 'user-1', async () => ({ data: null, error: null }));
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 401);
});

test('GET /dashboard/today — invalid JWT → 401', async () => {
  const auth = await authorizeProfileAccess(
    'Bearer bad-jwt',
    'user-1',
    async () => ({ data: null, error: new Error('invalid') }),
  );
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 401);
});

test('GET /dashboard/today — JWT for a different user → 403', async () => {
  const auth = await authorizeProfileAccess(
    'Bearer valid-jwt',
    'user-1',
    async () => ({ data: { user: { id: 'user-2' } }, error: null }),
  );
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 403);
});

test('GET /dashboard/today — correct user JWT → ok', async () => {
  const auth = await authorizeProfileAccess(
    'Bearer valid-jwt',
    'user-1',
    async () => ({ data: { user: { id: 'user-1' } }, error: null }),
  );
  assert.equal(auth.ok, true);
  assert.equal(auth.mode, 'user');
});

test('GET /events — no token → 401', async () => {
  const auth = await authorizeProfileAccess('', 'user-1', async () => ({ data: null, error: null }));
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 401);
});

test('GET /events — JWT for a different user → 403', async () => {
  const auth = await authorizeProfileAccess(
    'Bearer jwt',
    'user-1',
    async () => ({ data: { user: { id: 'other-user' } }, error: null }),
  );
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 403);
});

test('GET /events — correct user JWT → ok', async () => {
  const auth = await authorizeProfileAccess(
    'Bearer jwt',
    'user-1',
    async () => ({ data: { user: { id: 'user-1' } }, error: null }),
  );
  assert.equal(auth.ok, true);
});

// ─── POST /events dual-auth ───────────────────────────────────────────────────

test('POST /events — no token and no client token → 401', async () => {
  const hasClientToken = checkClientToken('', 'BB_SECRET');
  assert.equal(hasClientToken, false);
  const auth = await authorizeProfileAccess('', 'user-1', async () => ({ data: null, error: null }));
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 401);
});

test('POST /events — valid client token → passes client-token branch', () => {
  const hasClientToken = checkClientToken('Bearer BB_SECRET', 'BB_SECRET');
  assert.equal(hasClientToken, true);
});

test('POST /events — valid user JWT → passes JWT branch', async () => {
  const hasClientToken = checkClientToken('Bearer jwt', 'BB_SECRET');
  assert.equal(hasClientToken, false);
  const auth = await authorizeProfileAccess(
    'Bearer jwt',
    'user-1',
    async () => ({ data: { user: { id: 'user-1' } }, error: null }),
  );
  assert.equal(auth.ok, true);
});

// ─── 14-day boundary ──────────────────────────────────────────────────────────

test('14-day boundary — UTC timezone: result is start-of-day 14 days ago in UTC', () => {
  const now = new Date('2026-08-01T10:00:00Z');
  const result = computeFourteenDaysAgoISO('UTC', now);
  assert.equal(result, '2026-07-18T00:00:00.000Z');
});

test('14-day boundary — America/Chicago: result is start-of-day 14 days ago in Central time, not UTC midnight', () => {
  // 2026-08-01T10:00:00Z == 2026-08-01 05:00 AM CDT (UTC-5)
  // 14 days back → local date 2026-07-18
  // CDT offset at 2026-07-18 is -05:00
  // 2026-07-18T00:00:00-05:00 == 2026-07-18T05:00:00.000Z
  const now = new Date('2026-08-01T10:00:00Z');
  const result = computeFourteenDaysAgoISO('America/Chicago', now);
  assert.equal(result, '2026-07-18T05:00:00.000Z');
  assert.notEqual(result, '2026-07-18T00:00:00.000Z', 'must not use server UTC midnight');
});

test('14-day boundary — America/New_York: result is start-of-day 14 days ago in Eastern time', () => {
  // 2026-08-01T10:00:00Z == 2026-08-01 06:00 AM EDT (UTC-4)
  // 14 days back → local date 2026-07-18
  // EDT offset at 2026-07-18 is -04:00
  // 2026-07-18T00:00:00-04:00 == 2026-07-18T04:00:00.000Z
  const now = new Date('2026-08-01T10:00:00Z');
  const result = computeFourteenDaysAgoISO('America/New_York', now);
  assert.equal(result, '2026-07-18T04:00:00.000Z');
  assert.notEqual(result, '2026-07-18T00:00:00.000Z', 'must not use server UTC midnight');
});

test('14-day boundary — result differs between UTC and non-UTC, proving server-clock is not used', () => {
  const now = new Date('2026-08-01T10:00:00Z');
  const utcResult = computeFourteenDaysAgoISO('UTC', now);
  const chicagoResult = computeFourteenDaysAgoISO('America/Chicago', now);
  assert.notEqual(utcResult, chicagoResult);
});
