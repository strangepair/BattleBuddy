"""Client-side deduplication for the event-logging tool.

Prevents duplicate event_type calls to the backend within a sliding window.
"""

import time

DEDUP_WINDOW_SECONDS = 60


class EventDeduplicator:
    """Tracks the last-logged timestamp per event_type for a single session."""

    def __init__(self):
        self._last_logged: dict[str, float] = {}

    def should_skip(self, event_type: str) -> bool:
        """Return True if event_type was logged within DEDUP_WINDOW_SECONDS."""
        last = self._last_logged.get(event_type)
        if last is None:
            return False
        return (time.monotonic() - last) < DEDUP_WINDOW_SECONDS

    def record(self, event_type: str) -> None:
        """Mark event_type as successfully logged right now."""
        self._last_logged[event_type] = time.monotonic()
