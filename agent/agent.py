"""BattleBuddy LiveKit Voice Agent — VOIP-style conversation with Claude + Deepgram."""

import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from dotenv import load_dotenv
import httpx
from livekit import agents
from livekit.agents import AgentServer, AgentSession, Agent, function_tool, APIConnectOptions
from livekit.agents.llm import ChatContext
from livekit.agents.voice.agent_session import SessionConnectOptions
from livekit.plugins import anthropic, deepgram
import aiohttp
import asyncio


def local_now(timezone):
    """The user's current wall clock, or None if the zone can't be resolved.

    Never falls back to datetime.now(): the container clock is UTC, and a UTC
    time formatted without a zone and injected as "the current local time"
    is exactly the fabricated-timestamp bug — a confidently wrong clock. If we
    don't know the user's real local time, the model must be told it's
    unavailable, not handed a lie (requirements.txt pins tzdata so resolution
    only fails on a genuinely bogus timezone string).
    """
    try:
        return datetime.now(ZoneInfo(timezone)).strftime("%-I:%M %p on %A, %B %-d, %Y")
    except Exception:
        try:
            return datetime.now(ZoneInfo("America/Chicago")).strftime("%-I:%M %p on %A, %B %-d, %Y")
        except Exception:
            return None

load_dotenv(Path(__file__).parent / ".env")

# Fail loudly at boot if the tz database is missing (python:*-slim has no OS
# tzdata; the pip tzdata package in requirements.txt provides it). Every
# per-turn time injection depends on this.
try:
    ZoneInfo("America/Chicago")
    print("[Agent] tzdata OK — per-turn local-time injection active")
except Exception as _tz_err:
    print(f"[Agent] FATAL-ISH: tzdata unavailable ({_tz_err}) — local time injection will be disabled, BB will say it doesn't have the clock")

# Support both local dev layout (agent/ is sibling to server/) and container layout (/app/)
_base = Path(os.environ.get("APP_BASE", Path(__file__).parent.parent))

FALLBACK_PROMPT = (_base / "server" / "prompts" / "system.battlebuddy.md").read_text()
FALLBACK_PROMPT = FALLBACK_PROMPT.replace("{{profile}}", "New user.")
FALLBACK_PROMPT = FALLBACK_PROMPT.replace("{{trigger_context}}", "User opened a voice session.")
FALLBACK_PROMPT = FALLBACK_PROMPT.replace("{{recent_history}}", "No prior history.")
FALLBACK_PROMPT = FALLBACK_PROMPT.replace("{{life_architecture}}", "Not yet discovered — learn through conversation.")
FALLBACK_PROMPT = FALLBACK_PROMPT.replace("{{session_context}}", "No prior session data.")

VOICE_CONFIG_PATH = _base / "server" / "voice-config.json"
DEFAULT_VOICE = "aura-2-arcas-en"
SERVER_URL = os.environ.get("SERVER_URL", "http://localhost:3333")

# App-identity token for server routes gated by checkClientToken
# (/context/analyze) — the same shared secret the mobile build sends as
# `Authorization: Bearer ...`. Must be set on the agent's Railway service
# (same value as the server's BB_CLIENT_TOKEN) or transcript posts 401.
BB_CLIENT_TOKEN = os.environ.get("BB_CLIENT_TOKEN", "")


def auth_headers():
    """Authorization header for token-gated server routes. Empty when the
    token is unset so local dev against an ungated server still works —
    but production posts will 401 without it (warned at boot)."""
    return {"Authorization": f"Bearer {BB_CLIENT_TOKEN}"} if BB_CLIENT_TOKEN else {}

# Deploy stamp — bb-agent has no numbered builds (tarball deploys via
# `railway up`), so log the code's own timestamp at boot to make "what is
# the voice agent running right now" answerable from the logs.
try:
    _DEPLOY_STAMP = datetime.fromtimestamp(os.path.getmtime(__file__)).strftime("%Y-%m-%d %H:%M UTC")
