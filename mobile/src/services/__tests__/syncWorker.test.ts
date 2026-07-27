jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn().mockResolvedValue({
    runAsync: jest.fn(),
    getAllAsync: jest.fn(),
    execAsync: jest.fn(),
  }),
}));
jest.mock('../localDb');
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn().mockResolvedValue({ isConnected: true }),
}));
// syncWorker pulls in authStore, which imports ../supabase — and that module
// calls createClient() at load time, constructing a RealtimeClient that throws
// under jest (no WebSocket). Keep the import chain inert; these tests only read
// the current user id and never touch Supabase.
jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
  getAuthToken: jest.fn().mockResolvedValue(null),
}));

import { runSync } from '../syncWorker';
import * as localDb from '../localDb';

const mockFetch = jest.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('syncWorker', () => {
  describe('runSync', () => {
    it('pushes unsynced messages and events to the server', async () => {
      const messages = [
        { id: 'msg-1', session_id: 's-1', role: 'user', content: 'hello', mode: 'text', timestamp: 1000, synced: 0 as const },
      ];
      const events = [
        { id: 'evt-1', user_id: 'u-1', started_at: 1000, ended_at: 2000, mode: 'text' as const, outcome: 'resisted' as const, helped: 1 as const, intensity_start: 7, intensity_end: 3, trigger_context: null, synced: 0 as const },
      ];

      (localDb.getUnsyncedMessages as jest.Mock).mockResolvedValue(messages);
      (localDb.getUnsyncedCravingEvents as jest.Mock).mockResolvedValue(events);
      (localDb.markMessagesSynced as jest.Mock).mockResolvedValue(undefined);
      (localDb.markEventsSynced as jest.Mock).mockResolvedValue(undefined);

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ synced_ids: ['msg-1'] }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ synced_ids: ['evt-1'] }) });

      const result = await runSync();

      expect(result).toEqual({ messages: 1, events: 1 });
      expect(localDb.markMessagesSynced).toHaveBeenCalledWith(['msg-1']);
      expect(localDb.markEventsSynced).toHaveBeenCalledWith(['evt-1']);
    });

    it('returns zero counts when nothing to sync', async () => {
      (localDb.getUnsyncedMessages as jest.Mock).mockResolvedValue([]);
      (localDb.getUnsyncedCravingEvents as jest.Mock).mockResolvedValue([]);

      const result = await runSync();

      expect(result).toEqual({ messages: 0, events: 0 });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('propagates errors from failed sync requests', async () => {
      (localDb.getUnsyncedMessages as jest.Mock).mockResolvedValue([
        { id: 'msg-1', session_id: 's-1', role: 'user', content: 'hi', mode: 'text', timestamp: 1000, synced: 0 },
      ]);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(runSync()).rejects.toThrow('Sync messages failed: 500');
    });
  });
});
