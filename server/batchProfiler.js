/**
 * Batch Profiler — Layer 3 of the intelligence architecture.
 *
 * A configurable-frequency job that:
 *   1. Reads craving_events, session_reports, biometric_anomalies from Supabase
 *   2. Segments the user's history into journey phases (Layer 4)
 *   3. Computes a compact context profile artifact
 *   4. Writes user_context_profiles — the thing the real-time agent reads cheaply
 *
 * Frequency is the single cost knob. Run less often = cheaper but staler context.
 * Incremental by default (only processes events since last batch_version).
 *
 * Usage: node batchProfiler.js [--user <userId>] [--full]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = resolve(__dirname, '.env');
try {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const client = new Anthropic();

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  return res.ok ? res.json() : [];
}

async function supabaseUpsert(table, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(data),
  });
}

// ─── Phase segmentation ─────────────────────────────────────────────────────────

function segmentPhases(events) {
  if (events.length === 0) return [];

  const phases = [];
  let currentPhase = null;

  for (const event of events) {
    const phaseType = classifyPhase(event);

    if (!currentPhase || currentPhase.phase_type !== phaseType) {
      if (currentPhase) {
        currentPhase.ended_at = event.started_at;
      }
      currentPhase = {
        phase_type: phaseType,
        started_at: event.started_at,
        ended_at: null,
        event_count: 0,
        resist_count: 0,
        submit_count: 0,
        intensities: [],
      };
      phases.push(currentPhase);
    }

    currentPhase.event_count++;
    if (event.outcome === 'resisted') currentPhase.resist_count++;
    if (event.outcome === 'submitted') currentPhase.submit_count++;
    if (event.intensity_start != null) currentPhase.intensities.push(event.intensity_start);
  }

  return phases.map(p => ({
    ...p,
    avg_intensity: p.intensities.length > 0
      ? p.intensities.reduce((a, b) => a + b, 0) / p.intensities.length
      : null,
    intensities: undefined,
  }));
}

function classifyPhase(event) {
  if (event.outcome === 'submitted') return 'relapse';
  if (event.outcome === 'resisted') return 'active_resistance';
  return 'tapering';
}

// ─── Risk fingerprint ───────────────────────────────────────────────────────────

function computeRiskFingerprint(events) {
  const hourCounts = {};
  const dayOfWeekCounts = {};
  const triggerCounts = {};

  for (const event of events) {
    if (event.outcome !== 'submitted' && event.outcome !== 'resisted') continue;

    const date = new Date(event.started_at);
    const hour = date.getHours();
    const dow = date.getDay();

    hourCounts[hour] = (hourCounts[hour] || 0) + 1;

    const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
    dayOfWeekCounts[dayName] = (dayOfWeekCounts[dayName] || 0) + 1;

    const ctx = event.trigger_context;
    if (ctx?.trigger) {
      triggerCounts[ctx.trigger] = (triggerCounts[ctx.trigger] || 0) + 1;
    }
  }

  const topHours = Object.entries(hourCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => `${Number(h) < 12 ? Number(h) || 12 : Number(h) - 12}${Number(h) < 12 ? 'am' : 'pm'}`);

  const topTriggers = Object.entries(triggerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);

  return { time_risks: topHours, trigger_risks: topTriggers, day_risks: dayOfWeekCounts };
}

// ─── What works analysis ────────────────────────────────────────────────────────

function computeWhatWorks(reports) {
  const framingCounts = {};
  const copingCounts = {};

  for (const report of reports) {
    for (const helper of (report.what_helped || [])) {
      framingCounts[helper] = (framingCounts[helper] || 0) + 1;
    }
    const style = report.preferences?.coping_style;
    if (style) copingCounts[style] = (copingCounts[style] || 0) + 1;
  }

  return {
    framings: Object.entries(framingCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k),
    coping_styles: Object.entries(copingCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k),
  };
}

// ─── Trajectory ─────────────────────────────────────────────────────────────────

function computeTrajectory(events) {
  if (events.length < 4) return 'insufficient_data';

  const recent = events.slice(0, Math.ceil(events.length / 2));
  const older = events.slice(Math.ceil(events.length / 2));

  const recentResistRate = recent.filter(e => e.outcome === 'resisted').length / recent.length;
  const olderResistRate = older.filter(e => e.outcome === 'resisted').length / older.length;

  const diff = recentResistRate - olderResistRate;
  if (diff > 0.1) return 'improving';
  if (diff < -0.1) return 'declining';
  return 'stable';
}

// ─── Build profile text ─────────────────────────────────────────────────────────

async function buildProfileText(userId, events, reports, phases, risk, whatWorks, trajectory) {
  const totalEvents = events.length;
  const resisted = events.filter(e => e.outcome === 'resisted').length;
  const resistRate = totalEvents > 0 ? Math.round((resisted / totalEvents) * 100) : 0;

  let streak = 0;
  for (const e of events) {
    if (e.outcome === 'resisted') streak++;
    else break;
  }

  const currentPhase = phases.length > 0 ? phases[phases.length - 1] : null;
  const phaseAge = currentPhase
    ? Math.round((Date.now() - new Date(currentPhase.started_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const parts = [];
  parts.push(`${totalEvents} sessions, ${resistRate}% resist rate.`);
  if (streak > 0) parts.push(`Current streak: ${streak}.`);

  if (currentPhase) {
    parts.push(`Journey: day ${phaseAge} of ${currentPhase.phase_type.replace('_', ' ')}.`);
  }

  parts.push(`Trajectory: ${trajectory}.`);

  if (risk.trigger_risks.length > 0) parts.push(`Top triggers: ${risk.trigger_risks.join(', ')}.`);
  if (risk.time_risks.length > 0) parts.push(`Riskiest times: ${risk.time_risks.join(', ')}.`);
  if (whatWorks.framings.length > 0) parts.push(`What works: ${whatWorks.framings.join(', ')}.`);
  if (whatWorks.coping_styles.length > 0) parts.push(`Preferred coping: ${whatWorks.coping_styles.join(', ')}.`);

  // Get the most recent session hint
  if (reports.length > 0 && reports[0].next_session_hint) {
    parts.push(`Hint: ${reports[0].next_session_hint}`);
  }

  return parts.join(' ');
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function profileUser(userId, fullRebuild = false) {
  console.log(`Profiling user ${userId}...`);

  // Get existing profile
  const [existingProfile] = await supabaseGet(
    `user_context_profiles?user_id=eq.${userId}&select=batch_version,events_processed`,
  );
  const lastProcessed = fullRebuild ? 0 : (existingProfile?.events_processed || 0);

  // Fetch all events (ordered newest first for streak calc, then we reverse for phase segmentation)
  const events = await supabaseGet(
    `craving_events?user_id=eq.${userId}&select=*&order=started_at.desc&limit=500`,
  );

  if (events.length <= lastProcessed && !fullRebuild) {
    console.log(`  No new events since last batch (${lastProcessed} processed). Skipping.`);
    return;
  }

  const reports = await supabaseGet(
    `session_reports?user_id=eq.${userId}&select=*&order=created_at.desc&limit=20`,
  );

  // Phase segmentation needs chronological order
  const chronological = [...events].reverse();
  const phases = segmentPhases(chronological);
  const risk = computeRiskFingerprint(events);
  const whatWorks = computeWhatWorks(reports);
  const trajectory = computeTrajectory(events);

  // Write journey phases
  for (const phase of phases) {
    await supabaseUpsert('journey_phases', {
      user_id: userId,
      ...phase,
    });
  }

  // Build profile text
  const profileText = await buildProfileText(userId, events, reports, phases, risk, whatWorks, trajectory);

  const currentPhase = phases.length > 0 ? phases[phases.length - 1] : null;
  const phaseAge = currentPhase
    ? Math.round((Date.now() - new Date(currentPhase.started_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // Write context profile
  await supabaseUpsert('user_context_profiles', {
    user_id: userId,
    updated_at: new Date().toISOString(),
    profile_text: profileText,
    journey_position: currentPhase ? `Day ${phaseAge} of ${currentPhase.phase_type}` : null,
    risk_fingerprint: risk,
    what_works: whatWorks,
    trajectory,
    batch_version: (existingProfile?.batch_version || 0) + 1,
    events_processed: events.length,
  });

  console.log(`  Profile updated: ${events.length} events, ${phases.length} phases, trajectory=${trajectory}`);
}

async function main() {
  const args = process.argv.slice(2);
  const specificUser = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;
  const fullRebuild = args.includes('--full');

  if (specificUser) {
    await profileUser(specificUser, fullRebuild);
  } else {
    // Process all users who have events
    const users = await supabaseGet('users?select=id');
    console.log(`Processing ${users.length} users...`);
    for (const user of users) {
      await profileUser(user.id, fullRebuild);
    }
  }

  console.log('Batch profiling complete.');
}

main().catch(err => {
  console.error('Batch profiler failed:', err);
  process.exit(1);
});
