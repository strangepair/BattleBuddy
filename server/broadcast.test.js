/**
 * Tests for broadcast.js — SSE push channel.
 *
 * Covers:
 *  1. broadcastToUser delivers the correct SSE frame to registered clients.
 *  2. broadcastToUser is a no-op when no client is registered.
 *  3. A failing write on one client does not prevent delivery to others.
 *  4. registerSseClient cleanup removes the client and the user entry.
 *  5. Payload shape contract: event record (id, type, timestamp),
 *     today_count, current_gap_minutes, longest_gap_today_minutes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastToUser, registerSseClient } from './broadcast.js';

function fakeRes() {
  const written = [];
  return {
    written,
    write(chunk) { written.push(chunk); },
  };
}

test('broadcastToUser sends a named SSE event to a registered client', () => {
  const res = fakeRes();
  const unregister = registerSseClient('user-1', res);

  broadcastToUser('user-1', 'dashboard:update', { today_count: 3 });

  assert.equal(res.written.length, 1);
  assert.ok(res.written[0].startsWith('event: dashboard:update\n'));
  assert.ok(res.written[0].includes('"today_count":3'));

  unregister();
});

test('broadcastToUser is a no-op when no client is registered', () => {
  assert.doesNotThrow(() => {
    broadcastToUser('unknown-user', 'dashboard:update', { today_count: 0 });
  });
});

test('broadcastToUser delivers dashboard:update payload with correct shape', () => {
  const res = fakeRes();
  const unregister = registerSseClient('user-shape', res);

  const payload = {
    event: { id: 'abc-123', type: 'cigarette', timestamp: '2026-07-31T14:00:00.000Z' },
    today_count: 2,
    current_gap_minutes: 47,
    longest_gap_today_minutes: 120,
  };
  broadcastToUser('user-shape', 'dashboard:update', payload);

  assert.equal(res.written.length, 1);
  const frame = res.written[0];
  assert.ok(frame.startsWith('event: dashboard:update\n'), 'SSE event name');
  assert.ok(frame.includes('data: '), 'SSE data line present');

  const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
  const parsed = JSON.parse(dataLine.slice('data: '.length));

  assert.ok(parsed.event, 'payload.event present');
  assert.equal(parsed.event.id, 'abc-123');
  assert.equal(parsed.event.type, 'cigarette');
  assert.equal(typeof parsed.event.timestamp, 'string');
  assert.equal(typeof parsed.today_count, 'number');
  assert.equal(typeof parsed.current_gap_minutes, 'number');
  assert.equal(typeof parsed.longest_gap_today_minutes, 'number');
  assert.equal(parsed.today_count, 2);
  assert.equal(parsed.current_gap_minutes, 47);
  assert.equal(parsed.longest_gap_today_minutes, 120);

  unregister();
});

test('broadcastToUser swallows write errors and delivers to other clients', () => {
  const bad = { write() { throw new Error('socket gone'); } };
  const good = fakeRes();

  const u1 = registerSseClient('user-multi', bad);
  const u2 = registerSseClient('user-multi', good);

  assert.doesNotThrow(() => {
    broadcastToUser('user-multi', 'dashboard:update', { today_count: 1 });
  });
  assert.equal(good.written.length, 1);

  u1();
  u2();
});

test('unregister removes the client so further broadcasts are not delivered', () => {
  const res = fakeRes();
  const unregister = registerSseClient('user-cleanup', res);
  unregister();

  broadcastToUser('user-cleanup', 'dashboard:update', { today_count: 5 });
  assert.equal(res.written.length, 0);
});
