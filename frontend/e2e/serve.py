"""Static server for the end-to-end tests (playwright.config.ts).

Python's built-in http.server with two settings changed, so it keeps up when
Playwright's workers load pages in parallel (no extra package):

- request_queue_size 128 instead of 5. With 5, macOS refuses connections
  once a few browsers ask for a page's JavaScript files at the same moment
  (net::ERR_SOCKET_NOT_CONNECTED in the traces, Oct 22). A script that never
  loads means the page never hydrates, so buttons do nothing and tests fail.
- HTTP/1.1 keep-alive instead of one connection per file.

Usage: python3 e2e/serve.py <port> <directory>
"""

import functools
import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive (the handler sends Content-Length)


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


if __name__ == "__main__":
    port, directory = int(sys.argv[1]), sys.argv[2]
    handler = functools.partial(Handler, directory=directory)
    Server(("127.0.0.1", port), handler).serve_forever()
