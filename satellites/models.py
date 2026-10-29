from django.db import models
from django.db.models import Case, F, IntegerField, Subquery, Value, When


class SatelliteQuerySet(models.QuerySet):
    def rank_by_name(self, term):
        """Best name matches first: exact name, then names starting with the
        term, then the rest; ties by NORAD ID (oldest object first). Only
        orders, doesn't filter. Shared by the search endpoint and Ask
        Phoebe's satellite lookup, so both rank the same way."""
        return self.annotate(
            match_rank=Case(
                When(name__iexact=term, then=Value(0)),
                When(name__istartswith=term, then=Value(1)),
                default=Value(2),
                output_field=IntegerField(),
            )
        ).order_by("match_rank", "norad_cat_id")

    def current(self):
        """Satellites in the most recent ingest's feed.

        Every ingest stamps the satellites in that day's feed with one shared
        last_seen_at, so the current set is exactly the rows carrying the
        newest stamp. Satellites that dropped out of CelesTrak's active list
        keep an older stamp and drop out here. One SQL query (a subquery).
        """
        newest = self.model.objects.order_by(
            F("last_seen_at").desc(nulls_last=True)
        ).values("last_seen_at")[:1]
        return self.filter(last_seen_at=Subquery(newest))


# identity table
class Satellite(models.Model):
    norad_cat_id = models.PositiveIntegerField(unique=True)
    name = models.CharField(max_length=100)
    international_designator = models.CharField(max_length=20, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # When this satellite was last in CelesTrak's active feed (set by the
    # ingest; one shared value per run). Indexed for the current() subquery.
    last_seen_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = SatelliteQuerySet.as_manager()

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} ({self.norad_cat_id})"


# the orbit at one moment
class OrbitalElementSet(models.Model):
    satellite = models.ForeignKey(
        Satellite, on_delete=models.PROTECT, related_name="element_sets"
    )
    epoch = models.DateTimeField()
    mean_motion = models.FloatField()  # revolutions per day
    eccentricity = models.FloatField()
    inclination = models.FloatField()  # degrees
    ra_of_asc_node = models.FloatField()  # degrees
    arg_of_pericenter = models.FloatField()  # degrees
    mean_anomaly = models.FloatField()  # degrees
    bstar = models.FloatField()  # drag term
    mean_motion_dot = models.FloatField()
    mean_motion_ddot = models.FloatField()
    element_set_no = models.PositiveIntegerField()
    rev_at_epoch = models.PositiveIntegerField()
    ephemeris_type = models.PositiveSmallIntegerField(default=0)
    classification_type = models.CharField(max_length=1, default="U")
    fetched_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-epoch"]
        constraints = [
            models.UniqueConstraint(
                fields=["satellite", "epoch"], name="unique_element_set_per_epoch"
            ),
        ]

    def __str__(self):
        return f"{self.satellite.name} @ {self.epoch:%Y-%m-%d %H:%M} UTC"
