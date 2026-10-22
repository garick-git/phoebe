"""Sentry must never receive coordinates, place names, questions or IPs.

The unit tests pin each scrubbing rule. The last three run the real Sentry
SDK with a transport that keeps events in a list instead of sending them,
so they check what would actually leave the server.
"""

import io
import json

import httpx
import pytest
import sentry_sdk
from django.core import signals
from django.core.cache import cache
from django.db import close_old_connections
from sentry_sdk.transport import Transport

from ask.claude import ClaudeError
from ask.tests.conftest import FakeClaude
from config.observability import (
    init_sentry,
    scrub_breadcrumb,
    scrub_event,
    strip_query,
    strip_urls_in_text,
)

TONIGHT_URL = "https://phoebe.garickm.com/tonight/?lat=30.27&lon=-97.74&place=Austin"
# Values that must not appear anywhere in an event sent to Sentry.
# A place and latitude passed in at run time (the stack trace's source lines
# show the code around each frame, so the values must not be literals there).
VISITOR = ("Austin", 30.27)
SECRETS = ["30.27", "-97.74", "Austin", "Evergreen", "203.0.113.7", "lat=", "sessionid"]


def assert_clean(event):
    text = json.dumps(event)
    for value in SECRETS:
        assert value not in text, f"{value!r} would be sent to Sentry"


# Rules -------------------------------------------------------------------


def test_strip_query_keeps_scheme_host_and_path():
    assert strip_query(TONIGHT_URL) == "https://phoebe.garickm.com/tonight/"
    assert strip_query("/api/satellites/25544/passes/?lat=1&lon=2#x") == (
        "/api/satellites/25544/passes/"
    )
    assert strip_query("https://example.com/a") == "https://example.com/a"
    assert strip_query(None) is None


def test_urls_inside_text_lose_their_query():
    text = (
        "Client error '404 Not Found' for url "
        "'https://geocoding-api.open-meteo.com/v1/search?name=Austin&count=5'"
    )
    assert strip_urls_in_text(text) == (
        "Client error '404 Not Found' for url 'https://geocoding-api.open-meteo.com/v1/search'"
    )
    assert strip_urls_in_text("no url here?") == "no url here?"


def test_request_keeps_only_harmless_parts():
    event = {
        "request": {
            "url": "https://phoebe-api.garickm.com/api/satellites/25544/passes/?lat=30.27",
            "query_string": "lat=30.27&lon=-97.74",
            "data": {"question": "Can I see the ISS from Austin?"},
            "cookies": {"sessionid": "abc"},
            "env": {"REMOTE_ADDR": "203.0.113.7"},
            "headers": {
                "User-Agent": "Mozilla/5.0",
                "Referer": TONIGHT_URL,
                "X-Forwarded-For": "203.0.113.7",
                "Cookie": "sessionid=abc",
            },
        },
        "user": {"ip_address": "203.0.113.7"},
    }

    request = scrub_event(event)["request"]

    assert request == {
        "url": "https://phoebe-api.garickm.com/api/satellites/25544/passes/",
        "headers": {"User-Agent": "Mozilla/5.0"},
    }
    assert "user" not in event


def test_breadcrumbs_lose_queries():
    crumb = {
        "type": "http",
        "data": {
            "url": "https://api.open-meteo.com/v1/forecast?latitude=30.27&longitude=-97.74",
            "http.query": "latitude=30.27&longitude=-97.74",
            "http.method": "GET",
        },
        "message": f"GET {TONIGHT_URL}",
    }

    scrubbed = scrub_breadcrumb(crumb)

    assert scrubbed["data"] == {
        "url": "https://api.open-meteo.com/v1/forecast",
        "http.method": "GET",
    }
    assert_clean(scrubbed)


def test_frames_lose_local_variables_and_messages_lose_queries():
    event = {
        "exception": {
            "values": [
                {
                    "type": "HTTPStatusError",
                    "value": f"Server error for url '{TONIGHT_URL}'",
                    "stacktrace": {
                        "frames": [{"function": "f", "vars": {"lat": 30.27}}]
                    },
                }
            ]
        },
        "logentry": {
            "message": "failed: %s",
            "params": ["Austin"],
            "formatted": TONIGHT_URL,
        },
        "breadcrumbs": {"values": [{"data": {"url": TONIGHT_URL}}]},
    }

    assert_clean(scrub_event(event))


def test_no_dsn_means_no_sentry():
    assert init_sentry("") is False
    assert init_sentry(None) is False


# The real SDK -------------------------------------------------------------


class KeepEvents(Transport):
    """A Sentry transport that keeps events in a list instead of sending them."""

    def __init__(self, events):
        super().__init__()
        self.events = events

    def capture_envelope(self, envelope):
        for item in envelope.items:
            if item.type == "event":
                self.events.append(item.payload.json)


