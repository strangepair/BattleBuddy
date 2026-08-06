import type { ActivityLogEntry } from '../../hooks/useActivityLog';

/**
 * Pure layout helpers for DayTimelineSection.
 *
 * A day renders as a list of rows: hour rows (hours that contain entries)
 * and gap rows (runs of empty hours collapsed into a single slim divider).
 * Keeping this logic pure lets timeline-layout.test.ts pin the span and
 * collapse rules without mounting React Native components.
 */

export type TimelineRow =
  | { kind: 'hour'; hour: number; entries: ActivityLogEntry[] }
  | { kind: 'gap'; fromHour: number; toHour: number };

/** Earliest hour today's timeline starts at when no entry precedes it. */
export const DEFAULT_DAY_START_HOUR = 7;

export function entryTimestamp(e: ActivityLogEntry): string | null {
  return e.occurred_at ?? e.start_time ?? null;
}

export function entryLabel(e: ActivityLogEntry): string {
  if (e.type === 'activity') return e.activity_name ?? 'Activity';
  return (
    e.activityLabel ??
    (e.metadata?.activityLabel as string | undefined) ??
    e.location ??
    (e.metadata?.location as string | undefined) ??
    'Cigarette'
  );
}

export function fmtHour(h: number): string {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${suffix}`;
}

export function fmtGapLabel(fromHour: number, toHour: number): string {
  if (fromHour === toHour) return fmtHour(fromHour);
  return `${fmtHour(fromHour)} – ${fmtHour(toHour)}`;
}

/**
 * Build the row list for one day.
 *
 * Span rules:
 *  - today: from min(first entry hour, DEFAULT_DAY_START_HOUR, now hour)
 *    through the current hour — future hours don't exist yet.
 *  - past day: from its first entry's hour through its last entry's hour.
 *  - a day with no entries renders no rows (the section shows its own
 *    empty state); no placeholder blocks are ever injected.
 *
 * Entries are sorted ascending within their hour. Consecutive empty hours
 * collapse into one gap row.
 */
export function buildTimelineRows(
  entries: ActivityLogEntry[],
  isToday: boolean,
  now: Date = new Date(),
): TimelineRow[] {
  const dated = entries
    .map((e) => {
      const ts = entryTimestamp(e);
      return ts ? { e, d: new Date(ts) } : null;
    })
    .filter((x): x is { e: ActivityLogEntry; d: Date } => x !== null && !Number.isNaN(x.d.getTime()))
    .sort((a, b) => a.d.getTime() - b.d.getTime());

  if (dated.length === 0 && !isToday) return [];

  const nowHour = now.getHours();
  let start: number;
  let end: number;
  if (dated.length === 0) {
    // Today with nothing logged yet — no hour scaffolding, just the empty state.
    return [];
  } else if (isToday) {
    start = Math.min(dated[0].d.getHours(), DEFAULT_DAY_START_HOUR, nowHour);
    end = Math.max(nowHour, dated[dated.length - 1].d.getHours());
  } else {
    start = dated[0].d.getHours();
    end = dated[dated.length - 1].d.getHours();
  }

  const byHour = new Map<number, ActivityLogEntry[]>();
  for (const { e, d } of dated) {
    const h = d.getHours();
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(e);
  }

  const rows: TimelineRow[] = [];
  let gapStart: number | null = null;
  for (let h = start; h <= end; h++) {
    const inHour = byHour.get(h);
    if (inHour && inHour.length > 0) {
      if (gapStart !== null) {
        rows.push({ kind: 'gap', fromHour: gapStart, toHour: h - 1 });
        gapStart = null;
      }
      rows.push({ kind: 'hour', hour: h, entries: inHour });
    } else if (gapStart === null) {
      gapStart = h;
    }
  }
  if (gapStart !== null) {
    rows.push({ kind: 'gap', fromHour: gapStart, toHour: end });
  }
  return rows;
}
