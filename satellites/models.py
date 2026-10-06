from django.db import models


class Satellite(models.Model):
    norad_cat_id = models.PositiveIntegerField(unique=True)
    name = models.CharField(max_length=100)
    international_designator = models.CharField(max_length=20, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} ({self.norad_cat_id})"


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