except Exception:
    _DEPLOY_STAMP = "unknown"
print(f"[Agent] BattleBuddy voice agent — code stamp {_DEPLOY_STAMP}")
if not BB_CLIENT_TOKEN:
    print("[Agent] WARNING: BB_CLIENT_TOKEN is not set — /context/analyze posts will be rejected (401) and voice transcripts will not be captured")

END_PHRASES = ["bye bye buddy", "bye-bye buddy", "bye bye, buddy"]

SAVE_INTERVAL_SECONDS = 60


def get_voice():
    try:
        return json.loads(VOICE_CONFIG_PATH.read_text()).get("voice", DEFAULT_VOICE)
    except Exception:
        return DEFAULT_VOICE


def merge_agent_config(dispatch_meta, config):
    """Server-fetched session config wins over the compact dispatch metadata.

    LiveKit caps dispatch metadata at 64 KiB and the rendered system prompt is
    far bigger, so /livekit/token sends only small fields plus a one-time
    configToken; the full config (systemPrompt, greeting, ...) is fetched from
    the server. None values in the fetched config never clobber metadata.
    """
    if not config:
        return dispatch_meta
    return {**dispatch_meta, **{k: v for k, v in config.items() if v is not None}}


async def fetch_agent_config(room_name, config_token):
    """Trade the dispatch nonce for the full session config. Returns None on
    failure — callers fall back to dispatch metadata / FALLBACK_PROMPT so a
    server hiccup degrades the greeting, never the whole session."""
    if not room_name or not config_token:
        return None
    for attempt in range(3):
        try:
            async with aiohttp.ClientSession() as http:
                resp = await http.post(
                    f"{SERVER_URL}/livekit/agent-config",
                    json={"room": room_name, "token": config_token},
                    timeout=aiohttp.ClientTimeout(total=5),
                )
                if resp.status == 200:
                    return await resp.json()
                print(f"[Agent] agent-config fetch got {resp.status} (attempt {attempt + 1})")
        except Exception as e:
            print(f"[Agent] agent-config fetch failed (attempt {attempt + 1}): {e}")
        await asyncio.sleep(1)
    return None


async def send_to_context_agent(user_id, messages, session_id=None, is_session_end=False, timezone="America/Chicago", dev_mode=False):
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                f"{SERVER_URL}/context/analyze",
                json={"userId": user_id, "sessionId": session_id, "messages": messages, "isSessionEnd": is_session_end, "timezone": timezone, "devMode": dev_mode},
                headers=auth_headers(),
                timeout=aiohttp.ClientTimeout(total=30),
            )
            print(f"[Agent] Context agent responded: {resp.status} (end={is_session_end}, msgs={len(messages)})")
    except Exception as e:
        print(f"[Agent] Context agent call failed: {e}")


server = AgentServer()


