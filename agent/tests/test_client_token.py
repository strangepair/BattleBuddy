"""Tests that the agent attaches BB_CLIENT_TOKEN to token-gated server calls.

The server gates /context/analyze behind checkClientToken (Authorization:
Bearer <BB_CLIENT_TOKEN> — see server/index.js); an agent post without it
401s in production and the voice transcript is silently lost. Mirrors the
auth_headers logic the same way test_prompt_builder.py mirrors the devMode
injection — agent.py imports livekit at module level, so it can't be
imported here — plus source-inspection guards so the mirror can't drift.
"""

import re
from pathlib import Path

AGENT_SOURCE = (Path(__file__).parent.parent / "agent.py").read_text()


def auth_headers(token):
    return {"Authorization": f"Bearer {token}"} if token else {}


def test_auth_headers_bearer_format_matches_server_expectation():
    # checkClientToken strips a literal "Bearer " prefix — the header must
    # be exactly that shape.
    assert auth_headers("secret-123") == {"Authorization": "Bearer secret-123"}


def test_auth_headers_empty_when_token_unset():
    assert auth_headers("") == {}


def test_mirrored_logic_matches_agent_py():
    """Guard against the mirror drifting from the real implementation."""
    assert 'BB_CLIENT_TOKEN = os.environ.get("BB_CLIENT_TOKEN", "")' in AGENT_SOURCE
    assert (
        'return {"Authorization": f"Bearer {BB_CLIENT_TOKEN}"} if BB_CLIENT_TOKEN else {}'
        in AGENT_SOURCE
    )


def test_every_context_analyze_post_sends_auth_headers():
    """Both transcript posts (periodic save + final transcript) must attach
    the token. Scan each /context/analyze call site and require
    headers=auth_headers() inside the same http.post(...) call."""
    call_sites = [
        m.start() for m in re.finditer(r'\{SERVER_URL\}/context/analyze', AGENT_SOURCE)
    ]
    assert len(call_sites) >= 2, "expected the periodic-save and final-transcript call sites"
    for start in call_sites:
        window = AGENT_SOURCE[start : AGENT_SOURCE.index("print", start)]
        assert "headers=auth_headers()" in window, (
            "a /context/analyze post is missing headers=auth_headers() — "
            "it will 401 in production and the transcript will be lost"
        )


def test_boot_warning_when_token_missing():
    """Operators must be able to see a missing token in the Railway logs."""
    assert "BB_CLIENT_TOKEN is not set" in AGENT_SOURCE
