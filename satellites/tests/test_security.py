import pytest
from rest_framework.throttling import AnonRateThrottle

pytestmark = pytest.mark.django_db

LIST_URL = "/api/satellites/"
HSTS = "Strict-Transport-Security"


def test_hsts_is_sent_when_the_proxy_says_the_request_was_https(settings, client):
    settings.SECURE_HSTS_SECONDS = 3600

    response = client.get(LIST_URL, headers={"X-Forwarded-Proto": "https"})

    assert response.headers[HSTS] == "max-age=3600"


def test_hsts_is_not_sent_over_plain_http(settings, client):
    settings.SECURE_HSTS_SECONDS = 3600

    response = client.get(LIST_URL)

    assert HSTS not in response.headers


def test_throttle_returns_429_with_retry_after_once_the_limit_is_used(
    monkeypatch, client
):
    monkeypatch.setitem(AnonRateThrottle.THROTTLE_RATES, "anon", "3/min")

    for _ in range(3):
        assert client.get(LIST_URL).status_code == 200
    blocked = client.get(LIST_URL)

    assert blocked.status_code == 429
    assert "Retry-After" in blocked.headers


def test_throttle_counts_each_forwarded_client_separately(monkeypatch, client):
    # Behind Caddy every request arrives from Caddy's address; the real client
    # is in X-Forwarded-For. One client using its limit must not block another.
    monkeypatch.setitem(AnonRateThrottle.THROTTLE_RATES, "anon", "1/min")
    first = {"X-Forwarded-For": "203.0.113.1"}
    other = {"X-Forwarded-For": "203.0.113.2"}

    assert client.get(LIST_URL, headers=first).status_code == 200
    assert client.get(LIST_URL, headers=first).status_code == 429
    assert client.get(LIST_URL, headers=other).status_code == 200


@pytest.mark.parametrize("path", [LIST_URL, "/admin/login/"])
def test_csp_allows_only_phoebes_own_scripts_and_no_framing(settings, client, path):
    # The admin page links its CSS through the static files manifest, which only
    # exists after collectstatic (the Docker build), not in tests or CI: use
    # plain static file URLs here. The CSP header doesn't depend on them.
    settings.STORAGES = {
        **settings.STORAGES,
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }

    csp = client.get(path).headers["Content-Security-Policy"]

    directives = dict(part.strip().split(" ", 1) for part in csp.split(";"))
    assert directives["script-src"] == "'self'"  # no inline or outside scripts
    assert directives["object-src"] == "'none'"
    assert directives["base-uri"] == "'none'"
    assert directives["frame-ancestors"] == "'none'"
