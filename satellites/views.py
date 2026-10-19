import logging
from datetime import datetime, timedelta, timezone

from django.db.models import Case, F, IntegerField, Value, When
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle, ScopedRateThrottle

from .models import OrbitalElementSet, Satellite
from .passes import MIN_ELEVATION_DEG, find_passes
from .positions import PropagationError, compute_position
from .serializers import (
    PassQuerySerializer,
    SatelliteDetailSerializer,
    SatelliteListSerializer,
)

logger = logging.getLogger(__name__)

UNUSABLE_ORBIT_MESSAGE = "Cannot compute a position from this satellite's orbital data."

# What the globe needs per satellite: identity plus the orbital elements that
# satellite.js turns into positions. Never rounded: SGP4 needs full precision.
GLOBE_ELEMENT_FIELDS = [
    "epoch",
    "mean_motion",
    "eccentricity",
    "inclination",
    "ra_of_asc_node",
    "arg_of_pericenter",
    "mean_anomaly",
    "bstar",
    "mean_motion_dot",
    "mean_motion_ddot",
]


def _pass_point(point):
    # 1 decimal: a tenth of a degree is far finer than anyone can point.
    return {
        "time": point.time,
        "azimuth_deg": round(point.azimuth_deg, 1),
        "elevation_deg": round(point.elevation_deg, 1),
    }


def utc_now():
    """The current UTC time, to the second. It's a function so tests can swap
    in a fixed time."""
    return datetime.now(timezone.utc).replace(microsecond=0)


