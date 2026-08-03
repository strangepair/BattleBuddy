"""Unit tests for agent/utils/deduplication.py."""

import time
from unittest.mock import patch

from agent.utils.deduplication import EventDeduplicator, DEDUP_WINDOW_SECONDS


def test_first_call_is_not_skipped():
    dedup = EventDeduplicator()
    assert dedup.should_skip("cigarette") is False


def test_second_call_within_window_is_skipped():
    dedup = EventDeduplicator()
    dedup.record("cigarette")
    assert dedup.should_skip("cigarette") is True


def test_second_call_after_window_is_not_skipped():
    dedup = EventDeduplicator()
    past = time.monotonic() - DEDUP_WINDOW_SECONDS - 1
    dedup._last_logged["cigarette"] = past
    assert dedup.should_skip("cigarette") is False


def test_different_event_types_are_independent():
    dedup = EventDeduplicator()
    dedup.record("cigarette")
    assert dedup.should_skip("cigarette") is True
    assert dedup.should_skip("urge_resisted") is False


def test_record_updates_timestamp():
    dedup = EventDeduplicator()
    old_time = time.monotonic() - DEDUP_WINDOW_SECONDS - 1
    dedup._last_logged["cigarette"] = old_time
    assert dedup.should_skip("cigarette") is False
    dedup.record("cigarette")
    assert dedup.should_skip("cigarette") is True


def test_dedup_window_constant_is_60():
    assert DEDUP_WINDOW_SECONDS == 60
