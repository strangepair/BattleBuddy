// githubApi.js — the one place the control plane talks to GitHub REST.
//
// Raw fetch, no new npm dependency, matching how Resend and the repository
// dispatch call are already made. Extracted from devPipeline.js so the release
// bookkeeping (devRelease.js) and the reconciler both read GitHub the same way:
// GitHub is the source of truth for pipeline state, so there must be exactly one
// definition of "what we asked GitHub and how we handled a bad answer".

const GITHUB_API = 'https://api.github.com';

// Last value GitHub reported for this token's hourly REST budget. Callers that
// loop (the reconciler) check it and stop early rather than spending the
// pipeline's dispatch budget on bookkeeping.
let lastRateRemaining = null;
export function rateLimitRemaining() {
  return lastRateRemaining;
}

export function githubRepo() {
  return process.env.GITHUB_REPO || 'strangepair/BattleBuddy';
}

/** Absolute URL for a path under this repo, e.g. `pulls/12` or `actions/runs`. */
export function repoUrl(path) {
  return `${GITHUB_API}/repos/${githubRepo()}/${String(path).replace(/^\//, '')}`;
}

/**
 * Fetch a GitHub REST endpoint and return the raw Response.
 *
 * `url` may be absolute or a repo-relative path. Throws on a non-2xx so callers
 * never silently act on an error body — a reconciler that treats a 403 as "no
 * PRs found" would happily mark everything superseded.
 */
export async function githubFetch(url, init) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  const full = String(url).startsWith('http') ? String(url) : repoUrl(url);
  const res = await fetch(full, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init && init.headers),
    },
  });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null && remaining !== '') lastRateRemaining = Number(remaining);
  if (!res.ok) throw new Error(`github ${res.status} for ${full.split('/repos/')[1] || full}`);
  return res;
}

/** Same, parsed as JSON. */
export async function githubJson(url, init) {
  const res = await githubFetch(url, init);
  return res.json();
}
