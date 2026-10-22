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
    # Retry-After isn't CORS-safelisted: without this, fetch() reads it as
    # null and Ask Phoebe can't tell the daily limit from the per-minute one.
    assert "Retry-After" in throttled.headers
    assert throttled.headers["Access-Control-Expose-Headers"] == "Retry-After"


def test_other_origins_are_not_told_what_to_expose(client):
    response = client.get(LIST_URL, headers={"Origin": "https://evil.example"})

    assert "Access-Control-Expose-Headers" not in response.headers


def test_cors_only_applies_under_the_api(client):
    response = client.get("/not-the-api/", headers={"Origin": FRONT_END})

    assert response.status_code == 404
    assert ALLOW not in response.headers


PREFLIGHT = {
    "Origin": FRONT_END,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
}


def test_a_preflight_from_the_front_end_allows_a_json_post(client):
    response = client.options("/api/ask/", headers=PREFLIGHT)

    assert response.status_code == 200
    assert response.headers[ALLOW] == FRONT_END
    assert response.headers["Access-Control-Allow-Methods"] == "GET, POST"
    assert response.headers["Access-Control-Allow-Headers"] == "Content-Type"
    assert response.headers["Access-Control-Max-Age"] == "7200"
    assert "Origin" in response.headers["Vary"]
    # Cookies are never allowed cross-origin.
    assert "Access-Control-Allow-Credentials" not in response.headers


@pytest.mark.parametrize("origin", ["https://evil.example", "null"])
def test_a_preflight_from_another_origin_gets_no_permission(client, origin):
    response = client.options("/api/ask/", headers={**PREFLIGHT, "Origin": origin})

    # An answer without the Allow headers is how CORS says no.
    assert response.status_code == 200
    for header in (ALLOW, "Access-Control-Allow-Methods", "Access-Control-Allow-Headers"):
        assert header not in response.headers


def test_preflights_never_use_up_the_rate_limit(monkeypatch, client):
    monkeypatch.setitem(AnonRateThrottle.THROTTLE_RATES, "anon", "1/min")

    for _ in range(3):
        assert client.options(LIST_URL, headers=PREFLIGHT).status_code == 200

    # The one request allowed this minute is still available.
    assert client.get(LIST_URL, headers={"Origin": FRONT_END}).status_code == 200


def test_a_plain_options_request_still_reaches_the_api(client):
    # No Access-Control-Request-Method: not a preflight, so DRF answers it as
    # before (its usual description of the endpoint).
    response = client.options(LIST_URL, headers={"Origin": FRONT_END})

    assert response.status_code == 200
    assert "Access-Control-Allow-Methods" not in response.headers
    assert response.headers[ALLOW] == FRONT_END


def test_preflights_outside_the_api_get_no_cors(client):
    response = client.options("/not-the-api/", headers=PREFLIGHT)

    assert ALLOW not in response.headers


def test_a_bad_origin_is_never_echoed_in_the_error():
    # A .env without a final newline glued the next line onto this one.
    glued = "http://localhost:3000ANTHROPIC_API_KEY=not-a-real-secret"

    with pytest.raises(ImproperlyConfigured) as raised:
        parse_allowed_origins(glued)
    assert "not-a-real-secret" not in str(raised.value)
    assert "item 1" in str(raised.value)


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
