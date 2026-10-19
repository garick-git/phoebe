from datetime import datetime, timezone

import pytest
from rest_framework.throttling import AnonRateThrottle, ScopedRateThrottle

from satellites.ingest import ingest_records
from satellites.models import Satellite
from satellites.passes import find_passes
from satellites.tests.test_api import satellite
from satellites.tests.test_positions import ISS_RECORD

pytestmark = pytest.mark.django_db

# 40 minutes after the saved ISS record's epoch.
NOW = datetime(2026, 10, 6, 1, 0, 0, tzinfo=timezone.utc)
AUSTIN = "lat=30.27&lon=-97.74"


@pytest.fixture
def fixed_now(monkeypatch):
    """Freeze the time the endpoint starts searching from."""
    monkeypatch.setattr("satellites.views.utc_now", lambda: NOW)


@pytest.fixture
def iss():
    ingest_records([ISS_RECORD])
    return Satellite.objects.get(norad_cat_id=25544).element_sets.first()


def passes_url(query, norad=25544):
    return f"/api/satellites/{norad}/passes/?{query}"


def test_returns_the_weeks_passes(client, fixed_now, iss):
    response = client.get(passes_url(AUSTIN))

    assert response.status_code == 200
    data = response.json()
    assert set(data) == {
        "norad_cat_id",
        "name",
        "location",
        "start",
        "end",
        "days",
        "min_elevation_deg",
        "element_set_epoch",
        "element_set_age_hours",
        "passes",
    }
    assert data["norad_cat_id"] == 25544
    assert data["name"] == "ISS (ZARYA)"
    assert data["location"] == {"latitude": 30.27, "longitude": -97.74}
    assert data["start"] == "2026-10-06T01:00:00Z"
    assert data["end"] == "2026-10-13T01:00:00Z"  # 7 days by default
    assert data["days"] == 7
    assert data["min_elevation_deg"] == 10.0
    assert data["element_set_age_hours"] == 0.7

    # Same passes as calling the function directly (the function's own
    # tests check the passes themselves).
    expected = find_passes(iss, 30.27, -97.74, NOW, 7)
    assert len(data["passes"]) == len(expected) > 0
    first, want = data["passes"][0], expected[0]
    assert set(first) == {"rise", "peak", "set", "max_elevation_deg", "duration_s", "visibility"}
    assert set(first["rise"]) == {"time", "azimuth_deg", "elevation_deg"}
    assert first["rise"]["time"] == want.rise.time.isoformat().replace("+00:00", "Z")
    assert first["peak"]["azimuth_deg"] == round(want.peak.azimuth_deg, 1)
    assert first["max_elevation_deg"] == round(want.max_elevation_deg, 1)
    assert first["duration_s"] == want.duration_s


def test_every_pass_says_whether_it_is_visible(client, fixed_now, iss):
    data = client.get(passes_url(AUSTIN)).json()
    expected = find_passes(iss, 30.27, -97.74, NOW, 7)

    def as_json(point):
        return {
            "time": point.time.isoformat().replace("+00:00", "Z"),
            "azimuth_deg": round(point.azimuth_deg, 1),
            "elevation_deg": round(point.elevation_deg, 1),
        }

    shown = [p["visibility"] for p in data["passes"]]
    assert [v["visible"] for v in shown] == [p.visibility.visible for p in expected]
    # The saved ISS week over Austin has both kinds.
    hidden = shown[[p.visibility.visible for p in expected].index(False)]
    assert hidden == {"visible": False, "reason": "daylight", "start": None, "highest": None, "end": None}
    index = [p.visibility.visible for p in expected].index(True)
    seen, want = shown[index], expected[index].visibility
    assert seen == {
        "visible": True,
        "reason": None,
        "start": as_json(want.start),
        "highest": as_json(want.highest),
        "end": as_json(want.end),
    }


def test_days_limits_the_window(client, fixed_now, iss):
    week = client.get(passes_url(AUSTIN)).json()
    one_day = client.get(passes_url(AUSTIN + "&days=1")).json()

    assert one_day["end"] == "2026-10-07T01:00:00Z"
    assert 0 < len(one_day["passes"]) < len(week["passes"])
    # The same passes, but not byte for byte: find_events' search grid depends
    # on the window's length, so times can differ by a fraction of a second
    # (enough to flip a rounded second or a tenth of a degree).
    for short, long in zip(one_day["passes"], week["passes"]):
        for point in ("rise", "peak", "set"):
            gap = datetime.fromisoformat(short[point]["time"]) - datetime.fromisoformat(long[point]["time"])
            assert abs(gap.total_seconds()) <= 1


