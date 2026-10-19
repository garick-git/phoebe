"""Turn a stored element set into where the satellite is at a given moment."""

import math
from dataclasses import dataclass
from datetime import timezone

from skyfield.api import EarthSatellite, load, wgs84

# Skyfield's Timescale converts between UTC and the time scales astronomy
# uses (it also accounts for leap seconds). load.timescale() uses data that
# ships inside skyfield, so it needs no download. It is read-only, so one
# shared copy is built when this module is first imported (passes.py uses
# it too).
timescale = load.timescale()


class PropagationError(Exception):
    """SGP4 could not produce a position from this element set."""


@dataclass(frozen=True)
class Position:
    latitude: float  # degrees, north positive
    longitude: float  # degrees, east positive, -180 to 180
    altitude_km: float  # height above the WGS84 ellipsoid
    speed_km_s: float  # speed relative to Earth's center, not over the ground


def _omm_fields(element_set):
    """Rebuild the CelesTrak OMM fields that skyfield's from_omm() expects."""
    satellite = element_set.satellite
    epoch = element_set.epoch.astimezone(timezone.utc)
    return {
        "OBJECT_NAME": satellite.name,
        "OBJECT_ID": satellite.international_designator,
        "NORAD_CAT_ID": satellite.norad_cat_id,
        # The parser wants this exact text layout, microseconds included.
        "EPOCH": epoch.strftime("%Y-%m-%dT%H:%M:%S.%f"),
        "MEAN_MOTION": element_set.mean_motion,
        "ECCENTRICITY": element_set.eccentricity,
        "INCLINATION": element_set.inclination,
        "RA_OF_ASC_NODE": element_set.ra_of_asc_node,
        "ARG_OF_PERICENTER": element_set.arg_of_pericenter,
        "MEAN_ANOMALY": element_set.mean_anomaly,
        "BSTAR": element_set.bstar,
        "MEAN_MOTION_DOT": element_set.mean_motion_dot,
        "MEAN_MOTION_DDOT": element_set.mean_motion_ddot,
        "ELEMENT_SET_NO": element_set.element_set_no,
        "REV_AT_EPOCH": element_set.rev_at_epoch,
        "EPHEMERIS_TYPE": element_set.ephemeris_type,
        "CLASSIFICATION_TYPE": element_set.classification_type,
    }


def earth_satellite(element_set):
    """A skyfield satellite (SGP4 model) built from a stored element set."""
    return EarthSatellite.from_omm(timescale, _omm_fields(element_set))


def compute_position(element_set, when):
    """Where the satellite is at `when`, which must be timezone-aware.

    Raises ValueError for a naive datetime and PropagationError if SGP4
    cannot compute a position from the element set.
    """
    satellite = earth_satellite(element_set)
    # SGP4: element set + time -> position and velocity (km from Earth's center).
    geocentric = satellite.at(timescale.from_datetime(when))
    if geocentric.message is not None:
        # On failure skyfield returns NaN coordinates plus an explanation.
        raise PropagationError(geocentric.message)
    # Rotate to the Earth-fixed frame, then convert to latitude, longitude
    # and height above the WGS84 ellipsoid.
    where = wgs84.geographic_position_of(geocentric)
    return Position(
        latitude=float(where.latitude.degrees),
        longitude=float(where.longitude.degrees),
        altitude_km=float(where.elevation.km),
        speed_km_s=math.hypot(*geocentric.velocity.km_per_s),
    )
