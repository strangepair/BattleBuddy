import { ApiConfig } from '../config';

// Personal Records Wall, Journey screen, and Insight card data. The
// /stats/records, /stats/journey, and /insights endpoints don't exist on
// bb-server yet (see docs/08-UX-AGENT-EXPERIENCE-PLAN.md §5/§7) — every
// fetch here attempts the real endpoint first and falls back to realistic
// placeholder data so the UI is fully built and ready to connect the moment
// batchProfiler.js grows the records/insight-synthesis engine.

export interface RecordStat {
  key: 'longest_stretch' | 'most_urges_day' | 'most_urges_week' | 'lowest_day';
  icon: string;
  value: string;
  unit: string;
  setDate: string;
  context?: string;
  /** True when this record was just broken — drives the celebration banner. */
  isNew?: boolean;
}

export interface Milestone {
  key: string;
  title: string;
  /** null = locked/not yet unlocked. */
  unlockedAt: string | null;
  detail?: string;
}

export interface RecordsData {
  records: RecordStat[];
  milestones: Milestone[];
}

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

const PLACEHOLDER_RECORDS: RecordsData = {
  records: [
    {
      key: 'longest_stretch',
      icon: 'time-outline',
      value: '14h 20m',
      unit: 'Longest stretch between cigarettes',
      setDate: '2026-07-02',
      context: 'Stayed busy after the gym',
      isNew: true,
    },
    {
      key: 'most_urges_day',
      icon: 'water-outline',
      value: '6',
      unit: 'Most urges ridden out — one day',
      setDate: '2026-06-28',
    },
    {
      key: 'most_urges_week',
      icon: 'trending-up-outline',
      value: '23',
      unit: 'Most urges ridden out — one week',
      setDate: '2026-07-04',
    },
    {
      key: 'lowest_day',
      icon: 'locate-outline',
      value: '9',
      unit: 'Lowest day (baseline: 30)',
      setDate: '2026-06-30',
      context: '70% below baseline',
    },
  ],
  milestones: [
    {
      key: 'top_trigger',
      title: "Identified your top trigger",
      unlockedAt: '2026-06-15',
      detail: 'Evenings, right after the patch comes off',
    },
    {
      key: 'three_coping_moves',
      title: '3 coping moves that work for you',
      unlockedAt: '2026-06-22',
      detail: 'Garage walk, cold water, calling Alec',
    },
    {
      key: 'ten_urges',
      title: "Ridden out 10 urges",
      unlockedAt: '2026-06-25',
    },
    {
      key: 'no_session_urge',
      title: 'Handled an urge with no session at all',
      unlockedAt: null,
      detail: "Not yet — this one's on you",
    },
    {
      key: 'thirty_days_honest',
      title: '30 days of honest logging',
      unlockedAt: '2026-07-03',
      detail: 'Slips counted too',
    },
  ],
};

const PLACEHOLDER_JOURNEY: JourneyData = {
  arc: {
    baseline: 30,
    points: [
      { date: '2026-06-24', count: 28 },
      { date: '2026-06-25', count: 26 },
      { date: '2026-06-26', count: 24 },
      { date: '2026-06-27', count: 22 },
      { date: '2026-06-28', count: 20 },
      { date: '2026-06-29', count: 18 },
      { date: '2026-06-30', count: 9 },
      { date: '2026-07-01', count: 19 },
      { date: '2026-07-02', count: 16, isSlip: true },
      { date: '2026-07-03', count: 14 },
      { date: '2026-07-04', count: 12 },
      { date: '2026-07-05', count: 11 },
      { date: '2026-07-06', count: 10 },
    ],
  },
  heatmap: {
    rowLabels: ['AM', 'Mid', 'Aft', 'Eve', 'Night'],
    colLabels: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
    values: [
      [0.25, 0.4, 0.35, 0.4, 0.3, 0.2, 0.15],
      [0.15, 0.2, 0.2, 0.25, 0.2, 0.3, 0.3],
      [0.3, 0.35, 0.3, 0.3, 0.35, 0.4, 0.45],
      [0.85, 0.95, 0.9, 1, 0.9, 0.7, 0.6],
      [0.2, 0.15, 0.15, 0.2, 0.15, 0.25, 0.3],
    ],
  },
  whatWorks: [
    { name: 'Garage walk', succeeded: 8, total: 10 },
    { name: 'Rule of Three breathing', succeeded: 6, total: 9 },
    { name: 'Calling Alec', succeeded: 4, total: 5 },
    { name: 'Cold water', succeeded: 3, total: 6 },
  ],
  independence: [
    { label: 'Wk 1', selfInitiated: 20, prompted: 80 },
    { label: 'Wk 2', selfInitiated: 35, prompted: 65 },
    { label: 'Wk 3', selfInitiated: 50, prompted: 50 },
    { label: 'Wk 4', selfInitiated: 65, prompted: 35 },
  ],
};

const PLACEHOLDER_INSIGHTS: Insight[] = [
  {
    id: 'evening-window',
    text: 'Your evenings around 5pm keep coming up as the hardest stretch — right when the patch comes off.',
    triggerContext: 'Talking about the 5pm patch-off window being the hardest stretch of the day',
  },
  {
    id: 'garage-walk',
    text: "Walking the garage loop worked 8 of the last 10 times you tried it. That's your best move right now.",
    triggerContext: 'Talking about why the garage walk keeps working as a coping move',
  },
  {
    id: 'honest-logging',
    text: "You've logged every day for 19 days straight, slips included. That kind of honesty is rare — and it's exactly what makes this work.",
    triggerContext: 'Talking about the 19-day honest logging streak, slips included',
  },
];

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${ApiConfig.CHAT_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// The live /stats endpoints (server buildJourneyStats) answer in a different
// shape than these UI types — /stats/journey is {journey:{days,baseline}},
// /stats/records is a gap-metrics object, not RecordStat[]. Validate before
// trusting, or a real signed-in userId crashes every chart that maps over a
// field that isn't there. fetchStatsAll below speaks the live shape natively.
export async function fetchRecords(userId: string | null): Promise<RecordsData> {
  if (!userId) return PLACEHOLDER_RECORDS;
  const data = await fetchJson<RecordsData>(`/stats/records?userId=${encodeURIComponent(userId)}`);
  if (data && Array.isArray(data.records) && Array.isArray(data.milestones)) return data;
  return PLACEHOLDER_RECORDS;
}

export async function fetchJourney(userId: string | null): Promise<JourneyData> {
  if (!userId) return PLACEHOLDER_JOURNEY;
  const data = await fetchJson<JourneyData>(`/stats/journey?userId=${encodeURIComponent(userId)}`);
  if (
    data &&
    data.arc && Array.isArray(data.arc.points) &&
    data.heatmap && Array.isArray(data.heatmap.values) &&
    Array.isArray(data.whatWorks) &&
    Array.isArray(data.independence)
  ) {
    return data;
  }
  return PLACEHOLDER_JOURNEY;
}

export async function fetchInsights(userId: string | null): Promise<Insight[]> {
  if (!userId) return PLACEHOLDER_INSIGHTS;
  const data = await fetchJson<Insight[]>(`/insights?userId=${encodeURIComponent(userId)}`);
  return Array.isArray(data) ? data : PLACEHOLDER_INSIGHTS;
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
