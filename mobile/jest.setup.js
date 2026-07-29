// Shared jest environment for component tests (the launch gate in particular).
// Everything mocked here is a NATIVE/ENVIRONMENT boundary that does not exist
// under jest-node — never the components under test themselves.

require('react-native-gesture-handler/jestSetup');

// Official reanimated test setup: shared values / withTiming / withRepeat run
// against a fake timer-driven implementation, so real animation code in
// components (SessionHeader's orb ring) executes instead of being stubbed.
require('react-native-reanimated').setUpTests();

// AsyncStorage has no native layer in jest; in-memory implementation keeps
// store hydration paths (settingsStore, sessionStore, scopedStorage) real.
jest.mock('@react-native-async-storage/async-storage', () => {
  let store = {};
  const mock = {
    setItem: jest.fn(async (k, v) => {
      store[k] = String(v);
    }),
    getItem: jest.fn(async (k) => (k in store ? store[k] : null)),
    removeItem: jest.fn(async (k) => {
      delete store[k];
    }),
    clear: jest.fn(async () => {
      store = {};
    }),
    getAllKeys: jest.fn(async () => Object.keys(store)),
    multiGet: jest.fn(async (keys) => keys.map((k) => [k, store[k] ?? null])),
    multiSet: jest.fn(async (pairs) => {
      pairs.forEach(([k, v]) => {
        store[k] = String(v);
      });
    }),
    multiRemove: jest.fn(async (keys) => {
      keys.forEach((k) => delete store[k]);
    }),
  };
  return { __esModule: true, default: mock };
});

// Deterministically offline in CI: the chat hooks then take their offline
// path instead of attempting a real fetch against a LAN dev-server URL.
// Individual tests can re-mock with isConnected: true when they need it.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: false }),
  },
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn().mockResolvedValue({ isConnected: false }),
}));

// expo-video's VideoPlayer subclasses a native shared object that doesn't
// exist under jest (import-time throw). Video only plays in feed/media cards,
// never on the launch path.
jest.mock('expo-video', () => {
  const React = require('react');
  const player = () => ({
    play: jest.fn(),
    pause: jest.fn(),
    release: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeListener: jest.fn(),
    loop: false,
    muted: false,
  });
  return {
    __esModule: true,
    useVideoPlayer: jest.fn(player),
    createVideoPlayer: jest.fn(player),
    VideoView: (props) => React.createElement('ExpoVideoView', props, props.children),
  };
});

// LiveKit is a native WebRTC stack; VoiceSession only mounts after the user
// taps the speaker button (audio never auto-enables), so the launch path
// never renders it — but session.tsx imports the module, so imports must not
// throw under jest.
jest.mock('@livekit/react-native', () => {
  const React = require('react');
  return {
    __esModule: true,
    LiveKitRoom: ({ children }) => React.createElement(React.Fragment, null, children),
    useParticipants: jest.fn(() => []),
    useRoomContext: jest.fn(() => null),
    AudioSession: {
      startAudioSession: jest.fn(),
      stopAudioSession: jest.fn(),
      configureAudio: jest.fn(),
    },
    registerGlobals: jest.fn(),
  };
});
jest.mock('livekit-client', () => ({
  __esModule: true,
  // Event-name enum lookups just return the key name.
  RoomEvent: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

// supabase-js constructs a RealtimeClient at createClient() time, which
// throws under jest (no WebSocket global). Same boundary the service tests
// already mock (see syncWorker.test.ts).
jest.mock('./src/services/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      signOut: jest.fn().mockResolvedValue({ error: null }),
    },
  },
  getAuthToken: jest.fn().mockResolvedValue(null),
}));
