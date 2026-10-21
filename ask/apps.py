from django.apps import AppConfig
from django.core.exceptions import ImproperlyConfigured


class AskConfig(AppConfig):
    name = "ask"

    def ready(self):
        from django.conf import settings

        from .budget import PRICES_PER_MILLION

        # Fail at startup, not on the first question, if the model has no
        # known price (the daily budget couldn't be counted).
        if settings.ASK_PHOEBE_MODEL not in PRICES_PER_MILLION:
            # The value isn't echoed: a .env line that lost its newline could
            # carry the next line (a secret) with it.
            raise ImproperlyConfigured(
                "ASK_PHOEBE_MODEL has no price in ask/budget.py; add it there or "
                f"pick one of {', '.join(PRICES_PER_MILLION)}."
            )
