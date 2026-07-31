/**
 * broadcast.js — lightweight SSE push channel for per-user real-time events.
 *
 * Clients open GET /subscribe?userId=<id> and receive server-sent events.
 * broadcastToUser() pushes a named event + JSON payload to every open
 * connection for that user. A broadcast failure never throws — callers wrap
 * it in try/catch but this module also swallows write errors internally.
 *
 * The in-memory map is intentionally simple: single-process (Railway/Fly
 * single-instance deploy). If we ever go multi-instance we'd replace this
 * with a Redis pub/sub adapter behind the same interface.
 */

/** @type {Map<string, Set<import('node:http').ServerResponse>>} */
const sseClients = new Map();

/**
 * Register an SSE response object for a user. The caller is responsible for
 * setting the response headers and keeping the connection alive. Returns an
 * unregister function that removes the client when the connection closes.
 *
 * @param {string} userId
 * @param {import('node:http').ServerResponse} res
 * @returns {() => void} cleanup function
 */
export function registerSseClient(userId, res) {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
  return () => {
    const set = sseClients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(userId);
    }
  };
}

/**
 * Emit a named SSE event to every open connection for a user.
 * Errors writing to individual clients are silently swallowed so one dead
 * socket never prevents delivery to others.
 *
 * @param {string} userId
 * @param {string} event - SSE event name (e.g. 'dashboard:update')
 * @param {object} payload - JSON-serialisable object
 */
export function broadcastToUser(userId, event, payload) {
  const clients = sseClients.get(userId);
  if (!clients || clients.size === 0) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      // dead socket — let it linger until the close handler cleans it up
    }
  }
}
