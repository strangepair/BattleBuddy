"""BattleBuddy LiveKit Voice Agent — VOIP-style conversation with Claude + Deepgram."""

import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import AgentServer, AgentSession, Agent
from livekit.agents.llm import ChatContext
from livekit.plugins import anthropic, deepgram
import aiohttp
import asyncio


def local_now(timezone):
    try:
        return datetime.now(ZoneInfo(timezone)).strftime("%-I:%M %p on %A, %B %-d, %Y")
    except Exception:
        return datetime.now().strftime("%-I:%M %p on %A, %B %-d, %Y")

load_dotenv(Path(__file__).parent / ".env")

# Support both local dev layout (agent/ is sibling to prompts/) and container layout (/app/)
_base = Path(os.environ.get("APP_BASE", Path(__file__).parent.parent))

FALLBACK_PROMPT = (_base / "prompts" / "system.battlebuddy.md").read_text()
FALLBACK_PROMPT = FALLBACK_PROMPT.replace("{{profile}}", "New user.")
FALLBACK_PROMPT = FALLBACK_PROMPT.replace("{{trigger_context}}", "User opened a voice session.")
FALLBACK_PROMPT = FALLBACK_PROMPT.replace("{{recent_history}}", "No prior history.")

VOICE_CONFIG_PATH = _base / "server" / "voice-config.json"
DEFAULT_VOICE = "aura-2-arcas-en"
SERVER_URL = os.environ.get("SERVER_URL", "http://localhost:3333")

END_PHRASES = ["bye bye buddy", "bye-bye buddy", "bye bye, buddy"]

SAVE_INTERVAL_SECONDS = 60


def get_voice():
    try:
        return json.loads(VOICE_CONFIG_PATH.read_text()).get("voice", DEFAULT_VOICE)
    except Exception:
        return DEFAULT_VOICE


async def send_to_context_agent(user_id, messages, is_session_end=False, timezone="America/Chicago"):
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                f"{SERVER_URL}/context/analyze",
                json={"userId": user_id, "messages": messages, "isSessionEnd": is_session_end, "timezone": timezone},
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

    system_prompt = dispatch_meta.get("systemPrompt") or FALLBACK_PROMPT
    greeting = dispatch_meta.get("greeting") or "Say: 'Hey! How's it going?'"

    user_id = dispatch_meta.get("userId") or "default"
    timezone = dispatch_meta.get("timezone") or "America/Chicago"

    print(f"[Agent] Session started for {user_id}")

    session_messages = []
    last_save_count = 0
    session_ended = False

    class SessionAgent(Agent):
        def __init__(self):
            super().__init__(instructions=system_prompt)

        async def on_user_turn_completed(self, turn_ctx, new_message):
            # Inject the current local time before every response so BB always
            # knows "now" — the clock stays live for the whole call.
            try:
                now = local_now(timezone)
                turn_ctx.add_message(
                    role="system",
                    content=f"[The current local time for the user is {now}. Use this as 'now' when referencing time.]",
                )
            except Exception:
                pass

    session = AgentSession(
        stt=deepgram.STT(model="nova-3", language="multi"),
        llm=anthropic.LLM(model="claude-haiku-4-5-20251001"),
        tts=deepgram.TTS(model=get_voice()),
        min_endpointing_delay=0.5,
        max_endpointing_delay=1.5,
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

                    if role == "user":
                        lower = content.lower().strip()
                        for phrase in END_PHRASES:
                            if phrase in lower:
                                asyncio.ensure_future(_end_session(session, ctx, user_id, session_messages, timezone))
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
                await send_to_context_agent(user_id, list(session_messages), timezone=timezone)

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
            asyncio.ensure_future(_send_final_transcript(user_id, list(session_messages), timezone))

    await session.generate_reply(instructions=greeting)


async def _send_final_transcript(user_id, messages, timezone="America/Chicago"):
    """Send the final transcript with retries — this is the most important call."""
    for attempt in range(3):
        try:
            async with aiohttp.ClientSession() as http:
                resp = await http.post(
                    f"{SERVER_URL}/context/analyze",
                    json={"userId": user_id, "messages": messages, "isSessionEnd": True, "timezone": timezone},
                    timeout=aiohttp.ClientTimeout(total=30),
                )
                print(f"[Agent] Final transcript sent: {resp.status} ({len(messages)} msgs, attempt {attempt + 1})")
                if resp.status == 200:
                    return
        except Exception as e:
            print(f"[Agent] Final transcript attempt {attempt + 1} failed: {e}")
            if attempt < 2:
                await asyncio.sleep(2)


async def _end_session(session, ctx, user_id, messages, timezone="America/Chicago"):
    await session.generate_reply(
        instructions="The user said 'bye bye buddy' to end the call. "
        "Say bye and one short sentence of encouragement. Keep it warm and brief."
    )

    if messages and len(messages) >= 2:
        print(f"[Agent] End session — sending {len(messages)} messages to context agent")
        await send_to_context_agent(user_id, messages, is_session_end=True, timezone=timezone)

    await asyncio.sleep(3)
    await ctx.room.disconnect()


if __name__ == "__main__":
    agents.cli.run_app(server)
