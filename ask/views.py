import logging
from datetime import datetime, time, timedelta, timezone

from rest_framework import status
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import clock, service
from .serializers import AskSerializer

logger = logging.getLogger(__name__)


class AskBurstThrottle(AnonRateThrottle):
    """Per IP, per minute ("ask_burst" in settings). Like every DRF throttle
    here, counts live in each Gunicorn worker's memory, so the real limit is
    up to 2x and resets on a deploy: fine for stopping one person spamming;
    the daily budget (exact, in Postgres) guards the money."""

    scope = "ask_burst"


class AskDailyThrottle(AnonRateThrottle):
    """Per IP, per day ("ask_day"), so one visitor can't use up the whole
    site's daily budget."""

    scope = "ask_day"


# What each failure looks like to the visitor. Never the technical reason.
UNAVAILABLE = {
    "not_configured": (
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "Ask Phoebe isn't switched on here.",
    ),
    "daily_budget": (
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "Ask Phoebe has answered all it can for today. Back tomorrow!",
    ),
    "spend_limit": (
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "Ask Phoebe has used this month's budget and is resting until next month.",
    ),
    "busy": (
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "Ask Phoebe is busy right now. Try again in a minute.",
    ),
    "timeout": (
        status.HTTP_504_GATEWAY_TIMEOUT,
        "Ask Phoebe took too long to answer. Try again in a minute.",
    ),
    "config": (
        status.HTTP_502_BAD_GATEWAY,
        "Ask Phoebe isn't working right now.",
    ),
}


def _seconds_until_utc_midnight():
    now = clock.utc_now()
    midnight = datetime.combine(now.date() + timedelta(days=1), time(), timezone.utc)
    return int((midnight - now).total_seconds())


def _unavailable(kind):
    code, message = UNAVAILABLE[kind]
    response = Response({"detail": message, "code": kind}, status=code)
    if kind == "daily_budget":
        response["Retry-After"] = str(_seconds_until_utc_midnight())
    elif kind in ("busy", "timeout"):
        response["Retry-After"] = "60"
    return response


class AskView(APIView):
    """POST /api/ask/ with {"question": "..."} → {"answer", "complete",
    "tools", "usage"}. "tools" lists every tool call with its input and
    result, so the front end can render pass cards and check the answer's
    numbers against them (Oct 29) without a second request."""

    # No sessions or cookies: nothing for a cross-site request to ride on.
    authentication_classes = []
    permission_classes = [AllowAny]
    # JSON only. A JSON POST from another site always needs a CORS preflight,
    # which config/cors.py refuses for any origin but Phoebe's own.
    parser_classes = [JSONParser]
    # All three apply: the API-wide 60/min, then Ask's own per-minute and
    # per-day limits.
    throttle_classes = [AnonRateThrottle, AskBurstThrottle, AskDailyThrottle]

    def post(self, request):
        body = AskSerializer(data=request.data)
        body.is_valid(raise_exception=True)  # 400 with a message per field
        try:
            result = service.answer(body.validated_data["question"])
        except service.AskUnavailable as error:
            return _unavailable(error.kind)
        except service.ClaudeError as error:
            # The kind, HTTP status and Anthropic's error type only: never the
            # question (it can name a place) or anything from the request.
            if error.kind == "config":
                logger.error("Ask Phoebe: Claude API call failed: %s", error)
            else:
                logger.warning("Ask Phoebe: Claude API call failed: %s", error)
            return _unavailable(error.kind)
        return Response(result)
