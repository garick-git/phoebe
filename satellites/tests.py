import pytest

from satellites.models import Satellite


@pytest.mark.django_db
def test_can_create_satellite():
    Satellite.objects.create(norad_cat_id=25544, name="ISS (ZARYA)")
    assert Satellite.objects.count() == 1
