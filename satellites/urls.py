from rest_framework.routers import SimpleRouter

from .views import SatelliteViewSet

router = SimpleRouter()
router.register("satellites", SatelliteViewSet, basename="satellite")

urlpatterns = router.urls
