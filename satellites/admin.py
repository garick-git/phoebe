from django.contrib import admin

from .models import OrbitalElementSet, Satellite


@admin.register(Satellite)
class SatelliteAdmin(admin.ModelAdmin):
    list_display = [
        "name",
        "norad_cat_id",
        "international_designator",
        "last_seen_at",
    ]
    search_fields = ["name", "norad_cat_id", "international_designator"]


@admin.register(OrbitalElementSet)
class OrbitalElementSetAdmin(admin.ModelAdmin):
    list_display = ["satellite", "epoch", "inclination", "mean_motion", "eccentricity"]
    list_select_related = ["satellite"]
    search_fields = ["satellite__name", "satellite__norad_cat_id"]
    date_hierarchy = "epoch"
    autocomplete_fields = ["satellite"]
