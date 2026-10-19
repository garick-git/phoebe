from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from skyfield.api import wgs84

from satellites.passes import (
    COARSE_STEP_S,
    DAYLIGHT,
    EARTH_SHADOW,
    MAX_COARSE_SAMPLES,
    MIN_ELEVATION_DEG,
    Visibility,
    coarse_step_s,
    ephemeris,
    find_passes,
)
from satellites.positions import PropagationError, earth_satellite, timescale

from .test_positions import iss_element_set

AUSTIN = (30.27, -97.74)
# Sydney (southern hemisphere, east longitude): with the saved ISS record it
# has passes that come out of Earth's shadow, vanish into it, and stay in it.
SYDNEY = (-33.87, 151.21)
# 40 minutes after the saved ISS record's epoch, so the element set is fresh.
START = datetime(2026, 10, 6, 1, 0, 0, tzinfo=timezone.utc)


def brute_force_passes(element_set, latitude, longitude, start, seconds):
    """Passes found the slow, obvious way: the satellite's elevation every
    second, then where it crosses MIN_ELEVATION_DEG and where it is highest.

    Same SGP4 and observer as find_passes, but none of find_events' search
    logic, so it checks how we use find_events (event codes, grouping, the
    threshold, partial passes) rather than repeating its answer. To keep it
    fast, a once-a-minute scan first finds when the satellite is above the
    horizon at all; only those stretches (plus 2 minutes each side) are
    sampled every second.
    """
    satellite = earth_satellite(element_set)
    topocentric = satellite - wgs84.latlon(latitude, longitude)

    def elevation_at(offsets):
        t = timescale.utc(start.year, start.month, start.day, start.hour, start.minute, offsets)
        return topocentric.at(t).altaz()[0].degrees

    coarse = np.arange(0, seconds, 60)
    up = elevation_at(coarse) > 0
    # Start and end indexes of each run of "above the horizon" samples.
    edges = np.flatnonzero(np.diff(np.concatenate(([0], up.astype(int), [0]))))
    passes = []
    for first, last in zip(edges[::2], edges[1::2] - 1):
        lo = max(0, coarse[first] - 120)
        hi = min(seconds, coarse[last] + 120)
        offsets = np.arange(lo, hi)
        elevation = elevation_at(offsets)
        above = elevation >= MIN_ELEVATION_DEG
        rises = np.flatnonzero(~above[:-1] & above[1:]) + 1
        sets = np.flatnonzero(above[:-1] & ~above[1:])
        if len(rises) == 0 or len(sets) == 0 or sets[-1] < rises[0]:
            continue  # never reached 10 degrees, or cut off by the window
        rise, end = rises[0], sets[sets > rises[0]][0]
        peak = rise + int(np.argmax(elevation[rise : end + 1]))
        passes.append(
            {
                "rise": start + timedelta(seconds=int(offsets[rise])),
                "peak": start + timedelta(seconds=int(offsets[peak])),
                "set": start + timedelta(seconds=int(offsets[end])),
                "max_elevation_deg": float(elevation[peak]),
            }
        )
    return passes


def test_passes_match_a_brute_force_search():
    found = find_passes(iss_element_set(), *AUSTIN, START, days=2)
    expected = brute_force_passes(iss_element_set(), *AUSTIN, START, seconds=2 * 86400)

    assert len(found) == len(expected) >= 4
    for got, want in zip(found, expected):
        # 1 s sampling plus rounding to the second: within 2 s.
        assert abs((got.rise.time - want["rise"]).total_seconds()) <= 2
        assert abs((got.set.time - want["set"]).total_seconds()) <= 2
        # The top of a pass is flat, so its exact second is less sharp.
        assert abs((got.peak.time - want["peak"]).total_seconds()) <= 5
        assert got.max_elevation_deg == pytest.approx(want["max_elevation_deg"], abs=0.05)


