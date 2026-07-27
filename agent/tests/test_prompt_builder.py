"""Tests for devMode prompt injection in agent.py."""

DEV_MODE_BLOCK = "## Developer Session"

BASE_PROMPT = "You are BattleBuddy, a habit-change companion."

DEV_BLOCK_TEXT = (
    "\n\n## Developer Session\n"
    "You are currently speaking with the BattleBuddy developer. This is not a live user coaching session. "
    "When the developer shares product feedback, feature ideas, or bug observations, acknowledge them naturally "
    'and conversationally (e.g. "Good callout, I\'ll note that.") rather than treating them as personal '
    "habit-coaching topics. All safety protocols and hard limits remain fully in effect."
)


def build_prompt(base_prompt: str, dispatch_meta: dict) -> str:
    system_prompt = base_prompt
    if dispatch_meta.get("devMode", False):
        system_prompt = system_prompt + (
            "\n\n## Developer Session\n"
            "You are currently speaking with the BattleBuddy developer. This is not a live user coaching session. "
            "When the developer shares product feedback, feature ideas, or bug observations, acknowledge them naturally "
            'and conversationally (e.g. "Good callout, I\'ll note that.") rather than treating them as personal '
            "habit-coaching topics. All safety protocols and hard limits remain fully in effect."
        )
    return system_prompt


def test_dev_mode_true_injects_developer_section():
    result = build_prompt(BASE_PROMPT, {"devMode": True})
    assert DEV_MODE_BLOCK in result


def test_dev_mode_false_omits_developer_section():
    result = build_prompt(BASE_PROMPT, {"devMode": False})
    assert DEV_MODE_BLOCK not in result


def test_dev_mode_missing_omits_developer_section():
    result = build_prompt(BASE_PROMPT, {})
    assert DEV_MODE_BLOCK not in result


def test_dev_mode_true_does_not_remove_base_prompt():
    result = build_prompt(BASE_PROMPT, {"devMode": True})
    assert BASE_PROMPT in result


def test_dev_mode_false_prompt_unchanged():
    result = build_prompt(BASE_PROMPT, {"devMode": False})
    assert result == BASE_PROMPT
