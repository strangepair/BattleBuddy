/**
 * The Build Pipeline menu row (#97) only works if BOTH halves exist: the item
 * in MenuOverlay's list and the matching case in handleNavigate
 * (app/(app)/_layout.tsx). Miss the second and the row renders, taps, and
 * does nothing — a failure that looks like a broken screen, not a missing
 * route. The key→route pairing itself is now enforced at compile time (the
 * MenuKey union + the exhaustiveness guard in that switch); this covers the
 * runtime half: the row is top-level and reports the right key on tap.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

import MenuOverlay from '../components/common/MenuOverlay';
import { useUIStore } from '../stores/uiStore';

beforeEach(() => {
  act(() => {
    useUIStore.setState({ menuOpen: true });
  });
});

afterEach(() => {
  act(() => {
    useUIStore.setState({ menuOpen: false });
  });
});

describe('menu: Build Pipeline entry', () => {
  it('is a top-level row, not buried under Preferences', () => {
    const screen = render(<MenuOverlay onNavigate={jest.fn()} />);
    expect(screen.getByText('Build Pipeline')).toBeTruthy();
    screen.unmount();
  });

  it('reports the dev key when tapped', () => {
    const onNavigate = jest.fn();
    const screen = render(<MenuOverlay onNavigate={onNavigate} />);

    fireEvent.press(screen.getByText('Build Pipeline'));

    expect(onNavigate).toHaveBeenCalledWith('dev');
    screen.unmount();
  });
});
