"""log_activity tool — posts an activity entry to POST /logs/activity."""

import json
import aiohttp


async def log_activity(server_url: str, user_id: str, auth_headers: dict, activity_name: str, start_time: str = "", end_time: str = "", location: str = "") -> str:
    """Call POST /logs/activity with activity_name, start_time, end_time, and location.

    start_time is optional and omitted from the payload when empty — the
    server then stamps the authoritative current time, exactly as it does for
    a live log_event. When present (back-dating only), start_time and end_time
    must be the user's LOCAL wall-clock time exactly as stated (e.g.
    '2026-08-01T14:30:00') — never UTC-converted; the server re-anchors them
    in the user's timezone before storing.
    end_time is optional; omit it when only a start is known.
    """
    payload: dict = {
        "userId": user_id,
        "activity_name": activity_name,
    }
    if start_time:
        payload["start_time"] = start_time
    if end_time:
        payload["end_time"] = end_time
    if location:
        payload["location"] = location
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                f"{server_url}/logs/activity",
                json=payload,
                headers=auth_headers,
                timeout=aiohttp.ClientTimeout(total=10),
            )
            data = await resp.json()
            return json.dumps(data)
    except Exception as e:
        return json.dumps({"error": str(e)})
