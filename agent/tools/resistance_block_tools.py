"""resistance_block_tools — manages three-minute resistance block lifecycle via the backend API."""

import json
from datetime import datetime, timezone
import aiohttp


async def start_resistance_block(server_url: str, user_id: str, auth_headers: dict) -> dict:
    """POST /api/resistance-blocks — open a new resistance block for this session."""
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                f"{server_url}/api/resistance-blocks",
                json={"userId": user_id},
                headers=auth_headers,
                timeout=aiohttp.ClientTimeout(total=10),
            )
            data = await resp.json()
            return data
    except Exception as e:
        return {"error": str(e)}


async def flag_urge_on_block(server_url: str, block_id: str, auth_headers: dict) -> dict:
    """PATCH /api/resistance-blocks/{block_id} — mark that an urge occurred during this block."""
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.patch(
                f"{server_url}/api/resistance-blocks/{block_id}",
                json={"urge_occurred": True},
                headers=auth_headers,
                timeout=aiohttp.ClientTimeout(total=10),
            )
            data = await resp.json()
            return data
    except Exception as e:
        return {"error": str(e)}


async def close_resistance_block(server_url: str, block_id: str, urge_occurred: bool, auth_headers: dict) -> dict:
    """PATCH /api/resistance-blocks/{block_id} — close the block with ended_at=now."""
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.patch(
                f"{server_url}/api/resistance-blocks/{block_id}",
                json={
                    "ended_at": datetime.now(timezone.utc).isoformat(),
                    "urge_occurred": urge_occurred,
                },
                headers=auth_headers,
                timeout=aiohttp.ClientTimeout(total=10),
            )
            data = await resp.json()
            return data
    except Exception as e:
        return {"error": str(e)}
