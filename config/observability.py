"""Error tracking with Sentry, without sending visitors' data.

Sentry is off unless SENTRY_DSN is set. Only the server's .env sets it, so
local development, tests and CI never send anything.

What must never reach Sentry (location privacy, brief section 2; Ask
Phoebe's question can name a place):
- query strings, anywhere: the request URL (the passes endpoint's
  ?lat=&lon=), the Referer header, outgoing HTTP breadcrumbs (Open-Meteo
  calls carry a place name or coordinates in theirs) and URLs quoted inside
  messages (httpx's errors include the full URL);
- request bodies (Ask Phoebe's question);
- local variables of stack frames (they hold the same values);
- IP addresses and cookies.

The SDK settings remove most of this before an event is built; scrub_event
and scrub_breadcrumb are the last check before anything leaves the server.
Sentry's own server-side scrubbing (organization settings) is a third layer.
"""

import re
from urllib.parse import urlsplit, urlunsplit

# Request headers worth keeping. Everything else is dropped: Referer can hold
# a page URL with coordinates, X-Forwarded-For is the visitor's IP, Cookie
# and Authorization are credentials.
KEPT_HEADERS = {
    "accept",
    "content-length",
    "content-type",
    "host",
    "origin",
    "user-agent",
}

# An http(s) URL's query string or fragment, inside any text.
_URL_TAIL = re.compile(r"(https?://[^\s?#'\"]+)[?#][^\s'\"]*")


def strip_query(url):
    """The URL without its query string and fragment."""
    if not isinstance(url, str):
        return url
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def strip_urls_in_text(text):
    """Drop the query string and fragment of every URL quoted in `text`."""
    if not isinstance(text, str):
        return text
    return _URL_TAIL.sub(r"\1", text)


def _scrub_request(request):
    request.pop("query_string", None)
    request.pop("data", None)
    request.pop("cookies", None)
    request.pop("env", None)
    if "url" in request:
        request["url"] = strip_query(request["url"])
    headers = request.get("headers")
    if isinstance(headers, dict):
        request["headers"] = {
            name: value
            for name, value in headers.items()
            if name.lower() in KEPT_HEADERS
        }


def _scrub_frames(frames):
    for frame in frames or []:
        frame.pop("vars", None)


def scrub_breadcrumb(crumb, hint=None):
    """Sentry's before_breadcrumb hook."""
    data = crumb.get("data")
    if isinstance(data, dict):
        data.pop("http.query", None)
        data.pop("http.fragment", None)
        if "url" in data:
            data["url"] = strip_query(data["url"])
    if "message" in crumb:
        crumb["message"] = strip_urls_in_text(crumb["message"])
    return crumb


def scrub_event(event, hint=None):
    """Sentry's before_send hook: runs on every error event."""
    event.pop("user", None)
    if isinstance(event.get("request"), dict):
        _scrub_request(event["request"])

    logentry = event.get("logentry")
    if isinstance(logentry, dict):
        for key in ("message", "formatted"):
            if key in logentry:
                logentry[key] = strip_urls_in_text(logentry[key])
        # The %s arguments of a log call: drop them, the formatted text is kept.
        logentry.pop("params", None)
    if "message" in event:
        event["message"] = strip_urls_in_text(event["message"])

    for exception in (event.get("exception") or {}).get("values", []):
        exception["value"] = strip_urls_in_text(exception.get("value"))
        _scrub_frames((exception.get("stacktrace") or {}).get("frames"))
    for thread in (event.get("threads") or {}).get("values", []):
        _scrub_frames((thread.get("stacktrace") or {}).get("frames"))

    breadcrumbs = event.get("breadcrumbs")
    values = breadcrumbs.get("values") if isinstance(breadcrumbs, dict) else breadcrumbs
    for crumb in values or []:
        scrub_breadcrumb(crumb)
    return event


def init_sentry(dsn, environment="production", **extra):
    """Start Sentry if a DSN is set. Returns whether it started.

    `extra` exists for tests (a capturing transport); production passes none.
    """
    if not dsn:
        return False
    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn,
        environment=environment,
        # What the SDK may collect on its own (it replaces send_default_pii).
        data_collection={
            "user_info": False,  # no IP address or user details
            "cookies": {"mode": "off"},
            # Header names not listed are kept with "[Filtered]" values.
            "http_headers": {
                "request": {"mode": "allowlist", "terms": sorted(KEPT_HEADERS)}
            },
            "http_bodies": [],  # never request bodies (Ask's question)
            "url_query_params": {"mode": "off"},  # ?lat=&lon=
            "gen_ai": {"inputs": False, "outputs": False},
            "database_query_data": False,
            "stack_frame_variables": False,  # stack traces without local values
        },
        # Errors only: no performance tracing (traces_sample_rate stays unset),
        # and no sentry-trace/baggage headers added to outgoing requests
        # (Anthropic, Open-Meteo and CelesTrak have no use for them).
        trace_propagation_targets=[],
        before_send=scrub_event,
        before_breadcrumb=scrub_breadcrumb,
        **extra,
    )
    return True
