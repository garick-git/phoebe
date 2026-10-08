from datetime import datetime, timedelta, timezone

import pytest

from satellites.ingest import element_set_fields
from satellites.models import OrbitalElementSet, Satellite
from satellites.positions import PropagationError, compute_position

# A real ISS record from CelesTrak (epoch 2026-10-06), saved here so these
# tests need neither the network nor the database.
ISS_RECORD = {
    "OBJECT_NAME": "ISS (ZARYA)",
    "OBJECT_ID": "1998-067A",
    "EPOCH": "2026-10-06T00:20:47.860512",
    "MEAN_MOTION": 15.48747543,
    "ECCENTRICITY": 0.00068585,
    "INCLINATION": 51.6314,
    "RA_OF_ASC_NODE": 111.6262,
    "ARG_OF_PERICENTER": 227.8987,
    "MEAN_ANOMALY": 132.1419,
    "EPHEMERIS_TYPE": 0,
    "CLASSIFICATION_TYPE": "U",
    "NORAD_CAT_ID": 25544,
    "ELEMENT_SET_NO": 999,
    "REV_AT_EPOCH": 58893,
    "BSTAR": 0.00010208237,
    "MEAN_MOTION_DOT": 5.131e-05,
    "MEAN_MOTION_DDOT": 0,
}

NOON_ISH = datetime(2026, 10, 8, 20, 0, 0, tzinfo=timezone.utc)


def iss_element_set(**overrides):
    """An unsaved OrbitalElementSet for the ISS (no database needed)."""
    satellite = Satellite(
        norad_cat_id=ISS_RECORD["NORAD_CAT_ID"],
        name=ISS_RECORD["OBJECT_NAME"],
        international_designator=ISS_RECORD["OBJECT_ID"],
    )
    fields = element_set_fields(ISS_RECORD) | overrides
    return OrbitalElementSet(satellite=satellite, **fields)


def test_iss_position_matches_independent_calculation():
    # Expected values come from a separate calculation that doesn't use
    # skyfield's frame code (raw sgp4, then a hand-written Earth rotation
    # and WGS84 conversion), so this checks skyfield's wiring rather than
    # repeating its own output.
    position = compute_position(iss_element_set(), NOON_ISH)

    assert position.latitude == pytest.approx(-46.508, abs=0.01)
    assert position.longitude == pytest.approx(16.300, abs=0.01)
    assert position.altitude_km == pytest.approx(431.37, abs=0.5)
    assert position.speed_km_s == pytest.approx(7.655, abs=0.01)


def test_same_moment_in_another_timezone_gives_same_position():
    central = timezone(timedelta(hours=-5))
    same_moment = datetime(2026, 10, 8, 15, 0, 0, tzinfo=central)

    assert compute_position(iss_element_set(), same_moment) == compute_position(
        iss_element_set(), NOON_ISH
    )


def test_iss_stays_within_physical_limits_over_a_day():
    element_set = iss_element_set()
    start = datetime(2026, 10, 8, 0, 0, 0, tzinfo=timezone.utc)

    for minutes in range(0, 24 * 60, 30):
        p = compute_position(element_set, start + timedelta(minutes=minutes))
        # Latitude can't exceed the orbit's inclination (51.63 degrees);
        # the small allowance is because the Earth is slightly flattened.
        assert abs(p.latitude) <= 51.63 + 0.25
        assert -180 <= p.longitude <= 180
        assert 400 <= p.altitude_km <= 440
        assert 7.5 <= p.speed_km_s <= 7.8


def test_naive_datetime_is_rejected():
    with pytest.raises(ValueError):
        compute_position(iss_element_set(), datetime(2026, 10, 8, 20, 0, 0))


def test_unusable_element_set_raises_propagation_error():
    # An eccentricity of 1.5 isn't an ellipse, so SGP4 can't propagate it.
    with pytest.raises(PropagationError, match="eccentricity"):
        compute_position(iss_element_set(eccentricity=1.5), NOON_ISH)
