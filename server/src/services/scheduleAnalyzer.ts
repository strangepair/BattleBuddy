import type { ResistanceBlock } from '../db/schema.js';

export interface ScheduleWindow {
  start: string;
  end: string;
  blockCount: number;
  avgCleanBlocksPercent: number;
}

export interface ScheduleAnalysisResult {
  windows: ScheduleWindow[];
  insufficientData: boolean;
}

interface SupabaseClient {
  from(table: string): SupabaseQueryBuilder;
}

interface SupabaseQueryBuilder {
  select(cols?: string): SupabaseQueryBuilder;
  eq(col: string, val: unknown): SupabaseQueryBuilder;
  gte(col: string, val: unknown): SupabaseQueryBuilder;
  then(resolve: (result: { data: unknown; error: unknown }) => void): void;
}

const WINDOWS: Array<{ start: string; end: string; startHour: number; endHour: number }> = [
  { start: '00:00', end: '03:00', startHour: 0, endHour: 3 },
  { start: '03:00', end: '06:00', startHour: 3, endHour: 6 },
  { start: '06:00', end: '09:00', startHour: 6, endHour: 9 },
  { start: '09:00', end: '12:00', startHour: 9, endHour: 12 },
  { start: '12:00', end: '15:00', startHour: 12, endHour: 15 },
  { start: '15:00', end: '18:00', startHour: 15, endHour: 18 },
  { start: '18:00', end: '21:00', startHour: 18, endHour: 21 },
  { start: '21:00', end: '24:00', startHour: 21, endHour: 24 },
];

export async function analyzeUserSchedule(
  userId: string,
  supabase: SupabaseClient,
): Promise<ScheduleAnalysisResult> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await (supabase
    .from('resistance_blocks')
    .select()
    .eq('user_id', userId)
    .gte('session_date', sevenDaysAgo) as unknown as Promise<{ data: ResistanceBlock[] | null; error: unknown }>);

  if (error || !data) {
    return { windows: [], insufficientData: true };
  }

  const distinctDates = new Set(data.map((b) => b.session_date));
  if (distinctDates.size < 3) {
    return { windows: [], insufficientData: true };
  }

  const windowStats = WINDOWS.map((w) => {
    const blocksInWindow = data.filter((b) => {
      const hour = new Date(b.started_at).getUTCHours();
      return hour >= w.startHour && hour < w.endHour;
    });

    const blockCount = blocksInWindow.length;
    const cleanCount = blocksInWindow.filter((b) => !b.urge_occurred).length;
    const avgCleanBlocksPercent = blockCount > 0 ? cleanCount / blockCount : 0;

    return {
      start: w.start,
      end: w.end,
      blockCount,
      avgCleanBlocksPercent,
    };
  });

  const sorted = windowStats
    .sort((a, b) => b.blockCount - a.blockCount)
    .slice(0, 6);

  return { windows: sorted, insufficientData: false };
}
