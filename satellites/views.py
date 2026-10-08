import logging
from datetime import datetime, timezone

from django.db.models import Case, IntegerField, Value, When
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import Satellite
from .positions import PropagationError, compute_position
from .serializers import SatelliteDetailSerializer, SatelliteListSerializer

logger = logging.getLogger(__name__)


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

    def get_serializer_class(self):
        if self.action == "retrieve":
            return SatelliteDetailSerializer
        return SatelliteListSerializer

    def get_queryset(self):
        queryset = Satellite.objects.all()
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
                {"detail": "Cannot compute a position from this satellite's orbital data."},
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
