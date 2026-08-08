import type { ActivityLogEntry } from '../../hooks/useActivityLog';

/**
 * Pure layout math for the fixed-hour time grid (DayTimelineSection).
 *
 * Every hour of every day is a uniform fixed height — a true proportional
 * time grid (no collapsing of quiet hours). Events become absolutely
 * positioned blocks: top = minute offset, height = real duration when a
 * start AND end are known, floored at MIN_EVENT_MINUTES so instant logs
 * stay visible. Overlapping blocks share horizontal lanes.
 *
 * Keeping this pure lets timeline-layout.test.ts pin the offsets, the
 * 5-minute floor, duration sizing, and lane assignment without mounting
 * React Native components.
 */

export const MINUTE_HEIGHT = 2.5;
export const HOUR_HEIGHT = 60 * MINUTE_HEIGHT;
export const DAY_GRID_HEIGHT = 24 * HOUR_HEIGHT;
export const MIN_EVENT_MINUTES = 5;
export const MIN_BLOCK_HEIGHT = 48;

export interface TimelineBlock {
  entry: ActivityLogEntry;
  /** Minutes after midnight the block starts at. */
  startMinute: number;
  /** Rendered span in minutes (real duration, floored at MIN_EVENT_MINUTES). */
  spanMinutes: number;
  /** True when the span comes from a real start+end pair, not the floor. */
  hasDuration: boolean;
  /** Horizontal lane index within its overlap cluster (0-based). */
  lane: number;
  /** Total lanes in the block's overlap cluster (≥1). */
  laneCount: number;
}

export function entryTimestamp(e: ActivityLogEntry): string | null {
  return e.occurred_at ?? e.start_time ?? null;
}

/** End timestamp when the log carries one (activities' end_time, or a cigarette's metadata). */
export function entryEndTimestamp(e: ActivityLogEntry): string | null {
  if (e.type === 'activity') return e.end_time ?? null;
  const metaEnd = e.metadata?.end_time;
  return typeof metaEnd === 'string' ? metaEnd : null;
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

function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Real duration in minutes, from start+end or a cigarette's metadata.duration_minutes. */
function realDurationMinutes(e: ActivityLogEntry, start: Date): number | null {
  const endTs = entryEndTimestamp(e);
  if (endTs) {
    const end = new Date(endTs);
    if (!Number.isNaN(end.getTime())) {
      const min = (end.getTime() - start.getTime()) / 60_000;
      if (min > 0) return min;
    }
  }
  const metaDur = e.type === 'cigarette' ? e.metadata?.duration_minutes : undefined;
  if (typeof metaDur === 'number' && metaDur > 0) return metaDur;
  return null;
}

/**
 * Lay out one day's entries on the fixed grid.
 *
 * Blocks are clamped to the day (span past midnight is cut at 24:00).
 * Overlap lanes are assigned greedily within transitive overlap clusters,
 * so two simultaneous events sit side by side at half width each while
 * isolated events keep the full width.
 */
export function layoutDayBlocks(entries: ActivityLogEntry[]): TimelineBlock[] {
  const dated = entries
    .map((e) => {
      const ts = entryTimestamp(e);
      if (!ts) return null;
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return null;
      const startMinute = minuteOfDay(d);
      const dur = realDurationMinutes(e, d);
      const spanMinutes = Math.min(
        Math.max(dur ?? 0, MIN_EVENT_MINUTES),
        24 * 60 - startMinute,
      );
      return {
        entry: e,
        startMinute,
        spanMinutes,
        hasDuration: dur !== null,
        lane: 0,
        laneCount: 1,
      };
    })
    .filter((b): b is TimelineBlock => b !== null)
    .sort((a, b) => a.startMinute - b.startMinute || a.spanMinutes - b.spanMinutes);

  // Cluster transitively-overlapping blocks, then greedily assign lanes
  // within each cluster.
  let clusterStart = 0;
  let clusterEnd = -1;
  const flush = (from: number, to: number) => {
    const laneEnds: number[] = [];
    for (let i = from; i < to; i++) {
      const b = dated[i];
      let lane = laneEnds.findIndex((end) => end <= b.startMinute);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = b.startMinute + b.spanMinutes;
      b.lane = lane;
    }
    for (let i = from; i < to; i++) dated[i].laneCount = laneEnds.length;
  };
  for (let i = 0; i < dated.length; i++) {
    const b = dated[i];
    if (b.startMinute >= clusterEnd && i > clusterStart) {
      flush(clusterStart, i);
      clusterStart = i;
      clusterEnd = -1;
    }
    clusterEnd = Math.max(clusterEnd, b.startMinute + b.spanMinutes);
  }
  if (dated.length > 0) flush(clusterStart, dated.length);

  return dated;
}

/**
 * Height in px of a day's grid. Past days always render the full 24 hours;
 * today's grid runs midnight → the current minute (the NOW line is the
 * bottom edge — future hours don't exist yet).
 */
export function dayGridHeight(isToday: boolean, now: Date = new Date()): number {
  if (!isToday) return DAY_GRID_HEIGHT;
  return Math.max(minuteOfDay(now) * MINUTE_HEIGHT, HOUR_HEIGHT);
}

/** Hour marks (0..23) that fall inside a grid of the given px height. */
export function visibleHours(gridHeight: number): number[] {
  const hours: number[] = [];
  for (let h = 0; h < 24; h++) {
    if (h * HOUR_HEIGHT < gridHeight) hours.push(h);
  }
  return hours;
}
