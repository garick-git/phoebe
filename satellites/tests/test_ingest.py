from datetime import datetime, timezone

import pytest

from satellites.ingest import ingest_records, parse_epoch
from satellites.models import OrbitalElementSet, Satellite

pytestmark = pytest.mark.django_db


def omm_record(**overrides):
    """A CelesTrak-style OMM record with plausible sample values (not real data).
    Pass keyword arguments to change any field."""
    record = {
        "OBJECT_NAME": "ISS (ZARYA)",
        "OBJECT_ID": "1998-067A",
        "NORAD_CAT_ID": 25544,
        "EPOCH": "2026-10-06T12:00:00.000000",
        "MEAN_MOTION": 15.5,
        "ECCENTRICITY": 0.0004,
        "INCLINATION": 51.64,
        "RA_OF_ASC_NODE": 100.0,
        "ARG_OF_PERICENTER": 50.0,
        "MEAN_ANOMALY": 300.0,
        "BSTAR": 0.0002,
        "MEAN_MOTION_DOT": 0.0001,
        "MEAN_MOTION_DDOT": 0,
        "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 50000,
        "EPHEMERIS_TYPE": 0,
        "CLASSIFICATION_TYPE": "U",
    }
    record.update(overrides)
    return record


def hubble_record(**overrides):
    return omm_record(
        OBJECT_NAME="HST", OBJECT_ID="1990-037B", NORAD_CAT_ID=20580, **overrides
    )


def test_parse_epoch_returns_utc():
    result = parse_epoch("2026-10-06T12:34:56.123456")
    assert result == datetime(2026, 10, 6, 12, 34, 56, 123456, tzinfo=timezone.utc)


def test_first_ingest_creates_satellites_and_element_sets():
    result = ingest_records([omm_record(), hubble_record()])

    assert result == {"satellites": 2, "element_sets_added": 2}
    iss = Satellite.objects.get(norad_cat_id=25544)
    assert iss.name == "ISS (ZARYA)"
    assert iss.international_designator == "1998-067A"
    element_set = iss.element_sets.get()
    assert element_set.inclination == 51.64
    assert element_set.epoch == parse_epoch("2026-10-06T12:00:00.000000")


def test_ingesting_same_data_twice_adds_nothing():
    ingest_records([omm_record(), hubble_record()])
    result = ingest_records([omm_record(), hubble_record()])

    assert result["element_sets_added"] == 0
    assert Satellite.objects.count() == 2
    assert OrbitalElementSet.objects.count() == 2


def test_newer_epoch_adds_history_instead_of_overwriting():
    ingest_records([omm_record(EPOCH="2026-10-06T12:00:00.000000")])
    result = ingest_records([omm_record(EPOCH="2026-10-07T12:00:00.000000")])

    assert result["element_sets_added"] == 1
    iss = Satellite.objects.get(norad_cat_id=25544)
    epochs = [es.epoch.day for es in iss.element_sets.all()]
    assert epochs == [7, 6]  # newest first, and the old one is still there


def test_renamed_satellite_is_updated_not_duplicated():
    ingest_records([omm_record(OBJECT_NAME="ISS (ZARYA)")])
    ingest_records([omm_record(OBJECT_NAME="ISS")])

    assert Satellite.objects.count() == 1
    assert Satellite.objects.get(norad_cat_id=25544).name == "ISS"


def test_duplicate_records_in_one_feed_are_handled():
    result = ingest_records([omm_record(), omm_record()])

    assert result == {"satellites": 1, "element_sets_added": 1}
