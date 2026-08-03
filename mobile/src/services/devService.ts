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
  | 'duplicate';

export type DevTarget = 'backend' | 'agent' | 'ui' | 'prompt';

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
  source: 'transcript' | 'directive';
  description?: string;
  pr_url?: string | null;
  pr_number?: number | null;
  branch?: string | null;
  deploy_status?: string | null;
  error?: string | null;
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

/** List all build requests (newest first) for the Dev tab. */
export async function listRequests(userId: string | null): Promise<DevRequest[]> {
  try {
    const q = userId ? `?userId=${encodeURIComponent(userId)}` : '';
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

export interface WorkItem {
  id: string;
  title: string;
  stage: string;
  subsystem?: string | null;
  interpretation?: string | null;
  exception?: string | null;
  parent_work_item_id?: string | null;
  submission_count: number;
  latest_event?: {
    id: string;
    kind: string;
    detail?: Record<string, unknown>;
    created_at: string;
  } | null;
  created_at: string;
  updated_at?: string | null;
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
    release_id: string;
    created_at: string;
  }>;
}

export interface ExceptionItem {
  id: string;
  title: string;
  body: string;
  defaultAction: string;
  deadlineIso: string;
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
