"""BattleBuddy LiveKit Voice Agent — the EARS AND MOUTH of one shared brain.

Reply architecture (changed 2026-08-04; read this before touching the file).

There used to be two brains. The mobile client sends every final STT transcript
to bb-server's POST /session/turn, which runs its own Anthropic call and streams
the reply into the chat UI — that is the reply the user actually reads. This
agent ALSO ran its own LLM over the same turn, and that second generation never
produced audio: it hung somewhere between generate_reply and playout, so voice
sessions transcribed speech perfectly and answered in silence.

Now there is one brain and one reply:

    user speaks → Deepgram STT → transcript published to the room
        → mobile client POSTs it to /session/turn (unchanged)
        → server generates the reply, streams it to the chat UI (unchanged)
        → server pushes the finished text into this room as a `bb.speak`
          data packet (server/voiceBridge.js)
        → this agent speaks it with session.say() through Deepgram TTS

So the agent's own LLM is deliberately never invoked: on_user_turn_completed
raises StopResponse, and every place that used to call generate_reply now says
a literal line instead. The LLM stays configured on the session only because
AgentSession expects one — nothing routes to it. The @function_tool methods
below are likewise inert on this path (the server executes the same tools via
AGENT_TOOLS); they are kept so re-enabling the agent-side LLM is a one-line
change rather than a rewrite.
"""

import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from dotenv import load_dotenv
import httpx
from livekit import agents, rtc
from livekit.agents import AgentServer, AgentSession, Agent, function_tool, APIConnectOptions, StopResponse
from livekit.agents.llm import ChatContext
from livekit.agents.voice.agent_session import SessionConnectOptions
from livekit.plugins import anthropic, deepgram
from livekit.agents import tts as lk_tts
import logging
import inspect
import aiohttp
import asyncio

# Local agent modules. These MUST stay at module level and MUST NOT be prefixed
# with "agent." — two separate traps, both of which shipped green:
#   * The Dockerfile flattens agent/ into /app, so "agent.utils.x" resolves to
#     the agent.py *module* in the container and raises ModuleNotFoundError.
#     From a repo-root checkout it resolves fine (PEP 420 namespace package),
#     so local runs and root-relative CI never see it.
#   * The CI import gate executes only module-level code, so an import buried
#     in a method body is invisible to it. PR #101 put one inside
#     SessionAgent.__init__ and crash-looped every voice job for ~18 hours.
from utils.deduplication import EventDeduplicator
from tools.log_activity import log_activity as _log_activity
from tools.resistance_block_tools import (
    start_resistance_block as _start_resistance_block,
    flag_urge_on_block as _flag_urge_on_block,
    close_resistance_block as _close_resistance_block,
)
from tools.verify_log import verify_last_log as _verify_last_log

logger = logging.getLogger(__name__)


async def trace_node(label: str, result, item_name: str, exit_note: str = ""):
    """Iterate a LiveKit Agent node result, tracing first item / total / errors.

    `Agent.llm_node` and `Agent.tts_node` are NOT async generator functions in
    livekit-agents 1.6.2 — each is typed to return an AsyncIterable, OR a
    coroutine resolving to one, OR a coroutine resolving to None. All three
    shapes are handled here so a framework-side change of shape degrades to
    "no trace" instead of a TypeError that would break voice outright.

    Module level (not a closure) purely so tests/test_node_tracing.py can
    execute it: overrides that only run inside a live LiveKit session are
    invisible to CI, which is the same deferred-execution blind spot that let
    the agent.utils ModuleNotFoundError ship green.
    """
    t0 = time.monotonic()
    n = 0
    try:
        if inspect.isawaitable(result):
            result = await result
        if result is None:
            return
        async for item in result:
            n += 1
            if n == 1:
                _vlog(f"{label}: FIRST {item_name} after {time.monotonic() - t0:.2f}s")
            yield item
    except Exception as exc:
        _vlog(f"{label}: RAISED after {time.monotonic() - t0:.2f}s: {exc!r}")
        raise
    finally:
        _vlog(
            f"{label}: EXIT after {time.monotonic() - t0:.2f}s — {n} {item_name.lower()}s"
            f"{exit_note if n == 0 else ''}"
        )


def _vlog(msg: str) -> None:
    """Timestamped, flushed diagnostic line for the reply pipeline.

    Every line is prefixed [VOICE-DIAG] so one grep isolates the whole
    generate_reply → LLM → TTS → playback chain from the rest of the logs.
    Explicitly flushed: the container's stdout was block-buffered, so the
    plain print() lines only reached Railway when the process exited — which
    is precisely why a session that HANGS (rather than crashes) showed no
    trace of where it stopped. Dockerfile now also sets PYTHONUNBUFFERED=1;
    the flush here makes these lines independent of that.
    """
    # time.gmtime, not ZoneInfo — a diagnostic helper must never be able to
    # raise on a machine where the tz database is the thing that's broken.
    _t = time.time()
    print(f"[VOICE-DIAG {time.strftime('%H:%M:%S', time.gmtime(_t))}.{int((_t % 1) * 1000):03d}Z] {msg}", flush=True)


