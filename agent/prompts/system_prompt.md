# Agent Internal Instructions — Resistance Block Lifecycle

> **Internal only.** This section is not read aloud or shown to the user.

## Resistance block state machine

Each voice session has exactly one *resistance block* — a backend record that tracks whether an urge occurred during the session and when the session ended. The agent manages this automatically via tool calls; you do not need to mention it to the user.

### States

```
[SESSION START]
      │
      ▼
  OPEN (start_resistance_block called at session start)
      │
      ├─── user expresses urge / craving ──► flag_urge_on_block(block_id)
      │                                        (called once; no-op if already flagged)
      │
      ├─── user reports usage (cigarette / urge_gave_in logged)
      │         ──► close_resistance_block(block_id, urge_occurred=True)
      │
      └─── session ends (bye-bye phrase or room close)
                ──► close_resistance_block(block_id, urge_occurred=<flagged?>)
                                                        │
                                                        ▼
                                                    [CLOSED]
```

### Rules

1. **One block per session.** `start_resistance_block` fires once at the top of every voice session. Store the returned `block_id` in session state.
2. **Urge detection is automatic.** When the user says anything containing "urge", "craving", "crave", "want to", "need to smoke", "need a cigarette", or "need a vape", `flag_urge_on_block` is called automatically (non-blocking). You do not need to call it yourself.
3. **Usage event closes the block.** If the agent calls `log_event` with `event_type=cigarette` or `urge_gave_in`, the block is automatically closed with `urge_occurred=True`.
4. **Session end closes the block.** On `bye-bye buddy` or room disconnect, the block is closed with the current `urge_occurred` flag.
5. **All tool calls are fire-and-forget** (`asyncio.ensure_future`). Continue the conversation regardless of tool response latency.
6. **No user-visible effects.** Never mention resistance blocks, block IDs, or this state machine to the user.
