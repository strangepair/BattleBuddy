/**
 * The chat-screen developer-mode toggle (Mike's directive): a plain dock
 * button that flips the CONVERSATION between dev mode and companion mode.
 * The flag it sets (settingsStore.developerMode) rides on every chat turn as
 * `devMode`, which switches the agent's system prompt server-side and gates
 * transcript capture into the build pipeline.
 *
 * Structural safety is covered by launch-gate.test.tsx; this file covers the
 * feature itself.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SessionScreen from '../../app/(app)/session';
import { useSettingsStore } from '../stores/settingsStore';

const SAFE_AREA_METRICS = {
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
  frame: { x: 0, y: 0, width: 390, height: 844 },
};

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  useSettingsStore.setState({ developerMode: false });
});

describe('chat-screen developer-mode toggle', () => {
  it('renders in the dock and flips the conversation mode flag both ways', async () => {
    const screen = render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <SessionScreen />
      </SafeAreaProvider>,
    );
    await settle();

    const toggle = screen.getByLabelText(/developer mode off/i);
    fireEvent.press(toggle);
    expect(useSettingsStore.getState().developerMode).toBe(true);

    // The input surface tells the user which mode the conversation is in.
    expect(screen.getByPlaceholderText(/dev mode/i)).toBeTruthy();

    fireEvent.press(screen.getByLabelText(/developer mode on/i));
    expect(useSettingsStore.getState().developerMode).toBe(false);
    expect(screen.getByPlaceholderText(/talk to buddy/i)).toBeTruthy();

    screen.unmount();
  });

  it('persists the flag the chat request reads (settingsStore.developerMode)', async () => {
    // useSessionChat reads useSettingsStore.getState().developerMode at
    // send-time and posts it as `devMode` on /session/turn — assert the
    // toggle drives exactly that store field.
    const screen = render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <SessionScreen />
      </SafeAreaProvider>,
    );
    await settle();

    fireEvent.press(screen.getByLabelText(/developer mode off/i));
    expect(useSettingsStore.getState().developerMode).toBe(true);
    screen.unmount();

    // Store state survives the screen unmounting — mode is a property of the
    // conversation, not of the mounted screen.
    expect(useSettingsStore.getState().developerMode).toBe(true);
  });
});
