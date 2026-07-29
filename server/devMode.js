/**
 * Developer-mode state, in one place.
 *
 * The DEV toggle lives in the client's settings store and rides on every
 * request (`devMode` on /session/turn and /livekit/token) — the server holds
 * no per-user dev-mode state. These helpers are the single source of what the
 * model is told about that flag, shared by the check_dev_mode tool result and
 * the per-turn system-prompt status block.
 *
 * Lives in its own module (same reasoning as promptCache.js) so tests can
 * exercise the true/false behavior without booting the server.
 */

/**
 * Build the check_dev_mode tool result for a request.
 *
 * Reports the devMode flag the client sent with THIS request — the live state
 * of the chat screen's DEV toggle, never anything persisted or remembered.
 */
export function checkDevModeToolResult(toolUseId, requestContext = {}) {
  const on = requestContext.devMode === true;
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: JSON.stringify({
      dev_mode: on,
      meaning: on
        ? 'Developer mode is ON: this conversation is a developer session. It is being captured into the dev pipeline as product requests; feature/PR/build asks are pipeline input.'
        : 'Developer mode is OFF: this is a normal BattleBuddy companion conversation. If the user wants to create a PR or file a build request, tell them to flip the DEV toggle on the chat screen first — nothing is captured while it is off.',
    }),
  };
}

/**
 * Per-turn status block appended to the system prompt in BOTH states.
 *
 * OFF used to be represented only by the absence of the Developer Session
 * block, so a conversation whose history discussed dev mode could keep the
 * model believing it was on after the toggle flipped off. Stating the live
 * value every turn makes the prompt, the tool, and the toggle agree.
 */
export function devModeStatusBlock(devMode) {
  const on = devMode === true;
  return (
    '\n\n## Developer mode status\n' +
    `Developer mode is ${on ? 'ON' : 'OFF'} for this turn — the live value of the chat screen's DEV toggle, sent with this request. ` +
    'This overrides anything earlier in the conversation that says otherwise; check_dev_mode reports this same live value.'
  );
}
