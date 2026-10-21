from decimal import Decimal

import pytest

from ask import service, tools
from ask.models import DailyUsage
from ask.service import INCOMPLETE_ANSWER, MAX_OUTPUT_TOKENS, MAX_ROUNDS, AskUnavailable

from .conftest import NOW, final, tool_use

pytestmark = pytest.mark.django_db

QUESTION = "When can I see the ISS from Austin this week?"
PASSES_CALL = ("toolu_1", "get_passes", {"satellite": "ISS", "place": "Austin"})


def test_the_loop_runs_the_tool_and_sends_its_result_back(
    fake_claude, iss, austin, fixed_now
):
    claude = fake_claude(
        tool_use(PASSES_CALL), final("The ISS has 1 visible pass this week from Austin…")
    )

    result = service.answer(QUESTION)

    assert result["answer"].startswith("The ISS has 1 visible pass")
    assert result["complete"] is True
    assert [t["name"] for t in result["tools"]] == ["get_passes"]
    assert result["tools"][0]["result"]["place"]["label"] == austin["label"]
    assert result["usage"] == {"input_tokens": 4000, "output_tokens": 250, "claude_calls": 2}

    first, second = claude.requests
    assert first["messages"] == [{"role": "user", "content": QUESTION}]
    # Round 2 re-sends the whole conversation: the question, the assistant's
    # tool request unchanged, then the result (first in its message).
    assert second["messages"][0] == first["messages"][0]
    assert second["messages"][1]["role"] == "assistant"
    assert second["messages"][1]["content"][1]["id"] == "toolu_1"
    results = second["messages"][2]
    assert results["role"] == "user"
    assert results["content"][0]["type"] == "tool_result"
    assert results["content"][0]["tool_use_id"] == "toolu_1"
    assert results["content"][0]["is_error"] is False
    assert '"visible_pass_count"' in results["content"][0]["content"]


def test_every_request_carries_the_limits_and_the_tools(fake_claude, settings, fixed_now):
    settings.ASK_PHOEBE_MODEL = "claude-sonnet-5-5"
    claude = fake_claude(final("I can only help with satellite viewing."))

    service.answer("What's the capital of France?")

    body = claude.requests[0]
    assert body["model"] == "claude-sonnet-5-5"
    assert body["max_tokens"] == MAX_OUTPUT_TOKENS == 1024
    assert body["tool_choice"] == {"type": "auto"}
    assert {t["name"] for t in body["tools"]} == {
        "look_up_satellite", "get_passes", "get_cloud_forecast",
    }  # fmt: skip
    assert NOW.isoformat() in body["system"]


def test_parallel_tool_calls_get_their_results_in_one_message(
    fake_claude, iss, austin, fixed_now, monkeypatch
):
    monkeypatch.setitem(tools.HANDLERS, "get_cloud_forecast", lambda tool_input: {"ok": 1})
    claude = fake_claude(
        tool_use(PASSES_CALL, ("toolu_2", "get_cloud_forecast", {"place": "Austin"})),
        final("Clear skies for it."),
    )

    service.answer(QUESTION + " when it's clear")

    results = claude.requests[1]["messages"][2]["content"]
    assert [r["tool_use_id"] for r in results] == ["toolu_1", "toolu_2"]


def test_a_tool_error_goes_back_to_the_model_marked_as_an_error(fake_claude, iss, fixed_now):
    claude = fake_claude(
        tool_use(("toolu_1", "get_passes", {"satellite": "ISS"})),
        final("Which city?"),
    )

    result = service.answer(QUESTION)

    tool_result = claude.requests[1]["messages"][2]["content"][0]
    assert tool_result["is_error"] is True
    assert "'place' must be" in tool_result["content"]
    assert result["tools"][0]["is_error"] is True


def test_the_loop_stops_after_max_rounds(fake_claude, iss, austin, fixed_now):
    calls = [tool_use((f"toolu_{i}", "look_up_satellite", {"query": "ISS"})) for i in range(10)]
    claude = fake_claude(*calls)

    result = service.answer(QUESTION)

    assert len(claude.requests) == MAX_ROUNDS
    assert result["answer"] == INCOMPLETE_ANSWER
    assert result["complete"] is False


def test_tool_calls_are_capped_even_within_the_rounds(fake_claude, iss, fixed_now):
    many = [(f"toolu_{i}", "look_up_satellite", {"query": "ISS"}) for i in range(8)]
    claude = fake_claude(tool_use(*many), final("Done."))

    result = service.answer(QUESTION)

    assert len(result["tools"]) == service.MAX_TOOL_CALLS
    sent = claude.requests[1]["messages"][2]["content"]
    assert len(sent) == 8  # every tool_use still gets a result…
    assert all(r["is_error"] for r in sent[service.MAX_TOOL_CALLS :])  # …the extra ones refused


@pytest.mark.parametrize("stop_reason", ["max_tokens", "refusal", "something_new"])
def test_a_cut_off_or_refused_reply_is_never_shown_as_the_answer(
    fake_claude, fixed_now, stop_reason
):
    fake_claude(final("The ISS will be visible at 7:1", stop_reason=stop_reason))

    result = service.answer(QUESTION)

    assert result["answer"] == INCOMPLETE_ANSWER
    assert result["complete"] is False


def test_an_empty_final_reply_is_incomplete(fake_claude, fixed_now):
    fake_claude(final(""))

    assert service.answer(QUESTION)["complete"] is False


def test_no_api_key_means_not_configured(monkeypatch):
    monkeypatch.setattr("ask.service.get_client", lambda: None)

    with pytest.raises(AskUnavailable) as raised:
        service.answer(QUESTION)
    assert raised.value.kind == "not_configured"


def test_usage_and_cost_are_counted_for_the_day(fake_claude, iss, austin, fixed_now, settings):
    settings.ASK_PHOEBE_MODEL = "claude-opus-5-5"
    fake_claude(tool_use(PASSES_CALL, usage=(1500, 100)), final("…", usage=(4500, 300)))

    service.answer(QUESTION)

    row = DailyUsage.objects.get(day=NOW.date())
    assert (row.questions, row.claude_calls) == (1, 2)
    assert (row.input_tokens, row.output_tokens) == (6000, 400)
    # 6,000 x $4/M + 400 x $20/M = $0.024 + $0.008
    assert row.cost_usd == Decimal("0.032")


def test_once_todays_budget_is_spent_claude_is_not_called(fake_claude, fixed_now, settings):
    settings.ASK_PHOEBE_DAILY_BUDGET_USD = Decimal("0.15")
    DailyUsage.objects.create(day=NOW.date(), cost_usd=Decimal("0.15"))
    claude = fake_claude()

    with pytest.raises(AskUnavailable) as raised:
        service.answer(QUESTION)

    assert raised.value.kind == "daily_budget"
    assert claude.requests == []
    assert DailyUsage.objects.get(day=NOW.date()).questions == 0
