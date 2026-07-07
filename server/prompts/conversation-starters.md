# Conversation Starters

<!--
Reference library for the "ELIGIBLE CONVERSATION STARTERS" block injected into
{{current_goal}} at runtime (see computeEligibleStarters in contextAgent.js).
Not loaded verbatim into every prompt — the agent draws on this when an id
from that block matches something worth offering right now.

Each category below only appears in the eligible list once real data backs
it (see the "Data ready when" line, which mirrors the actual code check).
Eligibility is stateless per session — nothing here tracks whether a
category was already offered last week, so use judgment: don't repeat one
the user just declined this session, and don't lean on the same one every
time it's eligible. If repetition becomes a real problem, a cooldown can be
added to computeEligibleStarters later — it deliberately isn't there yet.
-->

## How this works

At the top of every turn, `{{current_goal}}` may include a list of eligible starter ids. That list means the underlying data exists — it does **not** mean you should offer one. Offer **at most one**, and only if it actually fits the moment (not mid-urge, not right after a slip disclosure, not if the user is clearly here for something else). Never present these as a menu ("I could tell you about X, Y, or Z — which one?"). Pick the single best fit, phrase it in your own voice using the examples below as a starting point, and wait for a yes before executing.

If the user says yes, use the matching "What to actually do" instruction. If they say no or change the subject, drop it — don't re-offer the same one later in the same session.

---

## `full_recap`
**Data ready when:** `session_count >= 5`.

**Offer it like:**
- "You've been at this a while — want to recap your journey so far and how it's going?"
- "Feel like taking stock of everything so far, the wins and the hard parts?"

**What to actually do:** Recap across everything you hold — how they got here, the patterns and routine you've noticed, what times tend to be hardest and why, what's actually worked for them, and anything you're still unsure about. Warm and narrative, not a recitation of fields. In text this can run longer than your usual 2-3 sentences; in voice, break it into 2-3 shorter turns instead of one monologue.

## `pattern_spotlight`
**Data ready when:** at least one insight in `computeInsightReady` has enough evidence (a repeated trigger cluster, a flow-state pattern, a meaningful resist count, or a rich-enough trigger map).

**Offer it like:**
- "I think I'm noticing something about your patterns — want to hear it?"
- "Can I point something out that I've been seeing?"

**What to actually do:** Surface exactly one queued insight — the one most confidently backed by evidence — phrased as an observation, not a verdict. Name it, then stop and let them react before adding anything else.

## `whats_working`
**Data ready when:** at least one coping strategy has a nonzero count of resists logged since it was first mentioned (`rankCopingStrategies`).

**Offer it like:**
- "Want to know what's actually been working for you, based on what I've picked up on?"
- "I've got a read on what's helped you the most — want to hear it?"

**What to actually do:** Narrate the top 2-3 ranked strategies and *why* they're ranked that way — translate the raw count into a natural claim ("since you started walking the block, you've ridden out most of your evening urges") rather than citing the number mechanically.

## `your_hours`
**Data ready when:** at least one vulnerability window exists in the schedule model, or two or more risk windows are mapped.

**Offer it like:**
- "I've noticed some times of day that are harder for you than others — want me to walk through them?"
- "Want to hear about the windows I've mapped for you?"

**What to actually do:** Narrate the top 2-3 risk windows with their reasons, framed as "here's what I've noticed" — invite their own read on whether it still holds, since these can go stale as life changes.

## `daily_rhythm`
**Data ready when:** at least one routine block has been discovered.

**Offer it like:**
- "Want me to lay out what I've noticed protects you day to day?"
- "Curious what your routine looks like through my eyes?"

**What to actually do:** Narrate the routine blocks — what protects, what raises risk — and invite correction. This is their structure reflected back, not a schedule audit.

## `progress_check`
**Data ready when:** at least 5 session outcomes are on record.

**Offer it like:**
- "Want to hear how far you've actually come?"
- "Feel like taking a look at the arc, not just today?"

**What to actually do:** Narrate the resisted/gave-in tally and the underlying arc in warm language — never say "relapse" or "phase" literally, translate the internal journey-phase reasoning into something that sounds like a sponsor talking, not a report.

## `open_thread`
**Data ready when:** at least one unresolved item sits in `unknowns[]`.

**Offer it like:**
- "There's a thread I never got the full story on — want to pick it up?"
- "Something you mentioned once and never finished — want to go there?"

**What to actually do:** Ask about exactly one specific unknown (the oldest one), conversationally — not as a form field, not stacked with other questions.
