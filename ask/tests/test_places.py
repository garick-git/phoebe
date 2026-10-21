import logging
from datetime import timedelta

import httpx
import pytest

from ask import places
from ask.tools import run_tool

from .conftest import AUSTIN, NOW

pytestmark = pytest.mark.django_db

AUSTIN_MN = {
    "id": 5016884, "name": "Austin", "latitude": 43.66663, "longitude": -92.97464,
    "admin1": "Minnesota", "country": "United States", "timezone": "America/Chicago",
}  # fmt: skip
AUSTIN_TX = {
    "id": 4671654, "name": "Austin", "latitude": 30.26715, "longitude": -97.74306,
    "admin1": "Texas", "country": "United States", "timezone": "America/Chicago",
}  # fmt: skip


def geocoding(*results):
    def handler(request):
        body = {"results": list(results)} if results else {"generationtime_ms": 0.1}
        return httpx.Response(200, json=body)

    return handler


def test_a_place_is_rounded_to_about_a_kilometer(open_meteo):
    seen = open_meteo(geocoding(AUSTIN_TX, AUSTIN_MN))

    place = places.find_place("Austin")

    assert place == AUSTIN
    assert seen[0].url.params["name"] == "Austin"


def test_a_region_after_a_comma_picks_between_same_named_places(open_meteo):
    seen = open_meteo(geocoding(AUSTIN_MN, AUSTIN_TX))

    assert places.find_place("Austin, Texas")["label"] == "Austin, Texas, United States"
    # Open-Meteo matches names only, so only the city is sent.
    assert seen[0].url.params["name"] == "Austin"


def test_results_without_a_usable_time_zone_or_coordinates_are_skipped(open_meteo):
    open_meteo(
        geocoding(
            {**AUSTIN_TX, "timezone": None},
            {**AUSTIN_TX, "timezone": "Mars/Olympus_Mons"},
            {**AUSTIN_TX, "latitude": "30.27"},  # a string, not a number
            {**AUSTIN_TX, "latitude": True},
            AUSTIN_MN,
        )
    )

    assert places.find_place("Austin")["label"] == "Austin, Minnesota, United States"


def test_no_match_says_what_to_try(open_meteo):
    open_meteo(geocoding())

    with pytest.raises(places.PlaceError, match="City, State"):
        places.find_place("Autsin")


def test_open_meteo_failing_is_a_plain_error(open_meteo):
    open_meteo(lambda request: httpx.Response(500))

    with pytest.raises(places.PlaceError, match="isn't answering"):
        places.find_place("Austin")


def forecast(start, values):
    def handler(request):
        times = [int((start + timedelta(hours=i)).timestamp()) for i in range(len(values))]
        return httpx.Response(
            200, json={"hourly": {"time": times, "cloud_cover": values}}
        )

    return handler


def test_the_forecast_is_grouped_by_local_day_and_hour(open_meteo, fixed_now, austin):
    # NOW is 01:00 UTC on Oct 6 = 8 pm on Mon Oct 5 in Austin.
    values = [10, 20, None, 101, 50] + [0] * 165
    seen = open_meteo(forecast(NOW, values))

    result, is_error = run_tool("get_cloud_forecast", {"place": "Austin", "days": 1})

    assert not is_error
    by_day = result["cloud_cover_percent"]
    assert list(by_day) == ["Mon Oct 5", "Tue Oct 6"]
    # A missing or impossible value stays missing: never a guess.
    assert by_day["Mon Oct 5"] == {"20:00": 10, "21:00": 20, "22:00": None, "23:00": None}
    assert by_day["Tue Oct 6"]["00:00"] == 50
    assert len(by_day["Tue Oct 6"]) == 21  # 1 day = 24 hours, plus the starting hour
    params = seen[0].url.params
    assert (params["latitude"], params["longitude"]) == ("30.27", "-97.74")
    assert params["timeformat"] == "unixtime"


def test_open_meteo_requests_never_reach_the_logs(open_meteo, austin, fixed_now, caplog):
    open_meteo(forecast(NOW, [0] * 170))
    caplog.set_level(logging.DEBUG)

    run_tool("get_cloud_forecast", {"place": "Austin"})

    # httpx logs each request URL (with its query string) at INFO.
    assert "latitude" not in caplog.text
    assert "30.27" not in caplog.text


def test_a_missing_forecast_is_an_error_not_a_guess(open_meteo, austin, fixed_now):
    open_meteo(lambda request: httpx.Response(200, json={"error": True}))

    result, is_error = run_tool("get_cloud_forecast", {"place": "Austin"})

    assert is_error
    assert "isn't available" in result["error"]
