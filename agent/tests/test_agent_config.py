"""Tests for merge_agent_config in agent.py.

The dispatch metadata is compact (LiveKit's 64 KiB cap); the full session
config is fetched from the server and merged over it. Mirrors the logic in
agent.py the same way test_prompt_builder.py mirrors the devMode injection —
agent.py imports livekit at module level, so it can't be imported here.
"""


def merge_agent_config(dispatch_meta, config):
    if not config:
        return dispatch_meta
    return {**dispatch_meta, **{k: v for k, v in config.items() if v is not None}}


def test_fetched_config_wins_over_metadata():
    meta = {"configToken": "n", "userId": "mike", "devMode": False}
    cfg = {"systemPrompt": "full prompt", "greeting": "hey", "devMode": True}
    merged = merge_agent_config(meta, cfg)
    assert merged["systemPrompt"] == "full prompt"
    assert merged["greeting"] == "hey"
    assert merged["devMode"] is True
    assert merged["userId"] == "mike"


def test_none_config_returns_metadata_unchanged():
    meta = {"userId": "mike"}
    assert merge_agent_config(meta, None) is meta


def test_none_values_never_clobber_metadata():
    meta = {"userId": "mike", "timezone": "America/Chicago"}
    cfg = {"systemPrompt": "p", "timezone": None, "last_session_at": None}
    merged = merge_agent_config(meta, cfg)
    assert merged["timezone"] == "America/Chicago"
    assert "last_session_at" not in merged


def test_mirrored_logic_matches_agent_py():
    """Guard against the mirror drifting from the real implementation."""
    import re
    from pathlib import Path

    source = (Path(__file__).parent.parent / "agent.py").read_text()
    match = re.search(
        r"def merge_agent_config\(dispatch_meta, config\):.*?return \{\*\*dispatch_meta, .*?\}\}",
        source,
        re.DOTALL,
    )
    assert match, "agent.py must define merge_agent_config with the mirrored merge"
    assert (
        "{**dispatch_meta, **{k: v for k, v in config.items() if v is not None}}"
        in match.group(0)
    )
