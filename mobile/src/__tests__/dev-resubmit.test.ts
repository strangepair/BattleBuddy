/**
 * resubmitRequest must surface the server's plan and its refusal reasons, so
 * the Dev screen can tell the user whether the deploy was re-run or a fresh
 * build was dispatched — and why nothing happened when the pipeline says no.
 */
import { resubmitRequest } from '../services/devService';

const g = globalThis as unknown as { fetch: typeof fetch };
const originalFetch = g.fetch;

function mockResponse(ok: boolean, status: number, body: unknown) {
  g.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

afterEach(() => {
  g.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('resubmitRequest', () => {
  it('returns the plan the server chose', async () => {
    mockResponse(true, 200, { ok: true, plan: 'rerun_deploy' });
    const result = await resubmitRequest('req-1');
    expect(result.ok).toBe(true);
    expect(result.plan).toBe('rerun_deploy');
  });

  it('surfaces the refusal reason for a request that is not stuck', async () => {
    mockResponse(false, 409, { error: 'cannot resubmit a request that is building' });
    const result = await resubmitRequest('req-1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/building/);
  });

  it('fails soft when the pipeline is unreachable', async () => {
    g.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const result = await resubmitRequest('req-1');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
