"""Load CelesTrak OMM (JSON) records into the database."""

from datetime import datetime, timezone

import httpx
from django.db import transaction
from django.utils import timezone as django_timezone

from .models import OrbitalElementSet, Satellite

CELESTRAK_ACTIVE_URL = (
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json"
)

# Identifies Phoebe to CelesTrak so they can contact us if something goes wrong.
USER_AGENT = "Phoebe/0.1 (satellite tracker; contact: garickmendez7@gmail.com)"


def fetch_omm(url=CELESTRAK_ACTIVE_URL):
    """Download OMM records from CelesTrak and return them as a list of dicts."""
    response = httpx.get(url, timeout=30, headers={"User-Agent": USER_AGENT})
    if response.is_error:
        # CelesTrak explains refusals in the body, so surface it (capped in
        # case the server sends back a long HTML error page).
        raise RuntimeError(
            f"CelesTrak returned {response.status_code} "
            f"{response.reason_phrase}: {response.text[:500]}"
        )
    return response.json()


def parse_epoch(value):
    """CelesTrak epochs are UTC but carry no timezone marker, so add one."""
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def element_set_fields(record):
    """Map one OMM record to OrbitalElementSet field values."""
    return {
        "epoch": parse_epoch(record["EPOCH"]),
        "mean_motion": record["MEAN_MOTION"],
        "eccentricity": record["ECCENTRICITY"],
        "inclination": record["INCLINATION"],
        "ra_of_asc_node": record["RA_OF_ASC_NODE"],
        "arg_of_pericenter": record["ARG_OF_PERICENTER"],
        "mean_anomaly": record["MEAN_ANOMALY"],
        "bstar": record["BSTAR"],
        "mean_motion_dot": record["MEAN_MOTION_DOT"],
        "mean_motion_ddot": record["MEAN_MOTION_DDOT"],
        "element_set_no": record["ELEMENT_SET_NO"],
        "rev_at_epoch": record["REV_AT_EPOCH"],
        "ephemeris_type": record.get("EPHEMERIS_TYPE", 0),
        "classification_type": record.get("CLASSIFICATION_TYPE", "U"),
    }


# atomic transaction (all or nothing)
@transaction.atomic
# upserts records
def ingest_records(records):
    """Upsert satellites and add any new element sets. Returns counts."""
    # One record per satellite, in case the feed ever repeats one.
    by_norad = {int(r["NORAD_CAT_ID"]): r for r in records}
    # One timestamp for the whole run, so "in the latest feed" is an exact
    # match on the newest last_seen_at (see SatelliteQuerySet.current).
    seen_at = django_timezone.now()

    Satellite.objects.bulk_create(
        [
            Satellite(
                norad_cat_id=norad,
                name=r["OBJECT_NAME"],
                international_designator=r.get("OBJECT_ID") or "",
                last_seen_at=seen_at,
            )
            for norad, r in by_norad.items()
        ],
        update_conflicts=True,
        unique_fields=["norad_cat_id"],
        update_fields=[
            "name",
            "international_designator",
            "updated_at",
            "last_seen_at",
        ],
        batch_size=1000,
    )

    satellite_ids = dict(Satellite.objects.values_list("norad_cat_id", "id"))

    before = OrbitalElementSet.objects.count()
    OrbitalElementSet.objects.bulk_create(
        [
            OrbitalElementSet(
                satellite_id=satellite_ids[norad], **element_set_fields(r)
            )
            for norad, r in by_norad.items()
        ],
        ignore_conflicts=True,
        batch_size=1000,
    )
    added = OrbitalElementSet.objects.count() - before

    return {"satellites": len(by_norad), "element_sets_added": added}
