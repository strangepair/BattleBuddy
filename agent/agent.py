"""BattleBuddy LiveKit Voice Agent — VOIP-style conversation with Claude + Deepgram."""

import json
import os
from pathlib import Path
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import AgentServer, AgentSession, Agent
from livekit.plugins import anthropic, deepgram

load_dotenv(Path(__file__).parent / ".env")

SYSTEM_PROMPT = (Path(__file__).parent.parent / "prompts" / "system.battlebuddy.md").read_text()
SYSTEM_PROMPT = SYSTEM_PROMPT.replace("{{profile}}", "New user — no history yet.")
SYSTEM_PROMPT = SYSTEM_PROMPT.replace("{{trigger_context}}", "User just opened a voice session — they may be having an urge.")
SYSTEM_PROMPT = SYSTEM_PROMPT.replace("{{recent_history}}", "First message in this session.")

VOICE_CONFIG_PATH = Path(__file__).parent.parent / "server" / "voice-config.json"
DEFAULT_VOICE = "aura-2-arcas-en"


def get_voice():
    try:
        config = json.loads(VOICE_CONFIG_PATH.read_text())
        return config.get("voice", DEFAULT_VOICE)
    except Exception:
        return DEFAULT_VOICE


GREETING_FRESH = (
    "The user just opened a voice session — they may be having an urge right now. "
    "Greet them warmly and let them know you're here. Keep it to 1-2 sentences."
)

GREETING_FROM_TEXT = (
    "The user just switched from text chat to voice mode — you were already talking. "
    "Acknowledge the switch naturally, like 'Hey, glad to hear your voice — let's keep going.' "
    "Don't re-introduce yourself. Keep it to one sentence."
)


END_PHRASES = ["bye bye buddy", "bye-bye buddy", "bye bye, buddy"]


class BattleBuddyAgent(Agent):
    def __init__(self):
        super().__init__(instructions=SYSTEM_PROMPT)


server = AgentServer()


@server.rtc_session(agent_name="battlebuddy")
async def battlebuddy_session(ctx: agents.JobContext):
    session = AgentSession(
        stt=deepgram.STT(model="nova-3", language="multi"),
        llm=anthropic.LLM(model="claude-haiku-4-5-20251001"),
        tts=deepgram.TTS(model=get_voice()),
        min_endpointing_delay=0.5,
        max_endpointing_delay=1.5,
    )

    @session.on("user_input_transcribed")
    def on_transcript(ev):
        text = ev.transcript.lower().strip()
        for phrase in END_PHRASES:
            if phrase in text:
                import asyncio
                asyncio.ensure_future(_end_session(session, ctx))
                return

    await session.start(
        room=ctx.room,
        agent=BattleBuddyAgent(),
    )

    # Detect if user switched from text chat
    greeting = GREETING_FRESH
    for p in ctx.room.remote_participants.values():
        try:
            meta = json.loads(p.metadata or "{}")
            if meta.get("context") == "switched_from_text":
                greeting = GREETING_FROM_TEXT
                break
        except (json.JSONDecodeError, TypeError):
            pass

    await session.generate_reply(instructions=greeting)


async def _end_session(session: AgentSession, ctx: agents.JobContext):
    await session.generate_reply(
        instructions="The user said 'bye bye buddy' to end the call. "
        "Say bye and one short sentence of encouragement. Keep it warm and brief."
    )
    import asyncio
    await asyncio.sleep(3)
    await ctx.room.disconnect()


if __name__ == "__main__":
    agents.cli.run_app(server)
