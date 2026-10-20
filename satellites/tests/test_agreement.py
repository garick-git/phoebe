"""Python half of the Python vs JavaScript position agreement test.

SGP4 runs in two places (brief, section 4): skyfield on the server
(compute_position, used for passes) and satellite.js in the browser (the
globe). This file owns the reference answers: it computes positions with
compute_position() for five real element sets and keeps them in a committed
fixture. The JavaScript half (frontend/src/lib/orbits.agreement.test.ts)
feeds the same element sets, in the same shape the elements endpoint sends,
through positionsAt() and packedPositionsAt() and checks it lands within
100 m on the ground, 10 m in altitude and 1 m/s in speed.

This test fails when the Python answers change (a skyfield or sgp4 upgrade,
an edit to positions.py, a change to the endpoint's fields), so the fixture
can never go stale without someone noticing. If the change is intended,
regenerate the fixture, then run Vitest to see whether the browser still
agrees:

    docker compose exec -e UPDATE_AGREEMENT_FIXTURE=1 web pytest satellites/tests/test_agreement.py

No network and no database: the element sets are written out below, and
unsaved model instances are enough for compute_position().
"""

import json
import os
from datetime import timedelta
from pathlib import Path

import pytest
from rest_framework.utils.encoders import JSONEncoder

from satellites.ingest import element_set_fields
from satellites.models import OrbitalElementSet, Satellite
from satellites.positions import compute_position
from satellites.views import GLOBE_ELEMENT_FIELDS

FIXTURE = Path(__file__).parent / "fixtures" / "position_agreement.json"

# Real CelesTrak records from the Oct 6 download (data/active.json), the same
# five orbit types as the Oct 15 one-off check: low (ISS, HST, a Starlink),
# geostationary (GOES 16) and highly elliptical (XMM-Newton, which reaches
# about 114,000 km). Written out so the test never needs the network.
RECORDS = [
    {
        "OBJECT_NAME": "ISS (ZARYA)", "OBJECT_ID": "1998-067A", "NORAD_CAT_ID": 25544,
        "EPOCH": "2026-10-06T00:20:47.860512", "MEAN_MOTION": 15.48747543,
        "ECCENTRICITY": 0.00068585, "INCLINATION": 51.6314, "RA_OF_ASC_NODE": 111.6262,
        "ARG_OF_PERICENTER": 227.8987, "MEAN_ANOMALY": 132.1419, "BSTAR": 0.00010208237,
        "MEAN_MOTION_DOT": 5.131e-05, "MEAN_MOTION_DDOT": 0, "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 58893, "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U",
    },
    {
        "OBJECT_NAME": "HST", "OBJECT_ID": "1990-037B", "NORAD_CAT_ID": 20580,
        "EPOCH": "2026-10-05T17:44:58.703712", "MEAN_MOTION": 15.31835008,
        "ECCENTRICITY": 0.00013816, "INCLINATION": 28.4731, "RA_OF_ASC_NODE": 44.3425,
        "ARG_OF_PERICENTER": 312.824, "MEAN_ANOMALY": 47.224, "BSTAR": 0.0001638019,
        "MEAN_MOTION_DOT": 5.417e-05, "MEAN_MOTION_DDOT": 0, "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 80553, "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U",
    },
    {
        "OBJECT_NAME": "STARLINK-1008", "OBJECT_ID": "2019-074B", "NORAD_CAT_ID": 44714,
        "EPOCH": "2026-10-06T05:14:07.015200", "MEAN_MOTION": 15.66150078,
        "ECCENTRICITY": 0.00029412, "INCLINATION": 53.1446, "RA_OF_ASC_NODE": 249.968,
        "ARG_OF_PERICENTER": 96.0198, "MEAN_ANOMALY": 264.1154, "BSTAR": 0.00039221138,
        "MEAN_MOTION_DOT": 0.00040734, "MEAN_MOTION_DDOT": 0, "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 38153, "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U",
    },
    {
        "OBJECT_NAME": "GOES 16", "OBJECT_ID": "2016-071A", "NORAD_CAT_ID": 41866,
        "EPOCH": "2026-10-06T05:24:12.720672", "MEAN_MOTION": 1.00271073,
        "ECCENTRICITY": 0.00022302, "INCLINATION": 0.6106, "RA_OF_ASC_NODE": 83.981,
        "ARG_OF_PERICENTER": 149.2955, "MEAN_ANOMALY": 117.9822, "BSTAR": 0,
        "MEAN_MOTION_DOT": -1.08e-06, "MEAN_MOTION_DDOT": 0, "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 3621, "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U",
    },
    {
        "OBJECT_NAME": "XMM-NEWTON", "OBJECT_ID": "1999-066A", "NORAD_CAT_ID": 25989,
        "EPOCH": "2026-09-26T01:52:28.597728", "MEAN_MOTION": 0.50121727,
        "ECCENTRICITY": 0.46485811, "INCLINATION": 63.9616, "RA_OF_ASC_NODE": 281.6787,
        "ARG_OF_PERICENTER": 63.103, "MEAN_ANOMALY": 0.1095, "BSTAR": 0,
        "MEAN_MOTION_DOT": 1.8e-06, "MEAN_MOTION_DDOT": 0, "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 2351, "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U",
    },
]

