import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests for the main flows (Ask Phoebe and Tonight), run against
 * the static export in out/: the same files Amplify serves. Build first:
 *
 *   npm run build && npm run test:e2e
 *
 * Every outside request is stubbed in the tests (Phoebe's API, Open-Meteo),
 * and anything unstubbed is aborted, so a run never depends on the network,
 * the weather, today's orbits or Claude credits.
 */
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI), // a stray test.only fails CI instead of skipping the rest
  retries: 0, // a flaky test should be fixed, not retried
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  // Python's built-in static server: no extra package. /tonight/ serves
  // out/tonight/index.html, as on Amplify (trailingSlash: true).
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory out`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    // http.server logs every request to stderr; a server that fails to start
    // still fails the run (Playwright waits for the URL).
    stdout: "ignore",
    stderr: "ignore",
  },
});
