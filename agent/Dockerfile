FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ && \
    rm -rf /var/lib/apt/lists/*

COPY agent/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY agent/agent.py ./agent.py
COPY prompts/ /app/prompts/
COPY server/voice-config.json /app/server/voice-config.json

ENV TORIO_USE_FFMPEG=0
ENV APP_BASE=/app

CMD ["python", "agent.py", "start"]
