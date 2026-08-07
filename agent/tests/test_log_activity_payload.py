"""Unit tests for agent/tools/log_activity.py payload construction.

The voice tool must be able to log an activity WITHOUT authoring a timestamp:
`activities.start_time` is timestamptz, and a model-authored offset-less local
wall clock stored raw is read as UTC by Postgres — that is how a 7:19 PM
Central drive surfaced on the calendar in the small hours. The server stamps
the current time when start_time is absent (same contract as a live
log_event), so the tool must OMIT the key rather than send an empty string.

Flat import, matching both the CI job's working-directory (agent/) and the
container layout (/app/agent.py + /app/tools).
"""

import asyncio
import inspect
import json

import tools.log_activity as log_activity_mod
from tools.log_activity import log_activity


class _FakeResponse:
    async def json(self):
        return {"ok": True, "id": "row-1"}


class _FakeSession:
    """Stands in for aiohttp.ClientSession, capturing the posted payload."""

    captured = {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kwargs):
        _FakeSession.captured = {"url": url, "payload": kwargs.get("json")}
        return _FakeResponse()


def _post(monkeypatch, **kwargs):
    monkeypatch.setattr(
        log_activity_mod.aiohttp, "ClientSession", lambda *a, **k: _FakeSession()
    )
    raw = asyncio.run(
        log_activity(
            server_url="http://server",
            user_id="u1",
            auth_headers={},
            **kwargs,
        )
    )
    assert json.loads(raw) == {"ok": True, "id": "row-1"}
    return _FakeSession.captured["payload"]


def test_start_time_has_an_empty_default():
    sig = inspect.signature(log_activity)
    assert sig.parameters["start_time"].default == ""


def test_start_time_is_omitted_when_absent(monkeypatch):
    payload = _post(monkeypatch, activity_name="drive to park")
    assert "start_time" not in payload
    assert payload == {"userId": "u1", "activity_name": "drive to park"}


def test_empty_start_time_is_omitted_not_sent_blank(monkeypatch):
    payload = _post(monkeypatch, activity_name="porch", start_time="")
    assert "start_time" not in payload


def test_back_dated_start_time_is_sent_verbatim(monkeypatch):
    payload = _post(
        monkeypatch,
        activity_name="gym",
        start_time="2026-08-01T14:30:00",
        end_time="2026-08-01T15:45:00",
        location="Planet Fitness",
    )
    assert payload["start_time"] == "2026-08-01T14:30:00"
    assert payload["end_time"] == "2026-08-01T15:45:00"
    assert payload["location"] == "Planet Fitness"


def test_posts_to_the_activity_route(monkeypatch):
    _post(monkeypatch, activity_name="walk")
    assert _FakeSession.captured["url"] == "http://server/logs/activity"
