from rest_framework import serializers

# Long enough for any real question ("When can I see the ISS from Austin this
# week when it's clear?" is 61 characters); short enough that nobody can
# paste an essay and make every round of the loop expensive (brief 6b).
MAX_QUESTION_LENGTH = 500


class AskSerializer(serializers.Serializer):
    """Checks the JSON body of POST /api/ask/ (it is never saved). DRF's
    CharField also strips surrounding spaces and rejects NUL characters."""

    question = serializers.CharField(min_length=3, max_length=MAX_QUESTION_LENGTH)
