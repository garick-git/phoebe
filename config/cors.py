"""CORS for Phoebe's read-only API.

The front end (https://phoebe.garickm.com) and the API
(https://phoebe-api.garickm.com) are different origins. Browsers still send the
request, but they only let the page *read* the response if it carries
Access-Control-Allow-Origin naming the page's own origin. This middleware adds
that header for an exact-match allowlist, and only on /api/ URLs.

Why our own middleware instead of django-cors-headers: the package's latest
release (4.9.0) declares support up to Django 6.0, and this project runs 6.1.
The API is GET-only with no cookies or custom headers, so browsers send "simple"
requests with no preflight (OPTIONS) to answer. When Ask Phoebe adds a JSON POST
(Week 4), preflight handling goes here, or we switch to the package once it
supports our Django version.
"""

from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.utils.cache import patch_vary_headers

API_PREFIX = "/api/"


def parse_allowed_origins(raw):
    """Turn "https://a.example,http://localhost:3000" into a list of origins.

    Fails at startup on anything that isn't exactly an origin: browsers send
    the Origin header as scheme://host[:port] in lowercase with no path, so a
    typo like a trailing slash would otherwise never match and fail silently.
    A wildcard ("*") is rejected on purpose.
    """
    origins = []
    for item in raw.split(","):
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
            raise ImproperlyConfigured(
                f"DJANGO_CORS_ALLOWED_ORIGINS: {origin!r} is not an origin like "
                "https://example.com (lowercase, no path, no trailing slash)."
            )
        origins.append(origin)
    return origins


class ApiCorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not request.path_info.startswith(API_PREFIX):
            return response  # the admin and everything else never get CORS

        # The response differs by Origin, so any cache must store one copy per
        # Origin instead of handing one site's permission to another.
        patch_vary_headers(response, ["Origin"])

        origin = request.headers.get("Origin")
        if origin and origin in settings.CORS_ALLOWED_ORIGINS:
            # Echo the one matching origin (the header can't hold a list).
            # Applies to every status, so the page can also read 404s and 429s.
            response["Access-Control-Allow-Origin"] = origin
        return response
