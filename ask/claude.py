"""A small client for Anthropic's Messages API, using httpx directly.

Why not the official SDK: it adds 12 packages and about 64 MB per Gunicorn
worker on a 1 GB server, and this project needs one endpoint (decision log,
2026-10-21). The request is plain JSON over HTTPS:

    POST https://api.anthropic.com/v1/messages
    x-api-key: <key>   anthropic-version: 2023-06-01

The key comes only from the server's environment (ANTHROPIC_API_KEY). It is
never logged, never put in an exception message, and never sent anywhere but
api.anthropic.com. Tests replace get_client() with a fake, so CI never calls
the real API.
"""

import logging
import threading

import httpx
from django.conf import settings

logger = logging.getLogger(__name__)

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"

# Per call. Opus writing up to MAX_OUTPUT_TOKENS usually takes a few seconds;
# 25 s leaves room for a slow moment without holding a request for minutes.
TIMEOUT = httpx.Timeout(25.0, connect=5.0)

# What a self-set Console spend limit returns (HTTP 400, invalid_request_error;
# docs: "Rate limits" → spend limits). Matched so visitors get a clear message.
SPEND_LIMIT_PREFIX = "You have reached your specified"


class ClaudeError(Exception):
    """The Messages API call failed. `kind` says how, for the response:

    - "spend_limit": the Console spend limit (or the tier's cap) is reached
    - "busy": rate limited (429) or overloaded (529), or a 5xx
    - "timeout": no answer in time, or the network failed
    - "config": a request the API rejected (our bug: bad key, bad request)
    """

    def __init__(self, kind, status=None, error_type=None):
        self.kind = kind
        self.status = status
        self.error_type = error_type
        # Only the category, status and Anthropic's error type: never the
        # request (it holds the visitor's question) or the headers (the key).
        super().__init__(f"{kind} (HTTP {status}, {error_type})")


def _classify(response):
    try:
        error = response.json().get("error", {})
    except ValueError:
        error = {}
    error_type = error.get("type")
    message = error.get("message", "")
    details = error.get("details") or {}
    status = response.status_code

    if message.startswith(SPEND_LIMIT_PREFIX) or (
        details.get("error_code") == "enforced_spend_limit_reached"
    ):
        return ClaudeError("spend_limit", status, error_type)
    if status in (429, 529) or status >= 500:
        return ClaudeError("busy", status, error_type)
    return ClaudeError("config", status, error_type)


class ClaudeClient:
    """Sends one Messages API request and returns the parsed JSON reply."""

    def __init__(self, api_key, transport=None):
        # `transport` lets tests answer requests with httpx.MockTransport.
        # One shared connection pool per Gunicorn worker (httpx.Client is safe
        # to share between the worker's threads), so each round reuses the
        # same TLS connection instead of a new handshake.
        self._http = httpx.Client(
            transport=transport,
            timeout=TIMEOUT,
            headers={
                "x-api-key": api_key,
                "anthropic-version": API_VERSION,
                "content-type": "application/json",
            },
        )

    def create_message(self, body):
        try:
            response = self._http.post(API_URL, json=body)
        except httpx.TimeoutException as error:
            raise ClaudeError("timeout") from error
        except httpx.HTTPError as error:
            raise ClaudeError("timeout", error_type=type(error).__name__) from error

        if response.status_code != 200:
            raise _classify(response)
        return response.json()


_client = None
_client_lock = threading.Lock()


def get_client():
    """The shared client, or None when no API key is configured (local
    development without a key, and CI). Tests replace this function."""
    global _client
    if not settings.ANTHROPIC_API_KEY:
        return None
    with _client_lock:
        if _client is None:
            _client = ClaudeClient(settings.ANTHROPIC_API_KEY)
        return _client
