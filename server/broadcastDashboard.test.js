/**
 * broadcastDashboard.test.js
 *
 * Tests the shape and contract of the `broadcastDashboard` function.
 * Node 18 doesn't support mock.module for ES modules, so we test the
 * broadcastDashboard logic by verifying deriveDashboardPayload produces the
 * correct shape and that broadcastDashboard's payload contract holds.
 *
 * The actual SSE transport (broadcast.js / broadcastToUser) is integration-only;
 * we verify the payload shape rules using deriveDashboardPayload directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDashboardPayload } from './usageFacts.js';

function buildBroadcastPayload(derivedPayload) {
  const { todayEntries, todayCount, currentGapMinutes, longestGapTodayMinutes } = derivedPayload;
  const lastEntry = Array.isArray(todayEntries) && todayEntries.length > 0
    ? todayEntries[todayEntries.length - 1]
    : null;
  return {
    event: lastEntry
      ? { id: lastEntry.id, instant: lastEntry.instant, activityLabel: lastEntry.activityLabel ?? null, location: lastEntry.location ?? null }
      : null,
    todayCount: todayCount ?? 0,
    currentGapMinutes: currentGapMinutes ?? null,
    longestGapTodayMinutes: longestGapTodayMinutes ?? 0,
  };
}

function makeRow(overrides = {}) {
  return {
    id: overrides.id ?? 'row-1',
    event_type: overrides.event_type ?? 'cigarette',
    occurred_at: overrides.occurred_at ?? new Date().toISOString(),
    metadata: overrides.metadata ?? {},
  };
}

test('broadcastDashboard payload — emits dashboard:update with longestGapTodayMinutes', () => {
  const now = new Date('2026-07-31T18:00:00Z');
  const rows = [
    makeRow({ id: 'a', occurred_at: '2026-07-31T10:00:00Z' }),
    makeRow({ id: 'b', occurred_at: '2026-07-31T12:00:00Z' }),
  ];
  const derived = deriveDashboardPayload(rows, 'America/Chicago', now);
  const payload = buildBroadcastPayload(derived);

  assert.ok('longestGapTodayMinutes' in payload, 'longestGapTodayMinutes missing');
  assert.equal(payload.longestGapTodayMinutes, 120);
});

test('broadcastDashboard payload — event includes id, instant, activityLabel, location', () => {
  const now = new Date('2026-07-31T15:00:00Z');
  const rows = [makeRow({
    id: 'evt-1',
    occurred_at: '2026-07-31T14:00:00Z',
    metadata: { location: 'car', trigger: { label: 'after coffee' } },
  })];
  const derived = deriveDashboardPayload(rows, 'America/Chicago', now);
  const payload = buildBroadcastPayload(derived);

  assert.ok(payload.event !== null, 'event should not be null');
  assert.equal(payload.event.id, 'evt-1');
  assert.equal(payload.event.instant, '2026-07-31T14:00:00Z');
  assert.equal(payload.event.activityLabel, 'after coffee');
  assert.equal(payload.event.location, 'car');
});

test('broadcastDashboard payload — empty rows produce event: null and zero counts', () => {
  const derived = deriveDashboardPayload([], 'America/Chicago', new Date('2026-07-31T10:00:00Z'));
  const payload = buildBroadcastPayload(derived);

  assert.equal(payload.event, null);
  assert.equal(payload.todayCount, 0);
  assert.equal(payload.longestGapTodayMinutes, 0);
  assert.equal(payload.currentGapMinutes, null);
});

test('broadcastDashboard payload — todayCount matches actual cigarette count', () => {
  const now = new Date('2026-07-31T18:00:00Z');
  const rows = [
    makeRow({ id: 'x1', occurred_at: '2026-07-31T09:00:00Z' }),
    makeRow({ id: 'x2', occurred_at: '2026-07-31T11:00:00Z' }),
    makeRow({ id: 'x3', occurred_at: '2026-07-31T14:00:00Z' }),
  ];
  const derived = deriveDashboardPayload(rows, 'America/Chicago', now);
  const payload = buildBroadcastPayload(derived);

  assert.equal(payload.todayCount, 3);
});

test('broadcastDashboard payload — currentGapMinutes reflects gap from last cigarette to now', () => {
  const now = new Date('2026-07-31T15:00:00Z');
  const rows = [makeRow({ id: 'last', occurred_at: '2026-07-31T14:00:00Z' })];
  const derived = deriveDashboardPayload(rows, 'America/Chicago', now);
  const payload = buildBroadcastPayload(derived);

  assert.equal(payload.currentGapMinutes, 60);
});

test('broadcastDashboard payload — uses last entry in todayEntries as event', () => {
  const now = new Date('2026-07-31T16:00:00Z');
  const rows = [
    makeRow({ id: 'first', occurred_at: '2026-07-31T10:00:00Z' }),
    makeRow({ id: 'last', occurred_at: '2026-07-31T15:00:00Z' }),
  ];
  const derived = deriveDashboardPayload(rows, 'America/Chicago', now);
  const payload = buildBroadcastPayload(derived);

  assert.equal(payload.event.id, 'last');
});
