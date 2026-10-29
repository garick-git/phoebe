from django.db import models


# daily budget. 1 row per day
class DailyUsage(models.Model):
    """What Ask Phoebe used on one UTC day: one row per day, shared by every
    Gunicorn worker and thread (the throttles' counts live in each worker's
    memory; this one has to be exact, because it guards real money).

    Written once per question and once per Claude call with an atomic
    `UPDATE ... SET x = x + n`, so concurrent questions can't lose counts.
    It also gives the resume's "questions asked" numbers.
    """

    day = models.DateField(unique=True)
    questions = models.PositiveIntegerField(default=0)
    claude_calls = models.PositiveIntegerField(default=0)
    input_tokens = models.PositiveBigIntegerField(default=0)
    output_tokens = models.PositiveBigIntegerField(default=0)
    # Estimated from the token counts and the model's list price; Anthropic's
    # Console is the real bill (and its spend limit the hard stop).
    cost_usd = models.DecimalField(max_digits=10, decimal_places=6, default=0)

    class Meta:
        ordering = ["-day"]
        verbose_name_plural = "daily usage"

    def __str__(self):
        return f"{self.day}: {self.questions} questions, ${self.cost_usd}"
