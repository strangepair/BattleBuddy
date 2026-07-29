/**
 * Ground-truth usage facts tests. TZ pinned to UTC — the exact prod condition
 * (Railway runs UTC). These encode the 2026-07-29 failure: bb_events held six
 * cigarette rows for the day and BB told the user "one today", because
 * nothing deterministic was handed to the model. Every count / last-cigarette
 * time / gap here must come out of deriveUsageFacts exactly, bucketed by the
 * USER's calendar day, never the server's.
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HABIT_EVENT_TYPES, deriveUsageFacts, renderUsageFactsLine } from './usageFacts.js';

const TZ = 'America/Chicago';
// 4:43 PM CDT on Wed 2026-07-29 (UTC-5)
const NOW = new Date('2026-07-29T21:43:00Z');

const cig = (iso, notes) => ({ id: iso, event_type: 'cigarette', occurred_at: iso, metadata: notes ? { notes } : null });

// Mike's actual store rows for 2026-07-29 (Central): 1:45 AM, 5:35 AM,
// 9:29 AM, 10:29 AM, 11:49 AM, 3:19 PM.
const MIKES_DAY = [
  cig('2026-07-29T06:45:00Z'),
  cig('2026-07-29T10:35:00Z', 'first cigarette of the day, in car on drive to gym'),
  cig('2026-07-29T14:29:00Z', 'on the couch'),
  cig('2026-07-29T15:29:00Z'),
  cig('2026-07-29T16:49:52.88Z', 'couch break'),
  cig('2026-07-29T20:19:41.626Z', 'heading to gym, on drive'),
];

test('the 2026-07-29 regression: six logged cigarettes are six, not one', () => {
  const f = deriveUsageFacts(MIKES_DAY, TZ, NOW);
  assert.equal(f.today_cigarette_count, 6);
  assert.equal(f.last_cigarette_local, '3:19 PM');
  assert.equal(f.last_cigarette_date, '2026-07-29');
  // 20:19:41Z -> 21:43:00Z is 83 minutes
  assert.equal(f.minutes_since_last_cigarette, 83);
  assert.equal(f.today_log.length, 6);
  assert.equal(f.today_log[0].local_time, '1:45 AM');
});

test('day boundary is the user\'s local midnight, not UTC midnight', () => {
  // 11:30 PM Central on 7/28 == 04:30Z on 7/29 — same UTC day as "today",
  // but the previous LOCAL day: must NOT count toward 7/29.
  const lateNight = cig('2026-07-29T04:30:00Z');
  // 12:10 AM Central on 7/29 == 05:10Z — first minutes of the local day.
  const justAfterMidnight = cig('2026-07-29T05:10:00Z');
  const f = deriveUsageFacts([lateNight, justAfterMidnight], TZ, NOW);
  assert.equal(f.today_cigarette_count, 1);
  assert.equal(f.today_log.length, 1);
  assert.equal(f.today_log[0].local_time, '12:10 AM');
});

test('last cigarette from yesterday is reported with its date, count today stays 0', () => {
  const yesterday = cig('2026-07-29T02:00:00Z', 'porch'); // 9:00 PM Central 7/28
  const f = deriveUsageFacts([yesterday], TZ, NOW);
  assert.equal(f.today_cigarette_count, 0);
  assert.equal(f.last_cigarette_local, '9:00 PM');
  assert.equal(f.last_cigarette_date, '2026-07-28');
  const line = renderUsageFactsLine(f);
  assert.match(line, /0 cigarettes logged/);
  assert.match(line, /9:00 PM on 2026-07-28/);
});

test('machinery rows (session_report etc.) never reach the facts', () => {
  const rows = [
    ...MIKES_DAY,
    { id: 'sr', event_type: 'session_report', occurred_at: '2026-07-29T21:00:00Z', metadata: { report: { big: 'blob' } } },
    { id: 'ta', event_type: 'transcript_audit', occurred_at: '2026-07-29T20:30:00Z', metadata: {} },
    { id: 's', event_type: 'session', occurred_at: '2026-07-29T19:00:00Z', metadata: {} },
  ];
  const f = deriveUsageFacts(rows, TZ, NOW);
  assert.equal(f.today_cigarette_count, 6);
  assert.equal(f.today_log.length, 6);
  assert.ok(!HABIT_EVENT_TYPES.includes('session_report'));
});

test('empty log: no fabrication path — explicit zeros and nulls', () => {
  const f = deriveUsageFacts([], TZ, NOW);
  assert.equal(f.today_cigarette_count, 0);
  assert.equal(f.last_cigarette_at, null);
  assert.equal(f.minutes_since_last_cigarette, null);
  const line = renderUsageFactsLine(f);
  assert.match(line, /No cigarettes in the log yet/);
  assert.match(line, /never count from conversation memory/);
});

test('urges resisted counted separately, never as cigarettes', () => {
  const rows = [
    cig('2026-07-29T15:29:00Z'),
    { id: 'u1', event_type: 'urge_resisted', occurred_at: '2026-07-29T18:00:00Z', metadata: null },
    { id: 'u2', event_type: 'urge_resisted', occurred_at: '2026-07-29T19:00:00Z', metadata: null },
  ];
  const f = deriveUsageFacts(rows, TZ, NOW);
  assert.equal(f.today_cigarette_count, 1);
  assert.equal(f.today_urges_resisted, 2);
  assert.match(renderUsageFactsLine(f), /Urges resisted today: 2/);
});

test('future-dated rows are excluded from "so far today"', () => {
  const rows = [cig('2026-07-29T15:29:00Z'), cig('2026-07-29T23:00:00Z')]; // 6 PM Central: after NOW
  const f = deriveUsageFacts(rows, TZ, NOW);
  assert.equal(f.today_cigarette_count, 1);
  assert.equal(f.last_cigarette_local, '10:29 AM');
});

test('rendered line contains the numbers and the no-computing rule', () => {
  const line = renderUsageFactsLine(deriveUsageFacts(MIKES_DAY, TZ, NOW));
  assert.match(line, /6 cigarettes logged/);
  assert.match(line, /Last cigarette: 3:19 PM today \(1h 23m ago\)/);
  assert.match(line, /1:45 AM/);
  assert.match(line, /report exactly these values/);
  assert.match(line, /never estimate/);
});

test('winter time (CST, UTC-6) buckets correctly', () => {
  const winterNow = new Date('2026-01-16T03:00:00Z'); // 9:00 PM CST on Jan 15
  const rows = [
    cig('2026-01-15T05:30:00Z'), // 11:30 PM CST on Jan 14 — yesterday
    cig('2026-01-15T06:30:00Z'), // 12:30 AM CST on Jan 15 — today
  ];
  const f = deriveUsageFacts(rows, TZ, winterNow);
  assert.equal(f.today_cigarette_count, 1);
  assert.equal(f.today_log[0].local_time, '12:30 AM');
});

test('long notes are truncated so the injection line stays compact', () => {
  const rows = [cig('2026-07-29T15:29:00Z', 'x'.repeat(200))];
  const f = deriveUsageFacts(rows, TZ, NOW);
  assert.ok(f.today_log[0].note.length <= 40);
});
