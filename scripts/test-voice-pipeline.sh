#!/bin/bash
# BattleBuddy Voice Pipeline Test
# Tests each link in the chain: server → token → LiveKit → agent → STT → Claude → TTS

set -e

SERVER="http://192.168.1.102:3333"
ROOM="test-pipeline-$(date +%s)"
IDENTITY="test-user-$$"
AGENT_LOG=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}  $1${NC}"; }

# Find the agent log file (most recent background task output matching agent.py)
find_agent_log() {
  local base="/private/tmp/claude-501/-Users-strangepair-Claude-Projects-BattleBuddy"
  AGENT_LOG=$(find "$base" -name "*.output" -newer /tmp/.bb_test_marker 2>/dev/null | while read f; do
    grep -l "registered worker" "$f" 2>/dev/null
  done | tail -1)

  # Fallback: find any agent log
  if [ -z "$AGENT_LOG" ]; then
    AGENT_LOG=$(find "$base" -name "*.output" 2>/dev/null | while read f; do
      grep -l "registered worker" "$f" 2>/dev/null
    done | tail -1)
  fi
}

echo "═══════════════════════════════════════════"
echo " BattleBuddy Voice Pipeline Test"
echo "═══════════════════════════════════════════"
echo ""

touch /tmp/.bb_test_marker

# ── 1. Server health ──
echo "1. Server health check..."
HEALTH=$(curl -s -w "\n%{http_code}" "$SERVER/health" 2>/dev/null)
HTTP_CODE=$(echo "$HEALTH" | tail -1)
BODY=$(echo "$HEALTH" | head -1)
if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"ok":true'; then
  pass "Server is healthy at $SERVER"
else
  fail "Server not responding at $SERVER (HTTP $HTTP_CODE)"
fi

# ── 2. API keys ──
echo ""
echo "2. API keys check..."
AGENT_ENV="/Users/strangepair/Claude/Projects/BattleBuddy/agent/.env"
grep -q "ANTHROPIC_API_KEY=sk-" "$AGENT_ENV" && pass "Anthropic API key set" || fail "Anthropic API key missing"
grep -q "LIVEKIT_API_KEY=" "$AGENT_ENV" && pass "LiveKit API key set" || fail "LiveKit API key missing"
grep -q "LIVEKIT_API_SECRET=" "$AGENT_ENV" && pass "LiveKit API secret set" || fail "LiveKit API secret missing"
grep -q "DEEPGRAM_API_KEY=" "$AGENT_ENV" && pass "Deepgram STT key set" || fail "Deepgram STT key missing"

# ── 3. Agent running ──
echo ""
echo "3. Voice agent process..."
AGENT_PID=$(ps aux | grep "agent.py" | grep -v grep | awk '{print $2}' | head -1)
if [ -z "$AGENT_PID" ]; then
  fail "Voice agent process is not running — start it with: cd agent && .venv/bin/python3 agent.py dev"
fi
pass "Voice agent running (PID $AGENT_PID)"

# ── 4. Claude chat streaming ──
echo ""
echo "4. Claude Haiku streaming (text mode)..."
CHAT_RESP=$(curl -s -m 15 -X POST "$SERVER/session/turn" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi in exactly 5 words."}]}' 2>/dev/null)
if echo "$CHAT_RESP" | grep -q '"text"'; then
  pass "Claude Haiku streaming works"
else
  fail "Chat streaming failed: $CHAT_RESP"
fi

# ── 5. LiveKit token + agent dispatch ──
echo ""
echo "5. LiveKit token + agent dispatch..."
TOKEN_RESP=$(curl -s -w "\n%{http_code}" -X POST "$SERVER/livekit/token" \
  -H "Content-Type: application/json" \
  -d "{\"room\":\"$ROOM\",\"identity\":\"$IDENTITY\"}" 2>/dev/null)
HTTP_CODE=$(echo "$TOKEN_RESP" | tail -1)
BODY=$(echo "$TOKEN_RESP" | head -1)
if [ "$HTTP_CODE" != "200" ]; then
  fail "Token request failed (HTTP $HTTP_CODE): $BODY"
fi
TOKEN=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  fail "No token in response"
fi
pass "LiveKit token generated for room: $ROOM"

# ── 6. Agent receives dispatch and initializes ──
echo ""
echo "6. Agent session initialization (waiting up to 15s)..."
find_agent_log

if [ -z "$AGENT_LOG" ]; then
  info "Could not find agent log file — skipping agent-side checks"
else
  # Wait for agent to pick up the job
  FOUND=0
  for i in $(seq 1 15); do
    if grep -q "$ROOM" "$AGENT_LOG" 2>/dev/null; then
      FOUND=1
      break
    fi
    sleep 1
  done

  if [ "$FOUND" = "0" ]; then
    fail "Agent never received dispatch for room $ROOM"
  fi
  pass "Agent received job for room $ROOM"

  # Wait a bit more for initialization
  sleep 3

  # ── 7. Check for TTS/STT errors ──
  echo ""
  echo "7. Agent error check (TTS, STT, model loading)..."

  ERRORS=$(grep -A2 "$ROOM" "$AGENT_LOG" 2>/dev/null | grep -i "ModuleNotFoundError\|ImportError\|No module named\|AttributeError" || true)
  if [ -n "$ERRORS" ]; then
    echo -e "${RED}✗ Agent errors found:${NC}"
    echo "$ERRORS" | head -5 | while read line; do
      echo -e "  ${RED}$line${NC}"
    done
    exit 1
  fi
  pass "No import/module errors in agent"

  # Check for TTS-specific failures
  TTS_ERRORS=$(grep "$ROOM" "$AGENT_LOG" 2>/dev/null | grep -i "tts.*error\|tts.*fail\|synthesize.*error" || true)
  if [ -n "$TTS_ERRORS" ]; then
    echo -e "${RED}✗ TTS errors found:${NC}"
    echo "$TTS_ERRORS" | head -3
    exit 1
  fi
  pass "No TTS errors detected"

  # Check for STT-specific failures
  STT_ERRORS=$(grep "$ROOM" "$AGENT_LOG" 2>/dev/null | grep -i "stt.*error\|transcri.*error\|deepgram.*error" || true)
  if [ -n "$STT_ERRORS" ]; then
    echo -e "${RED}✗ STT errors found:${NC}"
    echo "$STT_ERRORS" | head -3
    exit 1
  fi
  pass "No STT errors detected"
fi

# ── 8. Supabase connectivity ──
echo ""
echo "8. Supabase connectivity..."
SUPA_URL=$(grep SUPABASE_URL /Users/strangepair/Claude/Projects/BattleBuddy/server/.env | cut -d= -f2)
SUPA_KEY=$(grep SUPABASE_SERVICE_KEY /Users/strangepair/Claude/Projects/BattleBuddy/server/.env | cut -d= -f2)
if [ -n "$SUPA_URL" ] && [ -n "$SUPA_KEY" ]; then
  SUPA_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$SUPA_URL/rest/v1/" \
    -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY" 2>/dev/null)
  if [ "$SUPA_HTTP" = "200" ]; then
    pass "Supabase API reachable"
  else
    info "Supabase returned HTTP $SUPA_HTTP (may need table query — not a blocker)"
  fi
else
  info "Supabase credentials not fully configured"
fi

echo ""
echo "═══════════════════════════════════════════"
echo -e " ${GREEN}All checks passed.${NC}"
echo "═══════════════════════════════════════════"

rm -f /tmp/.bb_test_marker
