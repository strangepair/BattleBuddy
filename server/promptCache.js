/**
 * Prompt caching — splits the system prompt into a cacheable static half and a
 * per-turn volatile half.
 *
 * Everything above "## Runtime context" in prompts/system.battlebuddy.md is
 * byte-identical on every turn for every user (~95% of the file, ~35K tokens);
 * everything below it is filled in per turn. Marking the static half
 * `ephemeral` lets Anthropic serve it from cache instead of re-reading it every
 * turn. Cache reads bill at 10% of input, but the reason this ships first is
 * latency — that re-read was most of our time-to-first-token, and first token
 * <1s is the product (CLAUDE.md rule 5).
 *
 * Render order is tools -> system -> messages, so the single breakpoint on the
 * static block covers AGENT_TOOLS as well. Haiku's minimum cacheable prefix is
 * 4096 tokens; the static half is ~35K, so it clears the floor by an order of
 * magnitude. (Opus/Sonnet floors are 4096 and 2048 respectively — still fine if
 * the hot path ever moves off Haiku.)
 *
 * Lives in its own module rather than index.js so it can be tested without
 * booting the server.
 */

export const CACHE_SPLIT_MARKER = '## Runtime context';

/**
 * @param {string} systemPrompt - the fully-assembled prompt (admin directives +
 *   filled template + admin resources)
 * @returns {string | Array<{type: 'text', text: string, cache_control?: object}>}
 *   Content blocks with a cache breakpoint, or the original string if the
 *   marker is missing. The Anthropic SDK accepts either shape for `system`.
 */
export function toCachedSystemBlocks(systemPrompt) {
  const splitAt = systemPrompt.indexOf(CACHE_SPLIT_MARKER);

  // A missing marker means the section was renamed in the prompt file — most
  // likely by the agent design loop, which edits that file unattended. Fall
  // back to sending the prompt uncached rather than caching a prefix that now
  // contains per-turn data: a poisoned prefix would serve one user's profile to
  // the next, which is far worse than losing the cache.
  if (splitAt === -1) {
    console.warn(`[Cache] "${CACHE_SPLIT_MARKER}" not found in system prompt — sending uncached`);
    return systemPrompt;
  }

  return [
    { type: 'text', text: systemPrompt.slice(0, splitAt), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: systemPrompt.slice(splitAt) },
  ];
}