@server.rtc_session(agent_name="battlebuddy")
async def battlebuddy_session(ctx: agents.JobContext):
    dispatch_meta = {}
    try:
        raw = ctx.job.metadata if hasattr(ctx.job, 'metadata') else None
        if raw:
            dispatch_meta = json.loads(raw)
    except Exception:
        pass

    # The full config (system prompt + greeting) is too big for dispatch
    # metadata — trade the nonce for it. On failure the fallbacks below keep
    # the session speaking with the generic prompt rather than going silent.
    config_token = dispatch_meta.get("configToken")
    if config_token:
        room_name = dispatch_meta.get("room") or getattr(ctx.room, "name", None)
        fetched = await fetch_agent_config(room_name, config_token)
        if fetched:
            dispatch_meta = merge_agent_config(dispatch_meta, fetched)
        else:
            print(f"[Agent] agent-config unavailable for {room_name} — using fallback prompt")

    system_prompt = dispatch_meta.get("systemPrompt") or FALLBACK_PROMPT
    if dispatch_meta.get("devMode", False):
        system_prompt = system_prompt + "\n\n## Developer Session\nYou are currently speaking with the BattleBuddy developer. This is not a live user coaching session. When the developer shares product feedback, feature ideas, or bug observations, acknowledge them naturally and conversationally (e.g. \"Good callout, I'll note that.\") rather than treating them as personal habit-coaching topics. All safety protocols and hard limits remain fully in effect."
    greeting = dispatch_meta.get("greeting") or "Say: 'Hey, really glad you're here. How are you doing?'"

    user_id = dispatch_meta.get("userId") or "default"
    timezone = dispatch_meta.get("timezone") or "America/Chicago"
    # Rides every /context/analyze post so the server can rebuild a dev-capture
    # segment even after a redeploy wiped its in-memory state (devCapture.js).
    dev_mode_on = dispatch_meta.get("devMode", False) is True
    last_session_at = dispatch_meta.get("last_session_at")
    session_id = getattr(ctx.room, "name", None) or f"session-{int(time.time())}"

    # Compute session gap for the system prompt injection (Bug D)
    session_gap_str = ""
    if last_session_at:
        try:
            last_dt = datetime.fromisoformat(last_session_at.replace("Z", "+00:00"))
            gap_seconds = (datetime.now(last_dt.tzinfo or ZoneInfo("UTC")) - last_dt).total_seconds()
            gap_minutes = int(gap_seconds / 60)
            if gap_minutes < 30:
                session_gap_str = f"Last session: {gap_minutes} minutes ago. This is a continuation — skip the greeting."
            elif gap_minutes < 60:
                session_gap_str = f"Last session: {gap_minutes} minutes ago."
            elif gap_minutes < 1440:
                session_gap_str = f"Last session: {gap_minutes // 60} hours ago."
            else:
                session_gap_str = f"Last session: {gap_minutes // 1440} days ago."
        except Exception:
            pass

    print(f"[Agent] Session started for {user_id}")

    session_messages = []
    last_save_count = 0
    session_ended = False

    # Bug I: 30-second repeat buffer — track last question asked
    last_question = {"text": "", "time": 0.0}

    # Last successfully fetched usage-facts line — the fallback when the
    # per-turn fetch times out, so a server hiccup degrades to slightly stale
    # ground truth instead of no ground truth (which is when BB improvises).
    facts_cache = {"line": ""}

    async def fetch_usage_facts_line():
        """Ground-truth cigarette facts for the per-turn injection.

        Deterministic and server-computed (bb_events, user's timezone) — the
        voice model must never count or time-stamp cigarettes itself; it got
        'one today' past five logged rows doing that (2026-07-29). Tight
        timeout: this sits ahead of first-token on every turn.
        """
        try:
            async with aiohttp.ClientSession() as http:
                resp = await http.get(
                    f"{SERVER_URL}/context/factsline/{user_id}?timezone={timezone}",
                    timeout=aiohttp.ClientTimeout(total=1.5),
                )
                if resp.status == 200:
                    data = await resp.json()
                    line = data.get("line") or ""
                    if line:
                        facts_cache["line"] = line
                        return line
        except Exception as e:
            print(f"[Agent] factsline fetch failed: {e}")
        return facts_cache["line"]

    class SessionAgent(Agent):
        def __init__(self):
            super().__init__(instructions=system_prompt)

        @function_tool()
        async def check_dev_mode(self):
            """Report whether this conversation is in developer mode (the DEV toggle on the chat screen). Always call this whenever the user mentions dev mode / developer mode or asks to create a PR, file a build request, or ship a product change — verify the real state instead of assuming it."""
            # The toggle state rides on the /livekit/token request and reaches us
            # via dispatch metadata, so it is fixed for this voice connection —
            # flipping the toggle takes effect on the next connect (text turns
            # pick it up immediately).
            on = dispatch_meta.get("devMode", False) is True
            print(f"[Agent] check_dev_mode for {user_id}: {on}")
            return json.dumps({
                "dev_mode": on,
                "meaning": (
                    "Developer mode is ON: this conversation is a developer session. It is being captured into the dev pipeline as product requests; feature/PR/build asks are pipeline input."
                    if on else
                    "Developer mode is OFF: this is a normal BattleBuddy companion conversation. If the user wants to create a PR or file a build request, tell them to flip the DEV toggle on the chat screen first — nothing is captured while it is off."
                ),
            })

        @function_tool()
        async def get_usage_stats(self):
            """Get the user's deterministic cigarette/usage counts, gaps between cigarettes, and averages. Always call this for any numeric usage question instead of counting manually."""
            try:
                async with aiohttp.ClientSession() as http:
                    resp = await http.get(
                        f"{SERVER_URL}/context/stats/{user_id}?timezone={timezone}",
                        timeout=aiohttp.ClientTimeout(total=10),
                    )
                    data = await resp.json()
                    print(f"[Agent] Usage stats for {user_id}: {data}")
                    return json.dumps(data)
            except Exception as e:
                print(f"[Agent] get_usage_stats failed: {e}")
                return json.dumps({"error": str(e)})

        async def _fact_tool(self, name, tool_input):
            """Shared transport for the canonical-memory tools — one server
            executor (factTools.js) serves text and voice so they can't drift."""
            try:
                async with aiohttp.ClientSession() as http:
                    resp = await http.post(
                        f"{SERVER_URL}/context/facts/tool",
                        json={"userId": user_id, "name": name, "input": tool_input, "sessionId": session_id},
                        timeout=aiohttp.ClientTimeout(total=10),
                    )
                    data = await resp.json()
                    print(f"[Agent] {name} for {user_id}: {data}")
                    return json.dumps(data)
            except Exception as e:
                print(f"[Agent] {name} failed: {e}")
                return json.dumps({"error": str(e)})

        @function_tool()
        async def remember(self, category: str, statement: str, user_words: str):
            """Save a durable fact the user just stated about themselves — situation, people, triggers, what works, reasons, preferences. category is one of: identity, quit, trigger, window, routine, coping, motivation, person, preference, watch. statement: the fact as one plain sentence. user_words: REQUIRED verbatim quote of what the user said — a fact you cannot quote is a fact you may not save. Acknowledge naturally ('noted'), never read the mechanics aloud. Not for countable events (log_event) or your own inferences."""
            return await self._fact_tool("remember", {"category": category, "statement": statement, "user_words": user_words})

        @function_tool()
        async def correct_memory(self, key: str, new_statement: str = "", retire: bool = False):
            """The user corrected something you know about them. Applies immediately. key: the fact's key from your memory document or lookup_fact (e.g. 'trigger.morning-coffee'). Pass new_statement with the corrected fact, or retire=true if it's simply no longer true. Acknowledge the fix in the same turn."""
            payload = {"key": key}
            if new_statement:
                payload["new_statement"] = new_statement
            if retire:
                payload["retire"] = True
            return await self._fact_tool("correct_memory", payload)

        @function_tool()
        async def forget(self, key_or_topic: str):
            """The user explicitly asked you to forget something about them. Retires the fact and suppresses related past-session memories. Confirm back what was forgotten. For corrections use correct_memory instead."""
            return await self._fact_tool("forget", {"key_or_topic": key_or_topic})

        @function_tool()
        async def lookup_fact(self, key_or_category: str):
            """Look up stored facts about the user beyond your injected memory document — by key ('quit.reason'), category ('coping'), or fragment ('coffee'). If it returns nothing, you don't know it: say so and ask, never guess."""
            return await self._fact_tool("lookup_fact", {"key_or_category": key_or_category})

        @function_tool()
        async def recall_episodes(self, query: str, date: str = ""):
            """Search past conversations with this user — full transcript history plus distilled memory entries, all dated. Use whenever the user references something discussed before ('remember when...', 'what did we talk about', 'you said...'), on any memory probe, or when past context would materially improve the response. Cite dates conservatively from what it returns. For durable FACTS use your memory document or lookup_fact — this tool is for episodes and moments. query: keywords/topics/names. date: optional YYYY-MM-DD filter."""
            try:
                params = f"userId={user_id}&query={query}"
                if date:
                    params += f"&date={date}"
                async with aiohttp.ClientSession() as http:
                    resp = await http.get(
                        f"{SERVER_URL}/context/recall?{params}",
                        timeout=aiohttp.ClientTimeout(total=10),
                    )
                    data = await resp.json()
                    print(f"[Agent] recall_episodes '{query}' for {user_id}: {len(data.get('memory_entries', []))} memories, {len(data.get('transcript_excerpts', []))} excerpts")
                    return json.dumps(data)
            except Exception as e:
                print(f"[Agent] recall_episodes failed: {e}")
                return json.dumps({"error": str(e)})

        @function_tool()
        async def log_event(self, event_type: str, occurred_at: str = "", notes: str = "", trigger: str = "", location: str = ""):
            """Log a smoking or urge event the user just told you about. event_type is one of: cigarette, urge_resisted, urge_gave_in, milestone. ALWAYS leave occurred_at empty for 'right now' — the server stamps the authoritative current time; never compute 'now' yourself. Only pass occurred_at when back-dating, as the user's LOCAL wall-clock time exactly as they said it (e.g. '2026-07-29T16:43:00') — no timezone conversion, no UTC offset. trigger: optional short label for what triggered the event (e.g. 'after coffee', 'stress'). location: optional short label for where it happened (e.g. 'car', 'garage'). For slips, always confirm with the user before logging. Confirm back what you logged in one short line."""
            try:
                metadata: dict = {"source": "voice"}
                if notes:
                    metadata["notes"] = notes
                if location:
                    metadata["location"] = location
                if trigger:
                    metadata["trigger"] = {"label": trigger}
                payload = {
                    "userId": user_id,
                    "eventType": event_type,
                    "timezone": timezone,
                    "metadata": metadata,
                }
                if occurred_at:
                    payload["occurredAt"] = occurred_at
                async with aiohttp.ClientSession() as http:
                    resp = await http.post(
                        f"{SERVER_URL}/events",
                        json=payload,
                        headers=auth_headers(),
                        timeout=aiohttp.ClientTimeout(total=10),
                    )
                    data = await resp.json()
                    print(f"[Agent] log_event {event_type} for {user_id}: {data}")
                    return json.dumps(data)
            except Exception as e:
                print(f"[Agent] log_event failed: {e}")
                return json.dumps({"error": str(e)})

        @function_tool()
        async def update_event(self, event_id: str, action: str, event_type: str = "", occurred_at: str = "", notes: str = "", location: str = ""):
            """Correct or delete a mislogged event. action is 'update' or 'delete'. Get the event_id from get_usage_stats first. If correcting the time, pass occurred_at as the user's LOCAL wall-clock time exactly as they said it (e.g. '2026-07-29T16:43:00') — no timezone conversion, no UTC offset. location: optional corrected location label. Tell the user what changed."""
            try:
                payload = {"userId": user_id, "eventId": event_id, "action": action, "timezone": timezone}
                if event_type:
                    payload["eventType"] = event_type
                if occurred_at:
                    payload["occurredAt"] = occurred_at
                if notes:
                    payload["notes"] = notes
                if location:
                    payload["location"] = location
                async with aiohttp.ClientSession() as http:
                    resp = await http.post(
                        f"{SERVER_URL}/events/update",
                        json=payload,
                        headers=auth_headers(),
                        timeout=aiohttp.ClientTimeout(total=10),
                    )
                    data = await resp.json()
                    print(f"[Agent] update_event {action} {event_id} for {user_id}: {data}")
                    return json.dumps(data)
            except Exception as e:
                print(f"[Agent] update_event failed: {e}")
                return json.dumps({"error": str(e)})

        async def on_user_turn_completed(self, turn_ctx, new_message):
            # Inject the current local time before every response. This message
            # is the single source of "now" — it supersedes the (session-start,
            # by now stale) time in the system prompt and anything said earlier.
            try:
                now = local_now(timezone)
                if now:
                    turn_ctx.add_message(
                        role="system",
                        content=(
                            f"[The current local time for the user is {now} ({timezone}). "
                            "This is already local — never convert it or apply a UTC offset. "
                            "It supersedes any time stated earlier in this conversation or in your instructions. "
                            "Use it as 'now'; never compute or carry over a different time.]"
                        ),
                    )
                else:
                    turn_ctx.add_message(
                        role="system",
                        content=(
                            "[The current local time is UNAVAILABLE this turn. If you need the time, "
                            "say you don't have the clock right now — never estimate or invent one.]"
                        ),
                    )
            except Exception:
                pass

            # Inject the server-computed cigarette facts before every response
            # — counts, last-cigarette time, and gaps come ONLY from here (or a
            # fresh get_usage_stats call), never from the model's own memory.
            try:
                facts_line = await fetch_usage_facts_line()
                if facts_line:
                    turn_ctx.add_message(role="system", content=f"[{facts_line}]")
                else:
                    turn_ctx.add_message(
                        role="system",
                        content=(
                            "[LOGGED CIGARETTE FACTS are UNAVAILABLE this turn. For any count, "
                            "time, or gap question, call get_usage_stats and report only what it "
                            "returns — if that also fails, say you can't pull the log right now. "
                            "Never estimate or reconstruct numbers from conversation memory.]"
                        ),
                    )
            except Exception:
                pass

            # Bug I: Inject repeat guard
            if last_question["text"] and (time.time() - last_question["time"]) < 60:
                try:
                    turn_ctx.add_message(
                        role="system",
                        content=f"[REPEAT GUARD: You recently asked: \"{last_question['text']}\". Do NOT ask the same or a substantially similar question again. Move the conversation forward.]",
                    )
                except Exception:
                    pass

    session = AgentSession(
        stt=deepgram.STT(model="nova-3", language="multi"),
        # caching="ephemeral" caches the big system prompt + tools across turns
        # (the ~15K-token prompt was reprocessed cold on every turn, pushing
        # first-token time past the framework's 10s per-attempt default and
        # surfacing as BB "stuck thinking"). Generous read timeout for the
        # uncached first turn.
        llm=anthropic.LLM(
            model="claude-haiku-4-5-20251001",
            caching="ephemeral",
            timeout=httpx.Timeout(10.0, read=90.0),
        ),
        tts=deepgram.TTS(model=get_voice()),
        min_endpointing_delay=0.5,
        max_endpointing_delay=1.5,
        # Our on_user_turn_completed injects the local time each turn, which
        # invalidates every preemptive generation — pure duplicate LLM load.
        preemptive_generation=False,
        conn_options=SessionConnectOptions(
            llm_conn_options=APIConnectOptions(max_retry=3, retry_interval=1.0, timeout=45.0),
        ),
    )

    @session.on("conversation_item_added")
    def on_item(ev):
        try:
            item = ev.item
            role = str(getattr(item, 'role', ''))
            if role in ('user', 'assistant'):
                content = ""
                if hasattr(item, 'text_content'):
                    content = item.text_content
                elif hasattr(item, 'content'):
                    c = item.content
                    if isinstance(c, str):
                        content = c
                    elif isinstance(c, list):
                        for part in c:
                            t = getattr(part, 'text', None) or getattr(part, 'content', None)
                            if t:
                                content = str(t)
                                break
                if not content and hasattr(item, 'text'):
                    content = str(item.text)

                if content:
                    session_messages.append({"role": role, "content": content})

                    # Bug I: Track assistant questions for repeat buffer
                    if role == "assistant" and "?" in content:
                        last_question["text"] = content.strip()
                        last_question["time"] = time.time()

                    if role == "user":
                        lower = content.lower().strip()
                        for phrase in END_PHRASES:
                            if phrase in lower:
                                asyncio.ensure_future(_end_session(session, ctx, user_id, session_messages, session_id, timezone, dev_mode_on))
                                return
        except Exception:
            pass

    await session.start(
        room=ctx.room,
        agent=SessionAgent(),
    )

    # Periodic save loop — runs every SAVE_INTERVAL_SECONDS, sends whatever we have
    async def periodic_save():
        nonlocal last_save_count
        while not session_ended:
            await asyncio.sleep(SAVE_INTERVAL_SECONDS)
            if session_ended:
                break
            current_count = len(session_messages)
            if current_count > last_save_count and current_count >= 2:
                last_save_count = current_count
                print(f"[Agent] Periodic save: {current_count} messages for {user_id}")
                await send_to_context_agent(user_id, list(session_messages), session_id=session_id, timezone=timezone, dev_mode=dev_mode_on)

    save_task = asyncio.ensure_future(periodic_save())

    @session.on("error")
    def on_error(ev):
        err_msg = str(ev) if ev else "unknown error"
        print(f"[Agent] Session error for {user_id}: {err_msg}")
        if "credit balance" in err_msg or "too low" in err_msg or "billing" in err_msg.lower():
            asyncio.ensure_future(session.generate_reply(
                instructions="Say exactly: 'Hey, I'm having a connection issue on my end right now. Give me a minute and try again.' Do not say anything else."
            ))
        elif "rate" in err_msg.lower() and "limit" in err_msg.lower():
            asyncio.ensure_future(session.generate_reply(
                instructions="Say exactly: 'I'm getting a lot of traffic right now. Hang tight — try again in a minute.' Do not say anything else."
            ))

    @session.on("close")
    def on_close(ev):
        nonlocal session_ended
        if session_ended:
            return
        session_ended = True
        save_task.cancel()

        if session_messages and len(session_messages) >= 2:
            print(f"[Agent] Session close: sending {len(session_messages)} messages for {user_id} (isSessionEnd=true)")
            asyncio.ensure_future(_send_final_transcript(user_id, list(session_messages), session_id, timezone, dev_mode_on))

    await session.generate_reply(instructions=greeting)


