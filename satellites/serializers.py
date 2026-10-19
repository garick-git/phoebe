from rest_framework import serializers

from .models import OrbitalElementSet, Satellite
from .passes import MAX_DAYS


class OrbitalElementSetSerializer(serializers.ModelSerializer):
    class Meta:
        model = OrbitalElementSet
        fields = [
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
            "element_set_no",
            "rev_at_epoch",
        ]


class SatelliteListSerializer(serializers.ModelSerializer):
    class Meta:
        model = Satellite
        fields = ["norad_cat_id", "name", "international_designator"]


class SatelliteDetailSerializer(SatelliteListSerializer):
    latest_element_set = serializers.SerializerMethodField()

    class Meta(SatelliteListSerializer.Meta):
        fields = SatelliteListSerializer.Meta.fields + ["latest_element_set"]

    def get_latest_element_set(self, obj):
        element_set = obj.element_sets.first()
        if element_set is None:
            return None
        return OrbitalElementSetSerializer(element_set).data


def round_location(value):
    """Round a coordinate to 2 decimals (about 1 km), which is plenty for pass
    predictions and all Phoebe ever uses (location privacy, brief section 2).
    Adding 0.0 turns -0.0 (e.g. -0.001 rounded) into a plain 0.0."""
    return round(value, 2) + 0.0


class PassQuerySerializer(serializers.Serializer):
    """Checks the query string of the passes endpoint (it is never saved).

    DRF's FloatField already rejects "nan", "inf" and numbers too big for a
    float; the tests pin that so a future DRF change can't undo it quietly.
    """

    lat = serializers.FloatField(min_value=-90, max_value=90)
    lon = serializers.FloatField(min_value=-180, max_value=180)
    days = serializers.IntegerField(min_value=1, max_value=MAX_DAYS, default=MAX_DAYS)

    def validate_lat(self, value):
        return round_location(value)

    def validate_lon(self, value):
        return round_location(value)
