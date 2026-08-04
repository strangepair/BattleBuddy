"""Tests for trace_node — the LLM-vs-TTS diagnostic wrapper in agent.py.

Why this file exists: llm_node/tts_node overrides only execute inside a live
LiveKit session, so CI's compile and import gates cannot see them at all. That
is the same deferred-execution blind spot that let the `agent.utils`
ModuleNotFoundError ship green and kill voice for ~18 hours. These tests run
the wrapper for real, against every result shape livekit-agents 1.6.2 declares
for those nodes:

    AsyncIterable[...] | Coroutine[..., AsyncIterable[...]] | Coroutine[..., None]

A regression here means the instrumentation would break synthesis rather than
merely fail to log it — strictly worse than no instrumentation.
"""

import agent


async def _collect(gen):
    return [item async for item in gen]


async def _aiter(items):
    for item in items:
        yield item


async def _coro_returning_aiter(items):
    return _aiter(items)


async def _coro_returning_none():
    return None


def _run(coro):
    import asyncio
    return asyncio.run(coro)


def test_passes_through_plain_async_iterable():
    """The common case: node returns an async iterable directly."""
    out = _run(_collect(agent.trace_node("llm_node", _aiter(["a", "b", "c"]), "CHUNK")))
    assert out == ["a", "b", "c"]


def test_awaits_coroutine_that_resolves_to_async_iterable():
    """livekit-agents also permits a coroutine wrapping the iterable."""
    out = _run(_collect(agent.trace_node("tts_node", _coro_returning_aiter([1, 2]), "AUDIO FRAME")))
    assert out == [1, 2]


def test_coroutine_resolving_to_none_yields_nothing():
    """Coroutine[..., None] is a declared return shape — it must not TypeError."""
    out = _run(_collect(agent.trace_node("llm_node", _coro_returning_none(), "CHUNK")))
    assert out == []


def test_empty_stream_is_not_an_error():
    out = _run(_collect(agent.trace_node("llm_node", _aiter([]), "CHUNK", exit_note=" *** NOTHING ***")))
    assert out == []


def test_exception_propagates_and_is_not_swallowed():
    """The tracer must never convert a synthesis failure into silent success."""
    async def _boom():
        yield "first"
        raise RuntimeError("deepgram exploded")

    try:
        _run(_collect(agent.trace_node("tts_node", _boom(), "AUDIO FRAME")))
    except RuntimeError as exc:
        assert "deepgram exploded" in str(exc)
    else:
        raise AssertionError("trace_node swallowed the exception")


def test_logs_first_item_and_exit_note(capsys):
    """The two lines the next live session is read for."""
    _run(_collect(agent.trace_node("llm_node", _aiter([]), "CHUNK", exit_note=" *** LLM PRODUCED NOTHING ***")))
    empty_log = capsys.readouterr().out
    assert "LLM PRODUCED NOTHING" in empty_log

    _run(_collect(agent.trace_node("llm_node", _aiter(["x"]), "CHUNK", exit_note=" *** LLM PRODUCED NOTHING ***")))
    busy_log = capsys.readouterr().out
    assert "FIRST CHUNK" in busy_log
    assert "LLM PRODUCED NOTHING" not in busy_log