def test_every_pass_is_ordered_and_starts_and_ends_at_the_threshold():
    passes = find_passes(iss_element_set(), *AUSTIN, START, days=7)

    # Low-orbit satellites pass over a mid-latitude city a few times a day.
    assert 10 <= len(passes) <= 40
    for p in passes:
        assert START <= p.rise.time < p.peak.time < p.set.time <= START + timedelta(days=7)
        assert p.rise.elevation_deg == pytest.approx(MIN_ELEVATION_DEG, abs=0.1)
        assert p.set.elevation_deg == pytest.approx(MIN_ELEVATION_DEG, abs=0.1)
        assert MIN_ELEVATION_DEG <= p.max_elevation_deg <= 90
        assert 0 < p.duration_s < 12 * 60  # an ISS pass lasts minutes, not more
        for point in (p.rise, p.peak, p.set):
            assert 0 <= point.azimuth_deg < 360
            assert point.time.tzinfo is not None and point.time.microsecond == 0


def test_a_pass_under_way_at_the_start_is_left_out():
    first, second = find_passes(iss_element_set(), *AUSTIN, START, days=1)[:2]
    # 30 s after it rose: the window still holds that pass's peak and set,
    # but not its rise, so it must not come back as a pass.
    just_after_rise = first.rise.time + timedelta(seconds=30)

    passes = find_passes(iss_element_set(), *AUSTIN, just_after_rise, days=1)

    assert passes[0].rise.time >= just_after_rise
    assert abs((passes[0].rise.time - second.rise.time).total_seconds()) <= 1


