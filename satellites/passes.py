"""When a satellite passes over a place, and whether you can actually see it.

A "pass" starts when the satellite climbs above MIN_ELEVATION_DEG and ends
when it drops below it again. It is *visible* while it is above that height,
lit by the Sun, and the observer's sky is dark enough (the Sun more than 6
degrees below the horizon). The check covers the whole pass, not just its
peak: satellites often appear partway through a pass as they leave Earth's
shadow, or vanish into it before they set.
"""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from skyfield.api import load_file, wgs84

from .positions import PropagationError, earth_satellite, timescale

# Below about 10 degrees, trees, buildings and haze usually hide the
# satellite, and the brief's visibility rule starts at 10 degrees too.
MIN_ELEVATION_DEG = 10.0

# Orbital data goes stale (drag, and the ISS's reboosts), so predictions far
# ahead get worse. Seven days answers "this week".
MAX_DAYS = 7

# The sky counts as dark once the Sun is more than 6 degrees below the
# horizon (the end of civil twilight). Before that, the sky is too bright to
# pick out a satellite.
SUN_MAX_ALTITUDE_DEG = -6.0

# Where the Sun and Earth are: a 2026-2031 excerpt of NASA JPL's DE421
# ephemeris (551 KB, cut from the full 17 MB file with
# `python -m jplephem excerpt`), committed with the code so nothing is ever
# downloaded at build or request time; load_file() only reads the file.
# It keeps every body, because apparent() needs Jupiter and Saturn too.
# test_ephemeris.py fails a year before the excerpt runs out.
EPHEMERIS_PATH = Path(__file__).resolve().parent / "ephemeris" / "de421_2026-2031.bsp"
ephemeris = load_file(EPHEMERIS_PATH)
_sun = ephemeris["sun"]
_earth = ephemeris["earth"]


def _read_ephemeris_segments():
    """Do the same Sun calculation find_passes() does, once, at import.

    jplephem reads each segment's header with seek() + read() on one shared
    file the first time the segment is used (afterwards it's memory-mapped,
    which is safe to share). Gunicorn runs several threads per worker
    (gunicorn.conf.py), so doing that first read here, while Python's import
    lock lets only one thread run this module, means no two requests can ever
    interleave those reads. It also takes that work off the first request.
    """
    t = timescale.utc(2027, 1, 1)  # any moment inside the 2026-2031 excerpt
    here = _earth + wgs84.latlon(0, 0)
    here.at(t).observe(_sun).apparent()


_read_ephemeris_segments()

# Visibility is checked on a grid: every COARSE_STEP_S seconds through each
# pass (all passes in one vectorized call), then FINE_SAMPLES_PER_GAP times
# more often inside each gap where the answer changes, so start and end are
# found to the second. A visible stretch shorter than the coarse step can be
# missed; that is too brief to spot anyway.
COARSE_STEP_S = 10
FINE_SAMPLES_PER_GAP = 10
# Cap on coarse samples per search. A week of ISS passes needs about
# 800-1,400. A satellite that stays above the horizon for days (a high,
# elliptical orbit) would need tens of thousands, so its step grows instead
# of the work (brief 6b: no request can trigger a huge computation).
MAX_COARSE_SAMPLES = 3000

# Why a pass isn't visible.
DAYLIGHT = "daylight"  # the sky is never dark enough while it's up
EARTH_SHADOW = "earth_shadow"  # the sky is dark, but the satellite isn't sunlit then

# skyfield's event codes from find_events().
_RISE, _PEAK, _SET = 0, 1, 2

_SECONDS_PER_DAY = 86400


@dataclass(frozen=True)
class PassPoint:
    time: datetime  # UTC, to the second
    azimuth_deg: float  # compass direction: 0 north, 90 east, 180 south, 270 west
    elevation_deg: float  # angle above the horizon


@dataclass(frozen=True)
class Visibility:
    visible: bool
    reason: str | None = None  # DAYLIGHT or EARTH_SHADOW when not visible
    start: PassPoint | None = None  # when it appears (its rise, or later)
    highest: PassPoint | None = None  # highest point while visible
    end: PassPoint | None = None  # when it disappears (its set, or earlier)


@dataclass(frozen=True)
class Pass:
    rise: PassPoint
    peak: PassPoint
    set: PassPoint
    visibility: Visibility

    @property
    def max_elevation_deg(self):
        return self.peak.elevation_deg

    @property
    def duration_s(self):
        return int((self.set.time - self.rise.time).total_seconds())


def _to_second(when):
    """A UTC datetime rounded to the nearest second."""
    return (when + timedelta(microseconds=500_000)).replace(microsecond=0)


def _points(topocentric, t):
    """PassPoints for every time in `t`, from one vectorized call."""
    elevation, azimuth, _ = topocentric.at(t).altaz()
    return [
        PassPoint(
            time=_to_second(when),
            azimuth_deg=float(az),
            elevation_deg=float(el),
        )
        for when, az, el in zip(t.utc_datetime(), azimuth.degrees, elevation.degrees)
    ]


