"""The committed ephemeris excerpt (where the Sun and Earth are)."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import satellites
from satellites.passes import EPHEMERIS_PATH, ephemeris
from satellites.positions import timescale


def coverage():
    """First and last moment (UTC) that every body in the excerpt covers."""
    segments = [segment.spk_segment for segment in ephemeris.segments]
    first = max(segment.start_jd for segment in segments)
    last = min(segment.end_jd for segment in segments)
    # SPK files count days in TDB, a time scale within about 70 s of UTC.
    return timescale.tdb_jd(first).utc_datetime(), timescale.tdb_jd(last).utc_datetime()


def test_excerpt_has_at_least_a_year_left():
    first, last = coverage()
    now = datetime.now(timezone.utc)

    assert first <= now
    assert now + timedelta(days=365) < last, (
        f"The ephemeris excerpt ends {last:%Y-%m-%d}: cut a new one "
        "(docs/operations.md, 'Ephemeris excerpt') before it runs out."
    )


def test_excerpt_ships_inside_the_package():
    package = Path(satellites.__file__).resolve().parent

    assert EPHEMERIS_PATH.is_file()
    assert EPHEMERIS_PATH.parent == package / "ephemeris"
    # .gitignore ignores any folder named "data", at any depth.
    assert "data" not in EPHEMERIS_PATH.relative_to(package).parts
    assert EPHEMERIS_PATH.stat().st_size < 1_000_000  # an excerpt, not the 17 MB file
    assert ephemeris.path == str(EPHEMERIS_PATH)  # loaded from that file, not downloaded


def test_excerpt_has_the_bodies_visibility_needs():
    # The Sun and Earth for sunlight and twilight; Jupiter and Saturn because
    # apparent() corrects for how their gravity bends the Sun's light.
    for body in ("sun", "earth", "jupiter barycenter", "saturn barycenter"):
        assert body in ephemeris