# Hours after each element set's epoch: the epoch itself, then how old an
# element set gets in practice (the globe uses yesterday's; Tonight looks a
# week ahead).
OFFSETS_HOURS = [0, 6, 24, 72, 168]

# How closely a fresh run must match the committed numbers. Same inputs give
# the same answers; this slack only absorbs floating-point differences between
# machines (a Mac's ARM chip vs CI's x86). 1e-7 degrees is about 1 cm.
SAME_DEG = 1e-7
SAME_KM = 1e-5
SAME_KM_S = 1e-7


def element_set(record):
    """An unsaved OrbitalElementSet (no database needed)."""
    satellite = Satellite(
        norad_cat_id=record["NORAD_CAT_ID"],
        name=record["OBJECT_NAME"],
        international_designator=record["OBJECT_ID"],
    )
    return OrbitalElementSet(satellite=satellite, **element_set_fields(record))


def api_row(es):
    """The element set as /api/satellites/elements/ sends it: the same fields,
    run through DRF's JSON encoder (UTC times become "...Z")."""
    row = {field: getattr(es, field) for field in GLOBE_ELEMENT_FIELDS}
    row["norad_cat_id"] = es.satellite.norad_cat_id
    row["name"] = es.satellite.name
    return json.loads(json.dumps(row, cls=JSONEncoder))


def build_fixture():
    satellites = []
    for record in RECORDS:
        es = element_set(record)
        positions = []
        for hours in OFFSETS_HOURS:
            when = es.epoch + timedelta(hours=hours)
            p = compute_position(es, when)
            positions.append(
                {
                    "time": when.isoformat().replace("+00:00", "Z"),
                    # Rounded to about 1 mm / 1 µm per s: far finer than the
                    # tolerances, and it keeps the file readable.
                    "latitude": round(p.latitude, 8),
                    "longitude": round(p.longitude, 8),
                    "altitude_km": round(p.altitude_km, 6),
                    "speed_km_s": round(p.speed_km_s, 9),
                }
            )
        satellites.append({"element_set": api_row(es), "positions": positions})
    return {
        "about": (
            "Reference positions from skyfield (satellites/positions.py "
            "compute_position) for the Python vs JavaScript agreement test. "
            "Generated by satellites/tests/test_agreement.py; do not edit by hand."
        ),
        "satellites": satellites,
    }


def write_fixture(data):
    FIXTURE.parent.mkdir(exist_ok=True)
    FIXTURE.write_text(json.dumps(data, indent=2) + "\n")


def test_fixture_matches_compute_position():
    fresh = build_fixture()
    if os.environ.get("UPDATE_AGREEMENT_FIXTURE") == "1":
        write_fixture(fresh)

    committed = json.loads(FIXTURE.read_text())

    regenerate = (
        "compute_position() or the elements endpoint's fields no longer match "
        f"{FIXTURE.name}. If that change is intended, regenerate it with "
        "UPDATE_AGREEMENT_FIXTURE=1 (see this file's docstring), commit it, and "
        "run Vitest to check the browser still agrees."
    )
    assert len(committed["satellites"]) == len(fresh["satellites"]), regenerate
    for got, want in zip(committed["satellites"], fresh["satellites"]):
        assert got["element_set"] == want["element_set"], regenerate
        assert len(got["positions"]) == len(want["positions"]), regenerate
        for g, w in zip(got["positions"], want["positions"]):
            assert g["time"] == w["time"], regenerate
            assert g["latitude"] == pytest.approx(w["latitude"], abs=SAME_DEG), regenerate
            assert g["longitude"] == pytest.approx(w["longitude"], abs=SAME_DEG), regenerate
            assert g["altitude_km"] == pytest.approx(w["altitude_km"], abs=SAME_KM), regenerate
            assert g["speed_km_s"] == pytest.approx(w["speed_km_s"], abs=SAME_KM_S), regenerate