class _LoggedTTS(lk_tts.TTS):
    """Thin wrapper around deepgram.TTS that adds explicit per-step logging.

    Every TTS request is traced: request sent → synthesis complete → frames
    counted. Exceptions are re-raised (never swallowed) so the session error
    handler and LiveKit framework both see them.
    Playback start/end is logged via agent_started_speaking / agent_stopped_speaking
    session events (registered after session creation).
    """

    def __init__(self, inner: lk_tts.TTS, model_name: str = "unknown"):
        super().__init__(
            capabilities=inner.capabilities,
            sample_rate=inner.sample_rate,
            num_channels=inner.num_channels,
        )
        self._inner = inner
        self._model_name = model_name
        _vlog(
            f"TTS wrapper built — model={model_name} streaming={inner.capabilities.streaming} "
            f"sample_rate={inner.sample_rate} channels={inner.num_channels}"
        )

    def prewarm(self) -> None:
        # Forwarded so the inner Deepgram client still gets its connection
        # pool warmed; the base-class default is a no-op, so without this the
        # wrapper silently cost us the prewarm.
        try:
            self._inner.prewarm()
        except Exception as exc:
            _vlog(f"TTS prewarm failed (non-fatal): {exc!r}")

    def synthesize(self, text: str, *, conn_options=None) -> "_LoggedStream":
        from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
        opts = conn_options if conn_options is not None else DEFAULT_API_CONNECT_OPTIONS
        text_preview = text[:80].replace("\n", " ")
        print(f"[TTS] Request sent — text ({len(text)} chars): {text_preview!r}")
        try:
            inner_stream = self._inner.synthesize(text, conn_options=opts)
        except Exception as exc:
            print(f"[TTS] ERROR creating synthesis stream: {exc!r}")
            raise
        return _LoggedStream(tts=self, input_text=text, inner_stream=inner_stream, conn_options=opts)

    def stream(self, *, conn_options=None):
        # THIS is the path production actually takes. Deepgram advertises
        # capabilities.streaming=True, so LiveKit calls stream() and never
        # synthesize() — which means every [TTS] line in synthesize() above
        # has been dead code since it was added (PR #75) and its silence was
        # never evidence of anything. Log here instead. The stream object is
        # returned UNWRAPPED on purpose: the framework type-checks it, and a
        # proxy would risk breaking synthesis to gain logging that tts_node
        # (below) already provides at the frame level.
        from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
        opts = conn_options if conn_options is not None else DEFAULT_API_CONNECT_OPTIONS
        _vlog(f"tts.stream(): opening Deepgram synthesis stream (model={self._model_name})")
        try:
            return self._inner.stream(conn_options=opts)
        except Exception as exc:
            _vlog(f"tts.stream(): FAILED to open stream: {exc!r}")
            raise

    async def aclose(self) -> None:
        await self._inner.aclose()


class _LoggedStream(lk_tts.ChunkedStream):
    """Intercepts the inner Deepgram ChunkedStream to count frames and surface errors."""

    def __init__(self, *, tts: _LoggedTTS, input_text: str, inner_stream, conn_options):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._inner_stream = inner_stream
        self._frame_count = 0

    async def _run(self, output_emitter: lk_tts.AudioEmitter) -> None:
        try:
            await self._inner_stream._run(output_emitter)
        except Exception as exc:
            print(f"[TTS] ERROR during synthesis: {exc!r}")
            raise
        print(f"[TTS] Synthesis complete — audio queued for playback")


# local_now() lived here: it rendered the user's wall clock for the per-turn
# time injection. That injection fed the agent-side LLM, which no longer runs —
# /session/turn does the same job (server/timeContext.js) for the generation
# that actually happens. The rule it encoded still stands wherever time is
# stated: never fall back to the container clock, which is UTC, because a UTC
# time presented as local is the fabricated-timestamp bug.

load_dotenv(Path(__file__).parent / ".env")

# Fail loudly at boot if the tz database is missing (python:*-slim has no OS
# tzdata; the pip tzdata package in requirements.txt provides it). Still load-
# bearing for the session-gap math and the UTC stamps on voice_failure events.
try:
    ZoneInfo("America/Chicago")
    print("[Agent] tzdata OK")
except Exception as _tz_err:
    print(f"[Agent] FATAL-ISH: tzdata unavailable ({_tz_err}) — zone-aware timestamps will fail")

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

# ── Server → agent reply bridge ──────────────────────────────────────────────
# The server publishes each finished /session/turn reply to the room as a
# LiveKit data packet on this topic; we speak it. Topic-scoped so it can never
# collide with the client's own data traffic (it listens for the bare string
# "VOICE_FAILURE" on the default topic).
SPEAK_TOPIC = "bb.speak"

# Spoken when the server's greeting line can't be fetched (e.g. the agent
# redeployed ahead of the server and /voice/greeting isn't live yet). A literal,
# never an instruction: nothing on this path can turn an instruction into speech.
DEFAULT_SPOKEN_GREETING = "Hey, really glad you're here. How are you doing?"
DEFAULT_SPOKEN_CONTINUATION = "Okay, I'm on voice now — go ahead."


