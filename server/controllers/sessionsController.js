export async function listSessions(supabase, userId, { before, limit }) {
  const beforeDate = new Date(before);
  if (isNaN(beforeDate.getTime())) {
    return { error: 'Invalid `before` date; must be an ISO 8601 datetime string', status: 400 };
  }

  const clampedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .lt('created_at', beforeDate.toISOString())
    .order('created_at', { ascending: false })
    .limit(clampedLimit);

  if (error) {
    return { error: error.message, status: 500 };
  }

  const rows = data || [];
  const nextCursor = rows.length < clampedLimit ? null : rows[rows.length - 1].created_at;

  return { sessions: rows, nextCursor };
}
