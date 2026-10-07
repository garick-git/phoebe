import pytest

from satellites.models import Satellite
from satellites.ingest import ingest_records
from satellites.tests.test_ingest import omm_record

pytestmark = pytest.mark.django_db


def satellite(norad, name, **overrides):
    """An OMM record for a satellite with the given NORAD ID and name."""
    return omm_record(NORAD_CAT_ID=norad, OBJECT_NAME=name, **overrides)


def test_detail_returns_satellite_with_latest_element_set(client):
    ingest_records(
        [satellite(25544, "ISS (ZARYA)", EPOCH="2026-10-06T12:00:00.000000")]
    )
    ingest_records(
        [satellite(25544, "ISS (ZARYA)", EPOCH="2026-10-07T12:00:00.000000")]
    )

    response = client.get("/api/satellites/25544/")

    assert response.status_code == 200
    data = response.json()
    assert data["norad_cat_id"] == 25544
    assert data["name"] == "ISS (ZARYA)"
    assert data["latest_element_set"]["epoch"].startswith("2026-10-07")


def test_detail_unknown_satellite_returns_404(client):
    assert client.get("/api/satellites/99999/").status_code == 404


def test_detail_non_numeric_id_returns_404(client):
    assert client.get("/api/satellites/abc/").status_code == 404


def test_search_ranks_best_matches_first(client):
    ingest_records(
        [
            satellite(69796, "ISS OBJECT YM"),
            satellite(49044, "ISS (NAUKA)"),
            satellite(25544, "ISS (ZARYA)"),
            satellite(37772, "ARISSAT-1"),  # contains "iss" but doesn't start with it
            satellite(20580, "HST"),  # no match
        ]
    )

    response = client.get("/api/satellites/", {"search": "iss"})

    names = [s["name"] for s in response.json()["results"]]
    assert names == ["ISS (ZARYA)", "ISS (NAUKA)", "ISS OBJECT YM", "ARISSAT-1"]


def test_list_is_paginated(client):
    ingest_records([satellite(100000 + i, f"TEST SAT {i}") for i in range(51)])

    data = client.get("/api/satellites/").json()

    assert data["count"] == 51
    assert len(data["results"]) == 50
    assert data["next"] is not None


def test_list_exposes_only_summary_fields(client):
    ingest_records([satellite(25544, "ISS (ZARYA)")])

    item = client.get("/api/satellites/").json()["results"][0]

    assert set(item) == {"norad_cat_id", "name", "international_designator"}


def test_api_is_read_only(client):
    ingest_records([satellite(25544, "ISS (ZARYA)")])

    assert client.post("/api/satellites/", {}).status_code == 405
    assert client.delete("/api/satellites/25544/").status_code == 405
    assert Satellite.objects.count() == 1  # nothing was deleted
