import { ApiConfig } from '../config';

function getTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'America/Chicago';
  }
}

export interface ChatTurnOptions {
  messages: { role: string; content: string }[];
  profile?: string;
  recentHistory?: string;
  triggerContext?: { trigger: string; intensity: number; time: string } | null;
  userId?: string;
}

const REQUEST_TIMEOUT_MS = 30000;

export async function streamChatTurn(
  options: ChatTurnOptions,
  onToken: (accumulated: string) => void,
  signal: AbortSignal,
): Promise<string> {
  // Combine the caller's (unmount) signal with our own timeout so a stalled
  // fetch/read doesn't hang the UI forever. A timed-out abort must surface as
  // a normal error, not the silent 'AbortError' the caller uses for unmounts.
  const combinedController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    combinedController.abort();
  }, REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => combinedController.abort();
  if (signal.aborted) combinedController.abort();
  else signal.addEventListener('abort', onExternalAbort);

  try {
    const res = await fetch(`${ApiConfig.CHAT_URL}/session/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: options.messages,
        profile: options.profile,
        recent_history: options.recentHistory,
        trigger_context: options.triggerContext,
        userId: options.userId,
        timezone: getTimezone(),
      }),
      signal: combinedController.signal,
    });

    if (!res.ok) {
      let errorMsg = 'Failed to connect';
      try {
        const errBody = await res.json();
        if (typeof errBody.error === 'string' && errBody.error.includes('credit balance')) {
          errorMsg = "I'm having a connection issue on my end right now. Give me a minute and try again.";
        } else if (typeof errBody.error === 'string' && errBody.error.includes('rate')) {
          errorMsg = "I'm getting a lot of traffic right now. Try again in a minute.";
        } else {
          errorMsg = "Something went wrong on my end. Try again in a moment.";
        }
      } catch {}
      throw new Error(errorMsg);
    }
    if (!res.body) throw new Error('Something went wrong on my end. Try again in a moment.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let leftover = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = leftover + decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            let msg = "Something went wrong on my end. Try again in a moment.";
            if (parsed.error.includes('credit balance')) {
              msg = "I'm having a connection issue on my end right now. Give me a minute and try again.";
            } else if (parsed.error.includes('rate') || parsed.error.includes('overloaded')) {
              msg = "I'm getting a lot of traffic right now. Try again in a minute.";
            }
            throw new Error(msg);
          }
          if (parsed.text) {
            accumulated += parsed.text;
            onToken(accumulated);
          }
        } catch (e) {
          if (e instanceof Error && e.message !== data) throw e;
        }
      }
    }

    return accumulated;
  } catch (err) {
    if (timedOut) {
      throw new Error("I'm having a connection issue on my end right now. Give me a minute and try again.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', onExternalAbort);
  }
}
