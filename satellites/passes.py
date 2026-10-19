"""When a satellite passes over a place: rise, peak and set.

A "pass" here starts when the satellite climbs above MIN_ELEVATION_DEG and
ends when it drops below it again. Whether you can actually see it (the
satellite in sunlight, the sky dark enough) is a separate check.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from skyfield.api import wgs84

from .positions import PropagationError, earth_satellite, timescale

# Below about 10 degrees, trees, buildings and haze usually hide the
# satellite, and the brief's visibility rule starts at 10 degrees too.
MIN_ELEVATION_DEG = 10.0

# Orbital data goes stale (drag, and the ISS's reboosts), so predictions far
# ahead get worse. Seven days answers "this week".
MAX_DAYS = 7

# skyfield's event codes from find_events().
_RISE, _PEAK, _SET = 0, 1, 2


@dataclass(frozen=True)
class PassPoint:
    time: datetime  # UTC, to the second
    azimuth_deg: float  # compass direction: 0 north, 90 east, 180 south, 270 west
    elevation_deg: float  # angle above the horizon


@dataclass(frozen=True)
class Pass:
    rise: PassPoint
    peak: PassPoint
    set: PassPoint

    @property
    def max_elevation_deg(self):
        return self.peak.elevation_deg

    @property
    def duration_s(self):
        return int((self.set.time - self.rise.time).total_seconds())


def _to_second(when):
    """A UTC datetime rounded to the nearest second."""
    return (when + timedelta(microseconds=500_000)).replace(microsecond=0)


def find_passes(element_set, latitude, longitude, start, days):
    """Every complete pass over (latitude, longitude) from `start` for `days`.

    `start` must be timezone-aware (a naive datetime raises ValueError).
    A pass already under way at `start`, or still under way at the end of
    the window, is left out, so every pass has a rise, a peak and a set.
    Raises PropagationError if SGP4 can't use the element set.
    """
    if start.tzinfo is None:
        raise ValueError("start must be timezone-aware")

    satellite = earth_satellite(element_set)
    t0 = timescale.from_datetime(start)
    t1 = timescale.from_datetime(start + timedelta(days=days))

    # Check the element set works before searching. On failure skyfield
    # returns NaN positions plus a message instead of raising.
    message = satellite.at(t0).message
    if message is not None:
        raise PropagationError(message)

    # Height above sea level doesn't matter at the 2-decimal precision we use.
    observer = wgs84.latlon(latitude, longitude)
    times, events = satellite.find_events(
        observer, t0, t1, altitude_degrees=MIN_ELEVATION_DEG
    )
    if len(events) == 0:
        return []

    # Direction and height at every event in one vectorized call:
    # satellite minus observer = where the satellite is, seen from the ground.
    elevation, azimuth, _ = (satellite - observer).at(times).altaz()
    points = [
        PassPoint(
            time=_to_second(t.utc_datetime()),
            azimuth_deg=float(az),
            elevation_deg=float(el),
        )
        for t, az, el in zip(times, azimuth.degrees, elevation.degrees)
    ]

    passes = []
    rise = peak = None
    for code, point in zip(events, points):
        if code == _RISE:
            rise, peak = point, None
        elif code == _PEAK:
            # A low pass can have two culminations (a small dip in between);
            # keep the higher one. Peaks before the first rise belong to a
            # pass that started before the window and are ignored.
            if rise is not None and (peak is None or point.elevation_deg > peak.elevation_deg):
                peak = point
        elif code == _SET:
            if rise is not None and peak is not None:
                passes.append(Pass(rise=rise, peak=peak, set=point))
            rise = peak = None
    # A rise with no set yet means the window ended mid-pass: dropped.
    return passes
