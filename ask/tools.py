"""The three tools Ask Phoebe's model may call, and the code that runs them.

Every tool is read-only and returns public data only (brief 6b): satellite
records and orbits from our own database, pass predictions from
find_passes(), and a public cloud forecast. Nothing here writes, and nothing
the model sends can reach a secret, so a prompt injection ("ignore your
rules and…") has nothing to steer. Inputs from the model are checked like any
other untrusted input.

Times go back in the place's own time zone, already written out ("Wed Oct
28, 7:14 pm CDT"), so the model never converts UTC itself: fewer chances for
a wrong number in the answer (Oct 29 verifies every time against these
results).
"""

import logging
import math
from zoneinfo import ZoneInfo

from satellites.models import Satellite
from satellites.passes import EARTH_SHADOW, MAX_DAYS, MIN_ELEVATION_DEG, find_passes
from satellites.positions import PropagationError, compute_position

from . import clock, places
from .popular import popular_by_id, popular_by_name

logger = logging.getLogger(__name__)

MAX_NAME_LENGTH = 100
LOOKUP_RESULTS = 5

# The same words as Tonight's cards (frontend/src/lib/plainPass.ts).
COMPASS_8 = [
    "north", "northeast", "east", "southeast",
    "south", "southwest", "west", "northwest",
]  # fmt: skip
PARTWAY_FROM_DEG = 20
HIGH_FROM_DEG = 45
OVERHEAD_FROM_DEG = 70

TOOL_DEFINITIONS = [
    {
        "name": "look_up_satellite",
        "description": (
            "Find satellites by name, nickname (ISS, Tiangong, Hubble) or NORAD "
            "catalog number. Returns up to 5 matches, best first, and for the "
            "best match: where it is right now (latitude, longitude, altitude), "
            "its speed, orbit period and inclination."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A name, nickname or NORAD ID, e.g. 'Hubble' or '25544'.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_passes",
        "description": (
            "Upcoming passes of one satellite over a place, starting now, from "
            "real orbital data. Each pass says whether it can be seen (visible: "
            "true means above 10 degrees, lit by the Sun, and the sky dark "
            "enough). Visible passes give when it appears, its highest point "
            "and when it disappears, with plain-language direction and height. "
            "Passes that can't be seen give the reason: 'daylight' (the sky is "
            "too bright) or 'earth_shadow' (dark sky, but the satellite is in "
            "Earth's shadow, so it isn't lit). Times are the place's local time."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "satellite": {
                    "type": "string",
                    "description": "Name, nickname or NORAD ID, e.g. 'ISS'.",
                },
                "place": {
                    "type": "string",
                    "description": "A city, optionally with its state or country, "
                    "e.g. 'Austin, Texas'.",
                },
                "days": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_DAYS,
                    "description": "How many days ahead to search (default 7).",
                },
            },
            "required": ["satellite", "place"],
        },
    },
    {
        "name": "get_cloud_forecast",
        "description": (
            "Hourly total cloud cover (percent) for a place, in its local time, "
            "from now for up to 7 days (Open-Meteo). Each value is the forecast "
            "at the top of that hour. Forecasts beyond about 3 days are less "
            "reliable. Viewing scale used by Phoebe: good at 25% or less, fair "
            "at 50% or less, poor above 50%."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "place": {
                    "type": "string",
                    "description": "A city, optionally with its state or country.",
                },
                "days": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_DAYS,
                    "description": "How many days ahead (default 7).",
                },
            },
            "required": ["place"],
        },
    },
]


class ToolError(Exception):
    """Bad input or nothing found. The message goes back to the model as an
    error result, so it can correct itself or tell the user."""


# --- input checks ----------------------------------------------------------


def _name(tool_input, key):
    value = tool_input.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ToolError(f"'{key}' must be a non-empty string.")
    value = value.strip()
    if len(value) > MAX_NAME_LENGTH:
        raise ToolError(f"'{key}' is too long (at most {MAX_NAME_LENGTH} characters).")
    return value


def _days(tool_input):
    days = tool_input.get("days", MAX_DAYS)
    # bool is an int in Python; True must not mean 1 day.
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_DAYS:
        raise ToolError(f"'days' must be a whole number from 1 to {MAX_DAYS}.")
    return days


# --- plain language ----------------------------------------------------------


def compass8(azimuth_deg):
    """8-point compass word; exact boundaries round up (22.5 → northeast),
    like Tonight's cards (JavaScript's Math.round, not Python's round())."""
    return COMPASS_8[math.floor((azimuth_deg % 360) / 45 + 0.5) % 8]


def height_word(elevation_deg):
    if elevation_deg >= OVERHEAD_FROM_DEG:
        return "almost overhead"
    if elevation_deg >= HIGH_FROM_DEG:
        return "high"
    if elevation_deg >= PARTWAY_FROM_DEG:
        return "partway up"
    return "low"


def local_time(when, tz):
    """'Wed Oct 28, 7:14 pm CDT' plus the ISO time with its UTC offset."""
    local = when.astimezone(tz)
    hour = local.hour % 12 or 12
    suffix = "am" if local.hour < 12 else "pm"
    label = (
        f"{local:%a %b} {local.day}, {hour}:{local:%M} {suffix} {local.tzname()}"
    )
    return {"when": label, "time": local.isoformat()}


def _point(point, tz):
    return {
        **local_time(point.time, tz),
        "direction": compass8(point.azimuth_deg),
        "height": height_word(point.elevation_deg),
        "azimuth_deg": round(point.azimuth_deg, 1),
        "elevation_deg": round(point.elevation_deg, 1),
    }


# --- satellites -------------------------------------------------------------


