import { ApiConfig } from '../config';

type Handler = (payload: unknown) => void;

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const DISCONNECT_WARN_MS = 60_000;

let userId: string | null = null;
let abortController: AbortController | null = null;
let backoffMs = BACKOFF_INITIAL_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disconnectedSince: number | null = null;

const listeners = new Map<string, Set<Handler>>();

function notifyHandlers(event: string, payload: unknown) {
  listeners.get(event)?.forEach((h) => {
    try { h(payload); } catch { /* individual handler errors don't break others */ }
  });
}

function parseSSEChunk(chunk: string) {
  let event = 'message';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    }
  }
  if (data) {
    try {
      notifyHandlers(event, JSON.parse(data));
    } catch { /* malformed JSON — ignore frame */ }
  }
}

async function connect() {
  if (!userId) return;

  abortController = new AbortController();
  const url = `${ApiConfig.CHAT_URL}/subscribe?userId=${encodeURIComponent(userId)}`;

  try {
    const response = await fetch(url, {
      signal: abortController.signal,
      headers: { Accept: 'text/event-stream' },
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connect failed: ${response.status}`);
    }

    backoffMs = BACKOFF_INITIAL_MS;
    disconnectedSince = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const chunk of parts) {
        if (chunk.trim()) parseSSEChunk(chunk);
      }
    }
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError') return;
  }

  scheduleReconnect();
}

function scheduleReconnect() {
  if (!userId) return;
  if (disconnectedSince === null) disconnectedSince = Date.now();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);

  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

export function isDisconnectedTooLong(): boolean {
  return disconnectedSince !== null && Date.now() - disconnectedSince > DISCONNECT_WARN_MS;
}

export function startRealtime(uid: string) {
  if (userId === uid) return;
  stopRealtime();
  userId = uid;
  backoffMs = BACKOFF_INITIAL_MS;
  disconnectedSince = null;
  connect();
}

export function stopRealtime() {
  userId = null;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  abortController?.abort();
  abortController = null;
  disconnectedSince = null;
}

export function subscribe(event: string, handler: Handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
}

export function unsubscribe(event: string, handler: Handler) {
  listeners.get(event)?.delete(handler);
}
