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

CMD ["python", "agent.py", "start"]
