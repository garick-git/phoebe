/**
 * Hourly cloud cover from Open-Meteo's free forecast API (no key; CC BY 4.0,
 * credited on the About page). Called from the browser for the same reason as
 * city search: the free limits count per IP address, so each visitor uses
 * their own allowance. Only the place's rounded coordinates are sent, and no
 * Referer.
 *
 * Request shape (checked against Open-Meteo's docs, Oct 20):
 * - `hourly=cloud_cover`: total cloud cover, an instant value at the top of
 *   each hour, 0–100 %.
 * - `timeformat=unixtime` and no `timezone`: times come back as seconds since
 *   1970 UTC at UTC hour starts, so they line up with the API's UTC pass times
 *   with no time-zone or daylight-time handling (true for half-hour zones such
 *   as India's too).
 * - `forecast_hours` counts from the current hour, so it covers exactly the
 *   pass window instead of whole calendar days.
 */

import { roundCoord } from "@/lib/place";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/**
 * The 7-day pass window, plus the hour at or after the last possible visible
 * end (the rating reads it), plus one spare.
 */
export const FORECAST_HOURS = 7 * 24 + 2;

/** Total cloud cover (%), or null where the model has no value, keyed by the hour's start in ms since 1970 UTC. */
export type CloudForecast = ReadonlyMap<number, number | null>;

export async function fetchCloudForecast(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<CloudForecast> {
  const params = new URLSearchParams({
    latitude: String(roundCoord(lat)),
    longitude: String(roundCoord(lon)),
    hourly: "cloud_cover",
    forecast_hours: String(FORECAST_HOURS),
    timeformat: "unixtime",
  });
  const response = await fetch(`${FORECAST_URL}?${params}`, {
    signal,
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`Cloud forecast failed: HTTP ${response.status}`);
  return parseCloudForecast(await response.json());
}

/**
 * Open-Meteo's JSON → hour → cloud %. Outside data, so every value is checked:
 * a malformed body throws; a single bad or missing value becomes null (that
 * hour is "no data", never a guess).
 */
export function parseCloudForecast(body: unknown): CloudForecast {
  const hourly =
    typeof body === "object" && body !== null
      ? (body as { hourly?: { time?: unknown; cloud_cover?: unknown } }).hourly
      : undefined;
  const times = hourly?.time;
  const cover = hourly?.cloud_cover;
  if (!Array.isArray(times) || !Array.isArray(cover) || times.length !== cover.length) {
    throw new Error("Cloud forecast: unexpected response");
  }
  const forecast = new Map<number, number | null>();
  times.forEach((t, i) => {
    if (typeof t !== "number" || !Number.isInteger(t)) return;
    const value = cover[i];
    const valid = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
    forecast.set(t * 1000, valid ? value : null);
  });
  return forecast;
}
