import logging
from decimal import Decimal

import pytest
from rest_framework.throttling import AnonRateThrottle

from ask.claude import ClaudeError
from ask.models import DailyUsage
from ask.serializers import MAX_QUESTION_LENGTH

from .conftest import NOW, final

pytestmark = pytest.mark.django_db

URL = "/api/ask/"
QUESTION = "When can I see the ISS from Austin this week?"
FRONT_END = "https://phoebe.example.com"


def ask(client, body=None, **kwargs):
    if body is None:
        body = {"question": QUESTION}
    return client.post(URL, body, content_type="application/json", **kwargs)


def test_a_question_gets_an_answer(client, fake_claude, fixed_now):
    fake_claude(final("No visible ISS passes from Austin this week."))

    response = ask(client)

    assert response.status_code == 200
    data = response.json()
    assert set(data) == {"answer", "complete", "tools", "usage"}
    assert data["answer"] == "No visible ISS passes from Austin this week."
    assert data["complete"] is True


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"question": ""},
        {"question": "  hi  "},  # stripped to 2 characters
        {"question": "x" * (MAX_QUESTION_LENGTH + 1)},
        {"question": "When\x00"},
        {"question": ["a", "list"]},
    ],
)
def test_bad_questions_are_rejected_before_claude_is_called(client, body):
    # The autouse NoRealClaude would fail the test if Claude were called.
    assert ask(client, body).status_code == 400


def test_the_longest_allowed_question_is_accepted(client, fake_claude, fixed_now):
    fake_claude(final("…"))

    assert ask(client, {"question": "x" * MAX_QUESTION_LENGTH}).status_code == 200


def test_only_json_is_accepted(client):
    # A plain form post (which other sites can send without a CORS preflight).
    response = client.post(URL, {"question": QUESTION})

    assert response.status_code == 415


def test_ask_is_post_only(client):
    assert client.get(URL).status_code == 405


def test_asks_own_per_minute_limit(client, fake_claude, fixed_now, monkeypatch):
    monkeypatch.setitem(AnonRateThrottle.THROTTLE_RATES, "ask_burst", "2/min")
    fake_claude(final("1"), final("2"))

    statuses = [ask(client).status_code for _ in range(3)]

    assert statuses == [200, 200, 429]


def test_asks_own_per_day_limit(client, fake_claude, fixed_now, monkeypatch):
    monkeypatch.setitem(AnonRateThrottle.THROTTLE_RATES, "ask_day", "1/day")
    fake_claude(final("1"))

    assert [ask(client).status_code for _ in range(2)] == [200, 429]


def test_the_limits_count_each_visitor_separately(client, fake_claude, fixed_now, monkeypatch):
    monkeypatch.setitem(AnonRateThrottle.THROTTLE_RATES, "ask_burst", "1/min")
    fake_claude(final("1"), final("2"))

    first = ask(client, HTTP_X_FORWARDED_FOR="203.0.113.1")
    second = ask(client, HTTP_X_FORWARDED_FOR="203.0.113.2")

    assert (first.status_code, second.status_code) == (200, 200)


def test_a_spent_daily_budget_says_when_to_come_back(client, fixed_now, settings):
    settings.ASK_PHOEBE_DAILY_BUDGET_USD = Decimal("0.15")
    DailyUsage.objects.create(day=NOW.date(), cost_usd=Decimal("0.20"))

    response = ask(client)

    assert response.status_code == 503
    assert response.json()["code"] == "daily_budget"
    # NOW is 01:00 UTC, so the budget resets in 23 hours.
    assert response.headers["Retry-After"] == str(23 * 3600)


def test_no_api_key_is_a_clear_503(client, monkeypatch):
    monkeypatch.setattr("ask.service.get_client", lambda: None)

    response = ask(client)

    assert response.status_code == 503
    assert response.json()["code"] == "not_configured"


@pytest.mark.parametrize(
    "kind, status, retry_after",
    [("spend_limit", 503, None), ("busy", 503, "60"), ("timeout", 504, "60"), ("config", 502, None)],
)
def test_claude_failures_become_plain_messages(
    client, fake_claude, fixed_now, caplog, kind, status, retry_after
):
    fake_claude(ClaudeError(kind, 400, "some_error"))

    response = ask(client, {"question": "Can I see the ISS from 742 Evergreen Terrace?"})

    assert response.status_code == status
    assert response.json()["code"] == kind
    assert response.headers.get("Retry-After") == retry_after
    # The log says what failed, never what was asked.
    assert kind in caplog.text
    assert "Evergreen" not in caplog.text


def test_the_front_end_can_read_answers_and_errors(client, settings, fake_claude, fixed_now):
    settings.CORS_ALLOWED_ORIGINS = [FRONT_END]
    fake_claude(final("…"))
    origin = {"Origin": FRONT_END}

    answered = ask(client, headers=origin)
    rejected = ask(client, {"question": ""}, headers=origin)

    assert answered.headers["Access-Control-Allow-Origin"] == FRONT_END
    assert rejected.headers["Access-Control-Allow-Origin"] == FRONT_END


def test_answers_never_log_the_question(client, fake_claude, fixed_now, caplog):
    caplog.set_level(logging.DEBUG)
    fake_claude(final("…"))

    ask(client, {"question": "Can I see the ISS from 742 Evergreen Terrace?"})

    assert "Evergreen" not in caplog.text
