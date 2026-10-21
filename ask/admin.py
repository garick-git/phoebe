from django.contrib import admin

from .models import DailyUsage


@admin.register(DailyUsage)
class DailyUsageAdmin(admin.ModelAdmin):
    """Read-only: the counts are written only by Ask Phoebe itself."""

    list_display = ["day", "questions", "claude_calls", "input_tokens", "output_tokens", "cost_usd"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
