"""The list's 'current satellites' filter and the globe's elements endpoint."""

import pytest

from satellites.ingest import ingest_records
from satellites.models import Satellite
from satellites.tests.test_ingest import omm_record

pytestmark = pytest.mark.django_db

ELEMENTS_URL = "/api/satellites/elements/"


def satellite(norad, name, **overrides):
    return omm_record(NORAD_CAT_ID=norad, OBJECT_NAME=name, **overrides)


ISS = satellite(25544, "ISS (ZARYA)")
HST = satellite(20580, "HST")


def test_each_ingest_stamps_its_satellites_with_one_shared_time():
    ingest_records([ISS, HST])

    stamps = set(Satellite.objects.values_list("last_seen_at", flat=True))

    assert len(stamps) == 1
    assert None not in stamps


def test_a_satellite_missing_from_the_latest_feed_is_not_current():
    ingest_records([ISS, HST])
    ingest_records([ISS])  # HST dropped out of the active feed

    current = Satellite.objects.current()

    assert [s.norad_cat_id for s in current] == [25544]


def test_an_empty_database_has_no_current_satellites():
    assert Satellite.objects.current().count() == 0


def test_list_and_search_hide_satellites_that_left_the_feed(client):
    ingest_records([ISS, HST])
    ingest_records([ISS])

    listed = client.get("/api/satellites/").json()
    searched = client.get("/api/satellites/", {"search": "HST"}).json()

    assert [s["norad_cat_id"] for s in listed["results"]] == [25544]
    assert searched["count"] == 0


def test_detail_and_position_still_work_for_satellites_that_left_the_feed(client):
    ingest_records([ISS, HST])
    ingest_records([ISS])

    assert client.get("/api/satellites/20580/").status_code == 200
    assert client.get("/api/satellites/20580/position/").status_code == 200


def test_elements_returns_newest_element_set_per_current_satellite(client):
    ingest_records([ISS, HST])
    ingest_records(
        [
            satellite(25544, "ISS (ZARYA)", EPOCH="2026-10-07T12:00:00.000000"),
        ]
    )

    response = client.get(ELEMENTS_URL)

    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1  # HST left the feed
    iss = rows[0]
    assert set(iss) == {
        "norad_cat_id",
        "name",
        "epoch",
        "mean_motion",
        "eccentricity",
        "inclination",
        "ra_of_asc_node",
        "arg_of_pericenter",
        "mean_anomaly",
        "bstar",
        "mean_motion_dot",
        "mean_motion_ddot",
    }
    assert iss["norad_cat_id"] == 25544
    assert iss["name"] == "ISS (ZARYA)"
    assert iss["epoch"] == "2026-10-07T12:00:00Z"  # newest of the two


def test_elements_prefers_a_future_dated_epoch_when_it_is_newest(client):
    # Like XMM-Newton on Oct 15: the newest fit can be dated a few hours ahead.
    ingest_records([satellite(25989, "XMM-NEWTON", EPOCH="2026-10-15T08:00:00")])
    ingest_records([satellite(25989, "XMM-NEWTON", EPOCH="2099-01-01T00:35:25")])

    rows = client.get(ELEMENTS_URL).json()

    assert rows[0]["epoch"] == "2099-01-01T00:35:25Z"


def test_elements_keeps_full_precision(client):
    ingest_records([satellite(25544, "ISS (ZARYA)", BSTAR=0.000123456789012345)])

    row = client.get(ELEMENTS_URL).json()[0]

    assert row["bstar"] == 0.000123456789012345


def test_elements_is_one_unpaginated_list(client):
    ingest_records([satellite(100000 + i, f"TEST SAT {i}") for i in range(60)])

    rows = client.get(ELEMENTS_URL).json()

    assert isinstance(rows, list)
    assert len(rows) == 60  # more than one page of the list endpoint


def test_elements_can_be_cached_by_browsers_for_an_hour(client):
    ingest_records([ISS])

    response = client.get(ELEMENTS_URL)

    assert response.headers["Cache-Control"] == "public, max-age=3600"


def test_elements_is_read_only(client):
    assert client.post(ELEMENTS_URL, {}).status_code == 405
