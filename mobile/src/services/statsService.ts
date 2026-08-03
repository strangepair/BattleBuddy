import { ApiConfig } from '../config';

export interface ArcPoint {
  date: string;
  count: number;
  isSlip?: boolean;
}

export interface JourneyArc {
  baseline: number;
  points: ArcPoint[];
}

export interface HeatmapData {
  rowLabels: string[];
  colLabels: string[];
  /** 0–1 intensity, [row][col]. */
  values: number[][];
}

export interface WorksItem {
  name: string;
  succeeded: number;
  total: number;
}

export interface IndependenceWeek {
  label: string;
  selfInitiated: number;
  prompted: number;
}

export interface JourneyData {
  arc: JourneyArc;
  heatmap: HeatmapData;
  whatWorks: WorksItem[];
  independence: IndependenceWeek[];
}

export interface Insight {
  id: string;
  text: string;
  /** Passed as trigger context when the user taps "talk about this". */
  triggerContext: string;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${ApiConfig.CHAT_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── /stats/all — the One Conversation dashboard's single round-trip ─────────
// Server shape (buildJourneyStats in server/index.js) differs from the chart
// component types above, so adapters map days→points and raw heat counts→0-1.

export interface StatsAllResponse {
  sleep_window: { start: string; end: string };
  journey: { days: { date: string; count: number }[]; baseline: number };
  heatmap: { rows: string[]; cols: string[]; data: number[][] };
  records: {
    longest_waking_gap_ms: number;
    longest_waking_gap_at: string | null;
    current_waking_gap_ms: number;
    best_week_resists: number;
    note?: string;
  };
}

export async function fetchStatsAll(
  userId: string | null,
  timezone?: string,
): Promise<StatsAllResponse | null> {
  if (!userId) return null;
  const tz = timezone ?? (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Chicago'; }
  })();
  const data = await fetchJson<StatsAllResponse>(
    `/stats/all?userId=${encodeURIComponent(userId)}&timezone=${encodeURIComponent(tz)}`,
  );
  if (
    data &&
    data.journey && Array.isArray(data.journey.days) &&
    data.heatmap && Array.isArray(data.heatmap.data) &&
    data.records && typeof data.records.current_waking_gap_ms === 'number'
  ) {
    return data;
  }
  return null;
}

export function arcFromStatsAll(stats: StatsAllResponse): JourneyArc {
  return {
    baseline: stats.journey.baseline,
    points: stats.journey.days.map((d) => ({ date: d.date, count: d.count })),
  };
}

export function heatmapFromStatsAll(stats: StatsAllResponse): HeatmapData {
  const max = Math.max(1, ...stats.heatmap.data.flat());
  return {
    rowLabels: stats.heatmap.rows,
    colLabels: stats.heatmap.cols,
    values: stats.heatmap.data.map((row) => row.map((v) => v / max)),
  };
}

/** "2h 41m" from milliseconds — the waking-gap tiles and records. */
export function formatGapMs(ms: number): string {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