def parse_speak_packet(topic, data, seen_ids):
    """Decode a `bb.speak` data packet into the line to say, or None to ignore.

    Pure and module-level on purpose. The handler that calls it is registered
    inside the session, where neither CI gate can see it — the same deferred-
    execution blind spot that let a ModuleNotFoundError ship green and kill
    voice for 18 hours. This function holds every branch worth testing, so
    tests/test_speak_bridge.py can execute them for real.

    seen_ids is a mutable set: LiveKit reliable delivery can repeat a packet,
    and speaking the same reply twice is the exact failure this whole change
    exists to remove.

    A missing "type" is accepted. bb-server and bb-agent are separate Railway
    services that deploy independently, and the shape shipped in #125 was a
    bare {"text": …} — rejecting it would make voice silent for whatever window
    a new agent runs against the old server.
    """
    if topic != SPEAK_TOPIC:
        return None
    try:
        payload = json.loads(bytes(data).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("type", "speak") != "speak":
        return None
    text = (payload.get("text") or "").strip()
    if not text:
        return None
    msg_id = payload.get("id")
    if msg_id:
        if msg_id in seen_ids:
            return None
        seen_ids.add(msg_id)
    return text


async def fetch_greeting_text(room_name, config_token):
    """Ask the server for the LITERAL opening line to speak.

    The agent no longer has an LLM of its own, so it cannot turn the greeting
    *instruction* the server composes (buildVoiceGreeting) into speech. The
    server renders it to a spoken line and returns that. Auth is the same
    single-dispatch nonce used by /livekit/agent-config, which stays readable
    for its TTL. Returns None on any failure — the caller falls back to a
    literal so a server hiccup costs the greeting's warmth, never the session.
    """
    if not room_name or not config_token:
        return None
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                f"{SERVER_URL}/voice/greeting",
                json={"room": room_name, "token": config_token},
                timeout=aiohttp.ClientTimeout(total=15),
            )
            if resp.status == 200:
                data = await resp.json()
                return (data.get("text") or "").strip() or None
            _vlog(f"greeting: /voice/greeting returned {resp.status}")
    except Exception as e:
        _vlog(f"greeting: /voice/greeting failed: {e}")
    return None


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
    room_name = dispatch_meta.get("room") or getattr(ctx.room, "name", None)
    if config_token:
        fetched = await fetch_agent_config(room_name, config_token)
        if fetched:
            dispatch_meta = merge_agent_config(dispatch_meta, fetched)
        else:
            print(f"[Agent] agent-config unavailable for {room_name} — using fallback prompt")

    system_prompt = dispatch_meta.get("systemPrompt") or FALLBACK_PROMPT
    if dispatch_meta.get("devMode", False):
        system_prompt = system_prompt + "\n\n## Developer Session\nYou are currently speaking with the BattleBuddy developer. This is not a live user coaching session. When the developer shares product feedback, feature ideas, or bug observations, acknowledge them naturally and conversationally (e.g. \"Good callout, I'll note that.\") rather than treating them as personal habit-coaching topics. All safety protocols and hard limits remain fully in effect."
    # When switching from text to voice mid-session, skip the standard greeting
    # so the user doesn't hear "Hey, really glad you're here" again mid-conversation.
    # Only the FALLBACK is decided here: the real line comes from the server
    # (/voice/greeting), which renders the same buildVoiceGreeting instruction
    # this agent used to hand to its own LLM.
    is_continuation = (
        dispatch_meta.get("context") == "switched_from_text" and bool(dispatch_meta.get("sessionId"))
    )
    fallback_greeting = DEFAULT_SPOKEN_CONTINUATION if is_continuation else DEFAULT_SPOKEN_GREETING

    user_id = dispatch_meta.get("userId") or "default"
    timezone = dispatch_meta.get("timezone") or "America/Chicago"
    # Rides every /context/analyze post so the server can rebuild a dev-capture
    # segment even after a redeploy wiped its in-memory state (devCapture.js).
    dev_mode_on = dispatch_meta.get("devMode", False) is True
    # When the user switches from text to voice mid-session the mobile client
    # sends the active text-session ID so the voice agent continues the same
    # conversation rather than forking a new one. Fall back to the LiveKit room
    # name (which the token request also derives from the session ID when one
    # exists) and finally to a timestamp-based ID for fresh sessions.
    session_id = (
        dispatch_meta.get("sessionId")
        or getattr(ctx.room, "name", None)
        or f"session-{int(time.time())}"
    )
    if dispatch_meta.get("sessionId"):
        print(f"[Agent] Continuing existing session {session_id} for {user_id} (switched from text)")

    # A session-gap string was computed here for a system-prompt injection that
    # no code ever read (dead before this change, and the agent has no prompt to
    # inject into now). The live version is sessionGapPhrase() in
    # server/greeting.js, which feeds the greeting the server actually renders.

    print(f"[Agent] Session started for {user_id}")

    session_messages = []
    last_save_count = 0
    session_ended = False
    active_block_id: list = [None]
    block_urge_flagged: list = [False]

    # The per-turn context injections that used to live here — local time, the
    # server-computed usage-facts line, the 30-second repeat guard — are gone
    # with the agent-side LLM they fed. /session/turn performs every one of
    # them for the generation that actually happens now (see buildSystemPrompt
    # and buildLastEventAwareness in server/index.js), so keeping them here
    # bought nothing and cost up to 1.5s of blocking HTTP on every turn.

    class SessionAgent(Agent):
        def __init__(self):
            super().__init__(instructions=system_prompt)
            self._event_dedup = EventDeduplicator()

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
            """Log a smoking or urge event the user just told you about. event_type is one of: cigarette, urge_resisted, urge_gave_in, milestone. ALWAYS leave occurred_at empty for 'right now' — the server stamps the authoritative current time; never compute 'now' yourself. Only pass occurred_at when back-dating, as the user's LOCAL wall-clock time exactly as they said it (e.g. '2026-07-29T16:43:00') — no timezone conversion, no UTC offset. trigger: optional short label for what triggered the event (e.g. 'after coffee', 'stress'). location: optional short label for where it happened (e.g. 'car', 'garage'). When the user explicitly requests logging ('log', 'log that', 'log it', 'log my ...') with a discernible event type, call this tool immediately — do NOT ask a confirmation question first. Only ask a clarifying question when no event type can be inferred. For ambiguous slip disclosures where the user has NOT explicitly requested logging, confirm first. ORDERING REQUIREMENT: you MUST await the result of this tool call before generating any confirmation phrase ('logged', 'recorded', 'noted', 'saved', etc.). Never confirm a log entry until this tool call returns a success response (success=true). Do not emit a confirmation in the same generation pass as the tool call — only confirm in the follow-up turn after this tool has returned a success result. When confirming, always include the timestamp from the tool response local_time field (e.g. 'Logged at 7:45 AM') — never assume the current time. If this tool returns an error or success=false, do not claim the entry was saved; tell the user the log failed and offer to try again."""
            # ORDERING REQUIREMENT: This coroutine fully awaits the backend HTTP
            # round-trip before returning. The LLM confirmation turn MUST NOT be
            # generated until this function has returned — the return value is the
            # gate. In the server-side tool loop (index.js executeToolUse /
            # runStream), the LLM is only re-invoked after all tool_result blocks
            # have been collected, which means this await is the hard barrier
            # between "user said log it" and "agent says it's logged".
            # If the current user turn contains any log/record/save intent for a
            # cigarette event and this function has not yet returned, the LLM
            # cannot have a tool_result to include in its context, so it cannot
            # legitimately claim the entry was saved. Any confirmation phrase
            # before this function returns is a hallucination of the result.
            # GUARD: this function MUST complete its full await chain and return
            # a result dict containing success=true before the LLM can generate
            # any confirmation phrase ("logged", "recorded", "saved", count, or
            # timestamp). The tool loop only re-invokes the LLM after every
            # tool_result block is present in context, so this return value is
            # the hard gate between "user said log it" and "agent says it's logged".
            # Any confirmation emitted while this coroutine is in-flight would
            # be a hallucination — the tool_result is structurally unavailable.
            if self._event_dedup.should_skip(event_type):
                print(f"[Agent] log_event {event_type} deduplicated — skipping backend call")
                return json.dumps({"success": True, "ok": True, "deduplicated": True})
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
                # Awaiting here is the enforcement point: nothing downstream of
                # this coroutine can run until the HTTP response is received and
                # the result is returned to the tool loop. The LLM confirmation
                # turn is only possible after this await resolves.
                async def _post_event():
                    async with aiohttp.ClientSession() as http:
                        resp = await http.post(
                            f"{SERVER_URL}/events",
                            json=payload,
                            headers=auth_headers(),
                            timeout=aiohttp.ClientTimeout(total=10),
                        )
                        return resp.status, await resp.json()

                write_before = datetime.now(tz=ZoneInfo("UTC"))
                status, data = await _post_event()
                if status not in (200, 201) or not (data.get("ok") or data.get("success")):
                    reason = data.get("error") or data.get("message") or f"server returned {status}"
                    print(f"[Agent] log_event {event_type} FAILED for {user_id}: {reason}")
                    return json.dumps({"success": False, "error": reason})
                # Inject local_time so the LLM confirmation can echo the
                # persisted timestamp rather than assuming the current time.
                # The server returns entry.created_at as a raw UTC instant;
                # convert it to a human-readable local time here if the
                # server did not already include a local_time field.
                if not data.get("local_time"):
                    try:
                        raw_ts = (data.get("entry") or {}).get("created_at") or ""
                        if raw_ts:
                            _tz = ZoneInfo(timezone)
                            _dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).astimezone(_tz)
                            data = dict(data)
                            data["local_time"] = _dt.strftime("%-I:%M %p")
                    except Exception as _te:
                        print(f"[Agent] log_event local_time format failed (non-fatal): {_te}")
                # Verify the write landed in the backend before confirming.
                # If verification returns False the write is retried once;
                # if the retry also fails verification the error is surfaced.
                verified = await _verify_last_log(SERVER_URL, auth_headers(), event_type, write_before)
                if not verified:
                    print(f"[Agent] log_event {event_type} verify failed for {user_id} — retrying")
                    retry_status, retry_data = await _post_event()
                    if retry_status not in (200, 201) or not (retry_data.get("ok") or retry_data.get("success")):
                        reason = retry_data.get("error") or retry_data.get("message") or f"server returned {retry_status}"
                        print(f"[Agent] log_event {event_type} RETRY FAILED for {user_id}: {reason}")
                        return json.dumps({"success": False, "error": reason, "retry": True})
                    data = retry_data
                    if not data.get("local_time"):
                        try:
                            raw_ts = (data.get("entry") or {}).get("created_at") or ""
                            if raw_ts:
                                _tz = ZoneInfo(timezone)
                                _dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).astimezone(_tz)
                                data = dict(data)
                                data["local_time"] = _dt.strftime("%-I:%M %p")
                        except Exception as _te:
                            print(f"[Agent] log_event retry local_time format failed (non-fatal): {_te}")
                    verified2 = await _verify_last_log(SERVER_URL, auth_headers(), event_type, write_before)
                    if not verified2:
                        print(f"[Agent] log_event {event_type} re-verify failed for {user_id} after retry")
                        return json.dumps({"success": False, "error": "log could not be verified after retry", "retry": True})
                    data = dict(data)
                    data["retried"] = True
                    print(f"[Agent] log_event {event_type} retry verified for {user_id}: {data}")
                print(f"[Agent] log_event {event_type} for {user_id}: {data}")
                self._event_dedup.record(event_type)
                if event_type in ("cigarette", "urge_gave_in") and active_block_id[0]:
                    block_urge_flagged[0] = True
                    bid = active_block_id[0]
                    active_block_id[0] = None
                    asyncio.ensure_future(_close_block(bid, True))
                # Ensure success=true is always explicit on the success path so
                # the LLM has an unambiguous gate field to check before confirming.
                data = dict(data)
                data["success"] = True
                # Read-back: fetch confirmed count and last timestamp from the
                # backend AFTER the write is verified. This is mandatory — the
                # LLM must report only values returned by the backend, never
                # in-memory or computed counts (which can diverge if events are
                # logged from other surfaces between voice turns, or if the
                # dedup layer skipped a write).
                try:
                    async with aiohttp.ClientSession() as _stats_http:
                        _stats_resp = await _stats_http.get(
                            f"{SERVER_URL}/context/stats/{user_id}?timezone={timezone}",
                            timeout=aiohttp.ClientTimeout(total=10),
                        )
                        _stats = await _stats_resp.json()
                        print(f"[Agent] log_event stats read-back for {user_id}: {_stats}")
                        data["confirmed_stats"] = _stats
                except Exception as _se:
                    print(f"[Agent] log_event stats read-back failed (non-fatal): {_se}")
                    # Signal to the LLM that the count is unconfirmed so it
                    # falls back to the safe failure phrase instead of stating
                    # a number that may be stale.
                    data["confirmed_stats"] = {"error": str(_se), "unconfirmed": True}
                return json.dumps(data)
            except Exception as e:
                print(f"[Agent] log_event failed: {e}")
                return json.dumps({"success": False, "error": str(e)})

        @function_tool()
        async def log_activity(self, activity_name: str, start_time: str = "", end_time: str = "", location: str = ""):
            """Log an activity the user just reported starting or finishing. activity_name: short label (e.g. 'gym', 'lunch', 'work'). ALWAYS leave start_time empty for an activity happening now — the server stamps the authoritative current time; never compute 'now' yourself. Only pass start_time when back-dating, as the user's LOCAL wall-clock time as stated (e.g. '2026-08-01T14:30:00') — never convert to UTC. end_time: same format; omit when only a start is known. location: optional short label. Call immediately when the user reports finishing an activity or arriving somewhere — do NOT ask for confirmation first. If a back-dated start_time is genuinely ambiguous, ask once then call. Confirm in one sentence: the activity name and the time(s) logged."""
            result = await _log_activity(
                server_url=SERVER_URL,
                user_id=user_id,
                auth_headers=auth_headers(),
                activity_name=activity_name,
                start_time=start_time,
                end_time=end_time,
                location=location,
            )
            print(f"[Agent] log_activity '{activity_name}' for {user_id}: {result}")
            return result

        if dev_mode_on:
            @function_tool()
            async def create_dev_item(self, type: str, title: str, description: str, priority: str = "normal"):
                """Create a pipeline task (bug, feature, or task) directly from a developer session. type must be one of: bug, feature, task. title: short summary. description: what needs doing and why. priority: low | normal | high. Only available in developer mode. After calling, confirm to the user with the returned ID and title."""
                if not dev_mode_on:
                    return json.dumps({"error": "create_dev_item is only available in developer mode."})
                valid_types = ("bug", "feature", "task")
                if type not in valid_types:
                    return json.dumps({"error": f"type must be one of: {', '.join(valid_types)}"})
                try:
                    async with aiohttp.ClientSession() as http:
                        resp = await http.post(
                            f"{SERVER_URL}/api/dev-items",
                            json={"type": type, "title": title, "description": description, "priority": priority, "userId": user_id, "sessionId": session_id},
                            headers=auth_headers(),
                            timeout=aiohttp.ClientTimeout(total=10),
                        )
                        data = await resp.json()
                        print(f"[Agent] create_dev_item '{title}' for {user_id}: {data}")
                        if resp.status in (200, 201) and data.get("id"):
                            return json.dumps({"ok": True, "id": data["id"], "title": data.get("title", title)})
                        return json.dumps({"error": data.get("error", f"Server returned {resp.status}")})
                except Exception as e:
                    print(f"[Agent] create_dev_item failed: {e}")
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

        async def llm_node(self, *args, **kwargs):
            """Should never run. Kept as the tripwire for a second brain.

            on_user_turn_completed raises StopResponse, so no turn reaches an
            LLM call. If this ever logs ENTER, something re-armed agent-side
            generation and the user is about to be answered twice — by two
            different models, which is the failure this architecture removed.
            """
            _vlog("llm_node: ENTER — *** UNEXPECTED: agent-side LLM ran; the server is the reply source ***")
            async for _chunk in trace_node(
                "llm_node",
                Agent.llm_node(self, *args, **kwargs),
                "CHUNK",
                exit_note=" *** LLM PRODUCED NOTHING ***",
            ):
                yield _chunk

        async def tts_node(self, text, *args, **kwargs):
            """Trace the TTS leg: text in, audio frames out.

            This is now the ONLY node on the reply path — session.say() feeds
            it directly. FIRST AUDIO FRAME is the line that settles a silent
            session: if _speak() logs a say() and this reports 0 frames, the
            break is Deepgram synthesis; if this never ENTERs, the reply never
            reached the agent and the break is the server-side bridge.
            """
            _chars = {"n": 0}

            async def _counted_text():
                async for _t in text:
                    _chars["n"] += len(_t or "")
                    yield _t

            _vlog("tts_node: ENTER — text stream opened")
            try:
                async for _frame in trace_node(
                    "tts_node",
                    Agent.tts_node(self, _counted_text(), *args, **kwargs),
                    "AUDIO FRAME",
                    exit_note=" *** TTS EMITTED NO AUDIO ***",
                ):
                    yield _frame
            finally:
                _vlog(f"tts_node: {_chars['n']} chars of LLM text reached synthesis")

        async def on_user_turn_completed(self, turn_ctx, new_message):
            """Log the transcript, then stop — this agent never answers.

            Raising StopResponse is what makes the single-brain architecture
            real: livekit-agents catches it here and abandons the turn before
            any LLM call. The transcript itself is already on its way to the
            client (user_input_transcribed fires in the STT pipeline, upstream
            of and independent from reply generation), so the client still
            POSTs it to /session/turn and the reply still comes back — over
            the data channel, to be spoken by _speak() below.
            """
            # An empty transcript means Deepgram produced no output — nothing
            # to log and nothing for the server to answer.
            try:
                user_text = ""
                if hasattr(new_message, 'text_content') and new_message.text_content:
                    user_text = str(new_message.text_content)
                elif hasattr(new_message, 'content'):
                    c = new_message.content
                    if isinstance(c, str):
                        user_text = c
                    elif isinstance(c, list):
                        for part in c:
                            t = getattr(part, 'text', None)
                            if t:
                                user_text = str(t)
                                break
                if user_text:
                    print(f"[STT] Transcript received ({len(user_text)} chars): {user_text[:120]!r}")
                    _vlog(f"turn: transcript out to client — server will answer ({len(user_text)} chars)")
                else:
                    print(f"[STT] WARNING: empty transcript from Deepgram (message type: {type(new_message).__name__})")
            except Exception as e:
                print(f"[Agent] STT logging error: {e}")

            raise StopResponse()

    _voice_model = get_voice()
    print(f"[Agent] TTS voice model: {_voice_model}")
    _deepgram_tts = deepgram.TTS(model=_voice_model)
    _logged_tts = _LoggedTTS(_deepgram_tts, model_name=_voice_model)
    # The cold-prompt first-token hang is the leading hypothesis for the
    # silent greeting; the prompt's actual size is the premise, so state it.
    _vlog(f"system prompt: {len(system_prompt)} chars (~{len(system_prompt) // 4} tokens)")

    session = AgentSession(
        stt=deepgram.STT(model="nova-3", language="multi"),
        # Configured but never called: AgentSession expects an LLM, and every
        # turn is stopped before generation (see on_user_turn_completed). The
        # reply comes from bb-server over the bb.speak data channel.
        llm=anthropic.LLM(
            model="claude-haiku-4-5-20251001",
            caching="ephemeral",
            timeout=httpx.Timeout(10.0, read=90.0),
        ),
        tts=_logged_tts,
        min_endpointing_delay=0.5,
        max_endpointing_delay=1.5,
        # No agent-side generation happens at all, preemptive or otherwise.
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
            if role not in ('user', 'assistant'):
                return
            content = ""
            if hasattr(item, 'text_content') and item.text_content:
                content = str(item.text_content)
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
            if not content and hasattr(item, 'text') and item.text:
                content = str(item.text)

            if not content:
                print(f"[Agent] on_item: {role} turn has no extractable text (item type: {type(item).__name__})")
                return

            print(f"[Agent] on_item: {role} turn captured ({len(content)} chars)")
            session_messages.append({"role": role, "content": content})

            if role == "user":
                lower = content.lower().strip()
                for phrase in END_PHRASES:
                    if phrase in lower:
                        asyncio.ensure_future(_end_session(session, ctx, user_id, session_messages, session_id, timezone, dev_mode_on, active_block_id, block_urge_flagged))
                        return
                _URGE_KEYWORDS = ("urge", "craving", "crave", "want to", "need to smoke", "need a cigarette", "need a vape")
                if active_block_id[0] and not block_urge_flagged[0] and any(kw in lower for kw in _URGE_KEYWORDS):
                    block_urge_flagged[0] = True
                    asyncio.ensure_future(_flag_urge(active_block_id[0]))
        except Exception as e:
            print(f"[Agent] on_item error: {e}")

    # ── The mouth ────────────────────────────────────────────────────────────
    # Everything BattleBuddy says in voice goes through here, greeting included.
    # No LLM, no streaming node chain: text straight into the session's Deepgram
    # TTS. The three log lines bracket the whole call so a silent session is
    # readable from the logs alone — say() entered, playout finished, or raised.
    _spoken_ids = set()

    async def _speak(text, label="reply"):
        _vlog(f"[SPEAK] say({label}) — {len(text)} chars: {text[:80]!r}")
        _t0 = time.monotonic()
        try:
            handle = session.say(text)
            await handle.wait_for_playout()
            _vlog(f"[SPEAK] say({label}) playout finished after {time.monotonic() - _t0:.2f}s")
        except Exception as exc:
            _vlog(f"[SPEAK] say({label}) FAILED after {time.monotonic() - _t0:.2f}s: {exc!r}")

    # Registered before start() so a reply that arrives during connection setup
    # is not dropped. LiveKit hands server-published packets a null participant,
    # so identity is never checked — the topic plus the config nonce that gated
    # this room is the trust boundary.
    @ctx.room.on("data_received")
    def on_data(packet: rtc.DataPacket):
        try:
            text = parse_speak_packet(
                getattr(packet, "topic", None), getattr(packet, "data", b""), _spoken_ids
            )
            if text is None:
                return
            _vlog(f"[SPEAK] Reply received from server ({len(text)} chars)")
            asyncio.ensure_future(_speak(text))
        except Exception as exc:
            _vlog(f"[SPEAK] data handler error: {exc!r}")

    _vlog(f"[SPEAK] Bridge armed — listening for '{SPEAK_TOPIC}' data packets")

    print(f"[Agent] Starting session for {user_id} (session_id={session_id}, room={getattr(ctx.room, 'name', 'unknown')})")
    _session_agent = SessionAgent()
    await session.start(
        room=ctx.room,
        agent=_session_agent,
    )
    print(f"[Agent] Session started — STT={type(session.stt).__name__} (nova-3/multi), TTS={type(session.tts).__name__}, replies via bb.speak bridge")

    # The client already renders every reply from the /session/turn SSE stream.
    # Publishing the agent's own transcription would print the identical text a
    # second time in the chat. This detaches ONLY the agent-side sink: the user's
    # STT transcripts ride RoomIO's separate _user_tr_output, and that forwarding
    # is what the client turns into its /session/turn POST — break it and voice
    # goes mute again. Guarded so a framework rename costs a duplicate bubble,
    # never the session.
    try:
        session.output.set_transcription_enabled(False)
        _vlog("agent transcription output disabled — chat text comes from /session/turn")
    except Exception as exc:
        _vlog(f"could not disable agent transcription (non-fatal, expect duplicate chat text): {exc!r}")

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
        tts_keywords = ("tts", "audio", "synthesize", "voice", "timeout", "SesameTTS", "pcm")
        if any(kw in err_msg.lower() for kw in tts_keywords):
            # Root cause comment: voice_failure events were logged via an
            # f-string with unescaped inner quotes, producing malformed
            # pseudo-JSON that was hard to grep/parse. Now uses json.dumps for
            # a properly serialised, machine-readable record including
            # error_code (first word of reason) for log-based alerting.
            import json as _json
            _error_code = err_msg.split()[0] if err_msg else "unknown"
            _vf_event = {
                "type": "voice_failure",
                "reason": err_msg,
                "error_code": _error_code,
                "session_id": session_id,
                "user_id": user_id,
                "timestamp": datetime.now(ZoneInfo("UTC")).isoformat(),
            }
            print(f"[Agent] VOICE_FAILURE {_json.dumps(_vf_event)}")
        # Spoken literally rather than via generate_reply: asking a model to
        # relay an outage is a model call inside an outage, and this agent has
        # no reply path of its own any more.
        if "credit balance" in err_msg or "too low" in err_msg or "billing" in err_msg.lower():
            asyncio.ensure_future(_speak(
                "Hey, I'm having a connection issue on my end right now. Give me a minute and try again.",
                label="error",
            ))
        elif "rate" in err_msg.lower() and "limit" in err_msg.lower():
            asyncio.ensure_future(_speak(
                "I'm getting a lot of traffic right now. Hang tight — try again in a minute.",
                label="error",
            ))

    @session.on("user_started_speaking")
    def on_user_started_speaking(ev):
        print(f"[STT] Audio detected — user started speaking")

    @session.on("user_stopped_speaking")
    def on_user_stopped_speaking(ev):
        print(f"[STT] Audio endpoint — user stopped speaking; awaiting transcript")

    @session.on("agent_started_speaking")
    def on_agent_started_speaking(ev):
        # Fires when the first synthesised frame is actually published to the
        # room. Never fired once in the 2026-08-04 silent session.
        _vlog("agent_started_speaking — FIRST AUDIO PUBLISHED TO ROOM")

    @session.on("agent_stopped_speaking")
    def on_agent_stopped_speaking(ev):
        _vlog("agent_stopped_speaking — playback finished")

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

        if active_block_id[0]:
            asyncio.ensure_future(_close_block(active_block_id[0], block_urge_flagged[0]))

    # The greeting is still the cleanest probe of the whole audio path: it is
    # unconditional and depends on no VAD, no turn detection, and now no LLM.
    # If the user hears this line, TTS and playout are healthy and anything
    # still silent afterwards is the reply bridge, not the mouth.
    async def _open_block():
        result = await _start_resistance_block(SERVER_URL, user_id, auth_headers())
        bid = result.get("id") or result.get("block_id") or result.get("blockId")
        if bid:
            active_block_id[0] = bid
            print(f"[Agent] Resistance block opened: {bid} for {user_id}")
        else:
            print(f"[Agent] Resistance block open failed: {result}")

    async def _flag_urge(block_id: str):
        result = await _flag_urge_on_block(SERVER_URL, block_id, auth_headers())
        print(f"[Agent] Urge flagged on block {block_id}: {result}")

    async def _close_block(block_id: str, urge_occurred: bool):
        result = await _close_resistance_block(SERVER_URL, block_id, urge_occurred, auth_headers())
        print(f"[Agent] Resistance block closed {block_id} (urge={urge_occurred}): {result}")
        active_block_id[0] = None

    asyncio.ensure_future(_open_block())

    _vlog("greeting: fetching spoken line from server")
    _greet_t0 = time.monotonic()
    greeting_text = await fetch_greeting_text(room_name, config_token)
    if greeting_text:
        _vlog(f"greeting: server line in {time.monotonic() - _greet_t0:.2f}s ({len(greeting_text)} chars)")
    else:
        greeting_text = fallback_greeting
        _vlog(f"greeting: falling back to literal after {time.monotonic() - _greet_t0:.2f}s")
    await _speak(greeting_text, label="greeting")


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


async def _end_session(session, ctx, user_id, messages, session_id=None, timezone="America/Chicago", dev_mode=False, active_block_id=None, block_urge_flagged=None):
    # A literal sign-off, for the same reason as everywhere else on this path:
    # the agent has no LLM of its own, and the room is about to close — a
    # generation racing a disconnect is how a goodbye becomes silence.
    _vlog("end: speaking sign-off")
    try:
        handle = session.say("Bye for now — I'm proud of you. Talk soon.")
        await handle.wait_for_playout()
    except Exception as exc:
        _vlog(f"end: sign-off RAISED: {exc!r}")

    if messages and len(messages) >= 2:
        print(f"[Agent] End session — sending {len(messages)} messages to context agent")
        await send_to_context_agent(user_id, messages, session_id=session_id, is_session_end=True, timezone=timezone, dev_mode=dev_mode)

    if active_block_id is not None and active_block_id[0]:
        bid = active_block_id[0]
        urge = block_urge_flagged[0] if block_urge_flagged else False
        active_block_id[0] = None
        try:
            result = await _close_resistance_block(SERVER_URL, bid, urge, {"Authorization": f"Bearer {BB_CLIENT_TOKEN}"} if BB_CLIENT_TOKEN else {})
            print(f"[Agent] Resistance block closed at end_session {bid} (urge={urge}): {result}")
        except Exception as e:
            print(f"[Agent] Resistance block close failed: {e}")

    await asyncio.sleep(3)
    await ctx.room.disconnect()


if __name__ == "__main__":
    agents.cli.run_app(server)
