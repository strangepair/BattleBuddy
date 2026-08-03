/**
 * Pipeline screen: empty states, exception display, and mount safety.
 *
 * Tests are focused on the data-driven render layer (work items, releases,
 * exceptions, digest). The plumbing view (dev_build_requests) and its
 * archive/resubmit handlers are covered by the existing launch-gate and
 * dev-toggle tests.
 *
 * Isolation strategy: mock devService at the module boundary so we can
 * exercise each empty/non-empty case without network calls.
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// ── component under test ──────────────────────────────────────────────────────
import DevScreen from '../../app/(app)/dev';

// ── devService mock ───────────────────────────────────────────────────────────
jest.mock('../services/devService', () => ({
  listRequests: jest.fn().mockResolvedValue([]),
  submitDirective: jest.fn(),
  archiveRequest: jest.fn(),
  fetchWorkItems: jest.fn().mockResolvedValue([]),
  fetchReleases: jest.fn().mockResolvedValue([]),
  fetchDigest: jest.fn().mockResolvedValue(''),
}));

// ── component mocks ───────────────────────────────────────────────────────────
// expo-router is native-only; the Dev screen uses router.back() and useFocusEffect.
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useFocusEffect: (cb: () => void) => {
    const React = require('react');
    React.useEffect(cb, []);
  },
}));

// PRDetailView is a bottom-sheet with native animations; stub it out so the
// snapshot tests stay deterministic.
jest.mock('../components/dev/PRDetailView', () => ({
  PRDetailView: () => null,
}));

// react-native-gesture-handler Swipeable uses a native pan responder.
jest.mock('react-native-gesture-handler', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {},
    Swipeable: ({ children }: { children: React.ReactNode }) =>
      React.createElement(View, null, children),
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) =>
      React.createElement(View, null, children),
  };
});

jest.mock('react-native-gesture-handler/Swipeable', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Swipeable = React.forwardRef(
    ({ children }: { children: React.ReactNode }, _ref: unknown) =>
      React.createElement(View, null, children),
  );
  Swipeable.displayName = 'Swipeable';
  return Swipeable;
});

// ── stores ────────────────────────────────────────────────────────────────────
import { useSettingsStore } from '../stores/settingsStore';
import * as devService from '../services/devService';

const SAFE_AREA_METRICS = {
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
  frame: { x: 0, y: 0, width: 390, height: 844 },
};

function renderScreen() {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <DevScreen />
    </SafeAreaProvider>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (devService.listRequests as jest.Mock).mockResolvedValue([]);
  (devService.fetchWorkItems as jest.Mock).mockResolvedValue([]);
  (devService.fetchReleases as jest.Mock).mockResolvedValue([]);
  (devService.fetchDigest as jest.Mock).mockResolvedValue('');
  useSettingsStore.setState({ developerMode: false });
});

// ── 1. empty states ───────────────────────────────────────────────────────────

describe('pipeline screen: empty states', () => {
  it('renders work-item empty state message when workItems is []', async () => {
    const screen = renderScreen();
    await settle();

    expect(
      screen.getByText(/No work items yet — submissions will appear here/i),
    ).toBeTruthy();

    screen.unmount();
  });

  it('renders release empty state message when releases is [] but workItems exist', async () => {
    (devService.fetchWorkItems as jest.Mock).mockResolvedValue([
      {
        id: 'wi-1',
        title: 'Fix voice crash',
        stage: 'received',
        subsystem: 'voice',
        exception: null,
        submission_count: 1,
        created_at: new Date().toISOString(),
      },
    ]);
    (devService.fetchReleases as jest.Mock).mockResolvedValue([]);

    const screen = renderScreen();
    await settle();

    expect(screen.getByText(/No releases yet/i)).toBeTruthy();

    screen.unmount();
  });

  it('renders no exception section when exceptions is []', async () => {
    const screen = renderScreen();
    await settle();

    expect(screen.queryByText(/NEEDS YOUR INPUT/i)).toBeNull();

    screen.unmount();
  });

  it('mounts without error when all data sources return empty', async () => {
    expect(() => renderScreen()).not.toThrow();
    const screen = renderScreen();
    await settle();
    expect(() => screen.unmount()).not.toThrow();
  });
});

// ── 2. exception card ─────────────────────────────────────────────────────────

describe('pipeline screen: ExceptionCard', () => {
  const DEADLINE_ISO = '2026-08-10T12:00:00.000Z';
  const EXCEPTION_PAYLOAD = JSON.stringify({
    body: 'Clarify whether the fix applies to iOS only or both platforms.',
    defaultAction: 'Apply fix to both platforms and re-test.',
    deadlineIso: DEADLINE_ISO,
  });

  it('displays both defaultAction text and formatted deadline', async () => {
    (devService.fetchWorkItems as jest.Mock).mockResolvedValue([
      {
        id: 'wi-exc-1',
        title: 'Voice crash on tap',
        stage: 'received',
        subsystem: 'voice',
        exception: EXCEPTION_PAYLOAD,
        submission_count: 2,
        created_at: new Date().toISOString(),
      },
    ]);

    const screen = renderScreen();
    await settle();

    expect(screen.getByText(/NEEDS YOUR INPUT/i)).toBeTruthy();
    expect(
      screen.getByText(/Apply fix to both platforms and re-test/i),
    ).toBeTruthy();

    // The deadline must appear somewhere in the rendered tree (formatted).
    // Aug 10 2026 is the reference — any locale representation that includes
    // the year is acceptable.
    expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);

    screen.unmount();
  });

  it('shows the exception card title', async () => {
    (devService.fetchWorkItems as jest.Mock).mockResolvedValue([
      {
        id: 'wi-exc-2',
        title: 'Onboarding screen flickers',
        stage: 'received',
        subsystem: 'ui',
        exception: EXCEPTION_PAYLOAD,
        submission_count: 1,
        created_at: new Date().toISOString(),
      },
    ]);

    const screen = renderScreen();
    await settle();

    expect(screen.getAllByText('Onboarding screen flickers').length).toBeGreaterThan(0);

    screen.unmount();
  });
});

// ── 3. ExceptionCard component unit tests ────────────────────────────────────

import { ExceptionCard } from '../components/pipeline/ExceptionCard';

describe('ExceptionCard component', () => {
  it('renders defaultAction and deadlineIso', () => {
    const screen = render(
      <ExceptionCard
        title="Missing copy in settings"
        body="The settings screen is missing the export button label."
        defaultAction="Use generic label 'Export data'."
        deadlineIso="2026-09-01T00:00:00.000Z"
      />,
    );

    expect(screen.getByText(/Missing copy in settings/i)).toBeTruthy();
    expect(screen.getByText(/Use generic label 'Export data'/i)).toBeTruthy();
    expect(screen.getByText(/2026/)).toBeTruthy();

    screen.unmount();
  });
});
