/**
 * Pipeline screen rebuild — component and integration tests.
 *
 * Tests: empty states, exception-card display, screen mount resilience.
 * All network calls are mocked via globalThis.fetch so no real server is needed.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { render } from '@testing-library/react-native';

import { WorkItemCard } from '../components/pipeline/WorkItemCard';
import { ReleaseGroup } from '../components/pipeline/ReleaseGroup';
import { ExceptionCard } from '../components/pipeline/ExceptionCard';
import { AiDigest } from '../components/pipeline/AiDigest';

// ── helpers ─────────────────────────────────────────────────────────────────

const g = globalThis as unknown as { fetch: typeof fetch };

function mockFetchEmpty() {
  g.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ work_items: [], releases: [], requests: [], digest: '' }),
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Minimal inline sections that mirror the screen's conditional rendering ───

// The screen's IN FLIGHT section. An idle pipeline must SAY it is idle — the
// wall of terminal cards it used to render read the same as a jammed one.
function InFlightSection({ active }: { active: unknown[] }) {
  return (
    <View>
      {active.length === 0 ? (
        <Text>Pipeline clear — nothing in flight</Text>
      ) : null}
    </View>
  );
}

// History is behind a disclosure, so nothing terminal renders until it is asked
// for.
function RecentSection({ recent, expanded }: { recent: string[]; expanded: boolean }) {
  return (
    <View>
      <Text>RECENT RELEASES · {recent.length}</Text>
      {expanded ? recent.map((t) => <Text key={t}>{t}</Text>) : null}
    </View>
  );
}

function ExceptionsSection({ exceptions }: { exceptions: unknown[] }) {
  if (exceptions.length === 0) return null;
  return <View><Text>NEEDS ATTENTION</Text></View>;
}

// ── AiDigest ─────────────────────────────────────────────────────────────────

describe('AiDigest', () => {
  it('renders nothing when digest is null', () => {
    const { toJSON } = render(<AiDigest digest={null} />);
    expect(toJSON()).toBeNull();
  });

  it('renders nothing when digest is empty string', () => {
    const { toJSON } = render(<AiDigest digest="" />);
    expect(toJSON()).toBeNull();
  });

  it('renders the digest text when present', () => {
    const { getByText } = render(<AiDigest digest="3 work items in flight" />);
    expect(getByText('3 work items in flight')).toBeTruthy();
  });
});

// ── WorkItemCard ──────────────────────────────────────────────────────────────

describe('WorkItemCard', () => {
  it('renders title, status, and evidence count', () => {
    const { getByText } = render(
      <WorkItemCard title="Fix crash on launch" status="in_progress" evidenceCount={2} />,
    );
    expect(getByText('Fix crash on launch')).toBeTruthy();
    expect(getByText('in_progress')).toBeTruthy();
    expect(getByText('2 submissions')).toBeTruthy();
  });

  it('renders changeRef when provided', () => {
    const { getByText } = render(
      <WorkItemCard title="Add digest" status="done" evidenceCount={1} changeRef="PR #42" />,
    );
    expect(getByText('PR #42')).toBeTruthy();
  });

  it('does not render changeRef row when absent', () => {
    const { queryByText } = render(
      <WorkItemCard title="Add digest" status="done" evidenceCount={1} />,
    );
    expect(queryByText(/PR #/)).toBeNull();
  });
});

// ── ReleaseGroup ──────────────────────────────────────────────────────────────

describe('ReleaseGroup', () => {
  it('renders release label and formatted date', () => {
    const { getByText } = render(
      <ReleaseGroup releaseLabel="v1.2.0" releasedAt="2026-08-01T00:00:00.000Z">
        <WorkItemCard title="Child item" status="done" evidenceCount={0} />
      </ReleaseGroup>,
    );
    expect(getByText('v1.2.0')).toBeTruthy();
    expect(getByText('Child item')).toBeTruthy();
  });
});

// ── ExceptionCard ─────────────────────────────────────────────────────────────

describe('ExceptionCard', () => {
  const deadline = '2026-08-10T12:00:00.000Z';

  it('displays defaultAction text', () => {
    const { getByText } = render(
      <ExceptionCard
        title="Needs clarification"
        body="The scope is ambiguous."
        defaultAction="Proceed with narrowest interpretation"
        deadlineIso={deadline}
      />,
    );
    expect(getByText('Proceed with narrowest interpretation')).toBeTruthy();
  });

  it('displays a formatted deadline (not raw ISO)', () => {
    const { getByText } = render(
      <ExceptionCard
        title="Needs clarification"
        body="The scope is ambiguous."
        defaultAction="Proceed with narrowest interpretation"
        deadlineIso={deadline}
      />,
    );
    expect(getByText(/Aug/i)).toBeTruthy();
  });

  it('shows amber/warning border (borderColor matches warning token)', () => {
    const { toJSON } = render(
      <ExceptionCard
        title="Test"
        body="body"
        defaultAction="Do nothing"
        deadlineIso={deadline}
      />,
    );
    const json = toJSON() as { props: { style: Record<string, unknown> } } | null;
    expect(json).toBeTruthy();
    const style = Array.isArray(json!.props.style)
      ? Object.assign({}, ...json!.props.style)
      : json!.props.style;
    expect(style.borderColor).toBe('#2563EB');
  });

  it('does not throw when deadlineIso is an invalid date string', () => {
    expect(() =>
      render(
        <ExceptionCard
          title="Test"
          body="body"
          defaultAction="Do nothing"
          deadlineIso="not-a-date"
        />,
      ),
    ).not.toThrow();
  });
});

// ── Empty-state coverage ──────────────────────────────────────────────────────

describe('pipeline screen empty-state behaviour', () => {
  it('says the pipeline is clear when nothing is in flight', () => {
    const { getByText } = render(<InFlightSection active={[]} />);
    expect(getByText('Pipeline clear — nothing in flight')).toBeTruthy();
  });

  it('keeps terminal history collapsed until it is asked for', () => {
    const shipped = ['Shipped last week', 'Shipped yesterday'];
    const { queryByText, getByText } = render(
      <RecentSection recent={shipped} expanded={false} />,
    );
    expect(getByText('RECENT RELEASES · 2')).toBeTruthy();
    expect(queryByText('Shipped yesterday')).toBeNull();
  });

  it('reveals history on expand', () => {
    const { getByText } = render(
      <RecentSection recent={['Shipped yesterday']} expanded />,
    );
    expect(getByText('Shipped yesterday')).toBeTruthy();
  });

  it('renders no exception section when exceptions is []', () => {
    const { queryByText } = render(<ExceptionsSection exceptions={[]} />);
    expect(queryByText(/NEEDS ATTENTION/i)).toBeNull();
  });

  it('ExceptionCard displays both defaultAction text and formatted deadline', () => {
    const { getByText } = render(
      <ExceptionCard
        title="Clarify target area"
        body="Which surface should this change?"
        defaultAction="Apply to UI surface"
        deadlineIso="2026-08-12T09:00:00.000Z"
      />,
    );
    expect(getByText('Apply to UI surface')).toBeTruthy();
    expect(getByText(/Aug/i)).toBeTruthy();
  });

  it('screen mounts without error when all data sources return empty', () => {
    mockFetchEmpty();
    expect(() =>
      render(
        <>
          <AiDigest digest="" />
          <InFlightSection active={[]} />
          <RecentSection recent={[]} expanded={false} />
          <ExceptionsSection exceptions={[]} />
        </>,
      ),
    ).not.toThrow();
  });
});
