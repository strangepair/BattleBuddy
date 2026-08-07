/**
 * Pins the fixed-hour time-grid rules in timelineLayout.ts: minute offsets,
 * the 5-minute visual floor, duration sizing from start+end pairs, overlap
 * lanes, and grid heights (past days = full 24 h, today ends at NOW).
 * Timestamps are local wall-clock strings (no Z) so hour extraction is
 * deterministic in any CI timezone.
 */
import {
  layoutDayBlocks,
  dayGridHeight,
  visibleHours,
  entryLabel,
  entryEndTimestamp,
  fmtHour,
  MINUTE_HEIGHT,
  HOUR_HEIGHT,
  DAY_GRID_HEIGHT,
  MIN_EVENT_MINUTES,
} from '../components/dashboard/timelineLayout';
import type { ActivityLogEntry } from '../hooks/useActivityLog';

function cig(id: string, ts: string, extra: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return { type: 'cigarette', id, occurred_at: ts, ...extra };
}

function act(id: string, start: string, extra: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return { type: 'activity', id, start_time: start, ...extra };
}

const NOW = new Date('2026-08-06T16:30:00'); // 4:30 PM local

describe('layoutDayBlocks', () => {
  it('positions a block at its minute-of-day offset', () => {
    const [b] = layoutDayBlocks([cig('a', '2026-08-06T09:05:00')]);
    expect(b.startMinute).toBe(9 * 60 + 5);
  });

  it('floors instant logs at the 5-minute visual minimum', () => {
    const [b] = layoutDayBlocks([cig('a', '2026-08-06T09:05:00')]);
    expect(b.spanMinutes).toBe(MIN_EVENT_MINUTES);
    expect(b.hasDuration).toBe(false);
  });

  it('sizes an activity with start+end by its real duration', () => {
    const [b] = layoutDayBlocks([
      act('gym', '2026-08-06T14:00:00', { end_time: '2026-08-06T14:45:00', activity_name: 'Gym' }),
    ]);
    expect(b.spanMinutes).toBe(45);
    expect(b.hasDuration).toBe(true);
  });

  it('a duration shorter than the floor still renders at the floor', () => {
    const [b] = layoutDayBlocks([
      act('sip', '2026-08-06T14:00:00', { end_time: '2026-08-06T14:02:00' }),
    ]);
    expect(b.spanMinutes).toBe(MIN_EVENT_MINUTES);
    expect(b.hasDuration).toBe(true);
  });

  it("honors a cigarette's metadata end_time / duration_minutes", () => {
    const [byEnd] = layoutDayBlocks([
      cig('a', '2026-08-06T10:00:00', { metadata: { end_time: '2026-08-06T10:20:00' } }),
    ]);
    expect(byEnd.spanMinutes).toBe(20);
    const [byDur] = layoutDayBlocks([
      cig('b', '2026-08-06T10:00:00', { metadata: { duration_minutes: 12 } }),
    ]);
    expect(byDur.spanMinutes).toBe(12);
  });

  it('clamps a span that would run past midnight', () => {
    const [b] = layoutDayBlocks([
      act('late', '2026-08-06T23:30:00', { end_time: '2026-08-07T01:00:00' }),
    ]);
    expect(b.startMinute + b.spanMinutes).toBe(24 * 60);
  });

  it('gives overlapping blocks separate lanes at shared width', () => {
    const blocks = layoutDayBlocks([
      act('a', '2026-08-06T14:00:00', { end_time: '2026-08-06T15:00:00' }),
      cig('b', '2026-08-06T14:30:00'),
    ]);
    const lanes = blocks.map((b) => b.lane).sort();
    expect(lanes).toEqual([0, 1]);
    expect(blocks.every((b) => b.laneCount === 2)).toBe(true);
  });

  it('non-overlapping blocks keep full width (laneCount 1)', () => {
    const blocks = layoutDayBlocks([
      cig('a', '2026-08-06T09:00:00'),
      cig('b', '2026-08-06T11:00:00'),
    ]);
    expect(blocks.every((b) => b.lane === 0 && b.laneCount === 1)).toBe(true);
  });

  it('skips entries without a parseable timestamp', () => {
    const bad = { type: 'cigarette', id: 'x' } as ActivityLogEntry;
    expect(layoutDayBlocks([bad])).toEqual([]);
  });
});

describe('dayGridHeight / visibleHours', () => {
  it('past days always render the full 24-hour grid', () => {
    expect(dayGridHeight(false, NOW)).toBe(DAY_GRID_HEIGHT);
    expect(visibleHours(DAY_GRID_HEIGHT)).toHaveLength(24);
  });

  it("today's grid ends at the current minute (the NOW line)", () => {
    expect(dayGridHeight(true, NOW)).toBe((16 * 60 + 30) * MINUTE_HEIGHT);
  });

  it('today shows hour marks up to the current hour only', () => {
    const hours = visibleHours(dayGridHeight(true, NOW));
    expect(hours[hours.length - 1]).toBe(16);
  });

  it('hour height is uniform — the grid is proportional', () => {
    expect(HOUR_HEIGHT).toBe(60 * MINUTE_HEIGHT);
    expect(DAY_GRID_HEIGHT).toBe(24 * HOUR_HEIGHT);
  });
});

describe('entry helpers', () => {
  it('entryEndTimestamp reads activity end_time and cigarette metadata', () => {
    expect(entryEndTimestamp(act('a', 't', { end_time: 'e' }))).toBe('e');
    expect(entryEndTimestamp(cig('b', 't', { metadata: { end_time: 'e2' } }))).toBe('e2');
    expect(entryEndTimestamp(cig('c', 't'))).toBeNull();
  });

  it('cigarette label precedence: activityLabel > metadata.activityLabel > location > fallback', () => {
    expect(entryLabel(cig('a', 't', { activityLabel: 'Car', location: 'Garage' }))).toBe('Car');
    expect(entryLabel(cig('b', 't', { metadata: { activityLabel: 'Couch' } }))).toBe('Couch');
    expect(entryLabel(cig('c', 't', { location: 'Garage' }))).toBe('Garage');
    expect(entryLabel(cig('d', 't'))).toBe('Cigarette');
  });

  it('activity label uses activity_name with a fallback', () => {
    expect(entryLabel(act('a', 't', { activity_name: 'Gym drive' }))).toBe('Gym drive');
    expect(entryLabel(act('b', 't'))).toBe('Activity');
  });

  it('formats 12-hour labels', () => {
    expect(fmtHour(0)).toBe('12 AM');
    expect(fmtHour(12)).toBe('12 PM');
    expect(fmtHour(16)).toBe('4 PM');
  });
});
