"""Place names and cloud forecasts from Open-Meteo, called from the server.

Tonight calls Open-Meteo from the browser (each visitor uses their own
per-IP allowance; decision log 2026-10-19). Ask Phoebe's tools have to run on
the server, because our code is what runs a tool. Ask's own rate limits keep
these calls far under Open-Meteo's free limit (10,000 a day per IP).

Location privacy (brief section 2): coordinates are rounded to 2 decimals
(about 1 km) before they're used or sent, and neither the place name nor the
coordinates are ever logged. httpx logs every request URL (with its query
string) at INFO level, so its logger is held at WARNING here.
"""

import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from satellites.serializers import round_location

# The request URL holds the place name or the coordinates: keep it out of logs.
logging.getLogger("httpx").setLevel(logging.WARNING)

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = httpx.Timeout(8.0, connect=3.0)
USER_AGENT = "Phoebe/0.1 (satellite tracker; Ask Phoebe)"

# Hourly cloud cover for 7 days plus the hour after the last possible pass,
# counted from the current hour (the same window Tonight asks for).
FORECAST_HOURS = 170

_http = httpx.Client(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})


class PlaceError(Exception):
    """A place can't be found, or Open-Meteo didn't answer. The message is
    shown to the model, so it says what to try next, in plain words."""


def _text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def _finite(value, limit):
    # bool is an int in Python; True is not a coordinate.
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and abs(value) <= limit
    )


def _known_zone(name):
    if not name:
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


def find_place(name):
    """The best match for a place name, e.g. "Austin" or "Austin, Texas":
    {label, latitude, longitude, timezone}, coordinates rounded to 2 decimals.

    Open-Meteo matches the start of a city name, so "City, Region" is split
    and the region is used to choose between results with the same name.
    """
    city, _, region = name.partition(",")
    city, region = city.strip(), region.strip().lower()
    if len(city) < 2:
        raise PlaceError("Give a city name of at least 2 letters.")

    try:
        response = _http.get(
            GEOCODING_URL,
            params={"name": city, "count": 10, "language": "en", "format": "json"},
        )
        response.raise_for_status()
        results = response.json().get("results") or []
    except (httpx.HTTPError, ValueError) as error:
        raise PlaceError("The place search isn't answering right now.") from error

    places = []
    for raw in results:
        if not isinstance(raw, dict):
            continue
        label_parts = [_text(raw.get(key)) for key in ("name", "admin1", "country")]
        if not label_parts[0] or not _finite(raw.get("latitude"), 90) or not _finite(
            raw.get("longitude"), 180
        ):
            continue
        tz_name = _text(raw.get("timezone"))
        if not _known_zone(tz_name):
            continue  # times can't be shown in local time without a zone
        # Drop repeats, e.g. "Singapore, Singapore, Singapore".
        parts = []
        for part in label_parts:
            if part and part not in parts:
                parts.append(part)
        places.append(
            {
                "label": ", ".join(parts),
                "latitude": round_location(raw["latitude"]),
                "longitude": round_location(raw["longitude"]),
                "timezone": tz_name,
                "_region": " ".join(p.lower() for p in parts[1:]),
            }
        )

    if region:
        matching = [p for p in places if region in p["_region"]]
        places = matching or places
    if not places:
        raise PlaceError(
            f"No place called {name!r} was found. Try the city's name, or "
            "'City, State' / 'City, Country'."
        )
    best = places[0]  # Open-Meteo lists bigger places first
    return {key: value for key, value in best.items() if not key.startswith("_")}


def hourly_cloud_cover(latitude, longitude):
    """[(UTC datetime at the top of the hour, cloud cover %)] for the next
    FORECAST_HOURS hours. Raises PlaceError if Open-Meteo doesn't answer."""
    try:
        response = _http.get(
            FORECAST_URL,
            params={
                "latitude": round_location(latitude),
                "longitude": round_location(longitude),
                "hourly": "cloud_cover",
                "forecast_hours": FORECAST_HOURS,
                "timeformat": "unixtime",
            },
        )
        response.raise_for_status()
        hourly = response.json()["hourly"]
        times, cover = hourly["time"], hourly["cloud_cover"]
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
        raise PlaceError("The cloud forecast isn't available right now.") from error

    hours = []
    for when, percent in zip(times, cover):
        # A missing value stays missing (null), never a guess.
        if not isinstance(when, int):
            continue
        value = percent if _finite(percent, 100) and percent >= 0 else None
        hours.append((datetime.fromtimestamp(when, timezone.utc), value))
    return hours