def find_passes(element_set, latitude, longitude, start, days):
    """Every complete pass over (latitude, longitude) from `start` for `days`,
    each with its visibility.

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
    topocentric = satellite - observer
    points = _points(topocentric, times)

    # Group the events into complete passes: (rise, peak, set) indexes.
    groups = []
    rise = peak = None
    for i, code in enumerate(events):
        if code == _RISE:
            rise, peak = i, None
        elif code == _PEAK:
            # A low pass can have two culminations (a small dip in between);
            # keep the higher one. Peaks before the first rise belong to a
            # pass that started before the window and are ignored.
            if rise is not None and (
                peak is None or points[i].elevation_deg > points[peak].elevation_deg
            ):
                peak = i
        elif code == _SET:
            if rise is not None and peak is not None:
                groups.append((rise, peak, i))
            rise = peak = None
    # A rise with no set yet means the window ended mid-pass: dropped.
    if not groups:
        return []

    visibilities = _visibility(satellite, observer, topocentric, times.tt, groups, points)
    return [
        Pass(rise=points[r], peak=points[p], set=points[s], visibility=v)
        for (r, p, s), v in zip(groups, visibilities)
    ]


def coarse_step_s(total_pass_seconds):
    """Seconds between coarse samples: COARSE_STEP_S, or longer when the
    passes add up to more than MAX_COARSE_SAMPLES samples."""
    return max(COARSE_STEP_S, math.ceil(total_pass_seconds / MAX_COARSE_SAMPLES))


def _sunlit_and_dark(satellite, here, tt):
    """For each time (TT Julian dates): is the satellite in sunlight, and is
    the observer's sky dark? Both use the same Time object, so skyfield works
    out Earth's orientation once per time."""
    t = timescale.tt_jd(tt)
    sunlit = satellite.at(t).is_sunlit(ephemeris)
    sun_altitude = here.at(t).observe(_sun).apparent().altaz()[0].degrees
    return sunlit, sun_altitude < SUN_MAX_ALTITUDE_DEG


def _visibility(satellite, observer, topocentric, event_tt, groups, points):
    """One Visibility per pass (see the module docstring for the rule)."""
    here = _earth + observer
    spans = [(event_tt[r], event_tt[s]) for r, _, s in groups]
    total_seconds = sum((s - r) * _SECONDS_PER_DAY for r, s in spans)
    step_days = coarse_step_s(total_seconds) / _SECONDS_PER_DAY

    # Coarse stage: the rise, every step, and the set, for every pass at once.
    grids = [np.append(np.arange(r, s, step_days), s) for r, s in spans]
    owner = np.concatenate([np.full(len(g), k) for k, g in enumerate(grids)])
    tt = np.concatenate(grids)
    sunlit, dark = _sunlit_and_dark(satellite, here, tt)

    # Fine stage: inside every gap (within one pass) where the answer
    # changes, sample FINE_SAMPLES_PER_GAP times more often.
    ok = sunlit & dark
    changes = np.flatnonzero((ok[:-1] != ok[1:]) & (owner[:-1] == owner[1:]))
    if len(changes):
        fine_tt = np.concatenate(
            [np.linspace(tt[i], tt[i + 1], FINE_SAMPLES_PER_GAP + 1)[1:-1] for i in changes]
        )
        fine_owner = np.repeat(owner[changes], FINE_SAMPLES_PER_GAP - 1)
        fine_sunlit, fine_dark = _sunlit_and_dark(satellite, here, fine_tt)
        tt = np.concatenate([tt, fine_tt])
        owner = np.concatenate([owner, fine_owner])
        sunlit = np.concatenate([sunlit, fine_sunlit])
        dark = np.concatenate([dark, fine_dark])

    # Per pass: the first unbroken visible stretch, in time order. A low-orbit
    # pass has at most one; a long pass (hours, a high orbit) could have two,
    # and only the first is reported.
    windows = []  # (start_tt, end_tt) or the reason it isn't visible
    for k in range(len(groups)):
        mine = np.flatnonzero(owner == k)
        mine = mine[np.argsort(tt[mine])]
        seen = sunlit[mine] & dark[mine]
        if not seen.any():
            windows.append(EARTH_SHADOW if dark[mine].any() else DAYLIGHT)
            continue
        first = int(np.argmax(seen))
        hidden_after = np.flatnonzero(~seen[first:])
        last = first + int(hidden_after[0]) - 1 if len(hidden_after) else len(seen) - 1
        windows.append((tt[mine[first]], tt[mine[last]]))

    # Directions and heights for every start and end, in one vectorized call.
    visible_tt = [edge for w in windows if isinstance(w, tuple) for edge in w]
    edge_points = iter(_points(topocentric, timescale.tt_jd(visible_tt)) if visible_tt else [])

    results = []
    for (_, p, _), window in zip(groups, windows):
        if not isinstance(window, tuple):
            results.append(Visibility(visible=False, reason=window))
            continue
        start, end = next(edge_points), next(edge_points)
        start_tt, end_tt = window
        # Elevation climbs to the peak, then falls, so if the peak is outside
        # the visible stretch, its highest point is the edge nearest the peak.
        if event_tt[p] < start_tt:
            highest = start
        elif event_tt[p] > end_tt:
            highest = end
        else:
            highest = points[p]
        results.append(Visibility(visible=True, start=start, highest=highest, end=end))
    return results
