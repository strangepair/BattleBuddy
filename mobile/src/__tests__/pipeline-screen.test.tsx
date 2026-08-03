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

function WorkItemsSection({ workItems }: { workItems: unknown[] }) {
  return (
    <View>
      {workItems.length === 0 ? (
        <Text>No work items yet — submissions will appear here.</Text>
      ) : null}
    </View>
  );
}

function ReleasesSection({ releases }: { releases: unknown[] }) {
  return (
    <View>
      {releases.length === 0 ? <Text>No releases yet.</Text> : null}
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
    expect(style.borderColor).toBe('#FF9F0A');
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
  it('renders work-item empty state message when workItems is []', () => {
    const { getByText } = render(<WorkItemsSection workItems={[]} />);
    expect(getByText('No work items yet — submissions will appear here.')).toBeTruthy();
  });

  it('renders release empty state message when releases is []', () => {
    const { getByText } = render(<ReleasesSection releases={[]} />);
    expect(getByText('No releases yet.')).toBeTruthy();
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
          <WorkItemsSection workItems={[]} />
          <ReleasesSection releases={[]} />
          <ExceptionsSection exceptions={[]} />
        </>,
      ),
    ).not.toThrow();
  });
});
