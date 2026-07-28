import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { scopedKey } from '../services/scopedStorage';

// One Conversation surface preferences — the Aa text-size slider and the
// handedness toggle. Both persist per user, mirroring the web head's
// localStorage bb_tscale / bb_hand.

const KEYS = {
  textScale: 'bb_tscale',
  hand: 'bb_hand',
  developerMode: 'bb_dev_mode',
  // Unscoped marker for the one-shot developer-mode reset below.
  developerModeReset: 'bb_dev_mode_reset_v1',
};

export type Hand = 'left' | 'right';

export const TEXT_SCALE_MIN = 1.0;
export const TEXT_SCALE_MAX = 1.6;
const TEXT_SCALE_DEFAULT = 1.3;

interface SettingsState {
  /** Conversation text multiplier, 1.0–1.6. Default 1.3 — readable for
      fifty-something eyes without reading glasses. */
  textScale: number;
  hand: Hand;
  /** Developer mode: when on, the current conversation transcript is captured
      and routed to the build pipeline as product requests, and the Dev tab
      becomes visible. Persisted per user. Default off. */
  developerMode: boolean;
  setTextScale: (scale: number) => void;
  setHand: (hand: Hand) => void;
  setDeveloperMode: (on: boolean) => void;
}

function clampScale(v: number): number {
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, v));
}

export const useSettingsStore = create<SettingsState>((set) => ({
  textScale: TEXT_SCALE_DEFAULT,
  hand: 'right',
  developerMode: false,

  setTextScale: (scale) => {
    const clamped = clampScale(scale);
    AsyncStorage.setItem(scopedKey(KEYS.textScale), String(clamped)).catch(() => {});
    set({ textScale: clamped });
  },

  setHand: (hand) => {
    AsyncStorage.setItem(scopedKey(KEYS.hand), hand).catch(() => {});
    set({ hand });
  },

  setDeveloperMode: (on) => {
    AsyncStorage.setItem(scopedKey(KEYS.developerMode), on ? '1' : '0').catch(() => {});
    set({ developerMode: on });
  },
}));

/** Build 50 shipped a launch-time react-native-worklets fatal (RCTFatal →
    SIGABRT) that we have only ever seen with developer mode on. Until the
    cause is pinned down, clear the persisted flag exactly once per install so
    an *update* comes up in the known-good (off) state — an app update keeps
    AsyncStorage, so without this a crashing install stays crashing.
    The programmatic equivalent of delete + reinstall.

    Scanned rather than read by key: hydrate can run before auth resolves, so
    the flag may sit under either the bare key or `bb_dev_mode:<userId>`. The
    marker is deliberately unscoped so this runs once per install, not once
    per user. Remove once developer mode is verified safe. */
async function clearDeveloperModeOnce(): Promise<void> {
  const alreadyReset = await AsyncStorage.getItem(KEYS.developerModeReset);
  if (alreadyReset) return;
  const keys = await AsyncStorage.getAllKeys();
  const devKeys = keys.filter(
    (k) => k === KEYS.developerMode || k.startsWith(`${KEYS.developerMode}:`),
  );
  if (devKeys.length) await AsyncStorage.removeMany(devKeys);
  await AsyncStorage.setItem(KEYS.developerModeReset, '1');
}

export async function hydrateSettingsStore(): Promise<void> {
  try {
    await clearDeveloperModeOnce();
    const [scaleStr, hand, devMode] = await Promise.all([
      AsyncStorage.getItem(scopedKey(KEYS.textScale)),
      AsyncStorage.getItem(scopedKey(KEYS.hand)),
      AsyncStorage.getItem(scopedKey(KEYS.developerMode)),
    ]);
    useSettingsStore.setState({
      textScale: scaleStr ? clampScale(parseFloat(scaleStr) || TEXT_SCALE_DEFAULT) : TEXT_SCALE_DEFAULT,
      hand: hand === 'left' ? 'left' : 'right',
      developerMode: devMode === '1',
    });
  } catch {
    // defaults stand
  }
}
