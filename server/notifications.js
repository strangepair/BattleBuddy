// Push notification sender module — uses Expo Push API.
// Called by the /nudge/send endpoint and the scheduled nudge worker.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a push notification via Expo Push API.
 * @param {string} token - Expo push token (ExponentPushToken[...])
 * @param {{ title: string, body: string, data?: object }} message
 */
export async function sendPush(token, { title, body, data = {} }) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: token,
      sound: 'default',
      title,
      body,
      data,
      channelId: 'default',
    }),
  });

  const result = await res.json();

  if (result.data?.status === 'error') {
    console.error('Push send error:', result.data.message);
  }

  return result;
}

/**
 * Send a batch of push notifications (Expo supports up to 100 per request).
 * @param {Array<{ token: string, title: string, body: string, data?: object }>} messages
 */
export async function sendPushBatch(messages) {
  const batch = messages.map((m) => ({
    to: m.token,
    sound: 'default',
    title: m.title,
    body: m.body,
    data: m.data || {},
    channelId: 'default',
  }));

  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(batch),
  });

  return res.json();
}

/**
 * Check if the current time (in user's timezone) falls within quiet hours.
 * Handles midnight-crossing (e.g., 22:00–08:00).
 */
export function isQuietHours(quietStart, quietEnd, timezone) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour').value);
  const minute = parseInt(parts.find((p) => p.type === 'minute').value);
  const nowMinutes = hour * 60 + minute;

  const [startH, startM] = quietStart.split(':').map(Number);
  const [endH, endM] = quietEnd.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes > endMinutes) {
    // Crosses midnight: quiet from 22:00 to 08:00
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

// Nudge message templates
const NUDGE_MESSAGES = {
  check_in: [
    {
      title: 'Hey — checking in',
      body: "How's it going? Your buddy's here if you need to talk.",
    },
    {
      title: 'Quick check-in',
      body: 'Just seeing how you are. Tap if you want to chat.',
    },
    {
      title: "It's that time",
      body: "Your scheduled check-in. All good, or want to talk it through?",
    },
  ],
  streak: [
    { title: '🔥 Streak!', body: '{count} days strong. Your resistance is building.' },
    { title: 'Keep it going', body: "{count} days — that's real progress." },
  ],
  re_engage: [
    {
      title: "Hey — it's been a bit",
      body: 'No pressure. Just wanted you to know your buddy is here.',
    },
    {
      title: 'Still here for you',
      body: "Haven't heard from you in a while. Tap anytime.",
    },
  ],
};

export function pickNudgeMessage(type, context = {}) {
  const templates = NUDGE_MESSAGES[type];
  const template = templates[Math.floor(Math.random() * templates.length)];

  return {
    title: template.title.replace('{count}', context.streakCount || ''),
    body: template.body.replace('{count}', context.streakCount || ''),
    data: { type, route: 'chat' },
  };
}
