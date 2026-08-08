import type { ResistanceBlock } from '../db/schema.js';
import { calculateStreak } from '../services/streakCalculator.js';
import { analyzeUserSchedule } from '../services/scheduleAnalyzer.js';

interface NodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (chunk: unknown) => void): void;
}

interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

interface SupabaseClient {
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  from(table: string): SupabaseQueryBuilder;
}

interface SupabaseQueryBuilder {
  insert(row: Record<string, unknown>): SupabaseQueryBuilder;
  update(row: Record<string, unknown>): SupabaseQueryBuilder;
  select(cols?: string): SupabaseQueryBuilder;
  eq(col: string, val: unknown): SupabaseQueryBuilder;
  single(): Promise<{ data: unknown; error: unknown }>;
  then(resolve: (result: { data: unknown; error: unknown }) => void): void;
}

async function readBody(req: NodeRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: unknown) => { body += String(chunk); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function resolveUser(
  req: NodeRequest,
  supabase: SupabaseClient,
): Promise<{ id: string } | null> {
  const authHeader = req.headers['authorization'] ?? '';
  const token = (Array.isArray(authHeader) ? authHeader[0] : authHeader).startsWith('Bearer ')
    ? (Array.isArray(authHeader) ? authHeader[0] : authHeader).slice(7)
    : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id };
}

function json(res: NodeResponse, status: number, body: unknown, cors: Record<string, string>): void {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createResistanceBlocksHandler(supabase: SupabaseClient, cors: Record<string, string>) {
  return async function handle(req: NodeRequest, res: NodeResponse, subpath: string): Promise<boolean> {
    const method = req.method ?? 'GET';

    // POST /api/resistance-blocks
    if (method === 'POST' && subpath === '') {
      const user = await resolveUser(req, supabase);
      if (!user) { json(res, 401, { error: 'unauthorized' }, cors); return true; }

      let body: Record<string, unknown> = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* empty body ok */ }

      const row = {
        user_id: user.id,
        started_at: body.started_at ?? new Date().toISOString(),
        session_date: body.session_date ?? new Date().toISOString().slice(0, 10),
      };

      const { data, error } = await (supabase.from('resistance_blocks').insert(row).select().single() as unknown as Promise<{ data: unknown; error: unknown }>);
      if (error) { json(res, 500, { error: (error as { message?: string }).message ?? 'insert failed' }, cors); return true; }
      json(res, 201, data, cors);
      return true;
    }

    // PATCH /api/resistance-blocks/:id
    const patchMatch = subpath.match(/^\/([^/]+)$/);
    if (method === 'PATCH' && patchMatch) {
      const id = patchMatch[1];
      const user = await resolveUser(req, supabase);
      if (!user) { json(res, 401, { error: 'unauthorized' }, cors); return true; }

      let body: Record<string, unknown> = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* ok */ }

      const updates: Record<string, unknown> = {};
      if (body.ended_at !== undefined) updates.ended_at = body.ended_at;
      if (body.urge_occurred !== undefined) updates.urge_occurred = body.urge_occurred;

      const { data, error } = await (supabase
        .from('resistance_blocks')
        .update(updates)
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .single() as unknown as Promise<{ data: unknown; error: unknown }>);

      if (error) { json(res, 500, { error: (error as { message?: string }).message ?? 'update failed' }, cors); return true; }

      if (updates.urge_occurred !== true) {
        const { data: allBlocks } = await (supabase
          .from('resistance_blocks')
          .select()
          .eq('user_id', user.id) as unknown as Promise<{ data: ResistanceBlock[] | null; error: unknown }>);

        if (allBlocks) {
          const streak = calculateStreak(allBlocks);
          if (streak.latestMilestone) {
            await (supabase.from('rule_of_three_milestones').insert({
              user_id: user.id,
              milestone_type: streak.latestMilestone,
              blocks_count: streak.currentStreakBlocks,
              personal_best: streak.currentStreakBlocks >= streak.longestStreakBlocks,
            }) as unknown as Promise<{ data: unknown; error: unknown }>);
          }
        }
      }

      json(res, 200, data, cors);
      return true;
    }

    // GET /api/resistance-blocks/today
    if (method === 'GET' && subpath === '/today') {
      const user = await resolveUser(req, supabase);
      if (!user) { json(res, 401, { error: 'unauthorized' }, cors); return true; }

      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await (supabase
        .from('resistance_blocks')
        .select()
        .eq('user_id', user.id)
        .eq('session_date', today) as unknown as Promise<{ data: unknown; error: unknown }>);

      if (error) { json(res, 500, { error: (error as { message?: string }).message ?? 'query failed' }, cors); return true; }
      json(res, 200, data, cors);
      return true;
    }

    // GET /api/resistance-blocks/streak
    if (method === 'GET' && subpath === '/streak') {
      const user = await resolveUser(req, supabase);
      if (!user) { json(res, 401, { error: 'unauthorized' }, cors); return true; }

      const { data, error } = await (supabase
        .from('resistance_blocks')
        .select()
        .eq('user_id', user.id) as unknown as Promise<{ data: ResistanceBlock[] | null; error: unknown }>);

      if (error) { json(res, 500, { error: (error as { message?: string }).message ?? 'query failed' }, cors); return true; }
      const result = calculateStreak(data ?? []);
      json(res, 200, result, cors);
      return true;
    }

    // GET /api/resistance-blocks/schedule
    if (method === 'GET' && subpath === '/schedule') {
      const user = await resolveUser(req, supabase);
      if (!user) { json(res, 401, { error: 'unauthorized' }, cors); return true; }

      const result = await analyzeUserSchedule(user.id, supabase);
      json(res, 200, result, cors);
      return true;
    }

    return false;
  };
}
