from rest_framework import serializers

from .models import OrbitalElementSet, Satellite


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