def find_satellite(query):
    """Best match for a name, nickname or NORAD ID; ToolError if none."""
    if query.isdigit():
        satellite = Satellite.objects.filter(norad_cat_id=int(query)).first()
        if satellite is None:
            raise ToolError(f"No satellite has NORAD ID {query}.")
        return satellite
    popular = popular_by_name(query)
    if popular:
        satellite = Satellite.objects.filter(
            norad_cat_id=popular["norad_cat_id"]
        ).first()
        if satellite:
            return satellite
    satellite = (
        Satellite.objects.current().filter(name__icontains=query).rank_by_name(query).first()
    )
    if satellite is None:
        raise ToolError(f"No satellite matches {query!r}.")
    return satellite


def _identity(satellite):
    identity = {"norad_cat_id": satellite.norad_cat_id, "name": satellite.name}
    popular = popular_by_id(satellite.norad_cat_id)
    if popular:
        identity["nickname"] = popular["nickname"]
        identity["full_name"] = popular["full_name"]
    return identity


def look_up_satellite(tool_input):
    query = _name(tool_input, "query")
    best = find_satellite(query)
    others = []
    if not query.isdigit() and popular_by_name(query) is None:
        others = [
            _identity(s)
            for s in Satellite.objects.current()
            .filter(name__icontains=query)
            .exclude(pk=best.pk)
            .rank_by_name(query)[: LOOKUP_RESULTS - 1]
        ]

    details = _identity(best)
    details["international_designator"] = best.international_designator
    element_set = best.element_sets.first()
    if element_set is None:
        details["orbit"] = None
    else:
        now = clock.utc_now()
        details["orbit"] = {
            "period_minutes": round(1440 / element_set.mean_motion, 1),
            "inclination_deg": round(element_set.inclination, 1),
            "element_set_age_hours": round(
                (now - element_set.epoch).total_seconds() / 3600, 1
            ),
        }
        try:
            position = compute_position(element_set, now)
            details["now"] = {
                "time_utc": now.isoformat(),
                "latitude": round(position.latitude, 1),
                "longitude": round(position.longitude, 1),
                "altitude_km": round(position.altitude_km),
                "speed_km_s": round(position.speed_km_s, 2),
            }
        except PropagationError:
            details["now"] = None
    return {"best_match": details, "other_matches": others}


# --- passes and weather -----------------------------------------------------


def _place(tool_input):
    try:
        return places.find_place(_name(tool_input, "place"))
    except places.PlaceError as error:
        raise ToolError(str(error)) from error


def get_passes(tool_input):
    satellite = find_satellite(_name(tool_input, "satellite"))
    days = _days(tool_input)
    place = _place(tool_input)
    element_set = satellite.element_sets.first()
    if element_set is None:
        raise ToolError(f"No orbital data for {satellite.name} yet.")

    start = clock.utc_now()
    try:
        found = find_passes(
            element_set, place["latitude"], place["longitude"], start, days
        )
    except PropagationError as error:
        raise ToolError(f"Can't compute passes for {satellite.name}.") from error

    tz = ZoneInfo(place["timezone"])
    passes = []
    for p in found:
        v = p.visibility
        if v.visible:
            passes.append(
                {
                    "visible": True,
                    "appears": _point(v.start, tz),
                    "highest": _point(v.highest, tz),
                    "disappears": _point(v.end, tz),
                    "visible_for_s": int((v.end.time - v.start.time).total_seconds()),
                }
            )
        else:
            passes.append(
                {
                    "visible": False,
                    "reason": v.reason,
                    "peak": local_time(p.peak.time, tz)["when"],
                    "max_elevation_deg": round(p.max_elevation_deg, 1),
                }
            )

    return {
        "satellite": _identity(satellite),
        "place": place,
        "searched_from": local_time(start, tz)["when"],
        "days": days,
        "min_elevation_deg": MIN_ELEVATION_DEG,
        "element_set_age_hours": round(
            (start - element_set.epoch).total_seconds() / 3600, 1
        ),
        "visible_pass_count": sum(1 for p in passes if p["visible"]),
        "reasons": {
            "daylight": "the sky is too bright while it passes",
            EARTH_SHADOW: "the sky is dark, but the satellite is in Earth's shadow",
        },
        "passes": passes,
    }


def get_cloud_forecast(tool_input):
    days = _days(tool_input)
    place = _place(tool_input)
    try:
        hours = places.hourly_cloud_cover(place["latitude"], place["longitude"])
    except places.PlaceError as error:
        raise ToolError(str(error)) from error

    tz = ZoneInfo(place["timezone"])
    now = clock.utc_now()
    by_day = {}
    for when, percent in hours:
        if (when - now).total_seconds() > days * 86400:
            break
        local = when.astimezone(tz)
        day = f"{local:%a %b} {local.day}"
        by_day.setdefault(day, {})[f"{local:%H}:00"] = percent
    return {
        "place": place,
        "time_zone": tz.key,
        "cloud_cover_percent": by_day,
        "scale": "good <= 25%, fair <= 50%, poor > 50%",
    }


HANDLERS = {
    "look_up_satellite": look_up_satellite,
    "get_passes": get_passes,
    "get_cloud_forecast": get_cloud_forecast,
}


def run_tool(name, tool_input):
    """Run one tool call from the model: (result, is_error). Never raises."""
    handler = HANDLERS.get(name)
    if handler is None:
        return {"error": f"Unknown tool {name!r}."}, True
    if not isinstance(tool_input, dict):
        return {"error": "Tool input must be an object."}, True
    try:
        return handler(tool_input), False
    except ToolError as error:
        return {"error": str(error)}, True
    except Exception as error:
        # Only the tool and the error's type: messages can hold a place name
        # or a URL with coordinates (location privacy).
        logger.error("Ask Phoebe tool %s failed: %s", name, type(error).__name__)
        return {"error": "That tool failed unexpectedly."}, True
