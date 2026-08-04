FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ && \
    rm -rf /var/lib/apt/lists/*

COPY agent/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The image is FLAT: agent.py, utils/ and tools/ all land directly in /app.
# So imports inside agent.py must be "from utils…" / "from tools…", never
# "from agent.utils…" — in here `agent` is the agent.py module, not a package.
COPY agent/agent.py ./agent.py
COPY agent/utils/ ./utils/
COPY agent/tools/ ./tools/
COPY server/prompts/ /app/server/prompts/
COPY server/voice-config.json /app/server/voice-config.json

ENV TORIO_USE_FFMPEG=0
ENV APP_BASE=/app

# Bake the VAD / turn-detector model files into the image. Without this the
# first job would try to fetch them at runtime — same class of trap as the
# missing utils/ COPY in PR #120: fine everywhere it's tested, dead in the
# container. Runs after the ENV lines because importing agent.py needs
# APP_BASE to resolve server/prompts/. CI runs this same command so a broken
# download fails the PR, not the deploy.
RUN python agent.py download-files

CMD ["python", "agent.py", "start"]
