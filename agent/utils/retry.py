"""Network retry helper for outbound HTTP calls.

Wraps an async callable with up to 3 attempts and exponential backoff
(0.5 s, 1 s, 2 s).  Network-level exceptions (aiohttp.ClientError,
asyncio.TimeoutError, OSError) are caught; HTTP-level status codes are
left to the caller.

On final failure the helper returns the provided `fallback` value so that
no raw exception text ever surfaces in the agent's spoken output.
"""

import asyncio
import logging
from typing import Any, Callable, Coroutine

import aiohttp

logger = logging.getLogger(__name__)

_BACKOFF = (0.5, 1.0, 2.0)
_NETWORK_ERRORS = (aiohttp.ClientError, asyncio.TimeoutError, OSError)

CONN_FALLBACK = "I'm having trouble reaching the server right now — let's try again in a moment."


async def with_retry(
    fn: Callable[[], Coroutine[Any, Any, Any]],
    *,
    attempts: int = 3,
    fallback: Any = None,
    label: str = "fetch",
) -> Any:
    """Call *fn()* up to *attempts* times with exponential backoff.

    Returns the result of the first successful call, or *fallback* after
    exhausting all attempts.  Network exceptions are logged but never
    re-raised.

    Parameters
    ----------
    fn:
        Zero-argument async callable to invoke.
    attempts:
        Maximum number of tries (default 3).
    fallback:
        Value to return on final failure.
    label:
        Short identifier used in log messages.
    """
    for attempt in range(attempts):
        try:
            return await fn()
        except _NETWORK_ERRORS as exc:
            logger.warning("%s: attempt %d/%d failed: %r", label, attempt + 1, attempts, exc)
            if attempt < attempts - 1:
                await asyncio.sleep(_BACKOFF[min(attempt, len(_BACKOFF) - 1)])
    logger.error("%s: all %d attempts failed — returning fallback", label, attempts)
    return fallback
