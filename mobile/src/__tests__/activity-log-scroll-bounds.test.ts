/**
 * Asserts that the timeline's minimum scroll date equals the account creation
 * date once all pages have loaded, and that no future dates appear beyond today.
 *
 * Tests the pure helpers inlined from useActivityLog.ts so the hook's React
 * dependencies don't need to be set up.
 */

function isoDate(ts: string): string {
  return ts.slice(0, 10);
}

interface ActivityLogEntry {
  type: 'cigarette' | 'activity';
  id: string;
  occurred_at?: string;
  start_time?: string;
}

interface DayBucket {
  date: string;
  entries: ActivityLogEntry[];
}

function fillEmptyDays(buckets: DayBucket[], from: string, to: string): DayBucket[] {
  const filled: DayBucket[] = [];
  const existing = new Map(buckets.map((b) => [b.date, b]));
  const cursor = new Date(`${to}T00:00:00Z`);
  const stop = new Date(`${from}T00:00:00Z`);
  while (cursor >= stop) {
    const d = cursor.toISOString().slice(0, 10);
    filled.push(existing.get(d) ?? { date: d, entries: [] });
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return filled;
}

function buildAllDays(
  historyBuckets: DayBucket[],
  todayBucket: DayBucket,
  hasMore: boolean,
  accountStart: string,
): DayBucket[] {
  if (historyBuckets.length === 0) return [todayBucket];
  const newestHistory = historyBuckets[0]?.date ?? todayBucket.date;
  const oldestLoaded = historyBuckets[historyBuckets.length - 1]?.date ?? todayBucket.date;
  const fillFrom = hasMore ? oldestLoaded : accountStart;
  const historyFilled = fillEmptyDays(historyBuckets, fillFrom, newestHistory);
  return [todayBucket, ...historyFilled];
}

const TODAY = '2026-08-03';

describe('useActivityLog scroll bounds', () => {
  it('minimum day equals account creation date when all pages loaded (hasMore=false)', () => {
    const accountCreatedAt = '2026-07-01';
    const todayBucket: DayBucket = { date: TODAY, entries: [] };
    const historyBuckets: DayBucket[] = [
      { date: '2026-07-15', entries: [{ type: 'cigarette', id: 'c1', occurred_at: '2026-07-15T10:00:00Z' }] },
      { date: '2026-07-10', entries: [{ type: 'cigarette', id: 'c2', occurred_at: '2026-07-10T08:00:00Z' }] },
    ];

    const days = buildAllDays(historyBuckets, todayBucket, false, accountCreatedAt);
    const minDate = days[days.length - 1].date;

    expect(minDate).toBe(accountCreatedAt);
  });

  it('does not extend past account creation date', () => {
    const accountCreatedAt = '2026-07-20';
    const todayBucket: DayBucket = { date: TODAY, entries: [] };
    const historyBuckets: DayBucket[] = [
      { date: '2026-07-25', entries: [] },
      { date: '2026-07-22', entries: [] },
    ];

    const days = buildAllDays(historyBuckets, todayBucket, false, accountCreatedAt);
    const minDate = days[days.length - 1].date;

    expect(minDate).toBe(accountCreatedAt);
  });

  it('does not render future dates beyond today', () => {
    const accountCreatedAt = '2026-07-01';
    const todayBucket: DayBucket = { date: TODAY, entries: [] };
    const historyBuckets: DayBucket[] = [
      { date: '2026-07-30', entries: [] },
    ];

    const days = buildAllDays(historyBuckets, todayBucket, false, accountCreatedAt);
    const futureDays = days.filter((d) => d.date > TODAY);

    expect(futureDays).toHaveLength(0);
  });

  it('when more pages remain (hasMore=true) fills only up to oldestLoaded', () => {
    const accountCreatedAt = '2026-06-01';
    const todayBucket: DayBucket = { date: TODAY, entries: [] };
    const historyBuckets: DayBucket[] = [
      { date: '2026-07-20', entries: [] },
      { date: '2026-07-15', entries: [] },
    ];

    const days = buildAllDays(historyBuckets, todayBucket, true, accountCreatedAt);
    const minDate = days[days.length - 1].date;

    expect(minDate).toBe('2026-07-15');
    expect(minDate).not.toBe(accountCreatedAt);
  });

  it('events on each day are present after gap-filling', () => {
    const accountCreatedAt = '2026-07-28';
    const todayBucket: DayBucket = { date: TODAY, entries: [] };
    const entry: ActivityLogEntry = { type: 'cigarette', id: 'c3', occurred_at: '2026-07-30T09:00:00Z' };
    const historyBuckets: DayBucket[] = [
      { date: '2026-07-30', entries: [entry] },
    ];

    const days = buildAllDays(historyBuckets, todayBucket, false, accountCreatedAt);
    const jul30 = days.find((d) => d.date === '2026-07-30');

    expect(jul30).toBeDefined();
    expect(jul30!.entries[0].id).toBe('c3');
  });

  it('entry keys are stable (each day bucket has a unique date string)', () => {
    const accountCreatedAt = '2026-07-25';
    const todayBucket: DayBucket = { date: TODAY, entries: [] };
    const historyBuckets: DayBucket[] = [
      { date: '2026-07-28', entries: [] },
      { date: '2026-07-25', entries: [] },
    ];

    const days = buildAllDays(historyBuckets, todayBucket, false, accountCreatedAt);
    const keys = days.map((d) => d.date);
    const uniqueKeys = new Set(keys);

    expect(uniqueKeys.size).toBe(keys.length);
  });

  it('isoDate extracts YYYY-MM-DD from ISO timestamp', () => {
    expect(isoDate('2026-08-03T14:30:00Z')).toBe('2026-08-03');
    expect(isoDate('2026-07-01T00:00:00.000Z')).toBe('2026-07-01');
  });
});
