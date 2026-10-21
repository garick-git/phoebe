"""Ask Phoebe's site-wide daily budget, in dollars.

Three layers keep the Claude bill bounded (decision log, 2026-10-21):
per-IP throttles (views.py) stop one visitor using everyone's share; this
daily budget spreads the month's money across days for all visitors together;
the Console's workspace spend limit is the hard stop if this code is wrong.
"""

from decimal import Decimal

from django.conf import settings
from django.db.models import F

from . import clock
from .models import DailyUsage

# List prices in US dollars per million tokens (input, output), from
# platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-21.
# A model missing here fails at startup (apps.py), so a typo in
# ASK_PHOEBE_MODEL can't run with an unknown price.
PRICES_PER_MILLION = {
    "claude-opus-5-5": (Decimal("4"), Decimal("20")),
    "claude-sonnet-5-5": (Decimal("2"), Decimal("10")),
    "claude-haiku-5-5": (Decimal("0.10"), Decimal("0.50")),
}
MILLION = Decimal(1_000_000)


def cost_of(usage, model):
    """Dollars for one Messages API reply's `usage`. Cache tokens (unused
    today) are counted at the full input price, which can only overestimate."""
    input_price, output_price = PRICES_PER_MILLION[model]
    input_tokens = (
        usage.get("input_tokens", 0)
        + (usage.get("cache_creation_input_tokens") or 0)
        + (usage.get("cache_read_input_tokens") or 0)
    )
    output_tokens = usage.get("output_tokens", 0)
    return (input_tokens * input_price + output_tokens * output_price) / MILLION


def _today_row():
    row, _ = DailyUsage.objects.get_or_create(day=clock.utc_now().date())
    return row


def spent_today():
    row = DailyUsage.objects.filter(day=clock.utc_now().date()).first()
    return row.cost_usd if row else Decimal(0)


def over_budget():
    return spent_today() >= settings.ASK_PHOEBE_DAILY_BUDGET_USD


def count_question():
    DailyUsage.objects.filter(pk=_today_row().pk).update(questions=F("questions") + 1)


def record_call(usage, model):
    """Add one Claude call's tokens and cost to today's row; return the cost."""
    cost = cost_of(usage, model)
    DailyUsage.objects.filter(pk=_today_row().pk).update(
        claude_calls=F("claude_calls") + 1,
        input_tokens=F("input_tokens") + usage.get("input_tokens", 0),
        output_tokens=F("output_tokens") + usage.get("output_tokens", 0),
        cost_usd=F("cost_usd") + cost,
    )
    return cost
