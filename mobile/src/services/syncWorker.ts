import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {
  getUnsyncedMessages,
  getUnsyncedCravingEvents,
  markMessagesSynced,
  markEventsSynced,
  type LocalMessage,
  type LocalCravingEvent,
} from './localDb';
import { ApiConfig } from '../config';
import { useAuthStore } from '../stores/authStore';

const SYNC_BATCH_SIZE = 50;

function currentUserId(): string | null {
  try {
    return useAuthStore.getState().user?.id ?? null;
  } catch {
    return null;
  }
}

async function pushMessages(messages: LocalMessage[]): Promise<string[]> {
  const res = await fetch(`${ApiConfig.CHAT_URL}/sync/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, userId: currentUserId() }),
  });
  if (!res.ok) throw new Error(`Sync messages failed: ${res.status}`);
  const data = await res.json();
  return data.synced_ids as string[];
}

async function pushEvents(events: LocalCravingEvent[]): Promise<string[]> {
  const res = await fetch(`${ApiConfig.CHAT_URL}/sync/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events, userId: currentUserId() }),
  });
  if (!res.ok) throw new Error(`Sync events failed: ${res.status}`);
  const data = await res.json();
  return data.synced_ids as string[];
}

export async function runSync(): Promise<{ messages: number; events: number }> {
  let messageCount = 0;
  let eventCount = 0;

  const unsyncedMessages = await getUnsyncedMessages();
  for (let i = 0; i < unsyncedMessages.length; i += SYNC_BATCH_SIZE) {
    const batch = unsyncedMessages.slice(i, i + SYNC_BATCH_SIZE);
    const syncedIds = await pushMessages(batch);
    await markMessagesSynced(syncedIds);
    messageCount += syncedIds.length;
  }

  const unsyncedEvents = await getUnsyncedCravingEvents();
  for (let i = 0; i < unsyncedEvents.length; i += SYNC_BATCH_SIZE) {
    const batch = unsyncedEvents.slice(i, i + SYNC_BATCH_SIZE);
    const syncedIds = await pushEvents(batch);
    await markEventsSynced(syncedIds);
    eventCount += syncedIds.length;
  }

  return { messages: messageCount, events: eventCount };
}

let unsubscribeNet: (() => void) | null = null;
let unsubscribeApp: ReturnType<typeof AppState.addEventListener> | null = null;
let syncInFlight = false;

async function trySyncIfOnline(): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const state = await NetInfo.fetch();
    if (!state.isConnected) return;
    await runSync();
  } catch {
    // Silently swallow — we'll retry next time connectivity changes or app foregrounds
  } finally {
    syncInFlight = false;
  }
}

export function startSyncWorker(): () => void {
  unsubscribeNet = NetInfo.addEventListener((state) => {
    if (state.isConnected) {
      trySyncIfOnline();
    }
  });

  unsubscribeApp = AppState.addEventListener('change', (status: AppStateStatus) => {
    if (status === 'active') {
      trySyncIfOnline();
    }
  });

  trySyncIfOnline();

  return () => {
    unsubscribeNet?.();
    unsubscribeApp?.remove();
    unsubscribeNet = null;
    unsubscribeApp = null;
  };
}
