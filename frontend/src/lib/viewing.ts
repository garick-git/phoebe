/**
 * Cloud-cover viewing rating for a pass: "Good viewing · mostly clear".
 * Pure functions with no React, so Vitest can test them.
 *
 * Decisions (Oct 20, see the decision log):
 * - D1 Thresholds follow oktas, the meteorology scale: good up to 25 %
 *   (clear or a few clouds), fair up to 50 % (scattered), poor above 50 %
 *   (broken or overcast). A pass crosses one path of sky for a few minutes;
 *   above half cover it's a coin flip whether that path is open.
 * - D2 The cloudiest hourly value from the hour at or before the visible
 *   start to the hour at or after the visible end (Open-Meteo's values are
 *   snapshots at the top of each hour, so the pass sits between two).
 * - D3 Total cloud cover (the model's own blend of low, mid and high layers);
 *   weighting layers is parked.
 * - D4 Passes more than 72 h ahead are labelled "early forecast"; a missing
 *   value or a failed request means "unavailable", never a guessed rating.
 * - D5 The rating never changes the cards' time order.
 */

import type { CloudForecast } from "@/lib/forecast";

export const GOOD_MAX_PERCENT = 25;
export const FAIR_MAX_PERCENT = 50;

/** Beyond this, cloud forecasts change a lot, so the rating says "early forecast". */
export const EARLY_AFTER_HOURS = 72;

const HOUR_MS = 3_600_000;

export type Rating = "good" | "fair" | "poor";

export function ratingFor(percent: number): Rating {
  if (percent <= GOOD_MAX_PERCENT) return "good";
  if (percent <= FAIR_MAX_PERCENT) return "fair";
  return "poor";
}

const RATING_WORDS: Record<Rating, { label: string; sky: string }> = {
  good: { label: "Good viewing", sky: "mostly clear" },
  fair: { label: "Fair viewing", sky: "partly cloudy" },
  poor: { label: "Poor viewing", sky: "cloudy" },
};

/** UTC hour starts (ms) from the hour at or before `startMs` to the hour at or after `endMs`. */
export function hoursSpanned(startMs: number, endMs: number): number[] {
  const hours: number[] = [];
  const last = Math.ceil(endMs / HOUR_MS) * HOUR_MS;
  for (let h = Math.floor(startMs / HOUR_MS) * HOUR_MS; h <= last; h += HOUR_MS) hours.push(h);
  return hours;
}

export type CloudReading = { percent: number; hourMs: number };

/**
 * The cloudiest of those hours (the earliest one on a tie), or null if any of
 * them is missing: a rating from only part of the window could look clearer
 * than it is.
 */
export function worstCloud(forecast: CloudForecast, startMs: number, endMs: number): CloudReading | null {
  let worst: CloudReading | null = null;
  for (const hourMs of hoursSpanned(startMs, endMs)) {
    const percent = forecast.get(hourMs);
    if (percent === undefined || percent === null) return null;
    if (!worst || percent > worst.percent) worst = { percent, hourMs };
  }
  return worst;
}

export type ForecastState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; forecast: CloudForecast };

export type Viewing =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "rated"; rating: Rating; percent: number; hourMs: number; early: boolean };

/** The rating for one pass's visible part (ISO times from the API). */
export function viewingFor(state: ForecastState, startIso: string, endIso: string, nowMs: number): Viewing {
  if (state.status === "loading") return { status: "loading" };
  if (state.status === "error") return { status: "unavailable" };
  const startMs = Date.parse(startIso);
  const reading = worstCloud(state.forecast, startMs, Date.parse(endIso));
  if (!reading) return { status: "unavailable" };
  return {
    status: "rated",
    rating: ratingFor(reading.percent),
    percent: reading.percent,
    hourMs: reading.hourMs,
    early: startMs - nowMs > EARLY_AFTER_HOURS * HOUR_MS,
  };
}

/** The card's line: "Good viewing · mostly clear", "… · early forecast", or the loading / unavailable text. */
export function viewingText(viewing: Viewing): string {
  if (viewing.status === "loading") return "Checking clouds…";
  if (viewing.status === "unavailable") return "Cloud forecast unavailable";
  const { label, sky } = RATING_WORDS[viewing.rating];
  return `${label} · ${sky}${viewing.early ? " · early forecast" : ""}`;
}