def test_a_pass_still_under_way_at_the_end_is_left_out():
    first, second = find_passes(iss_element_set(), *AUSTIN, START, days=1)[:2]
    mid_second = second.rise.time + timedelta(seconds=second.duration_s // 2)
    days = (mid_second - START).total_seconds() / 86400

    passes = find_passes(iss_element_set(), *AUSTIN, START, days=days)

    assert len(passes) == 1
    assert passes[0].rise.time == first.rise.time


def test_a_geostationary_satellite_never_rises_or_sets():
    # About one orbit per sidereal day, nearly circular, nearly equatorial:
    # it hangs over one spot, so from Austin it never crosses 10 degrees.
    geostationary = iss_element_set(
        mean_motion=1.00271,
        eccentricity=0.0002,
        inclination=0.05,
        bstar=0.0,
        mean_motion_dot=0.0,
    )
    assert find_passes(geostationary, *AUSTIN, START, days=7) == []


def test_naive_start_is_rejected():
    with pytest.raises(ValueError):
        find_passes(iss_element_set(), *AUSTIN, START.replace(tzinfo=None), days=1)


def test_unusable_element_set_raises_propagation_error():
    with pytest.raises(PropagationError, match="eccentricity"):
        find_passes(iss_element_set(eccentricity=1.5), *AUSTIN, START, days=1)


# --- Visibility -------------------------------------------------------------


def brute_force_visibility(element_set, latitude, longitude, a_pass):
    """Whether, and when, a pass is visible, checked every second of it.

    Uses the brief's rule written out here (sunlit, Sun below -6 degrees),
    not find_passes' constants or its coarse-then-fine sampling, so it checks
    the sampling and the window logic. Whether skyfield's shadow and Sun
    positions are right is what the Heavens-Above cross-check is for.
    Returns (first visible second, last second of that stretch), counted from
    the rise, or None.
    """
    satellite = earth_satellite(element_set)
    here = ephemeris["earth"] + wgs84.latlon(latitude, longitude)
    rise = timescale.from_datetime(a_pass.rise.time)
    seconds = np.arange(0, a_pass.duration_s + 1)
    t = timescale.tt_jd(rise.tt + seconds / 86400)
    sunlit = satellite.at(t).is_sunlit(ephemeris)
    sun_altitude = here.at(t).observe(ephemeris["sun"]).apparent().altaz()[0].degrees
    visible = sunlit & (sun_altitude < -6)
    if not visible.any():
        return None
    first = int(np.argmax(visible))
    last = first
    while last + 1 < len(visible) and visible[last + 1]:
        last += 1
    return first, last


@pytest.mark.parametrize("place, days", [(AUSTIN, 7), (SYDNEY, 2)])
def test_visibility_matches_a_brute_force_check(place, days):
    passes = find_passes(iss_element_set(), *place, START, days=days)

    visible = 0
    for p in passes:
        expected = brute_force_visibility(iss_element_set(), *place, p)
        assert p.visibility.visible == (expected is not None)
        if expected is None:
            continue
        visible += 1
        first, last = expected
        start_s = (p.visibility.start.time - p.rise.time).total_seconds()
        end_s = (p.visibility.end.time - p.rise.time).total_seconds()
        # 1 s sampling plus rounding to the second: within 2 s.
        assert abs(start_s - first) <= 2
        assert abs(end_s - last) <= 2
    assert visible >= 2  # the check actually covered visible passes


def test_visible_window_lies_inside_its_pass():
    passes = find_passes(iss_element_set(), *SYDNEY, START, days=2)

    assert any(p.visibility.visible for p in passes)
    for p in passes:
        v = p.visibility
        if not v.visible:
            assert v.reason in (DAYLIGHT, EARTH_SHADOW)
            assert v.start is v.highest is v.end is None
            continue
        assert v.reason is None
        assert p.rise.time <= v.start.time <= v.highest.time <= v.end.time <= p.set.time
        assert v.start.elevation_deg >= MIN_ELEVATION_DEG - 0.1
        assert v.end.elevation_deg >= MIN_ELEVATION_DEG - 0.1
        assert v.highest.elevation_deg >= max(v.start.elevation_deg, v.end.elevation_deg)
        assert v.highest.elevation_deg <= p.max_elevation_deg
        if v.start.time <= p.peak.time <= v.end.time:
            assert v.highest == p.peak


def test_a_pass_can_appear_partway_as_it_leaves_earths_shadow():
    # 2026-10-06 17:06 UTC (4:06 am in Sydney): it rises in shadow, peaks at
    # 27 degrees still in shadow, and appears just after the peak.
    p = find_passes(iss_element_set(), *SYDNEY, START, days=2)[2]

    assert p.visibility.visible
    assert p.visibility.start.time > p.peak.time > p.rise.time
    assert p.visibility.start.elevation_deg > 20
    # Past the peak, the highest point you can see is where it appears.
    assert p.visibility.highest == p.visibility.start
    assert p.visibility.end == p.set


def test_a_pass_can_vanish_into_earths_shadow_before_it_sets():
    # 2026-10-07 09:46 UTC (8:46 pm in Sydney): visible from its rise, then it
    # fades into Earth's shadow on the way up, before its 73-degree peak.
    p = find_passes(iss_element_set(), *SYDNEY, START, days=2)[4]

    assert p.visibility.visible
    assert p.visibility.start == p.rise
    assert p.visibility.end.time < p.peak.time
    assert p.visibility.end.elevation_deg > 20
    assert p.visibility.highest == p.visibility.end


def test_a_pass_can_end_when_the_sky_gets_too_bright():
    # Sun 2026-10-11, 7:04 am in Austin: visible from its rise until dawn
    # brightens the sky (Sun at -6 degrees), while it is still sunlit and up.
    p = find_passes(iss_element_set(), *AUSTIN, START, days=7)[17]

    assert p.visibility.visible
    assert p.visibility.start == p.rise
    assert p.rise.time < p.visibility.end.time < p.set.time
    assert p.visibility.end.elevation_deg > 20


def test_a_high_pass_in_a_dark_sky_can_still_be_in_earths_shadow():
    # 2026-10-06 10:33 UTC (9:33 pm in Sydney): 58 degrees high, dark sky,
    # but the satellite is in Earth's shadow the whole time.
    p = find_passes(iss_element_set(), *SYDNEY, START, days=2)[1]

    assert p.max_elevation_deg > 50
    assert p.visibility == Visibility(visible=False, reason=EARTH_SHADOW)


def test_daytime_passes_are_not_visible_because_of_daylight():
    passes = find_passes(iss_element_set(), *AUSTIN, START, days=2)

    assert passes
    assert all(p.visibility.reason == DAYLIGHT for p in passes)


def test_long_passes_get_a_coarser_step_not_more_work():
    # A week of ISS passes (2-4 hours above 10 degrees) uses the normal step.
    assert coarse_step_s(4 * 3600) == COARSE_STEP_S
    assert coarse_step_s(COARSE_STEP_S * MAX_COARSE_SAMPLES) == COARSE_STEP_S
    # A high, elliptical orbit can be up for 110 hours a week: the step grows
    # so the number of samples stays at the cap.
    step = coarse_step_s(110 * 3600)
    assert step > COARSE_STEP_S
    assert 110 * 3600 / step <= MAX_COARSE_SAMPLES
