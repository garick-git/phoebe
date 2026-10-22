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

import type { Page, Route } from "@playwright/test";

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