@pytest.fixture
def sent_events():
    events = []
    started = init_sentry(
        "https://public@sentry.invalid/1", "test", transport=KeepEvents(events)
    )
    assert started
    yield events
    sentry_sdk.get_client().close()
    sentry_sdk.init()  # back to a client with no DSN, which sends nothing


def call_wsgi(method, path, query, body, headers):
    """Send one request through the real WSGI application, the way Gunicorn
    does in production (Django's test client skips the WSGI layer, which is
    where Sentry reads the URL and headers)."""
    from config.wsgi import application

    raw = json.dumps(body).encode()
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "SERVER_NAME": "phoebe-api.garickm.com",
        "SERVER_PORT": "443",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "HTTP_HOST": "phoebe-api.garickm.com",
        "HTTP_X_FORWARDED_PROTO": "https",
        "CONTENT_TYPE": "application/json",
        "CONTENT_LENGTH": str(len(raw)),
        "wsgi.input": io.BytesIO(raw),
        "wsgi.url_scheme": "http",
        "wsgi.errors": io.StringIO(),
        "wsgi.version": (1, 0),
        "wsgi.multithread": True,
        "wsgi.multiprocess": True,
        "wsgi.run_once": False,
        **headers,
    }
    statuses = []
    # Like Django's test client: don't let the request close the test's
    # database connection (it is inside the test's transaction).
    signals.request_started.disconnect(close_old_connections)
    signals.request_finished.disconnect(close_old_connections)
    try:
        b"".join(application(environ, lambda status, _headers: statuses.append(status)))
    finally:
        signals.request_started.connect(close_old_connections)
        signals.request_finished.connect(close_old_connections)
    return statuses[0]


def test_an_error_inside_a_request_reaches_sentry_without_visitor_data(
    sent_events, monkeypatch, db, settings
):
    """Ask's 'config' failure (for example a revoked API key) is logged at
    error level, so it becomes a Sentry issue: the config-error alert."""
    settings.ALLOWED_HOSTS = ["phoebe-api.garickm.com"]
    cache.clear()  # throttle counts
    fake = FakeClaude(ClaudeError("config", 401, "authentication_error"))
    monkeypatch.setattr("ask.service.get_client", lambda: fake)

    status = call_wsgi(
        "POST",
        "/api/ask/",
        "lat=30.27&lon=-97.74",
        {"question": "Can I see the ISS from Austin, 742 Evergreen Terrace?"},
        {
            "HTTP_REFERER": TONIGHT_URL,
            "HTTP_X_FORWARDED_FOR": "203.0.113.7",
            "HTTP_COOKIE": "sessionid=abc",
            "HTTP_USER_AGENT": "Mozilla/5.0",
        },
    )

    assert status.startswith("502")
    assert len(sent_events) == 1
    event = sent_events[0]
    assert event["level"] == "error"
    assert "config (HTTP 401, authentication_error)" in event["logentry"]["formatted"]
    request = event["request"]
    # Sentry sees Gunicorn's side of the request (plain HTTP behind Caddy).
    assert request["url"] == "http://phoebe-api.garickm.com/api/ask/"
    assert request["method"] == "POST"
    assert request["headers"]["User-Agent"] == "Mozilla/5.0"
    assert {"query_string", "data", "cookies", "env"}.isdisjoint(request)
    assert "user" not in event
    assert_clean(event)


def test_a_crash_keeps_its_stack_trace_but_not_its_variables(sent_events):
    seen_headers = []

    def open_meteo(request):
        seen_headers.append(dict(request.headers))
        return httpx.Response(200, json={})

    http = httpx.Client(transport=httpx.MockTransport(open_meteo))

    def look_up(place, latitude):
        url = "https://geocoding-api.open-meteo.com/v1/search"
        http.get(url, params={"name": place, "latitude": latitude})
        raise RuntimeError("lookup failed")

    try:
        look_up(*VISITOR)
    except RuntimeError:
        sentry_sdk.capture_exception()

    assert len(sent_events) == 1
    event = sent_events[0]
    frames = event["exception"]["values"][0]["stacktrace"]["frames"]
    assert frames[-1]["function"] == "look_up"
    assert all("vars" not in frame for frame in frames)
    urls = [
        crumb["data"]["url"]
        for crumb in event["breadcrumbs"]["values"]
        if crumb.get("data")
    ]
    assert "https://geocoding-api.open-meteo.com/v1/search" in urls
    assert_clean(event)
    # No tracing headers were added to the outgoing request.
    assert not {"sentry-trace", "baggage"} & set(seen_headers[0])
