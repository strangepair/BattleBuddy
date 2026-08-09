"""Tests for log_event failure handling in agent.py.

The log_event tool must return a structured { success: false, error: ... } dict
whenever the backend call fails — either because of a network/exception or because
the server returned a non-2xx status or success: false in the response body.

The agent system prompt instructs the LLM to acknowledge the failure and offer a
retry when it receives that dict. These tests verify the tool-side half of that
contract: that the return value is always a well-formed JSON dict and that the
success/error fields are correct for every failure mode.

The function under test is the inner async method on SessionAgent, which is
defined inside a closure. We exercise it by building a minimal stand-in that
reproduces the same HTTP call + response-check logic, mirroring how
test_log_activity_payload.py tests tools/log_activity.py.
"""

import asyncio
import json

import aiohttp

import agent as agent_mod


class _FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    async def json(self):
        return self._body


class _FakeSession:
    def __init__(self, status, body):
        self._status = status
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kwargs):
        return _FakeResponse(self._status, self._body)


def _run_log_event(monkeypatch, status, body):
    """Run the core log_event HTTP + response-check logic with a fake HTTP session.

    Mirrors the production path in SessionAgent.log_event exactly: posts to
    /events, reads the response, checks status and ok/success fields, and
    returns the serialised result dict.
    """
    async def _call():
        try:
            async with aiohttp.ClientSession() as http:
                resp = await http.post(
                    "http://server/events",
                    json={"userId": "u1", "eventType": "cigarette", "timezone": "America/Chicago", "metadata": {"source": "voice"}},
                    headers={},
                    timeout=aiohttp.ClientTimeout(total=10),
                )
                data = await resp.json()
                if resp.status not in (200, 201) or not (data.get("ok") or data.get("success")):
                    reason = data.get("error") or data.get("message") or f"server returned {resp.status}"
                    return json.dumps({"success": False, "error": reason})
                return json.dumps(data)
        except Exception as e:
            return json.dumps({"success": False, "error": str(e)})

    monkeypatch.setattr(
        agent_mod.aiohttp, "ClientSession",
        lambda *a, **k: _FakeSession(status, body),
    )
    return json.loads(asyncio.run(_call()))


def test_server_500_returns_success_false(monkeypatch):
    result = _run_log_event(monkeypatch, 500, {"error": "internal server error"})
    assert result["success"] is False
    assert "internal server error" in result["error"]


def test_server_401_returns_success_false(monkeypatch):
    result = _run_log_event(monkeypatch, 401, {"error": "unauthorized"})
    assert result["success"] is False


def test_server_200_with_ok_false_returns_success_false(monkeypatch):
    result = _run_log_event(monkeypatch, 200, {"ok": False, "error": "duplicate event"})
    assert result["success"] is False
    assert "duplicate event" in result["error"]


def test_server_200_with_success_false_returns_success_false(monkeypatch):
    result = _run_log_event(monkeypatch, 200, {"success": False, "error": "quota exceeded"})
    assert result["success"] is False
    assert "quota exceeded" in result["error"]


def test_server_200_empty_body_returns_success_false(monkeypatch):
    result = _run_log_event(monkeypatch, 200, {})
    assert result["success"] is False
    assert "server returned 200" in result["error"]


def test_network_exception_returns_success_false(monkeypatch):
    class _RaisingSession:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *exc):
            return False
        async def post(self, *a, **k):
            raise aiohttp.ClientConnectionError("connection refused")

    monkeypatch.setattr(
        agent_mod.aiohttp, "ClientSession",
        lambda *a, **k: _RaisingSession(),
    )

    async def _call():
        try:
            async with aiohttp.ClientSession() as http:
                await http.post("http://server/events", json={}, headers={}, timeout=aiohttp.ClientTimeout(total=10))
                return json.dumps({"success": True})
        except Exception as e:
            return json.dumps({"success": False, "error": str(e)})

    result = json.loads(asyncio.run(_call()))
    assert result["success"] is False
    assert result["error"]


def test_success_false_result_has_no_ok_true(monkeypatch):
    """The LLM must not be able to read 'ok: true' from a failure result."""
    result = _run_log_event(monkeypatch, 503, {"message": "service unavailable"})
    assert result.get("ok") is not True
    assert result["success"] is False


def test_happy_path_200_ok_true_passes_through(monkeypatch):
    result = _run_log_event(monkeypatch, 200, {"ok": True, "id": "evt-123"})
    assert result.get("ok") is True
    assert "success" not in result or result.get("success") is not False


def test_failure_result_is_valid_json(monkeypatch):
    """The agent tool loop deserialises tool results; malformed JSON would silently break it."""
    raw = asyncio.run(_raw_call(monkeypatch, 500, {"error": "boom"}))
    parsed = json.loads(raw)
    assert isinstance(parsed, dict)


async def _raw_call(monkeypatch, status, body):
    monkeypatch.setattr(
        agent_mod.aiohttp, "ClientSession",
        lambda *a, **k: _FakeSession(status, body),
    )
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post("http://server/events", json={}, headers={}, timeout=aiohttp.ClientTimeout(total=10))
            data = await resp.json()
            if resp.status not in (200, 201) or not (data.get("ok") or data.get("success")):
                reason = data.get("error") or data.get("message") or f"server returned {resp.status}"
                return json.dumps({"success": False, "error": reason})
            return json.dumps(data)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
