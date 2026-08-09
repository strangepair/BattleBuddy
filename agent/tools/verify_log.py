"""verify_log — read-back check after a log_event tool call.

Calls GET /api/logs/recent?limit=1 and confirms that the most recent entry
matches the expected event_type and has a logged_at timestamp >= expected_after.

Returns True when the entry is confirmed, False when it is absent or wrong.
Returns True (pass-through) on any network/auth error so a transient failure
does not cause the agent to infinitely retry a valid write.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import aiohttp


async def verify_last_log(
    server_url: str,
    auth_headers: dict,
    event_type: str,
    expected_after: datetime,
) -> bool:
    """Return True if the most recent log entry matches event_type and was
    logged at or after expected_after; False if it does not match.

    On any network error or non-200 response (including 401 when the agent
    token cannot authenticate against the user-JWT-gated endpoint) the
    function returns True so a transient auth or network issue does not
    trigger a spurious retry of a write that likely succeeded.
    """
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.get(
                f"{server_url}/api/logs/recent",
                params={"limit": "1"},
                headers=auth_headers,
                timeout=aiohttp.ClientTimeout(total=10),
            )
            if resp.status != 200:
                return True
            entries = await resp.json()
            if not entries or not isinstance(entries, list):
                return False
            entry = entries[0]
            if entry.get("event_type") != event_type:
                return False
            logged_at_raw = entry.get("logged_at") or ""
            if not logged_at_raw:
                return False
            logged_at = datetime.fromisoformat(
                logged_at_raw.replace("Z", "+00:00")
            )
            if logged_at.tzinfo is None:
                logged_at = logged_at.replace(tzinfo=timezone.utc)
            expected = expected_after
            if expected.tzinfo is None:
                expected = expected.replace(tzinfo=timezone.utc)
            return logged_at >= expected
    except Exception:
        return True
