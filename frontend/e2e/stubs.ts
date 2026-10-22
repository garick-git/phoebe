/**
 * Shared stubs for the end-to-end tests. Nothing here reaches the network:
 * `blockOutside()` aborts every request that isn't to the local static
 * server, and each test then stubs exactly the calls it expects.
 *
 * The API is cross-origin in production (phoebe.garickm.com calls
 * phoebe-api.garickm.com), so stubbed responses carry the same CORS headers
 * config/cors.py sends, and no more: a header the real server doesn't send
 * (or expose) must not make a test pass.
 */

import { expect, type Locator, type Page, type Route } from "@playwright/test";

export const APP_ORIGIN = "http://127.0.0.1:4173";

/** What config/cors.py adds for an allowed origin. */
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Expose-Headers": "Retry-After",
    Vary: "Origin",
  };
}

/** Abort anything not served by the local static server (registered first, so later stubs win). */
export async function blockOutside(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin !== APP_ORIGIN,
    (route) => route.abort("blockedbyclient"),
  );
}

/** A JSON response from Phoebe's API, answering its CORS preflight too. */
export async function fulfillApi(
  route: Route,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({
      status: 200,
      headers: {
        ...corsHeaders(),
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "7200",
      },
    });
    return;
  }
  await route.fulfill({ status, json: body, headers: { ...corsHeaders(), ...headers } });
}

/** Open-Meteo's hourly cloud cover (open CORS, like the real API), same % every hour. */
export async function stubCloudForecast(page: Page, percent: number | "fail"): Promise<void> {
  await page.route("https://api.open-meteo.com/v1/forecast**", async (route) => {
    if (percent === "fail") {
      await route.fulfill({ status: 500, body: "", headers: { "Access-Control-Allow-Origin": "*" } });
      return;
    }
    const firstHour = Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000);
    const hours = 24 * 40; // Oct 1 to Nov 10: covers both tests' weeks
    await route.fulfill({
      json: {
        hourly: {
          time: Array.from({ length: hours }, (_, i) => firstHour + i * 3600),
          cloud_cover: Array.from({ length: hours }, () => percent),
        },
      },
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
}

/**
 * Open a dialog, retrying until it opens. The page's HTML (with its buttons)
 * arrives before React has hydrated it, and a click in that moment does
 * nothing. Playwright's own pattern for this is to retry the action inside
 * toPass(), never to add a fixed wait. (The flaky drawer tests of Oct 22 were
 * mostly the test server dropping script requests; see e2e/serve.py.)
 */
export async function openDialog(dialog: Locator, open: () => Promise<void>): Promise<void> {
  await expect(async () => {
    if (!(await dialog.isVisible())) await open();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

/** One event as the browser sent it to PostHog. */
export type SentEvent = { event: string; properties: Record<string, unknown> };

/**
 * Answer PostHog's capture endpoint (with CORS, like the real one) and keep
 * every event body, so a test can check exactly what left the browser.
 * Only does anything in a build made with NEXT_PUBLIC_POSTHOG_KEY set.
 */
export async function recordAnalytics(page: Page): Promise<SentEvent[]> {
  const sent: SentEvent[] = [];
  await page.route("https://us.i.posthog.com/**", async (route) => {
    const headers = {
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (route.request().method() === "POST") sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, json: { status: "Ok" }, headers });
  });
  return sent;
}
