"""Shared fixtures for Ask Phoebe's tests.

Two safety nets are autouse, so no test can reach a real service by mistake:
the Claude client is replaced by one that fails the test, and Open-Meteo's
HTTP client by one that refuses every request. Tests that need answers
install a FakeClaude or a fake Open-Meteo explicitly.
"""

from datetime import datetime, timezone

import httpx
import pytest
from django.core.cache import cache

from ask import places
from satellites.ingest import ingest_records
from satellites.models import Satellite
from satellites.tests.test_positions import ISS_RECORD

# 40 minutes after the saved ISS record's epoch (the passes tests use it too).
NOW = datetime(2026, 10, 6, 1, 0, 0, tzinfo=timezone.utc)

AUSTIN = {
    "label": "Austin, Texas, United States",
    "latitude": 30.27,
    "longitude": -97.74,
    "timezone": "America/Chicago",
}


class NoRealClaude:
    def create_message(self, body):
        raise AssertionError("A test tried to call the real Claude API.")


class FakeClaude:
    """Plays back scripted Messages API replies and records every request."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []

    def create_message(self, body):
        # Deep-ish copy: the loop appends to `messages` after this call.
        self.requests.append({**body, "messages": list(body["messages"])})
        if not self.replies:
            raise AssertionError("FakeClaude ran out of scripted replies.")
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def tool_use(*calls, usage=(1000, 50)):
    """A reply asking for tools: calls are (id, name, input)."""
    return {
        "content": [
            {"type": "text", "text": "Let me check."},
            *(
                {"type": "tool_use", "id": id_, "name": name, "input": tool_input}
                for id_, name, tool_input in calls
            ),
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": usage[0], "output_tokens": usage[1]},
    }


def final(text, usage=(3000, 200), stop_reason="end_turn"):
    return {
        "content": [{"type": "text", "text": text}],
        "stop_reason": stop_reason,
        "usage": {"input_tokens": usage[0], "output_tokens": usage[1]},
    }


@pytest.fixture(autouse=True)
def clear_cache():
    """Throttle counts live in the cache; start every test with an empty one."""
    cache.clear()


@pytest.fixture(autouse=True)
def no_real_claude(monkeypatch):
    monkeypatch.setattr("ask.service.get_client", lambda: NoRealClaude())


def _refuse(request):
    raise AssertionError(f"A test tried to reach {request.url.host}.")


@pytest.fixture(autouse=True)
def no_real_open_meteo(monkeypatch):
    monkeypatch.setattr(places, "_http", httpx.Client(transport=httpx.MockTransport(_refuse)))


@pytest.fixture
def fixed_now(monkeypatch):
    monkeypatch.setattr("ask.clock.utc_now", lambda: NOW)
    return NOW


@pytest.fixture
def fake_claude(monkeypatch):
    """Install a FakeClaude: `fake_claude(reply, reply, ...)`."""

    def install(*replies):
        fake = FakeClaude(*replies)
        monkeypatch.setattr("ask.service.get_client", lambda: fake)
        return fake

    return install


@pytest.fixture
def open_meteo(monkeypatch):
    """Answer Open-Meteo requests with `handler(request) -> httpx.Response`;
    returns the list of requests seen."""

    def install(handler):
        seen = []

        def record(request):
            seen.append(request)
            return handler(request)

        monkeypatch.setattr(
            places, "_http", httpx.Client(transport=httpx.MockTransport(record))
        )
        return seen

    return install


@pytest.fixture
def austin(monkeypatch):
    """Skip geocoding: every place name resolves to Austin."""
    monkeypatch.setattr("ask.places.find_place", lambda name: dict(AUSTIN))
    return AUSTIN


@pytest.fixture
def iss(db):
    ingest_records([ISS_RECORD])
    return Satellite.objects.get(norad_cat_id=25544)
