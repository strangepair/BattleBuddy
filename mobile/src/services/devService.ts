import { ApiConfig } from '../config';

// Client for the Developer-mode build pipeline (control plane lives on the
// backend at ApiConfig.DEV_URL). All routes are app-identity authed with the
// shared CLIENT_TOKEN, matching outcomeRecorder / context routes.

export type DevRequestStatus =
  | 'pending'
  | 'building'
  | 'in_review'
  | 'merging'
  | 'deploying'
  | 'deployed'
  | 'failed'
  | 'needs_attention'
  // Terminal: triage matched this submission to an existing work item, so the
  // request was parked instead of built. See holdDuplicateRequests (server).
  | 'duplicate'
  // Terminal: the PR was closed without merging, or an operator cancelled the
  // row. Added by migration 022 — the client not knowing it is why 31 dead rows
  // rendered as "Pending development".
  | 'superseded';

export type DevTarget = 'backend' | 'agent' | 'ui' | 'prompt';

/** Where a request came from. `github` is a PR the reconciler adopted — a change
    raised straight on GitHub with no app intake path. Every change is tracked. */
export type DevSource = 'transcript' | 'directive' | 'github';

/** The work item a duplicate submission was attached to as evidence. */
export interface AttachedWorkItem {
  id: string;
  title: string;
  subsystem?: string;
}

/** Result of submitting a directive. `duplicate` means triage matched it to an
    existing work item and no build was started. */
export interface DirectiveResult {
  requests: DevRequest[];
  duplicate: boolean;
  attachedTo: AttachedWorkItem | null;
}

export interface DevRequest {
  id: string;
  title: string;
  target: DevTarget;
  status: DevRequestStatus;
  source: DevSource;
  description?: string;
  pr_url?: string | null;
  pr_number?: number | null;
  branch?: string | null;
  /** Release that carried this change to TestFlight, if any (migration 022). */
  release_id?: string | null;
  /** The work item this request implements. */
  work_item_id?: string | null;
  deploy_status?: string | null;
  error?: string | null;
  /** How many dispatch attempts this request has had (auto-retry + manual). */
  attempts?: number;
  /** 'transient' | 'stale_branch' | 'terminal' — null until a failure lands. */
  failure_class?: string | null;
  /** When the auto-retry loop will pick this up; null means it never will. */
  next_retry_at?: string | null;
  archived?: boolean;
  created_at: string;
  updated_at?: string;
}

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'America/Chicago';
  }
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ApiConfig.CLIENT_TOKEN}`,
  };
}

/** Send a captured developer-mode transcript to the pipeline. Non-blocking:
    swallows errors so a failed capture never disrupts the conversation. */
export async function captureTranscript(input: {
  userId: string | null;
  sessionId: string;
  messages: { role: string; content: string }[];
}): Promise<void> {
  try {
    await fetch(`${ApiConfig.DEV_URL}/dev/capture`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...input, timezone: tz() }),
    });
  } catch (err) {
    console.warn('[devService] capture failed:', err);
  }
}

/** Submit a typed directive from the Dev tab. Returns the created request(s)
    plus the triage verdict — `duplicate`/`attachedTo` are set when the backend
    matched this submission to an existing work item and started no build. */
export async function submitDirective(input: {
  userId: string | null;
  text: string;
  target?: DevTarget;
}): Promise<DirectiveResult> {
  const res = await fetch(`${ApiConfig.DEV_URL}/dev/directive`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`directive failed: ${res.status}`);
  const json = await res.json();
  return {
    requests: json.requests ?? [],
    duplicate: json.duplicate === true,
    attachedTo: json.attachedTo ?? null,
  };
}

/**
 * List build requests (newest first) for the Dev tab.
 *
 * `statuses` maps to the server's `?status=` filter. The screen uses it to ask
 * for every in-flight row SEPARATELY from the newest-100 window: without that, a
 * row that has been stuck for a few days falls off the back of the window and
 * the screen reports a clear pipeline while the queue is jammed — the exact
 * failure the window was added to prevent.
 */
export async function listRequests(
  userId: string | null,
  opts: { statuses?: DevRequestStatus[]; limit?: number } = {},
): Promise<DevRequest[]> {
  try {
    const params = new URLSearchParams();
    if (userId) params.set('userId', userId);
    if (opts.statuses?.length) params.set('status', opts.statuses.join(','));
    if (opts.limit) params.set('limit', String(opts.limit));
    const q = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${ApiConfig.DEV_URL}/dev/requests${q}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.requests ?? [];
  } catch {
    return [];
  }
}

export async function getRequest(id: string): Promise<DevRequest | null> {
  try {
    const res = await fetch(`${ApiConfig.DEV_URL}/dev/requests/${encodeURIComponent(id)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.request ?? null;
  } catch {
    return null;
  }
}

export async function archiveRequest(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${ApiConfig.DEV_URL}/dev/requests/${encodeURIComponent(id)}/archive`, {
      method: 'PATCH',
      headers: authHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ask the pipeline to try a stuck request again. `plan` is 'rerun_deploy'
    when the code already merged and only the deploy failed, otherwise
    'redispatch_build'. Returns ok:false with a reason the caller can show.
    On success, `item` contains the updated request row from the server. */
export async function resubmitRequest(
  id: string,
): Promise<{ ok: boolean; plan?: string; item?: DevRequest; error?: string }> {
  try {
    const res = await fetch(`${ApiConfig.DEV_URL}/dev/requests/${encodeURIComponent(id)}/resubmit`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error ?? `resubmit failed: ${res.status}` };
    return { ok: true, plan: body.plan, item: body.item ?? undefined };
  } catch (err) {
    return { ok: false, error: 'Could not reach the pipeline.' };
  }
}

export interface WorkItem {
  id: string;
  title: string;
  stage: string;
  subsystem?: string | null;
  exception?: string | null;
  submission_count: number;
  latest_event?: { kind: string; created_at: string } | null;
  created_at: string;
  updated_at?: string;
}

export interface Release {
  id: string;
  version: string;
  status: string;
  notes?: string | null;
  created_at: string;
  changes: Array<{
    id: string;
    work_item_id?: string | null;
    branch?: string | null;
    pr_number?: number | null;
    flag_key?: string | null;
    status: string;
  }>;
}

export async function fetchWorkItems(): Promise<WorkItem[]> {
  try {
    const res = await fetch(`${ApiConfig.DEV_URL}/api/pipeline/work-items`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.work_items ?? [];
  } catch {
    return [];
  }
}

export async function fetchReleases(): Promise<Release[]> {
  try {
    const res = await fetch(`${ApiConfig.DEV_URL}/api/pipeline/releases`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.releases ?? [];
  } catch {
    return [];
  }
}

export async function fetchDigest(): Promise<string> {
  try {
    const res = await fetch(`${ApiConfig.DEV_URL}/api/pipeline/digest`, {
      headers: authHeaders(),
    });
    if (!res.ok) return '';
    const json = await res.json();
    return json.digest ?? '';
  } catch {
    return '';
  }
}
