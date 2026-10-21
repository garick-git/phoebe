"""The current time for Ask Phoebe, in one place so tests can freeze it with
monkeypatch.setattr("ask.clock.utc_now", ...)."""

from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0)
