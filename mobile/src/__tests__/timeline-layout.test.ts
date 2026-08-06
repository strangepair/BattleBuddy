/**
 * Pins the mission-timeline layout rules in timelineLayout.ts:
 * hour spans, empty-hour collapse, today-vs-past behavior, and label
 * precedence. Timestamps are local wall-clock strings (no Z) so hour
 * extraction is deterministic in any CI timezone.
 */
import {
  buildTimelineRows,
  entryLabel,
  fmtHour,
  fmtGapLabel,
  DEFAULT_DAY_START_HOUR,
} from '../components/dashboard/timelineLayout';
import type { ActivityLogEntry } from '../hooks/useActivityLog';

function cig(id: string, ts: string, extra: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return { type: 'cigarette', id, occurred_at: ts, ...extra };
}

function act(id: string, start: string, extra: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return { type: 'activity', id, start_time: start, ...extra };
}

const NOW = new Date('2026-08-06T16:30:00'); // 4:30 PM local

describe('buildTimelineRows', () => {
  it('today: spans from DEFAULT_DAY_START_HOUR through the current hour, collapsing empty runs', () => {
    const rows = buildTimelineRows(
      [cig('a', '2026-08-06T09:05:00'), cig('b', '2026-08-06T09:40:00'), cig('c', '2026-08-06T14:10:00')],
      true,
      NOW,
    );
    expect(rows).toEqual([
      { kind: 'gap', fromHour: DEFAULT_DAY_START_HOUR, toHour: 8 },
      { kind: 'hour', hour: 9, entries: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })] },
      { kind: 'gap', fromHour: 10, toHour: 13 },
      { kind: 'hour', hour: 14, entries: [expect.objectContaining({ id: 'c' })] },
      { kind: 'gap', fromHour: 15, toHour: 16 },
    ]);
  });

  it('today: an entry before the default start extends the span earlier', () => {
    const rows = buildTimelineRows([cig('a', '2026-08-06T05:12:00')], true, NOW);
    expect(rows[0]).toEqual({ kind: 'hour', hour: 5, entries: [expect.objectContaining({ id: 'a' })] });
    expect(rows[rows.length - 1]).toEqual({ kind: 'gap', fromHour: 6, toHour: 16 });
  });

  it('today: never renders hours after the current hour', () => {
    const rows = buildTimelineRows([cig('a', '2026-08-06T09:00:00')], true, NOW);
    for (const row of rows) {
      const maxHour = row.kind === 'hour' ? row.hour : row.toHour;
      expect(maxHour).toBeLessThanOrEqual(16);
    }
  });

  it('past day: spans only from first to last entry, no scaffolding around them', () => {
    const rows = buildTimelineRows(
      [cig('a', '2026-08-05T22:15:00'), cig('b', '2026-08-05T20:00:00')],
      false,
      NOW,
    );
    expect(rows).toEqual([
      { kind: 'hour', hour: 20, entries: [expect.objectContaining({ id: 'b' })] },
      { kind: 'gap', fromHour: 21, toHour: 21 },
      { kind: 'hour', hour: 22, entries: [expect.objectContaining({ id: 'a' })] },
    ]);
  });

  it('entries are sorted ascending within an hour and across the day', () => {
    const rows = buildTimelineRows(
      [cig('late', '2026-08-05T10:45:00'), cig('early', '2026-08-05T10:05:00')],
      false,
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('hour');
    if (rows[0].kind === 'hour') {
      expect(rows[0].entries.map((e) => e.id)).toEqual(['early', 'late']);
    }
  });

  it('empty day renders no rows — no placeholder blocks, past or today', () => {
    expect(buildTimelineRows([], false, NOW)).toEqual([]);
    expect(buildTimelineRows([], true, NOW)).toEqual([]);
  });

  it('activity entries key off start_time', () => {
    const rows = buildTimelineRows([act('g', '2026-08-05T11:20:00', { activity_name: 'Gym drive' })], false, NOW);
    expect(rows).toEqual([
      { kind: 'hour', hour: 11, entries: [expect.objectContaining({ id: 'g' })] },
    ]);
  });

  it('entries without any timestamp are skipped, not crashed on', () => {
    const bad = { type: 'cigarette', id: 'x' } as ActivityLogEntry;
    expect(buildTimelineRows([bad], false, NOW)).toEqual([]);
  });
});

describe('entryLabel', () => {
  it('cigarette: activityLabel > metadata.activityLabel > location > fallback', () => {
    expect(entryLabel(cig('a', 't', { activityLabel: 'Car', location: 'Garage' }))).toBe('Car');
    expect(entryLabel(cig('b', 't', { metadata: { activityLabel: 'Couch' } }))).toBe('Couch');
    expect(entryLabel(cig('c', 't', { location: 'Garage' }))).toBe('Garage');
    expect(entryLabel(cig('d', 't'))).toBe('Cigarette');
  });

  it('activity: uses activity_name with a fallback', () => {
    expect(entryLabel(act('a', 't', { activity_name: 'Gym drive' }))).toBe('Gym drive');
    expect(entryLabel(act('b', 't'))).toBe('Activity');
  });
});

describe('hour formatting', () => {
  it('formats 12-hour labels', () => {
    expect(fmtHour(0)).toBe('12 AM');
    expect(fmtHour(7)).toBe('7 AM');
    expect(fmtHour(12)).toBe('12 PM');
    expect(fmtHour(16)).toBe('4 PM');
  });

  it('formats gap ranges, collapsing single-hour gaps', () => {
    expect(fmtGapLabel(9, 9)).toBe('9 AM');
    expect(fmtGapLabel(10, 13)).toBe('10 AM – 1 PM');
  });
});
