import re
from decimal import Decimal
from pathlib import Path

import pytest
from django.apps import apps
from django.core.exceptions import ImproperlyConfigured

from ask import budget
from ask.models import DailyUsage
from ask.popular import POPULAR_SATELLITES, popular_by_name

from .conftest import NOW

POPULAR_TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "popular.ts"


@pytest.mark.parametrize(
    "model, usage, dollars",
    [
        ("claude-opus-5-5", {"input_tokens": 1_000_000}, "4"),
        ("claude-opus-5-5", {"output_tokens": 1_000_000}, "20"),
        ("claude-sonnet-5-5", {"input_tokens": 7000, "output_tokens": 500}, "0.019"),
        ("claude-haiku-5-5", {"input_tokens": 7000, "output_tokens": 500}, "0.00095"),
        # Cache tokens (unused today) at the full input price: never an underestimate.
        ("claude-opus-5-5", {"input_tokens": 10, "cache_read_input_tokens": 990}, "0.004"),
    ],
)
def test_cost_from_token_counts_and_list_prices(model, usage, dollars):
    assert budget.cost_of(usage, model) == Decimal(dollars)


@pytest.mark.django_db
def test_the_budget_is_spent_at_exactly_its_limit(fixed_now, settings):
    settings.ASK_PHOEBE_DAILY_BUDGET_USD = Decimal("0.15")
    assert not budget.over_budget()  # no row yet

    budget.record_call({"input_tokens": 37_500}, "claude-opus-5-5")  # $0.15
    assert DailyUsage.objects.get(day=NOW.date()).cost_usd == Decimal("0.15")
    assert budget.over_budget()


def test_a_model_without_a_price_stops_startup(settings):
    settings.ASK_PHOEBE_MODEL = "claude-opus-5.5"  # a typo: dot instead of dash

    with pytest.raises(ImproperlyConfigured, match="has no price") as raised:
        apps.get_app_config("ask").ready()
    assert "5.5" not in str(raised.value)  # the value itself is never echoed


@pytest.mark.parametrize("name", ["iss", "The ISS", "Hubble", "HST", "tiangong", "CSS"])
def test_nicknames_are_matched_whole(name):
    assert popular_by_name(name) is not None


@pytest.mark.parametrize("name", ["is", "issue", "hub", "starlink"])
def test_partial_names_are_not_nicknames(name):
    assert popular_by_name(name) is None


@pytest.mark.skipif(not POPULAR_TS.exists(), reason="the front end isn't in this image")
def test_the_popular_list_matches_the_front_ends():
    source = POPULAR_TS.read_text()
    ids = [int(n) for n in re.findall(r"noradId:\s*(\d+)", source)]
    aliases = [
        re.findall(r'"([^"]+)"', block)
        for block in re.findall(r"aliases:\s*\[([^\]]*)\]", source)
    ]
    nicknames = re.findall(r'nickname:\s*"([^"]+)"', source)

    assert ids == [s["norad_cat_id"] for s in POPULAR_SATELLITES]
    assert nicknames == [s["nickname"] for s in POPULAR_SATELLITES]
    assert aliases == [s["aliases"] for s in POPULAR_SATELLITES]