def test_precise_coordinates_are_rounded_before_use(client, fixed_now, iss):
    precise = client.get(passes_url("lat=30.267153&lon=-97.743061")).json()
    rounded = client.get(passes_url(AUSTIN)).json()

    assert precise["location"] == {"latitude": 30.27, "longitude": -97.74}
    assert precise["passes"] == rounded["passes"]


def test_tiny_negative_coordinates_round_to_plain_zero(client, fixed_now, iss):
    response = client.get(passes_url("lat=-0.001&lon=-0.004"))

    assert response.json()["location"] == {"latitude": 0.0, "longitude": 0.0}
    assert b"-0.0" not in response.content


@pytest.mark.parametrize("query", ["lat=90&lon=180", "lat=-90&lon=-180", AUSTIN + "&days=1"])
def test_limits_themselves_are_allowed(client, fixed_now, iss, query):
    assert client.get(passes_url(query)).status_code == 200


@pytest.mark.parametrize(
    "query, field",
    [
        ("lon=-97.74", "lat"),  # missing
        ("lat=30.27", "lon"),  # missing
        ("lat=90.01&lon=0", "lat"),
        ("lat=-91&lon=0", "lat"),
        ("lat=0&lon=180.5", "lon"),
        ("lat=0&lon=-181", "lon"),
        ("lat=nan&lon=0", "lat"),  # Python's float() accepts these three
        ("lat=0&lon=inf", "lon"),
        ("lat=0&lon=-inf", "lon"),
        ("lat=1e400&lon=0", "lat"),  # too big for a float
        ("lat=north&lon=0", "lat"),
        ("lat=&lon=0", "lat"),
        (AUSTIN + "&days=0", "days"),
        (AUSTIN + "&days=8", "days"),
        (AUSTIN + "&days=2.5", "days"),
        (AUSTIN + "&days=week", "days"),
    ],
)
def test_bad_input_returns_400_naming_the_field(client, fixed_now, iss, query, field):
    response = client.get(passes_url(query))

    assert response.status_code == 400
    assert field in response.json()


def test_unknown_satellite_returns_404(client, fixed_now):
    assert client.get(passes_url(AUSTIN, norad=99999)).status_code == 404


def test_satellite_without_orbital_data_returns_404(client, fixed_now):
    Satellite.objects.create(norad_cat_id=25544, name="ISS (ZARYA)")

    response = client.get(passes_url(AUSTIN))

    assert response.status_code == 404
    assert "No orbital data" in response.json()["detail"]


def test_unusable_orbital_data_returns_422(client, fixed_now):
    ingest_records([satellite(25544, "ISS (ZARYA)", ECCENTRICITY=1.5)])

    response = client.get(passes_url(AUSTIN))

    assert response.status_code == 422
    # The response stays generic; the technical reason only goes in the log.
    assert "eccentricity" not in response.json()["detail"]


def test_passes_are_read_only(client, iss):
    assert client.post(passes_url(AUSTIN), {}).status_code == 405


def test_passes_limit_is_configured_at_20_a_minute(settings):
    assert settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["passes"] == "20/min"


def test_passes_have_their_own_stricter_limit(monkeypatch, client, fixed_now, iss):
    monkeypatch.setitem(ScopedRateThrottle.THROTTLE_RATES, "passes", "2/min")

    for _ in range(2):
        assert client.get(passes_url(AUSTIN)).status_code == 200
    blocked = client.get(passes_url(AUSTIN))

    assert blocked.status_code == 429
    assert "Retry-After" in blocked.headers
    # Only the passes endpoint is limited this tightly.
    assert client.get("/api/satellites/25544/position/").status_code == 200


def test_passes_also_count_toward_the_general_limit(monkeypatch, client, fixed_now, iss):
    monkeypatch.setitem(AnonRateThrottle.THROTTLE_RATES, "anon", "2/min")

    for _ in range(2):
        assert client.get(passes_url(AUSTIN)).status_code == 200

    assert client.get("/api/satellites/").status_code == 429
