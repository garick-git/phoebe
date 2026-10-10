FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Collect static files (admin, browsable API) into /app/staticfiles for WhiteNoise.
# Settings read these variables at import time, so this one command gets throw-away
# values; nothing is stored in the image's environment.
RUN DJANGO_SECRET_KEY=build-only POSTGRES_DB=x POSTGRES_USER=x POSTGRES_PASSWORD=x \
    python manage.py collectstatic --noinput

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# Production server by default. compose.yaml overrides this with runserver for development.
CMD ["gunicorn", "config.wsgi:application", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "2", \
     "--worker-tmp-dir", "/dev/shm", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
