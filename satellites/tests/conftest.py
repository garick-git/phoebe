import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def clear_cache():
    """Throttle counts live in the cache; start every test with an empty one."""
    cache.clear()
