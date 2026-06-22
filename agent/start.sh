#!/bin/bash
# Start the BattleBuddy voice agent with required env vars
cd "$(dirname "$0")"
export TORIO_USE_FFMPEG=0
exec .venv/bin/python3 agent.py "$@"
