/**
 * LAUNCH GATE — the CI check that the app's crash surface actually mounts.
 *
 * Builds 50–53 all aborted at launch. CI stayed green because it only ran
 * typecheck/lint/unit — nothing ever rendered the session screen. The two
 * root causes (commit 2756da2's evidence matrix):
 *
 *   1. A control rendered inside SessionHeader's animated subtree — the one
 *      place that mixes an infinite reanimated loop with react-native-screens
 *      snapshot-on-teardown (builds 51/53, crashed even with dev mode OFF).
 *   2. The session screen's structure varying with developerMode — dev ON
 *      added a 4th PagerView page + SegBar segment at runtime (build 50).
 *
 * This file makes both regressions, plus any plain JS throw on the launch
 * path, fail CI:
 *   - real mount/unmount of SessionScreen and SessionHeader (reanimated's
 *     official jest setup runs the real animation code);
 *   - structural invariants: dev-invariant session screen, exactly 3 pager
 *     pages, no interactive controls inside the header subtree.
 *
 * RESIDUAL GAP (documented, not closable in jest): the native UI-thread
 * teardown race itself (RNSScreenStackView setViewToSnapshot vs a live
 * worklet) needs a real arm64 device. Jest catches the code shapes that
 * triggered it, not the race. Device-level verification stays manual/EAS.
 */
import React from 'react';
import { Switch, TouchableOpacity, Pressable, TextInput } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import PagerView from 'react-native-pager-view';

import SessionScreen from '../../app/(app)/session';
import SessionHeader from '../components/session/SessionHeader';
import { useSettingsStore } from '../stores/settingsStore';

// ── environment shims (native boundaries only — see jest.setup.js) ──────────

// SafeArea host module is native; the library ships metrics for tests.
const SAFE_AREA_METRICS = {
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
  frame: { x: 0, y: 0, width: 390, height: 844 },
};

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>{ui}</SafeAreaProvider>,
  );
}

// Flush the mount effects (auto-greet, profile fetch settle on the offline
// path from the netinfo mock).
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * Structural fingerprint of a rendered tree: element types and child order,
 * no props, no text. Two trees with the same fingerprint have the same
 * native view hierarchy shape — which is exactly what must not vary with
 * developerMode on the session screen.
 */
type Fingerprint = { type: string; children: Fingerprint[] };
function fingerprint(node: ReturnType<ReturnType<typeof render>['toJSON']>): Fingerprint[] {
  if (node == null) return [];
  const nodes = Array.isArray(node) ? node : [node];
  return nodes
    .filter((n): n is Exclude<typeof n, string> => typeof n !== 'string')
    .map((n) => ({
      type: n.type,
      children: fingerprint(n.children as never),
    }));
}

function findByType(
  json: ReturnType<ReturnType<typeof render>['toJSON']>,
  typeName: string,
): { type: string; children: unknown[] | null } | null {
  if (json == null || typeof json === 'string') return null;
  const nodes = Array.isArray(json) ? json : [json];
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.type === typeName) return n as never;
    const hit = findByType(n.children as never, typeName);
    if (hit) return hit;
  }
  return null;
}

beforeEach(() => {
  jest.useRealTimers();
  useSettingsStore.setState({ developerMode: false });
});

// ── 1. the screen that crashed builds 50–53 mounts and unmounts clean ───────

describe('launch gate: session screen', () => {
  it('mounts, runs its launch effects, and unmounts without throwing', async () => {
    const screen = renderWithProviders(<SessionScreen />);
    await settle();

    // The screen actually rendered its interactive surface, not an error box.
    expect(screen.getByPlaceholderText(/talk to buddy/i)).toBeTruthy();

    // Unmount is the half that killed build 51 (teardown while the orb ring
    // animates). Must not throw with the real reanimated test runtime.
    expect(() => screen.unmount()).not.toThrow();
  });

  it('renders exactly 3 pager pages (home / chat / content)', async () => {
    const screen = renderWithProviders(<SessionScreen />);
    await settle();

    const pager = findByType(screen.toJSON(), 'RNCViewPager');
    expect(pager).toBeTruthy();
    expect(pager!.children).toHaveLength(3);
    screen.unmount();
  });

  it('is structurally dev-invariant: developerMode ON changes nothing in the view hierarchy', async () => {
    const screen = renderWithProviders(<SessionScreen />);
    await settle();
    const offShape = fingerprint(screen.toJSON());

    await act(async () => {
      useSettingsStore.getState().setDeveloperMode(true);
    });
    await settle();
    const onShape = fingerprint(screen.toJSON());

    // Build 50's dev-ON crash was a 4th PagerView page appearing at runtime.
    // Style/text/prop changes are allowed; structure is not.
    expect(onShape).toEqual(offShape);

    const pager = findByType(screen.toJSON(), 'RNCViewPager');
    expect(pager!.children).toHaveLength(3);
    screen.unmount();
  });
});

// ── 2. the header subtree that crashed builds 51/53 stays control-free ──────

describe('launch gate: SessionHeader', () => {
  it('mounts and unmounts without throwing while the orb ring animates', () => {
    const header = renderWithProviders(
      <SessionHeader mascotState="idle" phase="observation" />,
    );
    expect(() => header.unmount()).not.toThrow();
  });

  it('contains no interactive controls (builds 51/53 regression guard)', () => {
    const header = render(<SessionHeader mascotState="idle" phase="observation" />);
    // Every flown build that put a control inside this animated subtree
    // crashed at launch (evidence matrix in commit 2756da2). Any control —
    // Switch, touchable, input — belongs OUTSIDE the header.
    expect(header.UNSAFE_queryAllByType(Switch)).toHaveLength(0);
    expect(header.UNSAFE_queryAllByType(TouchableOpacity)).toHaveLength(0);
    expect(header.UNSAFE_queryAllByType(Pressable)).toHaveLength(0);
    expect(header.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
    header.unmount();
  });

  it('is dev-invariant: developerMode ON renders the identical header', () => {
    const off = render(<SessionHeader mascotState="idle" phase="observation" />);
    const offShape = fingerprint(off.toJSON());
    off.unmount();

    useSettingsStore.setState({ developerMode: true });
    const on = render(<SessionHeader mascotState="idle" phase="observation" />);
    const onShape = fingerprint(on.toJSON());
    on.unmount();

    expect(onShape).toEqual(offShape);
  });
});
