/**
 * Log Watcher v2 — simple, reliable transcript extraction from agent logs.
 *
 * Polls the agent log every 10 seconds. When a new "session closed" event appears,
 * extracts the conversation for that room and sends it to the context agent.
 *
 * Usage: node logWatcher.js <agent-log-file>
 */

import { readFileSync, statSync } from 'node:fs';
import { analyzeAndUpdate, buildProfileSummary } from './contextAgent.js';

const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: node logWatcher.js <agent-log-file>');
  process.exit(1);
}

const processedRooms = new Set();

// On startup, scan the entire log to find already-processed rooms
// (so we don't re-process old sessions)
try {
  const existingLog = readFileSync(logFile, 'utf-8');
  const closeMatches = existingLog.matchAll(/session closed.*?"room": "(bb-\d+)"/g);
  for (const m of closeMatches) {
    processedRooms.add(m[1]);
  }
  console.log(`[LogWatcher] Started. ${processedRooms.size} existing sessions marked as processed.`);
} catch {
  console.log('[LogWatcher] Started. No existing log found.');
}

async function processNewSessions() {
  try {
    const log = readFileSync(logFile, 'utf-8');
    const lines = log.split('\n');

    // Find all session closed events
    for (const line of lines) {
      if (!line.includes('session closed')) continue;
      const roomMatch = line.match(/"room": "(bb-\d+)"/);
      if (!roomMatch) continue;
      const roomName = roomMatch[1];

      if (processedRooms.has(roomName)) continue;
      processedRooms.add(roomName);

      // Extract messages for this room
      const messages = [];
      for (const l of lines) {
        if (!l.includes(roomName) || !l.includes('conversation_item_added')) continue;
        const roleMatch = l.match(/"role": "(user|assistant)"/);
        const textMatch = l.match(/"text": "(.*?)"(?:,\s*"pid)/s);
        if (roleMatch && textMatch) {
          messages.push({
            role: roleMatch[1],
            content: textMatch[1].replace(/\\n/g, '\n'),
          });
        }
      }

      if (messages.length < 2) {
        console.log(`[LogWatcher] Room ${roomName}: only ${messages.length} messages, skipping.`);
        continue;
      }

      // Extract userId
      let userId = 'default';
      for (const l of lines) {
        if (!l.includes(roomName)) continue;
        const pm = l.match(/"participant": "(user-\d+)"/);
        if (pm) { userId = pm[1]; break; }
      }

      console.log(`[LogWatcher] Room ${roomName} closed. ${messages.length} messages for ${userId}. Analyzing...`);

      try {
        await analyzeAndUpdate(userId, messages, true);
        const summary = buildProfileSummary(userId);
        console.log(`[LogWatcher] Profile updated for ${userId}: ${summary.substring(0, 150)}...`);
      } catch (e) {
        console.error(`[LogWatcher] Analysis failed for ${roomName}: ${e.message}`);
      }
    }
  } catch (e) {
    // File read error — ignore
  }
}

// Poll every 10 seconds
setInterval(processNewSessions, 10000);

// Also run once immediately for any sessions that closed while the watcher was down
setTimeout(processNewSessions, 2000);

process.on('SIGINT', () => process.exit(0));
console.log('[LogWatcher] Polling every 10 seconds.');
