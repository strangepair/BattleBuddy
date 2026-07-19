/**
 * Composing the opening line of a voice session.
 *
 * The old greeting had two shapes: a flat "Hey, how's it going?" for anyone the
 * agent didn't recognize, and — for returning users — an instruction to
 * "reference ONE specific thing you know about them." The second sounds right
 * but fails in practice: it hands the model no concrete fact and no sense of
 * how much time has passed, so the model invents something from the profile,
 * and invention reads generic. That is the "greeting isn't relevant" complaint.
 *
 * The fix is grounding. By the time we build the greeting the caller already
 * has the two things that make an opening feel like it remembers — a real
 * elapsed-time gap and a durable promoted fact about this person — so put them
 * directly in the instruction instead of asking the model to conjure them.
 *
 * Pure so it can be tested without LiveKit; the caller passes elapsed time in
 * rather than reading the clock.
 */

/**
 * A short human phrase for the gap since the last session.
 * Shared with buildSessionContext so the two never drift.
 *
 * @param {number|string|null} lastSessionAt - ms epoch or ISO string
 * @param {number} [nowMs=Date.now()]
 * @returns {string|null} e.g. "3 days ago", "yesterday", "2 hours ago", "just now"
 */
export function sessionGapPhrase(lastSessionAt, nowMs = Date.now()) {
  if (!lastSessionAt) return null;
  const lastMs = typeof lastSessionAt === 'number' ? lastSessionAt : Date.parse(lastSessionAt);
  if (!Number.isFinite(lastMs)) return null;

  const gapMinutes = Math.floor((nowMs - lastMs) / 60000);
  const gapHours = Math.floor(gapMinutes / 60);
  const gapDays = Math.floor(gapHours / 24);

  if (gapMinutes < 5) return 'just now';
  if (gapMinutes < 60) return `${gapMinutes} minutes ago`;
  if (gapHours < 24) return `${gapHours} hours ago`;
  if (gapDays === 1) return 'yesterday';
  return `${gapDays} days ago`;
}

/**
 * Build the greeting instruction handed to the voice agent.
 *
 * @param {object} args
 * @param {string}  args.userName
 * @param {boolean} args.isContinuation - switched from text, or resuming an open thread
 * @param {number}  args.sessionCount
 * @param {string|null} args.gapPhrase    - from sessionGapPhrase
 * @param {string|null} args.promotedFact - one durable fact, already reference-framed
 * @param {string|null} args.hint         - a next_session_hints follow-up, if any
 * @returns {string}
 */
export function buildVoiceGreeting({
  userName = 'there',
  isContinuation = false,
  sessionCount = 0,
  gapPhrase = null,
  promotedFact = null,
  hint = null,
} = {}) {
  // Mid-thread: the person was just here. Don't reintroduce — a warm greeting
  // after a 30-second gap reads as amnesia, which is the opposite of the goal.
  if (isContinuation) {
    return 'Casually acknowledge switching to voice and continue the conversation. One sentence.';
  }

  // Someone the agent has real history with. Ground the opening in a concrete
  // fact and a real time-gap rather than asking it to invent something.
  if (sessionCount > 0) {
    const lines = [`Greet ${userName} warmly by name — you know them well (${sessionCount} conversations).`];

    if (gapPhrase && gapPhrase !== 'just now') {
      lines.push(`You last spoke ${gapPhrase}; let that land naturally if it fits — don't force it.`);
    }
    if (promotedFact) {
      // A real thing you carry about them. Reference framing already applies to
      // promoted memories, so this is safe to speak to as something you noted.
      lines.push(`Something you carry about them: "${promotedFact}". Reference it naturally to show you remember — do not quote it verbatim.`);
    } else if (hint) {
      // No promoted fact yet (the tier fills over ~a week). Fall back to the
      // last session's follow-up rather than a generic opener.
      lines.push(`A thread from last time worth picking up: "${hint}".`);
    } else {
      lines.push('Reference one specific thing you know about them to show you remember.');
    }

    lines.push('Keep it to two sentences, then wait for their response.');
    return lines.join(' ');
  }

  // Genuinely new. A warm, plain opener is the honest move — nothing to remember yet.
  return `Say: "Hey, ${userName}! How's it going?" and wait for their response.`;
}
