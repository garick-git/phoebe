from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from ask import tools
from ask.tools import compass8, height_word, local_time, run_tool
from satellites.ingest import ingest_records
from satellites.passes import find_passes
from satellites.tests.test_api import satellite

from .conftest import AUSTIN, NOW

pytestmark = pytest.mark.django_db

CHICAGO = ZoneInfo("America/Chicago")


@pytest.mark.parametrize(
    "azimuth, word",
    [
        (0, "north"),
        (22.4, "north"),
        (22.5, "northeast"),  # boundaries round up, like Tonight's cards
        (90, "east"),
        (202.5, "southwest"),
        (315, "northwest"),
        (337.5, "north"),
        (359.9, "north"),
        (-45, "northwest"),
    ],
)
def test_compass_words_match_tonights_cards(azimuth, word):
    assert compass8(azimuth) == word


@pytest.mark.parametrize(
    "elevation, word",
    [(10, "low"), (19.9, "low"), (20, "partway up"), (44.9, "partway up"),
     (45, "high"), (69.9, "high"), (70, "almost overhead"), (90, "almost overhead")],
)  # fmt: skip
def test_height_bands_match_tonights_cards(elevation, word):
    assert height_word(elevation) == word


def test_times_are_written_in_the_places_own_time_zone():
    evening = datetime(2026, 10, 29, 0, 14, 5, tzinfo=timezone.utc)
    after_the_change = datetime(2026, 11, 2, 12, 5, tzinfo=timezone.utc)

    assert local_time(evening, CHICAGO) == {
        "when": "Wed Oct 28, 7:14 pm CDT",
        "time": "2026-10-28T19:14:05-05:00",
    }
    # Daylight time ends Nov 1: the same zone, a different name and offset.
    assert local_time(after_the_change, CHICAGO)["when"] == "Mon Nov 2, 6:05 am CST"


@pytest.mark.parametrize("query", ["ISS", "iss", "the ISS", "space station", "25544"])
def test_the_iss_is_found_by_nickname_or_norad_id(iss, query):
    assert tools.find_satellite(query).norad_cat_id == 25544


def test_nicknames_reach_satellites_whose_names_dont_contain_them():
    ingest_records([satellite(20580, "HST"), satellite(48274, "CSS (TIANHE)")])

    assert tools.find_satellite("Hubble").name == "HST"
    assert tools.find_satellite("Tiangong").name == "CSS (TIANHE)"


def test_other_names_use_the_apis_ranking():
    ingest_records(
        [satellite(44235, "STARLINK-1008"), satellite(44238, "STARLINK-24"),
         satellite(9999, "NOT STARLINK")]
    )  # fmt: skip

    assert tools.find_satellite("starlink").norad_cat_id == 44235  # starts-with, oldest
    with pytest.raises(tools.ToolError, match="No satellite matches"):
        tools.find_satellite("no such thing")


def test_look_up_satellite_describes_the_best_match(iss, fixed_now):
    result, is_error = run_tool("look_up_satellite", {"query": "ISS"})

    assert not is_error
    best = result["best_match"]
    assert best["norad_cat_id"] == 25544
    assert best["nickname"] == "ISS"
    assert best["orbit"]["period_minutes"] == pytest.approx(93.0, abs=0.1)
    assert best["orbit"]["inclination_deg"] == 51.6
    assert best["orbit"]["element_set_age_hours"] == 0.7
    assert 400 < best["now"]["altitude_km"] < 440
    assert result["other_matches"] == []  # a nickname match is unambiguous


def test_get_passes_reports_exactly_what_find_passes_found(iss, fixed_now, austin):
    result, is_error = run_tool("get_passes", {"satellite": "ISS", "place": "Austin"})

    assert not is_error
    expected = find_passes(iss.element_sets.first(), 30.27, -97.74, NOW, 7)
    assert len(result["passes"]) == len(expected)
    assert result["visible_pass_count"] == sum(p.visibility.visible for p in expected)
    assert result["place"] == AUSTIN
    assert result["satellite"]["name"] == "ISS (ZARYA)"
    assert result["searched_from"] == "Mon Oct 5, 8:00 pm CDT"

    for got, want in zip(result["passes"], expected):
        assert got["visible"] == want.visibility.visible
        if got["visible"]:
            start = want.visibility.start
            assert got["appears"]["time"] == start.time.astimezone(CHICAGO).isoformat()
            assert got["appears"]["direction"] == compass8(start.azimuth_deg)
            assert got["visible_for_s"] == int(
                (want.visibility.end.time - start.time).total_seconds()
            )
        else:
            assert got["reason"] == want.visibility.reason
            assert got["max_elevation_deg"] == round(want.max_elevation_deg, 1)


def test_the_visible_austin_pass_reads_like_tonights_card(iss, fixed_now, austin):
    # test_passes.py pins this pass: Sun Oct 11, 7:04 am, ending at dawn.
    result, _ = run_tool("get_passes", {"satellite": "ISS", "place": "Austin"})

    visible = [p for p in result["passes"] if p["visible"]]
    assert any(p["appears"]["when"].startswith("Sun Oct 11, 7:0") for p in visible)


@pytest.mark.parametrize(
    "tool_input, message",
    [
        ({"place": "Austin"}, "'satellite' must be"),
        ({"satellite": "ISS"}, "'place' must be"),
        ({"satellite": "ISS", "place": "  "}, "'place' must be"),
        ({"satellite": "ISS", "place": "x" * 101}, "too long"),
        ({"satellite": "ISS", "place": "Austin", "days": 0}, "'days'"),
        ({"satellite": "ISS", "place": "Austin", "days": 8}, "'days'"),
        ({"satellite": "ISS", "place": "Austin", "days": True}, "'days'"),
        ({"satellite": "ISS", "place": "Austin", "days": "7"}, "'days'"),
        ({"satellite": "NOPE", "place": "Austin"}, "No satellite"),
    ],
)
def test_bad_tool_input_comes_back_as_an_error_the_model_can_read(
    iss, austin, tool_input, message
):
    result, is_error = run_tool("get_passes", tool_input)

    assert is_error
    assert message in result["error"]


def test_unknown_tools_and_non_object_input_are_errors():
    assert run_tool("delete_everything", {}) == ({"error": "Unknown tool 'delete_everything'."}, True)
    assert run_tool("get_passes", "ISS")[1] is True


def test_an_unexpected_failure_logs_only_its_type(monkeypatch, caplog):
    def explode(tool_input):
        raise RuntimeError("https://api.open-meteo.com/v1/forecast?latitude=30.27")

    monkeypatch.setitem(tools.HANDLERS, "get_cloud_forecast", explode)

    result, is_error = run_tool("get_cloud_forecast", {"place": "Austin"})

    assert is_error and result == {"error": "That tool failed unexpectedly."}
    assert "RuntimeError" in caplog.text
    assert "30.27" not in caplog.text


def test_every_tool_has_a_handler_and_a_schema():
    names = [t["name"] for t in tools.TOOL_DEFINITIONS]
    assert sorted(names) == sorted(tools.HANDLERS)
    for definition in tools.TOOL_DEFINITIONS:
        assert definition["input_schema"]["type"] == "object"
        assert definition["description"]
