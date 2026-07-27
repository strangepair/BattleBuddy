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

export async function hydrateSettingsStore(): Promise<void> {
  try {
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
