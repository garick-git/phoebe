import pytest
from django.core.exceptions import ImproperlyConfigured
from rest_framework.throttling import AnonRateThrottle

from config.cors import parse_allowed_origins

pytestmark = pytest.mark.django_db

FRONT_END = "https://phoebe.example.com"
LIST_URL = "/api/satellites/"
ALLOW = "Access-Control-Allow-Origin"


@pytest.fixture(autouse=True)
def allowed_origins(settings):
    settings.CORS_ALLOWED_ORIGINS = [FRONT_END]


def test_the_front_end_origin_may_read_the_api(client):
    response = client.get(LIST_URL, headers={"Origin": FRONT_END})

    assert response.status_code == 200
    assert response.headers[ALLOW] == FRONT_END
    assert "Origin" in response.headers["Vary"]


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",
        "http://phoebe.example.com",  # same host, plain HTTP
        "https://phoebe.example.com.evil.example",  # look-alike suffix
        "https://phoebe.example.com:8443",  # different port
        "null",  # sandboxed iframes and file:// pages
    ],
)
def test_any_other_origin_gets_no_permission(client, origin):
    response = client.get(LIST_URL, headers={"Origin": origin})

    # The server still answers; the browser is what stops the page reading it.
    assert response.status_code == 200
    assert ALLOW not in response.headers
    assert "Origin" in response.headers["Vary"]


def test_requests_without_an_origin_get_no_cors_header(client):
    assert ALLOW not in client.get(LIST_URL).headers


def test_error_responses_are_readable_by_the_front_end(monkeypatch, client):
    # Without the header a 404 or 429 looks like a network error to the page.
    monkeypatch.setitem(AnonRateThrottle.THROTTLE_RATES, "anon", "1/min")
    origin = {"Origin": FRONT_END}

    not_found = client.get("/api/satellites/999999999/", headers=origin)
    throttled = client.get(LIST_URL, headers=origin)

    assert not_found.status_code == 404
    assert not_found.headers[ALLOW] == FRONT_END
    assert throttled.status_code == 429
    assert throttled.headers[ALLOW] == FRONT_END


def test_cors_only_applies_under_the_api(client):
    response = client.get("/not-the-api/", headers={"Origin": FRONT_END})

    assert response.status_code == 404
    assert ALLOW not in response.headers


def test_allowed_origins_are_read_from_a_comma_separated_list():
    raw = " https://phoebe.example.com , http://localhost:3000 ,"

    assert parse_allowed_origins(raw) == [
        "https://phoebe.example.com",
        "http://localhost:3000",
    ]
    assert parse_allowed_origins("") == []


@pytest.mark.parametrize(
    "bad",
    [
        "*",
        "https://phoebe.example.com/",  # trailing slash never matches
        "phoebe.example.com",  # no scheme
        "https://phoebe.example.com/api",
        "https://Phoebe.example.com",  # browsers send lowercase
        "ftp://phoebe.example.com",
    ],
)
def test_anything_that_is_not_an_exact_origin_fails_at_startup(bad):
    with pytest.raises(ImproperlyConfigured):
        parse_allowed_origins(bad)
