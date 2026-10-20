"""The production access log must never contain a visitor's coordinates."""

import runpy
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

from gunicorn.config import Config
from gunicorn.glogging import Logger

GUNICORN_CONF = Path(__file__).resolve().parents[2] / "gunicorn.conf.py"
PATH = "/api/satellites/25544/passes/"
QUERY = "lat=30.267153&lon=-97.743061"


def production_access_line():
    """Build an access-log line exactly the way Gunicorn does, using the
    real gunicorn.conf.py, for a request whose URL and Referer both carry
    precise coordinates."""
    config = Config()
    for name, value in runpy.run_path(str(GUNICORN_CONF)).items():
        if name in config.settings:
            config.set(name, value)
    logger = Logger(config)

    referer = f"https://phoebe-api.garickm.com{PATH}?{QUERY}"
    environ = {
        "REQUEST_METHOD": "GET",
        "RAW_URI": f"{PATH}?{QUERY}",
        "PATH_INFO": PATH,
        "QUERY_STRING": QUERY,
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "172.18.0.4",
        "HTTP_REFERER": referer,
        "HTTP_USER_AGENT": "pytest",
    }
    request = SimpleNamespace(headers=[("REFERER", referer), ("HOST", "phoebe-api.garickm.com")])
    response = SimpleNamespace(status="200 OK", sent=1234, headers=[])
    atoms = logger.atoms_wrapper_class(
        logger.atoms(response, request, environ, timedelta(milliseconds=42))
    )
    return config.access_log_format % atoms  # what Logger.access() writes


def test_access_log_keeps_the_path_but_not_the_query_or_referer():
    line = production_access_line()

    assert f'"GET {PATH} HTTP/1.1" 200 1234 42ms' in line
    assert "lat=" not in line
    assert "30.26" not in line
    assert "97.74" not in line
