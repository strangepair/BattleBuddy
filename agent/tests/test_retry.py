"""Tests for utils/retry.py — exponential backoff retry helper."""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.retry import with_retry, CONN_FALLBACK

import aiohttp


class _FakeConnError(aiohttp.ClientError):
    pass


@pytest.mark.asyncio
async def test_succeeds_first_try():
    calls = []

    async def _fn():
        calls.append(1)
        return "ok"

    result = await with_retry(_fn)
    assert result == "ok"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_retries_on_network_error_and_succeeds(monkeypatch):
    monkeypatch.setattr("utils.retry._BACKOFF", (0, 0, 0))
    calls = []

    async def _fn():
        calls.append(1)
        if len(calls) < 3:
            raise _FakeConnError("boom")
        return "recovered"

    result = await with_retry(_fn)
    assert result == "recovered"
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_returns_fallback_after_all_attempts_fail(monkeypatch):
    monkeypatch.setattr("utils.retry._BACKOFF", (0, 0, 0))
    calls = []

    async def _fn():
        calls.append(1)
        raise _FakeConnError("no network")

    result = await with_retry(_fn, fallback="FALLBACK")
    assert result == "FALLBACK"
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_timeout_error_is_retried(monkeypatch):
    monkeypatch.setattr("utils.retry._BACKOFF", (0, 0, 0))
    calls = []

    async def _fn():
        calls.append(1)
        raise asyncio.TimeoutError()

    result = await with_retry(_fn, fallback=None)
    assert result is None
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_non_network_exception_propagates():
    async def _fn():
        raise ValueError("logic error")

    with pytest.raises(ValueError, match="logic error"):
        await with_retry(_fn)


@pytest.mark.asyncio
async def test_conn_fallback_string_contains_no_traceback():
    assert "Traceback" not in CONN_FALLBACK
    assert "Exception" not in CONN_FALLBACK
    assert len(CONN_FALLBACK) > 10