async def _send_final_transcript(user_id, messages, session_id=None, timezone="America/Chicago", dev_mode=False):
    """Send the final transcript with retries — this is the most important call."""
    for attempt in range(3):
        try:
            async with aiohttp.ClientSession() as http:
                resp = await http.post(
                    f"{SERVER_URL}/context/analyze",
                    json={"userId": user_id, "sessionId": session_id, "messages": messages, "isSessionEnd": True, "timezone": timezone, "devMode": dev_mode},
                    headers=auth_headers(),
                    timeout=aiohttp.ClientTimeout(total=30),
                )
                print(f"[Agent] Final transcript sent: {resp.status} ({len(messages)} msgs, attempt {attempt + 1})")
                if resp.status == 200:
                    return
        except Exception as e:
            print(f"[Agent] Final transcript attempt {attempt + 1} failed: {e}")
            if attempt < 2:
                await asyncio.sleep(2)


async def _end_session(session, ctx, user_id, messages, session_id=None, timezone="America/Chicago", dev_mode=False):
    await session.generate_reply(
        instructions="The user said 'bye bye buddy' to end the call. "
        "Say bye and one short sentence of encouragement. Keep it warm and brief."
    )

    if messages and len(messages) >= 2:
        print(f"[Agent] End session — sending {len(messages)} messages to context agent")
        await send_to_context_agent(user_id, messages, session_id=session_id, is_session_end=True, timezone=timezone, dev_mode=dev_mode)

    await asyncio.sleep(3)
    await ctx.room.disconnect()


if __name__ == "__main__":
    agents.cli.run_app(server)
