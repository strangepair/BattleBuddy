import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerStatus } from '../devPipeline.js';

test('workerStatus response contains ttlMinutes with all four stage keys', () => {
  const status = workerStatus();
  assert.ok(status.ttlMinutes, 'ttlMinutes field is present');
  const keys = ['building', 'in_review', 'merging', 'deploying'];
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(status.ttlMinutes, key), `ttlMinutes has key: ${key}`);
    assert.equal(typeof status.ttlMinutes[key], 'number', `ttlMinutes.${key} is a number`);
  }
});