class SatelliteViewSet(viewsets.ReadOnlyModelViewSet):
    """List/search satellites, and show one satellite by NORAD ID."""

    lookup_field = "norad_cat_id"
    lookup_value_regex = r"\d+"  # digits only; anything else is a 404 at the URL
    filter_backends = [filters.SearchFilter]
    search_fields = ["name"]  # case-insensitive "contains" match
    # Named rate limit for actions that opt in (see passes); None means only
    # the default per-IP limit applies.
    throttle_scope = None

    def get_serializer_class(self):
        if self.action == "retrieve":
            return SatelliteDetailSerializer
        return SatelliteListSerializer

    def get_queryset(self):
        if self.action in ("retrieve", "position", "passes"):
            # Old links keep working for satellites that left the feed.
            queryset = Satellite.objects.all()
        else:
            queryset = Satellite.objects.current()
        term = self.request.query_params.get(
            filters.SearchFilter.search_param, ""
        ).strip()
        if term:
            # Best matches first: exact name, then names starting with the
            # term, then names that merely contain it (SearchFilter does the
            # filtering afterward; this only decides the order).
            queryset = queryset.annotate(
                match_rank=Case(
                    When(name__iexact=term, then=Value(0)),
                    When(name__istartswith=term, then=Value(1)),
                    default=Value(2),
                    output_field=IntegerField(),
                )
            ).order_by("match_rank", "norad_cat_id")
        return queryset

    @action(detail=False, methods=["get"])
    def elements(self, request):
        """Newest element set for every current satellite, in one response.

        The globe downloads this once and animates positions in the browser
        with satellite.js. Not paginated: its size is set by the active
        catalog (about 17,000), not by anything the client sends. Built with
        .values() instead of a serializer because a serializer's per-field work
        adds up over 17,000 rows.
        """
        rows = (
            OrbitalElementSet.objects.filter(satellite__in=Satellite.objects.current())
            # DISTINCT ON (satellite_id) keeps the first row per satellite, and
            # the ordering makes that the newest epoch (even one dated slightly
            # in the future, which is still the freshest fit). Uses the unique
            # (satellite, epoch) index.
            .order_by("satellite_id", "-epoch")
            .distinct("satellite_id")
            .values(
                *GLOBE_ELEMENT_FIELDS,
                norad_cat_id=F("satellite__norad_cat_id"),
                name=F("satellite__name"),
            )
        )
        response = Response(list(rows))
        # The data changes once a day (08:00 UTC ingest) and positions are
        # computed in the browser, so a cached copy stays correct for an hour.
        response["Cache-Control"] = "public, max-age=3600"
        return response

    @action(detail=True, methods=["get"])
    def position(self, request, norad_cat_id=None):
        """Where the satellite is right now, from its newest element set."""
        satellite = self.get_object()  # 404 if the NORAD ID is unknown
        element_set = satellite.element_sets.first()  # newest epoch first
        if element_set is None:
            return Response(
                {"detail": "No orbital data for this satellite yet."},
                status=status.HTTP_404_NOT_FOUND,
            )

        now = utc_now()
        try:
            current = compute_position(element_set, now)
        except PropagationError as error:
            # The technical reason goes in the log, not in the response.
            logger.warning(
                "Cannot compute a position for NORAD %s: %s",
                satellite.norad_cat_id,
                error,
            )
            return Response(
                {"detail": UNUSABLE_ORBIT_MESSAGE},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        age_hours = (now - element_set.epoch).total_seconds() / 3600
        return Response(
            {
                "norad_cat_id": satellite.norad_cat_id,
                "name": satellite.name,
                "timestamp": now,
                # Rounded: SGP4 is only accurate to about a kilometer, so
                # more digits would be false precision.
                "latitude": round(current.latitude, 3),
                "longitude": round(current.longitude, 3),
                "altitude_km": round(current.altitude_km, 1),
                "speed_km_s": round(current.speed_km_s, 3),
                "element_set_epoch": element_set.epoch,
                "element_set_age_hours": round(age_hours, 1),
            }
        )

    @action(
        detail=True,
        methods=["get"],
        # Both limits apply: the general 60/min and the stricter "passes" one.
        throttle_classes=[AnonRateThrottle, ScopedRateThrottle],
        throttle_scope="passes",
    )
    def passes(self, request, norad_cat_id=None):
        """Upcoming passes over a location: when the satellite rises above 10
        degrees, its highest point, and when it sets below 10 degrees.

        Query: lat and lon (required, rounded to 2 decimals before use) and
        days (1 to 7, default 7). The search always starts now.
        """
        query = PassQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)  # 400 with a message per field
        latitude = query.validated_data["lat"]
        longitude = query.validated_data["lon"]
        days = query.validated_data["days"]

        satellite = self.get_object()  # 404 if the NORAD ID is unknown
        element_set = satellite.element_sets.first()  # newest epoch first
        if element_set is None:
            return Response(
                {"detail": "No orbital data for this satellite yet."},
                status=status.HTTP_404_NOT_FOUND,
            )

        start = utc_now()
        try:
            found = find_passes(element_set, latitude, longitude, start, days)
        except PropagationError as error:
            # Never log the location, only which satellite failed.
            logger.warning(
                "Cannot compute passes for NORAD %s: %s",
                satellite.norad_cat_id,
                error,
            )
            return Response(
                {"detail": UNUSABLE_ORBIT_MESSAGE},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        age_hours = (start - element_set.epoch).total_seconds() / 3600
        return Response(
            {
                "norad_cat_id": satellite.norad_cat_id,
                "name": satellite.name,
                # The rounded location actually used, so clients can see it.
                "location": {"latitude": latitude, "longitude": longitude},
                "start": start,
                "end": start + timedelta(days=days),
                "days": days,
                "min_elevation_deg": MIN_ELEVATION_DEG,
                "element_set_epoch": element_set.epoch,
                "element_set_age_hours": round(age_hours, 1),
                "passes": [
                    {
                        "rise": _pass_point(p.rise),
                        "peak": _pass_point(p.peak),
                        "set": _pass_point(p.set),
                        "max_elevation_deg": round(p.max_elevation_deg, 1),
                        "duration_s": p.duration_s,
                    }
                    for p in found
                ],
            }
        )
