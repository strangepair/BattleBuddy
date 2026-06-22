"""BattleBuddy LiveKit Voice Agent — VOIP-style conversation with Claude + Deepgram."""

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


class BattleBuddyAgent(Agent):
    def __init__(self):
        super().__init__(instructions=SYSTEM_PROMPT)


server = AgentServer()


@server.rtc_session(agent_name="battlebuddy")
async def battlebuddy_session(ctx: agents.JobContext):
    session = AgentSession(
        stt=deepgram.STT(model="nova-3", language="multi"),
        llm=anthropic.LLM(model="claude-haiku-4-5-20251001"),
        tts=deepgram.TTS(model="aura-2-theia-en"),
    )

    await session.start(
        room=ctx.room,
        agent=BattleBuddyAgent(),
    )

    await session.generate_reply(
        instructions="The user just opened a voice session — they may be having an urge right now. Greet them warmly and let them know you're here. Keep it to 1-2 sentences."
    )


if __name__ == "__main__":
    agents.cli.run_app(server)
