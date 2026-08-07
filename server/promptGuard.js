/**
 * Prompt size guard — the single source of truth for how large the system
 * prompt file is allowed to get.
 *
 * Why this exists: system.battlebuddy.md is injected on EVERY turn (text and
 * voice), so its size is latency and cost on the hot path — and the voice
 * path once broke outright when the filled prompt blew past LiveKit's 64 KB
 * dispatch-metadata cap. The file ballooned from ~43 KB to ~153 KB in ten
 * days because the nightly agent design loop appended near-duplicate bullets
 * unattended. Two enforcement points share these numbers:
 *
 *  - promptSize.test.js: fails CI (and `npm test`) if the repo copy exceeds
 *    the cap, so a bloated prompt cannot merge.
 *  - agentDesignLoop.js: refuses to persist a rewritten prompt that exceeds
 *    the cap OR grows more than the per-run budget, so the in-process
 *    production loop (which writes to the Railway volume, bypassing git and
 *    CI) cannot re-bloat the live prompt either.
 *
 * If you hit the cap with a legitimate change, tighten or replace existing
 * prompt content instead of appending — or consciously raise the cap here,
 * in one place, with a reviewed commit.
 */

// Hard ceiling for the template file. The trimmed prompt is ~49 KB; this
// leaves ~7 KB of headroom for deliberate, reviewed additions while staying
// far from the 64 KB LiveKit dispatch cap (which the filled prompt — template
// plus per-user context — must also clear).
export const MAX_PROMPT_BYTES = 56 * 1024;

// How much a single design-loop run may grow the prompt. Real rule changes
// are replacements or tight additions; anything bigger than this in one
// unattended run is almost certainly duplicated content.
export const MAX_GROWTH_PER_RUN_BYTES = 2 * 1024;

/**
 * @param {string} content - candidate prompt content
 * @param {{previous?: string|null}} [opts] - pass the pre-run content to also
 *   enforce the per-run growth budget
 * @returns {{ok: boolean, bytes: number, violations: string[]}}
 */
export function checkPromptSize(content, { previous = null } = {}) {
  const bytes = Buffer.byteLength(content, 'utf-8');
  const violations = [];

  if (bytes > MAX_PROMPT_BYTES) {
    violations.push(
      `prompt is ${bytes} bytes — exceeds the ${MAX_PROMPT_BYTES}-byte cap (see server/promptGuard.js)`
    );
  }

  if (previous != null) {
    const growth = bytes - Buffer.byteLength(previous, 'utf-8');
    if (growth > MAX_GROWTH_PER_RUN_BYTES) {
      violations.push(
        `prompt grew ${growth} bytes in one run — exceeds the ${MAX_GROWTH_PER_RUN_BYTES}-byte per-run budget (see server/promptGuard.js)`
      );
    }
  }

  return { ok: violations.length === 0, bytes, violations };
}
