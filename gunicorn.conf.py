"""Gunicorn settings for production.

Gunicorn reads ./gunicorn.conf.py from its working directory on its own
(/app in the image), so the Dockerfile only says which app to run.
Development doesn't use this file: compose.yaml runs runserver instead.
"""

bind = "0.0.0.0:8000"
# 2 sync workers: each loads numpy and skyfield, and the server has 1 GB
# shared with Postgres.
workers = 2
# Worker health pings go to memory, not the container's disk (a known Docker
# issue where they can stall).
worker_tmp_dir = "/dev/shm"
# Both logs go to stdout/stderr, so `docker compose logs web` shows them.
accesslog = "-"
errorlog = "-"

# Location privacy (brief section 2): never log the query string, because
# the passes endpoint's query holds the visitor's coordinates. Gunicorn's
# default format uses %(r)s, the full request line including "?lat=...",
# and %(f)s, the Referer, which can hold the same URL (for example the
# browsable API's own page). Instead: method, path without the query
# (%(U)s) and protocol, plus how long the request took (%(M)s, milliseconds).
# Rounding or rejecting in Django can't help here: Gunicorn writes this line
# after the response, from the original request.
access_log_format = '%(h)s %(t)s "%(m)s %(U)s %(H)s" %(s)s %(b)s %(M)sms "%(a)s"'
