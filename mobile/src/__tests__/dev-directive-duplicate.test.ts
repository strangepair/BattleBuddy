/**
 * submitDirective must pass the triage verdict through to the caller.
 *
 * It previously returned `json.requests` alone, discarding `duplicate` and
 * `attachedTo`, so the Dev screen silently reloaded and never told the user
 * their submission had been recognised as already-tracked work. That made two
 * of the five duplicate-submission gate criteria unobservable in the app.
 */
import { submitDirective } from '../services/devService';

// `global` is not in this project's tsconfig types (["jest"] only, no node),
// so reach the fetch binding through globalThis.
const g = globalThis as unknown as { fetch: typeof fetch };
const originalFetch = g.fetch;

function mockJson(body: unknown) {
  g.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  }) as unknown as typeof fetch;
}

afterEach(() => {
  g.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('submitDirective triage passthrough', () => {
  it('surfaces duplicate + attachedTo when triage matched an existing item', async () => {
    mockJson({
      requests: [{ id: 'req-1', title: 'x', target: 'ui', status: 'duplicate', source: 'directive', created_at: 'now' }],
      duplicate: true,
      attachedTo: { id: 'wi-9', title: 'Voice crashes on iOS', subsystem: 'voice' },
    });

    const result = await submitDirective({ userId: 'u1', text: 'voice goes silent' });

    expect(result.duplicate).toBe(true);
    expect(result.attachedTo).toEqual({ id: 'wi-9', title: 'Voice crashes on iOS', subsystem: 'voice' });
    expect(result.requests).toHaveLength(1);
  });

  it('reports not-duplicate when the backend omits the triage fields', async () => {
    mockJson({ requests: [] });

    const result = await submitDirective({ userId: 'u1', text: 'something new' });

    expect(result.duplicate).toBe(false);
    expect(result.attachedTo).toBeNull();
    expect(result.requests).toEqual([]);
  });
});
