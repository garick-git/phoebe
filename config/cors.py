"""CORS for Phoebe's read-only API.

The front end (https://phoebe.garickm.com) and the API
(https://phoebe-api.garickm.com) are different origins. Browsers still send the
request, but they only let the page *read* the response if it carries
Access-Control-Allow-Origin naming the page's own origin. This middleware adds
that header for an exact-match allowlist, and only on /api/ URLs.

Why our own middleware instead of django-cors-headers: the package's latest
release (4.9.0, checked again on 2026-10-21) declares support up to Django 6.0,
and this project runs 6.1.

Preflight: GETs with no custom headers are "simple" requests, sent directly.
Ask Phoebe's POST with `Content-Type: application/json` is not, so the browser
first sends an OPTIONS request with Access-Control-Request-Method asking
permission. This middleware answers that itself, before DRF or the throttles
see it, so a preflight never uses up anyone's question allowance.
"""

from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.http import HttpResponse
from django.utils.cache import patch_vary_headers

API_PREFIX = "/api/"

# What a preflight may ask for. Only what the API actually uses: GET for
# everything, POST for Ask Phoebe, and Content-Type for its JSON body. No
# credentials (cookies) are ever allowed cross-origin.
PREFLIGHT_ALLOW_METHODS = "GET, POST"
PREFLIGHT_ALLOW_HEADERS = "Content-Type"
# How long the browser may reuse a preflight answer, in seconds. Chrome caps
# this at 2 hours (7200) and Firefox at 24; 2 hours means a visitor asking
# several questions sends one preflight, not one per question.
PREFLIGHT_MAX_AGE = "7200"
# Response headers the page's JavaScript may read beyond the CORS-safelisted
# few (Content-Type and the like). Retry-After tells Ask Phoebe's per-day
# limit (hours) from the per-minute one, so the page can say "try again
# tomorrow" instead of "wait a minute" (decision log, Oct 22).
EXPOSE_HEADERS = "Retry-After"


def parse_allowed_origins(raw):
    """Turn "https://a.example,http://localhost:3000" into a list of origins.

    Fails at startup on anything that isn't exactly an origin: browsers send
    the Origin header as scheme://host[:port] in lowercase with no path, so a
    typo like a trailing slash would otherwise never match and fail silently.
    A wildcard ("*") is rejected on purpose.
    """
    origins = []
    for position, item in enumerate(raw.split(","), start=1):
        origin = item.strip()
        if not origin:
            continue
        parts = urlsplit(origin)
        if (
            parts.scheme not in ("http", "https")
            or not parts.netloc
            or parts.path
            or parts.query
            or parts.fragment
            or origin != origin.lower()
        ):
            # Never echo the value: if a .env line lost its newline, the next
            # line (possibly a secret) is part of it. Happened on 2026-10-21.
            raise ImproperlyConfigured(
                f"DJANGO_CORS_ALLOWED_ORIGINS: item {position} is not an origin like "
                "https://example.com (lowercase, no path, no trailing slash). Check "
                "it with: grep '^DJANGO_CORS_ALLOWED_ORIGINS=' .env"
            )
        origins.append(origin)
    return origins


class ApiCorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if not request.path_info.startswith(API_PREFIX):
            # The admin and everything else never get CORS.
            return self.get_response(request)

        origin = request.headers.get("Origin")
        allowed = bool(origin) and origin in settings.CORS_ALLOWED_ORIGINS

        if (
            request.method == "OPTIONS"
            and "Access-Control-Request-Method" in request.headers
        ):
            # A preflight: answer it here (the view never runs). Unknown origins
            # get an empty 200 with no Allow headers, which the browser treats
            # as "no", so the real request is never sent.
            response = HttpResponse(status=200)
            patch_vary_headers(response, ["Origin"])
            if allowed:
                response["Access-Control-Allow-Origin"] = origin
                response["Access-Control-Allow-Methods"] = PREFLIGHT_ALLOW_METHODS
                response["Access-Control-Allow-Headers"] = PREFLIGHT_ALLOW_HEADERS
                response["Access-Control-Max-Age"] = PREFLIGHT_MAX_AGE
            return response

        response = self.get_response(request)

        # The response differs by Origin, so any cache must store one copy per
        # Origin instead of handing one site's permission to another.
        patch_vary_headers(response, ["Origin"])

        if allowed:
            # Echo the one matching origin (the header can't hold a list).
            # Applies to every status, so the page can also read 404s and 429s.
            response["Access-Control-Allow-Origin"] = origin
            response["Access-Control-Expose-Headers"] = EXPOSE_HEADERS
        return response
