"""The well-known satellites people ask about, with the names they use.

A copy of frontend/src/lib/popular.ts (the list behind Tonight and the
globe's nickname search), so "Hubble" and "Tiangong" mean the same satellite
everywhere. test_popular.py fails if the two lists drift apart.
"""

POPULAR_SATELLITES = [
    {
        "norad_cat_id": 25544,
        "nickname": "ISS",
        "full_name": "International Space Station",
        "aliases": ["iss", "space station", "international space station", "zarya"],
    },
    {
        "norad_cat_id": 48274,
        "nickname": "Tiangong",
        "full_name": "Tiangong space station",
        "aliases": ["tiangong", "chinese space station", "css", "tianhe"],
    },
    {
        "norad_cat_id": 20580,
        "nickname": "Hubble",
        "full_name": "Hubble Space Telescope",
        "aliases": ["hubble", "hst", "hubble space telescope"],
    },
]

_BY_ID = {sat["norad_cat_id"]: sat for sat in POPULAR_SATELLITES}


def popular_by_id(norad_cat_id):
    return _BY_ID.get(norad_cat_id)


def popular_by_name(query):
    """The popular satellite whose nickname or alias is exactly `query`
    (case-insensitive, "the" ignored), or None. Exact, not starts-with: the
    model sends whole names ("Hubble"), and "iss" must not match "issue"."""
    q = query.strip().lower()
    if q.startswith("the "):
        q = q[4:].strip()
    for sat in POPULAR_SATELLITES:
        if q == sat["nickname"].lower() or q in sat["aliases"]:
            return sat
    return None
