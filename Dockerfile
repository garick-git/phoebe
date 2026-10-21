FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# COPY keeps each file's permissions from the machine that builds the image, and
# the app runs as appuser, so make everything readable (and folders enterable)
# whatever they were there. A Mac copy with owner-only files failed on 2026-10-21.
RUN chmod -R a+rX /app

# Collect static files (admin, browsable API) into /app/staticfiles for WhiteNoise.
# Settings read these variables at import time, so this one command gets throw-away
# values; nothing is stored in the image's environment.
RUN DJANGO_SECRET_KEY=build-only POSTGRES_DB=x POSTGRES_USER=x POSTGRES_PASSWORD=x \
    python manage.py collectstatic --noinput

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# Production server by default; its settings are in gunicorn.conf.py, which
# Gunicorn reads from /app on its own. compose.yaml overrides this with
# runserver for development.
CMD ["gunicorn", "config.wsgi:application"]
