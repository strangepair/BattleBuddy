import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDashboardPayload } from './usageFacts.js';

const TZ = 'America/Chicago';

function makeRow(overrides = {}) {
  return {
    id: overrides.id ?? 'row-1',
    event_type: overrides.event_type ?? 'cigarette',
    occurred_at: overrides.occurred_at ?? new Date().toISOString(),
    metadata: overrides.metadata ?? {},
  };
}

test('deriveDashboardPayload — empty rows returns zero counts', () => {
  const result = deriveDashboardPayload([], TZ, new Date('2026-07-31T15:00:00Z'));
  assert.equal(result.todayCount, 0);
  assert.equal(result.currentGapMinutes, null);
  assert.equal(result.longestGapTodayMinutes, 0);
  assert.deepEqual(result.todayEntries, []);
  assert.deepEqual(result.recentHistory, []);
});

test('deriveDashboardPayload — required fields present', () => {
  const now = new Date('2026-07-31T15:00:00Z');
  const row = makeRow({ id: 'abc', occurred_at: '2026-07-31T14:00:00Z' });
  const result = deriveDashboardPayload([row], TZ, now);

  assert.ok('todayEntries' in result, 'todayEntries missing');
  assert.ok('todayCount' in result, 'todayCount missing');
  assert.ok('currentGapMinutes' in result, 'currentGapMinutes missing');
  assert.ok('longestGapTodayMinutes' in result, 'longestGapTodayMinutes missing');
  assert.ok('recentHistory' in result, 'recentHistory missing');
});

test('deriveDashboardPayload — todayEntries contain id, instant, activityLabel, location', () => {
  const now = new Date('2026-07-31T15:00:00Z');
  const row = makeRow({
    id: 'entry-1',
    occurred_at: '2026-07-31T13:00:00Z',
    metadata: { location: 'car', trigger: { label: 'after coffee' } },
  });
  const result = deriveDashboardPayload([row], TZ, now);

  assert.equal(result.todayEntries.length, 1);
  const entry = result.todayEntries[0];
  assert.equal(entry.id, 'entry-1');
  assert.equal(entry.instant, '2026-07-31T13:00:00Z');
  assert.equal(entry.activityLabel, 'after coffee');
  assert.equal(entry.location, 'car');
});

test('deriveDashboardPayload — currentGapMinutes is correct', () => {
  const now = new Date('2026-07-31T15:00:00Z');
  const row = makeRow({ id: 'g1', occurred_at: '2026-07-31T14:30:00Z' });
  const result = deriveDashboardPayload([row], TZ, now);
  assert.equal(result.currentGapMinutes, 30);
});

test('deriveDashboardPayload — longestGapTodayMinutes calculated between consecutive entries', () => {
  const now = new Date('2026-07-31T18:00:00Z');
  const rows = [
    makeRow({ id: 'a', occurred_at: '2026-07-31T10:00:00Z' }),
    makeRow({ id: 'b', occurred_at: '2026-07-31T12:00:00Z' }),
    makeRow({ id: 'c', occurred_at: '2026-07-31T14:00:00Z' }),
  ];
  const result = deriveDashboardPayload(rows, TZ, now);
  assert.equal(result.todayCount, 3);
  assert.equal(result.longestGapTodayMinutes, 120);
});

test('deriveDashboardPayload — prior-day rows go to recentHistory not todayEntries', () => {
  const now = new Date('2026-07-31T10:00:00Z');
  const todayRow = makeRow({ id: 'today', occurred_at: '2026-07-31T08:00:00Z' });
  const yesterdayRow = makeRow({ id: 'yesterday', occurred_at: '2026-07-30T20:00:00Z' });
  const result = deriveDashboardPayload([todayRow, yesterdayRow], TZ, now);

  const todayIds = result.todayEntries.map((e) => e.id);
  const historyIds = result.recentHistory.map((e) => e.id);
  assert.ok(todayIds.includes('today'), 'today row missing from todayEntries');
  assert.ok(historyIds.includes('yesterday'), 'yesterday row missing from recentHistory');
  assert.ok(!todayIds.includes('yesterday'), 'yesterday should not be in todayEntries');
});

test('deriveDashboardPayload — non-cigarette event_types are excluded', () => {
  const now = new Date('2026-07-31T15:00:00Z');
  const rows = [
    makeRow({ id: 'cig', event_type: 'cigarette', occurred_at: '2026-07-31T14:00:00Z' }),
    makeRow({ id: 'urge', event_type: 'urge_resisted', occurred_at: '2026-07-31T13:00:00Z' }),
  ];
  const result = deriveDashboardPayload(rows, TZ, now);
  assert.equal(result.todayCount, 1);
  const ids = result.todayEntries.map((e) => e.id);
  assert.ok(ids.includes('cig'));
  assert.ok(!ids.includes('urge'));
});

test('deriveDashboardPayload — activityLabel falls back to notes when no trigger', () => {
  const now = new Date('2026-07-31T15:00:00Z');
  const row = makeRow({
    id: 'n1',
    occurred_at: '2026-07-31T14:00:00Z',
    metadata: { notes: 'after lunch' },
  });
  const result = deriveDashboardPayload([row], TZ, now);
  assert.equal(result.todayEntries[0].activityLabel, 'after lunch');
});
