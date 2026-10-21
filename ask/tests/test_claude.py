import json

import httpx
import pytest

from ask.claude import API_URL, API_VERSION, ClaudeClient, ClaudeError

KEY = "test-key-not-a-real-secret"
BODY = {"model": "claude-opus-5-5", "max_tokens": 10, "messages": [{"role": "user", "content": "hi"}]}


def client_answering(handler):
    seen = []

    def record(request):
        seen.append(request)
        return handler(request)

    return ClaudeClient(KEY, transport=httpx.MockTransport(record)), seen


def error(status, error_type, message="", **details):
    body = {"type": "error", "error": {"type": error_type, "message": message}}
    if details:
        body["error"]["details"] = details
    return lambda request: httpx.Response(status, json=body)


def test_a_request_is_plain_json_with_the_key_in_a_header():
    client, seen = client_answering(
        lambda request: httpx.Response(200, json={"content": [], "stop_reason": "end_turn"})
    )

    reply = client.create_message(BODY)

    assert reply["stop_reason"] == "end_turn"
    request = seen[0]
    assert str(request.url) == API_URL
    assert request.headers["x-api-key"] == KEY
    assert request.headers["anthropic-version"] == API_VERSION == "2023-06-01"
    assert json.loads(request.content) == BODY


@pytest.mark.parametrize(
    "handler, kind",
    [
        # A self-set Console limit (400) and the tier's own cap (429).
        (error(400, "invalid_request_error", "You have reached your specified API usage limits."), "spend_limit"),
        (error(429, "rate_limit_error", "monthly cap", error_code="enforced_spend_limit_reached"), "spend_limit"),
        (error(429, "rate_limit_error", "Too many requests"), "busy"),
        (error(529, "overloaded_error", "Overloaded"), "busy"),
        (error(500, "api_error"), "busy"),
        (error(401, "authentication_error", "invalid x-api-key"), "config"),
        (error(400, "invalid_request_error", "messages: bad"), "config"),
        (lambda request: httpx.Response(502, text="<html>bad gateway</html>"), "busy"),
    ],
)  # fmt: skip
def test_failures_are_sorted_into_kinds(handler, kind):
    client, _ = client_answering(handler)

    with pytest.raises(ClaudeError) as raised:
        client.create_message(BODY)
    assert raised.value.kind == kind


@pytest.mark.parametrize("exception", [httpx.ReadTimeout("slow"), httpx.ConnectError("down")])
def test_network_trouble_is_a_timeout(exception):
    def fail(request):
        raise exception

    client, _ = client_answering(fail)

    with pytest.raises(ClaudeError) as raised:
        client.create_message(BODY)
    assert raised.value.kind == "timeout"


def test_an_error_never_carries_the_key_or_the_question():
    client, _ = client_answering(error(401, "authentication_error", f"bad key {KEY}"))

    with pytest.raises(ClaudeError) as raised:
        client.create_message(BODY)
    assert KEY not in str(raised.value)
    assert "hi" not in str(raised.value)
    assert str(raised.value) == "config (HTTP 401, authentication_error)"


def test_no_key_means_no_client(settings):
    from ask.claude import get_client

    settings.ANTHROPIC_API_KEY = ""
    assert get_client() is None
