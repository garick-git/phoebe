from django.db.models import Case, IntegerField, Value, When
from rest_framework import filters, viewsets

from .models import Satellite
from .serializers import SatelliteDetailSerializer, SatelliteListSerializer


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
