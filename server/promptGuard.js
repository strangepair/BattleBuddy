/**
 * Prompt guard — the single source of truth for what a change to the system
 * prompt must satisfy: how large the file may get, and what must survive.
 *
 * Why this exists: system.battlebuddy.md is injected on EVERY turn (text and
 * voice), so its size is latency and cost on the hot path — and the voice
 * path once broke outright when the filled prompt blew past LiveKit's 64 KB
 * dispatch-metadata cap. The file ballooned from ~43 KB to ~153 KB in ten
 * days because the nightly agent design loop appended near-duplicate bullets
 * unattended. Two enforcement points share these numbers:
 *
 *  - promptSize.test.js: fails CI (and `npm test`) if the repo copy exceeds
 *    the cap, so a bloated prompt cannot merge. Since the design loop stopped
 *    writing the live prompt and started opening PRs instead, this is the
 *    enforcement point that actually blocks one.
 *  - agentDesignLoop.js: refuses to PROPOSE a prompt that exceeds the cap OR
 *    grows more than the per-run budget, so a bad proposal never becomes a PR
 *    a human has to read and close.
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

// ─── Content integrity ────────────────────────────────────────────────────────

/**
 * Markers that MUST survive every rewrite of the system prompt.
 *
 * A full-file "return the complete updated prompt" rewrite can silently drop
 * content if the model runs out of output tokens mid-generation — the response
 * is truncated wherever generation happened to be, with no error raised. This
 * bit us twice (2026-07-03 and 2026-07-04): the {{placeholder}} runtime-context
 * block, the Hard limits section, and the 988 crisis off-ramp all disappeared
 * from the tail of the file because the rewrite ran out of budget before
 * reaching them. A content-marker sanity check is the only way to catch it —
 * the model's own "never remove X" instruction is not self-enforcing.
 */
export const REQUIRED_MARKERS = [
  '{{current_goal}}', '{{profile}}', '{{life_architecture}}',
  '{{trigger_context}}', '{{relevant_memories}}', '{{recent_history}}',
  '{{session_context}}', '988', '## Hard limits',
];

export function findMissingMarkers(content) {
  return REQUIRED_MARKERS.filter(marker => !content.includes(marker));
}

/**
 * Every gate a proposed prompt must clear before it may become a PR.
 *
 * Both checks used to run at write time, guarding the live file. They now
 * guard the branch instead — same numbers, same markers, one step earlier —
 * because the cheapest bad proposal is the one that never becomes a PR a human
 * has to read and close.
 *
 * @param {string} proposed - the patched prompt
 * @param {string} base     - the repo copy the patches were applied to
 * @returns {{ok: boolean, violations: string[], size: object}}
 */
export function validateProposedPrompt(proposed, base) {
  const violations = [];

  const missing = findMissingMarkers(proposed);
  if (missing.length > 0) {
    violations.push(`patches would remove required marker(s): ${missing.join(', ')}`);
  }

  const size = checkPromptSize(proposed, { previous: base });
  violations.push(...size.violations);

  return { ok: violations.length === 0, violations, size };
}
