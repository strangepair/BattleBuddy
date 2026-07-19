/**
 * Greeting composition — pure, so this exercises the real logic with no LiveKit.
 *
 * The point of Phase 3's greeting work is that a returning user's opening is
 * grounded in a concrete fact and a real time-gap rather than invented, so the
 * tests assert those actually land in the instruction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionGapPhrase, buildVoiceGreeting } from './greeting.js';

const NOW = Date.parse('2026-07-19T18:00:00Z');
const minutesAgo = n => NOW - n * 60000;
const daysAgo = n => NOW - n * 24 * 60 * 60000;

test('sessionGapPhrase renders each bucket', () => {
  assert.equal(sessionGapPhrase(minutesAgo(2), NOW), 'just now');
  assert.equal(sessionGapPhrase(minutesAgo(20), NOW), '20 minutes ago');
  assert.equal(sessionGapPhrase(minutesAgo(200), NOW), '3 hours ago');
  assert.equal(sessionGapPhrase(daysAgo(1), NOW), 'yesterday');
  assert.equal(sessionGapPhrase(daysAgo(3), NOW), '3 days ago');
});

test('sessionGapPhrase handles ISO strings and missing input', () => {
  assert.equal(sessionGapPhrase('2026-07-16T18:00:00Z', NOW), '3 days ago');
  assert.equal(sessionGapPhrase(null, NOW), null);
  assert.equal(sessionGapPhrase('not a date', NOW), null);
});

test('a mid-thread switch does not re-greet', () => {
  const g = buildVoiceGreeting({ userName: 'Mike', isContinuation: true, sessionCount: 40 });
  assert.match(g, /switching to voice/i);
  assert.doesNotMatch(g, /warmly|how's it going/i);
});

test('a genuinely new user gets a plain warm opener, nothing invented', () => {
  const g = buildVoiceGreeting({ userName: 'Sam', sessionCount: 0 });
  assert.match(g, /Hey, Sam/);
  // Nothing to remember yet — it must not claim history.
  assert.doesNotMatch(g, /you know them|conversations|last spoke/i);
});

test('a returning user greeting is grounded in the promoted fact and the gap', () => {
  const g = buildVoiceGreeting({
    userName: 'Mike',
    sessionCount: 40,
    gapPhrase: '3 days ago',
    promotedFact: 'the drive past the gym is when the craving hits hardest',
  });
  assert.match(g, /Mike/);
  assert.match(g, /40 conversations/);
  assert.match(g, /3 days ago/);
  assert.match(g, /drive past the gym/);
  // The fact is context to reference, not a line to read out.
  assert.match(g, /do not quote it verbatim/i);
});

test('"just now" is not surfaced as a gap to mention', () => {
  const g = buildVoiceGreeting({ userName: 'Mike', sessionCount: 5, gapPhrase: 'just now' });
  assert.doesNotMatch(g, /just now/);
});

test('with no promoted fact yet, it falls back to the last-session hint', () => {
  // The promoted tier is empty for ~a week after launch, so this is the common
  // early case — it must still beat a generic opener.
  const g = buildVoiceGreeting({
    userName: 'Mike',
    sessionCount: 3,
    gapPhrase: 'yesterday',
    promotedFact: null,
    hint: 'ask how the weekend camping trip went',
  });
  assert.match(g, /camping trip/);
  assert.doesNotMatch(g, /How's it going/);
});

test('with neither fact nor hint, it still asks for something specific', () => {
  const g = buildVoiceGreeting({ userName: 'Mike', sessionCount: 3 });
  assert.match(g, /specific thing/i);
});

test('a due check-in outranks a promoted fact and is framed as optional', () => {
  const g = buildVoiceGreeting({
    userName: 'Mike',
    sessionCount: 20,
    gapPhrase: '2 days ago',
    promotedFact: 'the drive past the gym is the hard part',
    checkIn: 'how the first day back at work went',
  });
  assert.match(g, /first day back at work/);
  // The check-in is the reason to open — the memory reference steps aside.
  assert.doesNotMatch(g, /drive past the gym/);
  // Must be droppable and never shaming.
  assert.match(g, /drop it entirely if the moment isn't right/i);
  assert.match(g, /do not read it verbatim/i);
});

test('a check-in never fires on a mid-thread continuation', () => {
  const g = buildVoiceGreeting({ userName: 'Mike', isContinuation: true, sessionCount: 20, checkIn: 'the work thing' });
  assert.match(g, /switching to voice/i);
  assert.doesNotMatch(g, /work thing/);
});
