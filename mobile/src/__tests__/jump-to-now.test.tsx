/**
 * DayCalendarView — "Jump to Now" button render tests.
 *
 * The button is visible on initial mount (viewportHeight === 0 → now is not
 * in view). It disappears once the wrapper onLayout fires with a height large
 * enough to contain the current-time offset (scroll position stays at 0).
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import DayCalendarView from '../components/dashboard/DayCalendarView';

const NO_LOGS: never[] = [];
const NO_PROJECTED: never[] = [];

describe('DayCalendarView — Jump to Now button', () => {
  it('renders the "Now" button on initial mount (before layout measurement)', () => {
    const { getByLabelText } = render(
      <DayCalendarView projected={NO_PROJECTED} actuals={NO_LOGS} />,
    );
    expect(getByLabelText('Jump to now')).toBeTruthy();
  });

  it('button label text is "Now"', () => {
    const { getByText } = render(
      <DayCalendarView projected={NO_PROJECTED} actuals={NO_LOGS} />,
    );
    expect(getByText('Now')).toBeTruthy();
  });

  it('pressing the button does not throw', () => {
    const { getByLabelText } = render(
      <DayCalendarView projected={NO_PROJECTED} actuals={NO_LOGS} />,
    );
    expect(() => fireEvent.press(getByLabelText('Jump to now'))).not.toThrow();
  });

  it('button is absent when today is already in view (nowOffset within viewport)', () => {
    const { queryByLabelText, getByLabelText, UNSAFE_root } = render(
      <DayCalendarView projected={NO_PROJECTED} actuals={NO_LOGS} />,
    );

    expect(getByLabelText('Jump to now')).toBeTruthy();

    const now = new Date();
    const nowOffset = (now.getHours() * 60 + now.getMinutes()) * 2;

    fireEvent(UNSAFE_root, 'layout', {
      nativeEvent: { layout: { height: nowOffset + 200 } },
    });

    expect(queryByLabelText('Jump to now')).toBeNull();
  });
});
